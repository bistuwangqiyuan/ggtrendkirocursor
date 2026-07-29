/**
 * Three-phase BP batch: read once, think without the database, write once.
 *
 * WHY
 * Neon's free plan bills compute time and auto-suspends after 5 idle minutes.
 * The old batch inserted a placeholder row before each LLM call and updated it
 * after, so a ~10-minute run kept a query landing every ~2 minutes and the
 * compute never got to suspend. Confining all database work to the first and
 * last seconds of the run lets it suspend during the LLM phase, which is where
 * almost all of the wall-clock time goes.
 *
 * Phases:
 *   1. PREPARE  — one wake: stale-row reset, dedupe sets, candidate list,
 *                 avoid-models, canonical business models.
 *   2. GENERATE — LLM only. Zero database access. Each finished plan is appended
 *                 to a Netlify Blobs buffer immediately.
 *   3. FLUSH    — one wake: insert every result in a single transaction, then
 *                 drop the buffer.
 *
 * CRASH SAFETY
 * Dropping the placeholder row means a crash mid-phase-2 no longer leaves a
 * `generating` row behind — but it would lose the completed work. The Blobs
 * buffer is what replaces it: a plan is durable the moment its LLM call returns,
 * and the next run replays any buffer whose flush never happened. That is
 * strictly better than the old behaviour, where a crash lost the LLM spend AND
 * left a stuck row.
 *
 * DEGRADED MODE
 * The same buffer is what keeps the pipeline productive through a Neon outage.
 * When phase 1 cannot reach the database, it falls back to the cached dedupe
 * state (bpDedupeCache.ts) and picks candidates from the last trends snapshot
 * plus the intake queue, phase 2 runs normally, and phase 3's failed flush leaves
 * the buffer for the next run. The outage costs a delay in storing plans, not the
 * plans themselves.
 */
import {
  buildAvoidModelsLine,
  buildUserPrompt,
  bpService,
  normalizeBusinessModel,
  normalizeKeyword,
  validateAndNormalizeBpContent,
  BpValidationError,
  SYSTEM_PROMPT,
  type BatchResultInput,
  type CanonicalBusinessModel,
} from './bp';
import { generateJson, isLlmConfigured, LlmError } from './llm';
import { deleteSnapshot, listSnapshotKeys, readSnapshot, writeSnapshot } from '../cache/snapshot';
import { recordError } from '../observability/errorLog';
import { loadBpDedupeState, saveBpDedupeState } from './bpDedupeCache';
import { pendingTrendsAsTrends } from './trendIntake';
import type { BpTrendSnapshot } from '../../types';

const BUFFER_PREFIX = 'bp/pending/';

interface BufferedBatch {
  batchId: string;
  startedAt: string;
  results: BatchResultInput[];
}

export interface BatchRunSummary {
  generated: number;
  duplicates: number;
  failed: number;
  skipped: number;
  replayed: number;
  candidates: number;
  /** Wall-clock ms spent with the database in use (phases 1 and 3 only). */
  dbPhaseMs: number;
  llmPhaseMs: number;
  /** True when the run planned from cached dedupe state because the DB was down. */
  degraded: boolean;
  /** True when finished plans are sitting in the buffer, awaiting a later flush. */
  buffered: boolean;
  errors: string[];
}

export interface BatchRunOptions {
  batchSize: number;
  /** Stop starting new generations once this deadline (epoch ms) passes. */
  generateUntil: number;
  llmTimeoutMs?: number;
  /** Pause between LLM calls, to be gentle on providers. */
  spacingMs?: number;
}

/**
 * Replay buffers left behind by a crashed or database-starved run. Called at the
 * start of a batch, and by the recovery job, so completed-but-unflushed plans
 * reach Postgres instead of being lost.
 */
export async function replayPendingBatches(currentBatchId?: string): Promise<number> {
  let replayed = 0;
  for (const key of await listSnapshotKeys(BUFFER_PREFIX)) {
    if (currentBatchId && key === `${BUFFER_PREFIX}${currentBatchId}`) continue;
    const buffered = await readSnapshot<BufferedBatch>(key);
    const results = buffered?.data.results ?? [];
    if (results.length === 0) {
      await deleteSnapshot(key);
      continue;
    }
    try {
      // A buffer can be hours old, and it may have been planned from cached
      // dedupe state, so check against the live archive before inserting.
      const deduped = await dropAlreadyAnalyzed(results);
      const { inserted } = await bpService.insertBatchResults(deduped);
      replayed += inserted;
      await deleteSnapshot(key);
      console.log(
        `[bp-batch] replayed ${inserted} unflushed report(s) from ${key}` +
        (deduped.length < results.length ? ` (${results.length - deduped.length} already analyzed)` : '')
      );
    } catch (error) {
      // Keep the buffer: the next run tries again. Losing paid LLM output is
      // worse than carrying a buffer for another 3 hours.
      console.error(`[bp-batch] replay failed for ${key}:`, (error as Error).message);
      recordError('bp-batch', error, { context: { stage: 'replay', key } });
    }
  }
  return replayed;
}

