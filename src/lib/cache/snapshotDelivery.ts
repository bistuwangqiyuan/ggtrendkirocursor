/**
 * Proof that the snapshots a job just wrote are visible to readers — and a way
 * back when they are not.
 *
 * WHY A PROBE AND NOT A LOG LINE
 * On 2026-07-26 the scheduled job rebuilt every snapshot, reported success, and
 * changed nothing: its Blobs environment was missing, so the store resolved to
 * the container's filesystem and each write landed in a directory that died with
 * the invocation. Postgres kept receiving reports the whole time, so the only
 * visible symptom was pages frozen for 44 hours, and the error log could not
 * record it because the log is a blob too.
 *
 * The lesson is that "the write returned true" is not evidence. A nonce written
 * and then read back through a re-resolved store is: it exercises the same code
 * path the rebuild uses and can only pass if the bytes really left the process.
 *
 * When the round trip fails, the read side is repaired over HTTP through
 * `/api/snapshots/rebuild`, which runs in the SSR function where Netlify injects
 * the Blobs environment automatically — the path that was demonstrably working
 * while the background function's was not. It costs one extra database wake-up,
 * which is the right trade against a frozen site.
 */
import {
  SNAPSHOT_KEYS,
  readSnapshot,
  resetSnapshotStore,
  snapshotBackend,
  snapshotBackendError,
  writeSnapshot,
  type SnapshotBackend,
} from './snapshot';
import { ALL_SECTIONS, type SnapshotSection } from './snapshotBuilder';

const PROBE_KEY = 'ops/store-probe';

/**
 * How old the freshest-per-section snapshots may get before the read side counts
 * as frozen. The write window runs every three hours, so two missed windows plus
 * an hour of slack is a signal, not noise.
 */
