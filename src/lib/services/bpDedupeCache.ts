/**
 * A Blobs-resident copy of everything the batch needs to pick and de-duplicate
 * candidates, so analysis can continue while Postgres is unavailable.
 *
 * WHY
 * The batch's prepare phase reads five things from the database: which keywords
 * already have a completed plan, which keep failing, which business models to
 * steer away from, and the canonical plan for each model. All of it is read-only
 * reference data that changes slowly — but because it lived only in Postgres, a
 * quota-exhausted Neon meant prepare failed and the run generated nothing at all,
 * even though the LLM was available and the hotwords were in hand.
 *
 * So every successful prepare writes this state to Blobs. When prepare fails, the
 * batch falls back to the cached copy and keeps generating; the finished plans go
 * to the existing Blobs buffer and are flushed when the database returns. An
 * outage becomes a delay in *storing* plans rather than a hole in the archive.
 *
 * THE STALENESS TRADE-OFF
 * A cached dedupe set can miss plans written after it was captured, so a degraded
 * run could pick a keyword that was analyzed in the meantime. Two things bound the
 * damage: the cache expires (a very old copy is refused outright), and the flush
 * path re-checks against the live database before inserting. Duplicate work is
 * possible; a duplicate row is not.
 */
import { readSnapshot, writeSnapshot } from '../cache/snapshot';
import type { CanonicalBusinessModel } from './bp';

const KEY = 'bp/dedupe-state';

/**
 * Beyond this, the cached sets have missed too many days of writes to steer
 * selection responsibly, and the run reports "no candidates" instead of guessing.
 */
const DEFAULT_MAX_AGE_HOURS = 72;

/** Bound the blob: dedupe is all-history, so these sets only ever grow. */
const MAX_NORMS = 20_000;
const MAX_CANONICAL_MODELS = 5_000;

export interface BpDedupeState {
  capturedAt: string;
  /** keyword_norms with a completed plan (all history). */
  completedKeywordNorms: string[];
  /** keyword_norms circuit-broken by repeated failures. */
  failedKeywordNorms: string[];
  /** Business models to steer the LLM away from. */
  avoidModels: string[];
  canonicalModels: CanonicalBusinessModel[];
}

export interface LoadedBpDedupeState {
  state: BpDedupeState;
  ageMs: number;
  /** True when the copy is too old to steer selection. */
  stale: boolean;
}

export function dedupeCacheMaxAgeHours(): number {
  const raw = Number(process.env.BP_DEDUPE_CACHE_MAX_AGE_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_HOURS;
}

/** Persist the state a successful prepare just read. Never throws. */
export async function saveBpDedupeState(input: {
  completedKeywordNorms: Iterable<string>;
  failedKeywordNorms: Iterable<string>;
  avoidModels: string[];
  canonicalModels: Iterable<CanonicalBusinessModel>;
}): Promise<boolean> {
  const state: BpDedupeState = {
    capturedAt: new Date().toISOString(),
    // Newest entries matter most for steering, and they sit at the end of the
    // set, so the cap trims from the front.
    completedKeywordNorms: [...input.completedKeywordNorms].slice(-MAX_NORMS),
    failedKeywordNorms: [...input.failedKeywordNorms].slice(-MAX_NORMS),
    avoidModels: input.avoidModels.slice(0, 100),
    canonicalModels: [...input.canonicalModels].slice(-MAX_CANONICAL_MODELS),
  };
  return writeSnapshot<BpDedupeState>(KEY, state);
}

/** Read the cached state. Returns null when absent or unusable. */
export async function loadBpDedupeState(
  now: Date = new Date(),
  maxAgeHours: number = dedupeCacheMaxAgeHours()
): Promise<LoadedBpDedupeState | null> {
  const snap = await readSnapshot<BpDedupeState>(KEY);
  const state = snap?.data;
  if (!state || !Array.isArray(state.completedKeywordNorms)) return null;
  const capturedAt = Date.parse(state.capturedAt ?? '');
  if (!Number.isFinite(capturedAt)) return null;
  const ageMs = now.getTime() - capturedAt;
  return { state, ageMs, stale: ageMs > maxAgeHours * 3_600_000 };
}