/**
 * Drop results whose keyword already has a completed plan in Postgres.
 *
 * Only completed plans are filtered: a failed placeholder must still be written,
 * because it is what advances the keyword's failure counter. Falls back to
 * inserting everything if the check itself fails — an occasional duplicate is a
 * smaller loss than discarding finished work.
 */
async function dropAlreadyAnalyzed(results: BatchResultInput[]): Promise<BatchResultInput[]> {
  const norms = results
    .filter((r) => r.status === 'completed')
    .map((r) => normalizeKeyword(r.snapshot.keyword));
  if (norms.length === 0) return results;
  let existing: Set<string>;
  try {
    existing = await bpService.getCompletedKeywordNormsAmong(norms);
  } catch {
    return results;
  }
  if (existing.size === 0) return results;
  return results.filter(
    (r) => r.status !== 'completed' || !existing.has(normalizeKeyword(r.snapshot.keyword))
  );
}

/**
 * Keywords sitting in unflushed buffers. A second outage run must skip these:
 * the cached dedupe state predates them, so without this the same hotword would
 * be analyzed again in every window until the database came back.
 */
export async function bufferedKeywordNorms(): Promise<Set<string>> {
  const norms = new Set<string>();
  for (const key of await listSnapshotKeys(BUFFER_PREFIX)) {
    const buffered = await readSnapshot<BufferedBatch>(key);
    for (const result of buffered?.data.results ?? []) {
      norms.add(normalizeKeyword(result.snapshot.keyword));
    }
  }
  return norms;
}

/** Whether any finished plans are waiting to be flushed. Blobs only, no DB. */
export async function pendingBufferedReports(): Promise<{ batches: number; reports: number }> {
  let batches = 0;
  let reports = 0;
  for (const key of await listSnapshotKeys(BUFFER_PREFIX)) {
    const buffered = await readSnapshot<BufferedBatch>(key);
    const count = buffered?.data.results?.length ?? 0;
    if (count === 0) continue;
    batches++;
    reports += count;
  }
  return { batches, reports };
}