export function snapshotMaxAgeSeconds(): number {
  const raw = Number(process.env.SNAPSHOT_MAX_AGE_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 7 * 3600;
}

/** The snapshot each section publishes last, used to judge that section's age. */
const WITNESSES: [SnapshotSection, string, string][] = [
  ['trends', 'trendsTop', SNAPSHOT_KEYS.trendsTop],
  ['landing', 'landingIndex', SNAPSHOT_KEYS.landingIndex],
  ['bp', 'bpList', SNAPSHOT_KEYS.bpList],
  ['monitor', 'monitorLatest', SNAPSHOT_KEYS.monitorLatest],
  ['stats', 'statsOverview', SNAPSHOT_KEYS.statsOverview],
];

export interface SnapshotStaleness {
  stale: boolean;
  staleAfterSeconds: number;
  /** Age of the oldest witness; null when every one of them is missing. */
  maxAgeSeconds: number | null;
  missing: string[];
  /** Sections whose witness is missing or past the threshold. */
  staleSections: SnapshotSection[];
  ages: Record<string, number | null>;
}

/**
 * How frozen the read side is, judged from Blobs alone.
 *
 * Shared by the public status endpoint and the hourly watchdog so that "stale"
 * means one thing: a monitor cannot report a problem the repair job disagrees
 * with.
 */
export async function snapshotStaleness(now: Date = new Date()): Promise<SnapshotStaleness> {
  const threshold = snapshotMaxAgeSeconds();
  const result: SnapshotStaleness = {
    stale: false,
    staleAfterSeconds: threshold,
    maxAgeSeconds: null,
    missing: [],
    staleSections: [],
    ages: {},
  };

  for (const [section, name, key] of WITNESSES) {
    const snap = await readSnapshot<unknown>(key);
    if (!snap) {
      result.ages[name] = null;
      result.missing.push(name);
      result.staleSections.push(section);
      continue;
    }
    const age = Math.round((now.getTime() - Date.parse(snap.generatedAt)) / 1000);
    result.ages[name] = age;
    result.maxAgeSeconds = Math.max(result.maxAgeSeconds ?? 0, age);
    if (age > threshold) result.staleSections.push(section);
  }

  result.stale = result.staleSections.length > 0;
  return result;
}

export interface StoreProbe {
  /** The nonce completed a write -> re-resolve -> read cycle. */
  ok: boolean;
  backend: SnapshotBackend;
  /** Why Blobs was refused, when it was. */
  error: string | null;
  detail: string;
}

interface ProbePayload {
  nonce: string;
  at: string;
}

/**
 * Write a nonce and read it back through a freshly resolved store.
 *
 * The reset is essential: both the micro-cache and the memoised store would
 * otherwise answer from the same process that just claimed to have written, which
 * is exactly the assumption being tested.
 */
export async function probeSnapshotStore(): Promise<StoreProbe> {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const backendBefore = await snapshotBackend();
  const wrote = await writeSnapshot<ProbePayload>(PROBE_KEY, { nonce, at: new Date().toISOString() });
  if (!wrote) {
    return {
      ok: false,
      backend: backendBefore,
      error: snapshotBackendError(),
      detail: `write refused (backend=${backendBefore})`,
    };
  }

  resetSnapshotStore();
  const backend = await snapshotBackend();
  const readBack = await readSnapshot<ProbePayload>(PROBE_KEY);
  if (readBack?.data.nonce === nonce) {
    return { ok: true, backend, error: null, detail: `round trip ok (backend=${backend})` };
  }
  return {
    ok: false,
    backend,
    error: snapshotBackendError(),
    detail: readBack
      ? `read back a different write (backend=${backend}) — the store is not shared with readers`
      : `nonce did not survive the write (backend=${backend})`,
  };
}

/** The site's own origin, as seen from inside a Netlify function. */
function baseUrl(): string | null {
  const raw = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.BASE_URL;
  return raw ? raw.replace(/\/$/, '') : null;
}

export interface HttpRepairResult {
  ok: boolean;
  /** Sections confirmed rebuilt through the SSR route. */
  completed: SnapshotSection[];
  /** Sections still incomplete when the budget ran out. */
  incomplete: SnapshotSection[];
  passes: number;
  detail: string;
}

/**
 * Rebuild snapshots by driving the SSR endpoint, one section at a time.
 *
 * That endpoint is synchronous and stops at its own budget, reporting which
 * sections it had to truncate, so a cold landing set needs several passes — the
 * same loop `scripts/snapshot-bootstrap.mjs` runs by hand.
 */
export async function repairSnapshotsViaHttp(
  options: {
    sections?: SnapshotSection[];
    budgetMs?: number;
    maxPassesPerSection?: number;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<HttpRepairResult> {
  const sections = options.sections ?? ALL_SECTIONS;
  const deadline = Date.now() + (options.budgetMs ?? 4 * 60 * 1000);
  const maxPasses = options.maxPassesPerSection ?? 8;
  const doFetch = options.fetchImpl ?? fetch;
  const result: HttpRepairResult = { ok: false, completed: [], incomplete: [], passes: 0, detail: '' };

  const base = baseUrl();
  const secret = process.env.CRON_SECRET?.trim() || process.env.ADMIN_SECRET?.trim();
  if (!base || !secret) {
    result.incomplete = [...sections];
    result.detail = !base ? 'no site URL in the environment' : 'no CRON_SECRET/ADMIN_SECRET to authenticate with';
    return result;
  }

  for (const section of sections) {
    let done = false;
    for (let pass = 1; pass <= maxPasses; pass++) {
      if (Date.now() > deadline) break;
      result.passes++;
      try {
        const res = await doFetch(`${base}/api/snapshots/rebuild?sections=${section}`, {
          method: 'POST',
          // Astro rejects a cross-site POST without a matching Origin.
          headers: { Authorization: `Bearer ${secret}`, Origin: base },
        });
        if (!res.ok) {
          result.detail = `${section}: HTTP ${res.status}`;
          break;
        }
        const body = (await res.json()) as { report?: { truncated?: string[]; errors?: Record<string, string> } };
        const report = body.report;
        if (!report) {
          result.detail = `${section}: response carried no report`;
          break;
        }
        if (report.errors && Object.keys(report.errors).length > 0) {
          result.detail = `${section}: ${JSON.stringify(report.errors).slice(0, 200)}`;
          break;
        }
        if (!report.truncated?.includes(section)) {
          done = true;
          break;
        }
      } catch (error) {
        result.detail = `${section}: ${(error as Error).message}`;
        break;
      }
    }
    if (done) result.completed.push(section);
    else result.incomplete.push(section);
  }

  result.ok = result.incomplete.length === 0;
  if (!result.detail) {
    result.detail = result.ok
      ? `rebuilt ${result.completed.join(',')} in ${result.passes} pass(es)`
      : `budget spent with ${result.incomplete.join(',')} incomplete`;
  }
  return result;
}

export interface DeliveryResult {
  /** The read side is up to date, whether directly or after a repair. */
  ok: boolean;
  probe: StoreProbe;
  /** Whether the SSR fallback had to be used. */
  repaired: boolean;
  repair: HttpRepairResult | null;
  /** One line for the run summary. */
  summary: string;
}

/**
 * Verify this run's snapshot writes are real, and repair them if not.
 *
 * Call at the end of a job that rebuilt snapshots, before the log is flushed.
 */
export async function ensureSnapshotsDelivered(
  options: { sections?: SnapshotSection[]; budgetMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<DeliveryResult> {
  const probe = await probeSnapshotStore();
  if (probe.ok) {
    return { ok: true, probe, repaired: false, repair: null, summary: `store=${probe.backend}` };
  }

  const repair = await repairSnapshotsViaHttp(options);
  return {
    ok: repair.ok,
    probe,
    repaired: true,
    repair,
    summary:
      `store=BROKEN(${probe.detail}) repair=${repair.ok ? 'ok' : 'FAILED'}` +
      ` [${repair.detail}]`,
  };
}
