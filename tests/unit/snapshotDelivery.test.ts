import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SNAPSHOT_KEYS, resetSnapshotStore, writeSnapshot } from '../../src/lib/cache/snapshot';
import {
  ensureSnapshotsDelivered,
  probeSnapshotStore,
  repairSnapshotsViaHttp,
  snapshotMaxAgeSeconds,
  snapshotStaleness,
} from '../../src/lib/cache/snapshotDelivery';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  process.env.SNAPSHOT_BACKEND = 'fs';
  process.env.SNAPSHOT_DIR = dir;
  process.env.URL = 'https://example.test';
  process.env.CRON_SECRET = 'test-secret';
  delete process.env.SNAPSHOT_MAX_AGE_SECONDS;
  delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  resetSnapshotStore();
});

afterEach(async () => {
  delete process.env.SNAPSHOT_BACKEND;
  delete process.env.SNAPSHOT_DIR;
  delete process.env.URL;
  delete process.env.CRON_SECRET;
  delete process.env.SNAPSHOT_MAX_AGE_SECONDS;
  delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  resetSnapshotStore();
  await rm(dir, { recursive: true, force: true });
});

/** All five witnesses, written now, so the read side looks freshly rebuilt. */
async function seedAllWitnesses(): Promise<void> {
  await writeSnapshot(SNAPSHOT_KEYS.trendsTop, { rows: [] });
  await writeSnapshot(SNAPSHOT_KEYS.landingIndex, { keywords: [] });
  await writeSnapshot(SNAPSHOT_KEYS.bpList, { reports: [] });
  await writeSnapshot(SNAPSHOT_KEYS.monitorLatest, { sites: [] });
  await writeSnapshot(SNAPSHOT_KEYS.statsOverview, { daily: [] });
}

describe('probeSnapshotStore', () => {
  it('passes when a nonce survives the round trip', async () => {
    const probe = await probeSnapshotStore();
    expect(probe.ok).toBe(true);
    expect(probe.backend).toBe('filesystem');
  });

  it('fails when there is no store to write to', async () => {
    // The July 2026 state: a function with no Blobs environment. The old code
    // wrote to the container and called it a success.
    delete process.env.SNAPSHOT_BACKEND;
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'bp-batch-background';
    resetSnapshotStore();

    const probe = await probeSnapshotStore();
    expect(probe.ok).toBe(false);
    expect(probe.backend).toBe('unavailable');
    expect(probe.detail).toContain('write refused');
  });
});

describe('snapshotStaleness', () => {
  it('is not stale right after a rebuild', async () => {
    await seedAllWitnesses();
    resetSnapshotStore();
    const freshness = await snapshotStaleness();
    expect(freshness.stale).toBe(false);
    expect(freshness.staleSections).toEqual([]);
    expect(freshness.maxAgeSeconds!).toBeLessThan(60);
  });

  it('flags a read side frozen past the threshold', async () => {
    await seedAllWitnesses();
    resetSnapshotStore();
    // Judged 10 hours later, which is more than two missed three-hourly windows.
    const freshness = await snapshotStaleness(new Date(Date.now() + 10 * 3_600_000));
    expect(freshness.stale).toBe(true);
    expect(freshness.staleSections).toHaveLength(5);
    expect(freshness.maxAgeSeconds).toBeGreaterThan(freshness.staleAfterSeconds);
  });

  it('treats a missing snapshot as stale, and names it', async () => {
    await writeSnapshot(SNAPSHOT_KEYS.trendsTop, { rows: [] });
    resetSnapshotStore();
    const freshness = await snapshotStaleness();
    expect(freshness.stale).toBe(true);
    expect(freshness.missing).toContain('bpList');
    expect(freshness.staleSections).toContain('bp');
    expect(freshness.staleSections).not.toContain('trends');
  });

  it('honours SNAPSHOT_MAX_AGE_SECONDS', async () => {
    process.env.SNAPSHOT_MAX_AGE_SECONDS = '60';
    expect(snapshotMaxAgeSeconds()).toBe(60);
    await seedAllWitnesses();
    resetSnapshotStore();
    const freshness = await snapshotStaleness(new Date(Date.now() + 120_000));
    expect(freshness.stale).toBe(true);
  });

  it('falls back to two missed windows plus slack when unset', () => {
    expect(snapshotMaxAgeSeconds()).toBe(7 * 3600);
    process.env.SNAPSHOT_MAX_AGE_SECONDS = '0';
    expect(snapshotMaxAgeSeconds()).toBe(7 * 3600);
  });
});