export async function runBpBatch(options: BatchRunOptions): Promise<BatchRunSummary> {
  const summary: BatchRunSummary = {
    generated: 0,
    duplicates: 0,
    failed: 0,
    skipped: 0,
    replayed: 0,
    candidates: 0,
    dbPhaseMs: 0,
    llmPhaseMs: 0,
    degraded: false,
    buffered: false,
    errors: [],
  };

  if (!isLlmConfigured()) {
    summary.errors.push('LLM_NOT_CONFIGURED');
    return summary;
  }

  const batchId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
  const bufferKey = `${BUFFER_PREFIX}${batchId}`;

  // ---- Phase 1: prepare (database in use) --------------------------------
  const prepareStart = Date.now();
  let candidates: { snapshot: BpTrendSnapshot; trendScore: number }[] = [];
  let avoidLine = '';
  let canonicalByModel: Map<string, CanonicalBusinessModel> = new Map();
  try {
    summary.replayed = await replayPendingBatches(batchId);

    const staleReset = await bpService.resetStaleGenerating();
    if (staleReset > 0) console.log(`[bp-batch] reset ${staleReset} stale generating report(s)`);

    const [completed, recentlyFailed] = await Promise.all([
      bpService.getRecentlyCompletedKeywordNorms(),
      bpService.getRecentlyFailedKeywordNorms(),
    ]);
    const skip = new Set<string>([...completed, ...recentlyFailed]);

    const avoidModels = await bpService.getRecentBusinessModels().catch(() => [] as string[]);
    avoidLine = buildAvoidModelsLine(avoidModels);
    canonicalByModel = await bpService.listCanonicalBusinessModels();

    // Anything still queued was harvested while the store was unavailable and is
    // not in the trends snapshot yet, so offer it alongside the snapshot.
    const extraTrends = await pendingTrendsAsTrends();
    candidates = await bpService.pickEligibleTrendCandidates(options.batchSize, skip, '4h', { extraTrends });
    summary.candidates = candidates.length;

    // Keep the DB-free copy current, so the next outage has fresh state to work
    // from. Failing to cache must not fail the run.
    await saveBpDedupeState({
      completedKeywordNorms: completed,
      failedKeywordNorms: recentlyFailed,
      avoidModels,
      canonicalModels: canonicalByModel.values(),
    }).catch(() => false);
  } catch (error) {
    summary.errors.push(`prepare: ${(error as Error).message}`);
    recordError('bp-batch', error, { context: { stage: 'prepare', batchId } });
    const fallback = await prepareFromCache(options.batchSize);
    if (!fallback) {
      summary.dbPhaseMs += Date.now() - prepareStart;
      return summary;
    }
    summary.degraded = true;
    candidates = fallback.candidates;
    summary.candidates = candidates.length;
    avoidLine = fallback.avoidLine;
    canonicalByModel = fallback.canonicalByModel;
    console.log(
      `[bp-batch] degraded prepare: ${candidates.length} candidate(s) from cached state ` +
      `(${Math.round(fallback.cacheAgeMs / 60_000)}min old)`
    );
  }
  summary.dbPhaseMs += Date.now() - prepareStart;

  if (candidates.length === 0) {
    summary.skipped = 1;
    console.log('[bp-batch] no eligible trend; nothing to generate');
    return summary;
  }

  // ---- Phase 2: generate (LLM only, ZERO database access) ----------------
  const llmStart = Date.now();
  const results: BatchResultInput[] = [];
  // Business models produced earlier in THIS batch also count for dedupe, so two
  // candidates in one run can't both create the same canonical plan.
  const pendingModels = new Set<string>();

  for (let i = 0; i < candidates.length; i++) {
    if (Date.now() > options.generateUntil) {
      console.log(`[bp-batch] generate deadline reached after ${i} of ${candidates.length}`);
      break;
    }
    const { snapshot } = candidates[i];
    try {
      const llm = await generateJson<any>({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: buildUserPrompt(snapshot, avoidLine),
        temperature: 0.7,
        maxTokens: 4000,
        deadlineMs: options.llmTimeoutMs,
      });

      const content = validateAndNormalizeBpContent(llm.data);
      const bmNorm = normalizeBusinessModel(content.businessModel);
      const model = llm.provider ? `${llm.provider}/${llm.model}` : llm.model;

      const canonical = bmNorm ? canonicalByModel.get(bmNorm) : undefined;
      if (canonical) {
        // Duplicate business model: record a pointer row instead of storing the
        // content twice, so the trigger keyword still counts as analyzed.
        results.push({
          snapshot,
          status: 'completed',
          title: canonical.title,
          summary: canonical.summary,
          selectedOpportunity: canonical.selectedOpportunity,
          contentJson: null,
          businessModelNorm: bmNorm,
          canonicalReportId: canonical.id,
          model,
          tokensUsed: llm.tokensUsed ?? null,
        });
        summary.duplicates++;
      } else if (bmNorm && pendingModels.has(bmNorm)) {
        // Collides with a plan generated moments ago in this same batch, whose id
        // does not exist yet. Store it as its own canonical plan rather than
        // pointing at an unknown id — the next run's dedupe will catch any repeat.
        results.push(buildCompletedResult(snapshot, content, bmNorm, model, llm.tokensUsed));
        summary.generated++;
      } else {
        if (bmNorm) pendingModels.add(bmNorm);
        results.push(buildCompletedResult(snapshot, content, bmNorm, model, llm.tokensUsed));
        summary.generated++;
      }
      console.log(`[bp-batch] ${i + 1}/${candidates.length} -> "${snapshot.keyword}" ok`);
    } catch (err) {
      const code = err instanceof LlmError ? err.code
        : err instanceof BpValidationError ? 'BP_INVALID'
        : 'GENERATION_FAILED';
      const message = (err as Error).message || '生成失败';
      // Failed attempts are still recorded, so the keyword's failure counter
      // advances and the circuit breaker can eventually skip it.
      results.push({
        snapshot,
        status: 'failed',
        error: `${code}: ${message}`.slice(0, 1000),
      });
      summary.failed++;
      summary.errors.push(`${snapshot.keyword}: ${code}`);
      console.error(`[bp-batch] ${i + 1}/${candidates.length} -> failed: ${code} ${message}`);
      recordError('bp-batch', err, { context: { stage: 'generate', keyword: snapshot.keyword, code } });
      if (code === 'LLM_NOT_CONFIGURED') break;
      // Three consecutive failures usually means every LLM endpoint is down.
      if (trailingFailures(results) >= 3) {
        console.error('[bp-batch] 3 consecutive failures; stopping batch early');
        break;
      }
    }

    // Durability point: this plan survives a crash from here on.
    await writeSnapshot<BufferedBatch>(bufferKey, {
      batchId,
      startedAt: new Date(llmStart).toISOString(),
      results,
    });

    if (i < candidates.length - 1 && options.spacingMs) {
      await new Promise((r) => setTimeout(r, options.spacingMs));
    }
  }
  summary.llmPhaseMs = Date.now() - llmStart;

  // ---- Phase 3: flush (database in use) ----------------------------------
  if (results.length === 0) {
    await deleteSnapshot(bufferKey);
    return summary;
  }
  const flushStart = Date.now();
  try {
    // A degraded run selected against a cached dedupe set; ask the live archive
    // before writing, in case the database came back mid-run.
    const toInsert = summary.degraded ? await dropAlreadyAnalyzed(results) : results;
    const { inserted } = await bpService.insertBatchResults(toInsert);
    console.log(`[bp-batch] flushed ${inserted} report(s) to Postgres`);
    await deleteSnapshot(bufferKey);
  } catch (error) {
    // Buffer stays on disk; the next run replays it. Counters are corrected so
    // the summary doesn't claim reports that aren't in the database.
    summary.errors.push(`flush: ${(error as Error).message}`);
    recordError('bp-batch', error, { context: { stage: 'flush', batchId, pending: results.length } });
    console.error('[bp-batch] flush failed, buffer retained for replay:', (error as Error).message);
    summary.buffered = true;
    summary.generated = 0;
    summary.duplicates = 0;
  }
  summary.dbPhaseMs += Date.now() - flushStart;

  return summary;
}

