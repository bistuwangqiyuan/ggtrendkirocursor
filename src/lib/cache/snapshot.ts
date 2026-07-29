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
 * Which store actually answered.
 *
 * `unavailable` is not the same as `filesystem`: inside a Lambda there is no
 * durable disk, so treating the filesystem as a snapshot store means every write
 * reports success into a directory that dies with the container. Distinguishing
 * the two is what lets a caller notice that its rebuild never reached a reader.
 */
export type SnapshotBackend = 'blobs' | 'filesystem' | 'unavailable';

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
let resolvedBackend: SnapshotBackend | null = null;
let backendError: string | null = null;

/**
 * Whether this process is a serverless function, where the working directory is
 * read-only and anything written to it is discarded when the container exits.
 * Netlify sets both variables in the Lambda runtime.
 */
function isServerless(): boolean {
  return !!process.env.AWS_LAMBDA_FUNCTION_NAME || !!process.env.LAMBDA_TASK_ROOT;
}

/**
 * Resolve the Netlify Blobs store. Returns null when unavailable — outside a
 * function that means the filesystem backend takes over (plain `astro dev`,
 * tests, the outage drill); inside one it means snapshots cannot be served or
 * stored at all, and callers are told so rather than being handed a store that
 * quietly loses everything.
 */
async function getBlobStore(): Promise<BlobStore | null> {
  if (!storePromise) {
    storePromise = (async () => {
      if (process.env.SNAPSHOT_BACKEND === 'fs') {
        resolvedBackend = 'filesystem';
        return null;
      }
      try {
        const { getStore } = await import('@netlify/blobs');
        // Site-wide store (not deploy-scoped) so snapshots survive deploys.
        const store = getStore({ name: STORE_NAME, consistency: 'strong' }) as unknown as BlobStore;
        // Probe once: getStore() is lazy, so credential problems only surface on
        // the first real call.
        await store.get('__probe__', { type: 'text' });
        resolvedBackend = 'blobs';
        backendError = null;
        return store;
      } catch (error) {
        backendError = (error as Error).message;
        resolvedBackend = isServerless() ? 'unavailable' : 'filesystem';
        console.warn(
          `[snapshot] Netlify Blobs unavailable (${backendError}); backend=${resolvedBackend}`
        );
        return null;
      }
    })();
  }
  return storePromise;
}

/** Which backend serves snapshots in this process. Resolves it if needed. */
export async function snapshotBackend(): Promise<SnapshotBackend> {
  await getBlobStore();
  return resolvedBackend ?? 'unavailable';
}

/** Why Blobs was rejected, when it was. Null once a store is in use. */
export function snapshotBackendError(): string | null {
  return backendError;
}

/**
 * Give `@netlify/blobs` the credentials a Lambda-compatible (v1) function
 * receives on its event, and re-resolve the store.
 *
 * Netlify injects the Blobs environment automatically into v2 functions and the
 * Astro SSR handler, but a v1 handler gets it as `event.blobs` plus two request
 * headers, which the library only reads once `connectLambda(event)` has run.
 * Skipping this call raises MissingBlobsEnvironmentError on the first store
 * access — and until 2026-07-29 this module answered that by switching to the
 * filesystem, so the scheduled job's snapshot rebuild wrote into a throwaway
 * Lambda directory. Postgres kept receiving every report while all pages stayed
 * frozen on the last snapshot an SSR request happened to write, for 44 hours,
 * with nothing logged: the error log is itself a blob.
 *
 * Call it as the first statement of any v1 handler that touches snapshots.
 * Returns whether the environment is now wired up.
 */
export async function connectSnapshotStoreToLambda(event: unknown): Promise<boolean> {
  const blobs = (event as { blobs?: unknown } | null)?.blobs;
  if (typeof blobs !== 'string' || blobs.length === 0) {
    // Local invocation, or a runtime that injects the environment directly.
    return false;
  }
  try {
    const { connectLambda } = await import('@netlify/blobs');
    connectLambda(event as Parameters<typeof connectLambda>[0]);
    // Drop any resolution made before the credentials existed.
    resetSnapshotStore();
    return true;
  } catch (error) {
    console.error('[snapshot] connectLambda failed:', (error as Error).message);
    return false;
  }
}

/** For tests: drop cached backend resolution and micro-cache. */
export function resetSnapshotStore(): void {
  storePromise = null;
  resolvedBackend = null;
  backendError = null;
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
    if (store) raw = await store.get(key, { type: 'text' });
    else if (resolvedBackend === 'unavailable') return null;
    else raw = await fsRead(key);
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
    else if (resolvedBackend === 'unavailable') {
      // Writing to the container's filesystem would report success and lose the
      // data; the caller needs to know so it can repair through another path.
      console.error(`[snapshot] write refused, no store available: ${key} (${backendError})`);
      return false;
    } else await fsWrite(key, body);
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
    if (!store) return resolvedBackend === 'unavailable' ? [] : await fsList(prefix);
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
    else if (resolvedBackend === 'unavailable') return false;
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
