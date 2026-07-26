/**
 * Snapshot store — the layer that keeps page reads off Postgres.
 *
 * WHY THIS EXISTS
 * Neon's free plan bills *compute time* (100 CU-hours/project/month), not query
 * count. The compute auto-suspends after 5 minutes of inactivity, so every
 * request that touches Postgres both wakes the instance and resets that 5-minute
 * timer. A site with steady crawler traffic therefore keeps the compute awake
 * 24/7 (~730 h/month) and blows the quota on its own, no matter how few queries
 * each page runs.
 *
 * So the read path must not touch Postgres at all. Scheduled jobs (which already
 * pay for a wake window) write JSON snapshots here; pages read them. Netlify
 * Blobs costs no Neon compute.
 *
 * Every function here is fail-soft: reads return null and writes return false
 * rather than throwing, so a snapshot-store outage degrades a page instead of
 * 500-ing it.
 */
import { APP_VERSION } from '../../version';

export interface Snapshot<T> {
  /** ISO timestamp of when the snapshot was produced. */
  generatedAt: string;
  /** App version that produced it, for debugging shape drift. */
  version: string;
  data: T;
}

/** Canonical snapshot keys. Slash-separated so Blobs prefix listing works. */
export const SNAPSHOT_KEYS = {
  trendsTop: 'trends/top',
  trendsCategories: 'trends/categories',
  landingIndex: 'landing/index',
  landingDetail: (slug: string) => `landing/detail/${slug}`,
  bpList: 'bp/list',
  bpDetail: (id: string) => `bp/detail/${id}`,
  monitorLatest: 'monitor/latest',
  statsOverview: 'stats/overview',
} as const;

const STORE_NAME = 'snapshots';

/**
 * Per-instance micro-cache. A warm Lambda serving a burst of requests would
 * otherwise re-fetch the same blob every time. Kept deliberately short so a
 * fresh snapshot propagates quickly.
 */
const MICRO_CACHE_TTL_MS = 30_000;
const microCache = new Map<string, { at: number; value: Snapshot<unknown> | null }>();

type BlobStore = {
  get(key: string, opts?: { type: 'text' }): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ blobs: { key: string }[] }>;
};

let storePromise: Promise<BlobStore | null> | null = null;

/**
 * Resolve the Netlify Blobs store. Returns null when unavailable (e.g. plain
 * `astro dev` with no Netlify credentials), which makes callers fall back to the
 * filesystem backend.
 */
async function getBlobStore(): Promise<BlobStore | null> {
  if (!storePromise) {
    storePromise = (async () => {
      if (process.env.SNAPSHOT_BACKEND === 'fs') return null;
      try {
        const { getStore } = await import('@netlify/blobs');
        // Site-wide store (not deploy-scoped) so snapshots survive deploys.
        const store = getStore({ name: STORE_NAME, consistency: 'strong' }) as unknown as BlobStore;
        // Probe once: getStore() is lazy, so credential problems only surface on
        // the first real call.
        await store.get('__probe__', { type: 'text' });
        return store;
      } catch (error) {
        console.warn('[snapshot] Netlify Blobs unavailable, using filesystem backend:', (error as Error).message);
        return null;
      }
    })();
  }
  return storePromise;
}

/** For tests: drop cached backend resolution and micro-cache. */
export function resetSnapshotStore(): void {
  storePromise = null;
  microCache.clear();
}

// ---------------------------------------------------------------------------
// Filesystem fallback (local dev / tests)
// ---------------------------------------------------------------------------

function fsRoot(): string {
  return process.env.SNAPSHOT_DIR?.trim() || '.snapshots';
}

/**
 * Map a snapshot key to a filesystem path. Each segment is percent-encoded so
 * CJK slugs and characters Windows forbids in filenames (`:` `?` `*` ...) are
 * safe, while the mapping stays deterministic and reversible.
 */
function keyToFsPath(key: string): string {
  const segments = key.split('/').filter(Boolean).map((s) => encodeURIComponent(s));
  return `${fsRoot()}/${segments.join('/')}.json`;
}