/**
 * Rebuild the prepare phase's inputs without the database, for use when it is
 * unavailable. Returns null when there is no usable cached state, which is the
 * signal to skip generation rather than guess at what has already been analyzed.
 */
async function prepareFromCache(batchSize: number): Promise<{
  candidates: { snapshot: BpTrendSnapshot; trendScore: number }[];
  avoidLine: string;
  canonicalByModel: Map<string, CanonicalBusinessModel>;
  cacheAgeMs: number;
} | null> {
  const loaded = await loadBpDedupeState();
  if (!loaded) {
    console.error('[bp-batch] no cached dedupe state; cannot generate while the store is down');
    return null;
  }
  if (loaded.stale) {
    const hours = Math.round(loaded.ageMs / 3_600_000);
    console.error(`[bp-batch] cached dedupe state is ${hours}h old; refusing to generate from it`);
    recordError('bp-batch', `dedupe cache too old (${hours}h)`, {
      level: 'warn',
      context: { stage: 'prepare-cache', ageHours: hours },
    });
    return null;
  }

  const { state } = loaded;
  const skip = new Set<string>([
    ...state.completedKeywordNorms,
    ...state.failedKeywordNorms,
    // The cache predates anything an earlier outage run generated, so the buffer
    // is the only record that those keywords are already taken.
    ...(await bufferedKeywordNorms()),
  ]);

  const extraTrends = await pendingTrendsAsTrends();
  const candidates = await bpService.pickEligibleTrendCandidates(batchSize, skip, '4h', {
    extraTrends,
    allowDbScan: false,
  });

  const canonicalByModel = new Map<string, CanonicalBusinessModel>();
  for (const model of state.canonicalModels) {
    if (model?.businessModelNorm) canonicalByModel.set(model.businessModelNorm, model);
  }

  return {
    candidates,
    avoidLine: buildAvoidModelsLine(state.avoidModels),
    canonicalByModel,
    cacheAgeMs: loaded.ageMs,
  };
}

function buildCompletedResult(
  snapshot: BpTrendSnapshot,
  content: ReturnType<typeof validateAndNormalizeBpContent>,
  bmNorm: string,
  model: string,
  tokensUsed?: number
): BatchResultInput {
  return {
    snapshot,
    status: 'completed',
    title: content.title,
    summary: content.summary,
    selectedOpportunity: content.selectedOpportunity,
    contentJson: content,
    businessModelNorm: bmNorm || null,
    canonicalReportId: null,
    model,
    tokensUsed: tokensUsed ?? null,
    opportunities: content.opportunities,
  };
}

/** How many results at the tail of the list are failures. */
export function trailingFailures(results: BatchResultInput[]): number {
  let count = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].status !== 'failed') break;
    count++;
  }
  return count;
}