describe('repairSnapshotsViaHttp', () => {
  function reply(body: unknown, status = 200) {
    return { ok: status < 400, status, json: async () => body } as unknown as Response;
  }

  it('drives one section until the endpoint stops truncating', async () => {
    const calls: string[] = [];
    let pass = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      pass++;
      // Two truncated passes, then complete — a cold landing set behaves this way.
      return reply({ report: { written: {}, truncated: pass < 3 ? ['landing'] : [], errors: {} } });
    });

    const result = await repairSnapshotsViaHttp({
      sections: ['landing'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.completed).toEqual(['landing']);
    expect(result.passes).toBe(3);
    expect(calls[0]).toBe('https://example.test/api/snapshots/rebuild?sections=landing');
  });

  it('authenticates and sends an Origin, or Astro rejects the POST', async () => {
    const fetchImpl = vi.fn(async () => reply({ report: { truncated: [], errors: {} } }));
    await repairSnapshotsViaHttp({ sections: ['bp'], fetchImpl: fetchImpl as unknown as typeof fetch });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-secret');
    expect((init.headers as Record<string, string>).Origin).toBe('https://example.test');
  });

  it('stops on a section error and reports which section failed', async () => {
    const fetchImpl = vi.fn(async () =>
      reply({ report: { truncated: [], errors: { bp: 'database is suspended' } } })
    );
    const result = await repairSnapshotsViaHttp({
      sections: ['bp'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.incomplete).toEqual(['bp']);
    expect(result.detail).toContain('database is suspended');
  });

  it('reports an HTTP failure rather than looping on it', async () => {
    const fetchImpl = vi.fn(async () => reply({}, 401));
    const result = await repairSnapshotsViaHttp({
      sections: ['bp'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.passes).toBe(1);
    expect(result.detail).toContain('401');
  });

  it('gives up immediately without a secret to authenticate with', async () => {
    delete process.env.CRON_SECRET;
    delete process.env.ADMIN_SECRET;
    const fetchImpl = vi.fn();
    const result = await repairSnapshotsViaHttp({
      sections: ['bp'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.detail).toContain('CRON_SECRET');
  });

  it('stops at its budget instead of overrunning the function', async () => {
    // Always truncated: without a budget this would loop to maxPasses.
    const fetchImpl = vi.fn(async () => reply({ report: { truncated: ['landing'], errors: {} } }));
    const result = await repairSnapshotsViaHttp({
      sections: ['landing'],
      budgetMs: -1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.incomplete).toEqual(['landing']);
  });
});

describe('/api/snapshots/status as a watchdog signal', () => {
  // The endpoint an external uptime monitor can poll. Before this it answered 200
  // with a 44-hour-old timestamp in the body, so nothing ever noticed.
  async function callStatus(): Promise<{ status: number; body: any }> {
    const { GET } = await import('../../src/pages/api/snapshots/status');
    const res = await (GET as (ctx: unknown) => Promise<Response>)({});
    return { status: res.status, body: await res.json() };
  }

  it('answers 200 while snapshots are fresh', async () => {
    await seedAllWitnesses();
    resetSnapshotStore();
    const res = await callStatus();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.stale).toBe(false);
  });

  it('answers 503 once the read side is frozen', async () => {
    process.env.SNAPSHOT_MAX_AGE_SECONDS = '1';
    await seedAllWitnesses();
    resetSnapshotStore();
    await new Promise((r) => setTimeout(r, 1100));
    const res = await callStatus();
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.stale).toBe(true);
    // The body still has to say what is wrong, not just fail.
    expect(res.body.staleSections.length).toBeGreaterThan(0);
    expect(res.body.snapshots.bpList.present).toBe(true);
  });

  it('answers 503 when a snapshot has never been written', async () => {
    resetSnapshotStore();
    const res = await callStatus();
    expect(res.status).toBe(503);
    expect(res.body.staleSections).toContain('bp');
  });
});

describe('ensureSnapshotsDelivered', () => {
  it('does nothing more when the store works', async () => {
    const fetchImpl = vi.fn();
    const delivery = await ensureSnapshotsDelivered({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(delivery.ok).toBe(true);
    expect(delivery.repaired).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(delivery.summary).toContain('store=filesystem');
  });

  it('repairs through the SSR route when the store is unusable', async () => {
    delete process.env.SNAPSHOT_BACKEND;
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'bp-batch-background';
    resetSnapshotStore();

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ report: { truncated: [], errors: {} } }),
    }) as unknown as Response);

    const delivery = await ensureSnapshotsDelivered({
      sections: ['bp'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(delivery.probe.ok).toBe(false);
    expect(delivery.repaired).toBe(true);
    expect(delivery.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(delivery.summary).toContain('store=BROKEN');
    expect(delivery.summary).toContain('repair=ok');
  });

  it('says so when neither the store nor the repair works', async () => {
    delete process.env.SNAPSHOT_BACKEND;
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'bp-batch-background';
    resetSnapshotStore();

    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const delivery = await ensureSnapshotsDelivered({
      sections: ['bp'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(delivery.ok).toBe(false);
    expect(delivery.summary).toContain('repair=FAILED');
    expect(delivery.summary).toContain('fetch failed');
  });
});