function fsPathToKey(path: string): string {
  const root = fsRoot().replace(/\\/g, '/');
  const rel = path.replace(/\\/g, '/').replace(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), '');
  return rel.replace(/\.json$/, '').split('/').map((s) => decodeURIComponent(s)).join('/');
}

async function fsRead(key: string): Promise<string | null> {
  try {
    const fs = await import('node:fs/promises');
    return await fs.readFile(keyToFsPath(key), 'utf8');
  } catch {
    return null;
  }
}

async function fsWrite(key: string, value: string): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const file = keyToFsPath(key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value, 'utf8');
}

async function fsDelete(key: string): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.rm(keyToFsPath(key), { force: true });
}

async function fsList(prefix: string): Promise<string[]> {
  try {
    const fs = await import('node:fs/promises');
    const entries = await fs.readdir(fsRoot(), { recursive: true, withFileTypes: true });
    const keys: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      // parentPath is Node >= 20.12; fall back to the deprecated `path`.
      const dir = (entry as any).parentPath ?? (entry as any).path ?? fsRoot();
      const key = fsPathToKey(`${dir}/${entry.name}`);
      if (key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read a snapshot. Returns null when missing or unreadable — never throws. */
export async function readSnapshot<T>(key: string): Promise<Snapshot<T> | null> {
  const cached = microCache.get(key);
  if (cached && Date.now() - cached.at < MICRO_CACHE_TTL_MS) {
    return cached.value as Snapshot<T> | null;
  }
  let raw: string | null = null;
  try {
    const store = await getBlobStore();
    raw = store ? await store.get(key, { type: 'text' }) : await fsRead(key);
  } catch (error) {
    console.error('[snapshot] read failed', key, (error as Error).message);
    return null;
  }
  let parsed: Snapshot<T> | null = null;
  if (raw) {
    try {
      const candidate = JSON.parse(raw);
      // Guard against a half-written or legacy payload.
      if (candidate && typeof candidate === 'object' && 'data' in candidate) {
        parsed = candidate as Snapshot<T>;
      }
    } catch (error) {
      console.error('[snapshot] parse failed', key, (error as Error).message);
    }
  }
  microCache.set(key, { at: Date.now(), value: parsed });
  return parsed;
}

/** Read just the payload, or `fallback` when the snapshot is missing. */
export async function readSnapshotData<T>(key: string, fallback: T): Promise<T> {
  const snap = await readSnapshot<T>(key);
  return snap ? snap.data : fallback;
}

/** Write a snapshot. Returns false on failure — never throws. */
export async function writeSnapshot<T>(key: string, data: T): Promise<boolean> {
  const payload: Snapshot<T> = {
    generatedAt: new Date().toISOString(),
    version: APP_VERSION,
    data,
  };
  const body = JSON.stringify(payload);
  try {
    const store = await getBlobStore();
    if (store) await store.set(key, body);
    else await fsWrite(key, body);
    microCache.set(key, { at: Date.now(), value: payload as Snapshot<unknown> });
    return true;
  } catch (error) {
    console.error('[snapshot] write failed', key, (error as Error).message);
    return false;
  }
}

/** List keys under a prefix. Returns [] on failure — never throws. */
export async function listSnapshotKeys(prefix: string): Promise<string[]> {
  try {
    const store = await getBlobStore();
    if (!store) return await fsList(prefix);
    const { blobs } = await store.list({ prefix });
    return blobs.map((b) => b.key);
  } catch (error) {
    console.error('[snapshot] list failed', prefix, (error as Error).message);
    return [];
  }
}

/** Delete a snapshot. Returns false on failure — never throws. */
export async function deleteSnapshot(key: string): Promise<boolean> {
  try {
    const store = await getBlobStore();
    if (store) await store.delete(key);
    else await fsDelete(key);
    microCache.delete(key);
    return true;
  } catch (error) {
    console.error('[snapshot] delete failed', key, (error as Error).message);
    return false;
  }
}

/**
 * Whether a read path is allowed to fall back to Postgres when its snapshot is
 * missing. Off by default: silently reverting to DB reads would restore exactly
 * the traffic pattern that exhausts the Neon quota, and would do so invisibly.
 */
export function isDbReadFallbackAllowed(): boolean {
  return process.env.ALLOW_DB_READ_FALLBACK === 'true';
}
