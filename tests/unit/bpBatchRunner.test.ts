import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// bp.ts and llm.ts are mocked so the runner can be exercised without a database
// or a real LLM. The snapshot layer is NOT mocked: the write-behind buffer is the
// crash-safety mechanism under test, so it runs against the real fs backend.
const generateJson = vi.fn();
const isLlmConfigured = vi.fn(() => true);

const bpServiceMock = {
  resetStaleGenerating: vi.fn(async () => 0),
  getRecentlyCompletedKeywordNorms: vi.fn(async () => new Set<string>()),
  getRecentlyFailedKeywordNorms: vi.fn(async () => new Set<string>()),
  getCompletedKeywordNormsAmong: vi.fn(async () => new Set<string>()),
  pickEligibleTrendCandidates: vi.fn(async () => [] as any[]),
  getRecentBusinessModels: vi.fn(async () => [] as string[]),
  listCanonicalBusinessModels: vi.fn(async () => new Map()),
  insertBatchResults: vi.fn(async (items: any[]) => ({ inserted: items.length, reports: [] })),
};

vi.mock('../../src/lib/services/llm', async () => {
  const actual = await vi.importActual<any>('../../src/lib/services/llm');
  return { ...actual, generateJson, isLlmConfigured };
});

vi.mock('../../src/lib/services/bp', async () => {
  const actual = await vi.importActual<any>('../../src/lib/services/bp');
  return { ...actual, bpService: bpServiceMock };
});

const {
  runBpBatch,
  replayPendingBatches,
  trailingFailures,
  bufferedKeywordNorms,
  pendingBufferedReports,
} = await import('../../src/lib/services/bpBatchRunner');
const { listSnapshotKeys, readSnapshot, writeSnapshot, resetSnapshotStore } = await import(
  '../../src/lib/cache/snapshot'
);

let dir: string;

/** Minimal LLM payload that survives validateAndNormalizeBpContent. */
function validBpPayload(businessModel: string) {
  const opportunities = Array.from({ length: 5 }, (_, i) => ({
    name: `机会${i + 1}`,
    description: `具体描述 ${i + 1}`,
    scores: { market: 8 - i * 0.1, roi: 8, onlineability: 9, feasibility: 7, speed: 7, moat: 6 },
  }));
  return {
    title: '标题',
    summary: '摘要',
    selectedOpportunity: '机会1',
    businessModel,
    opportunities,
    seedReturn: {
      annualizedBook: '80%',
      winRate: '15%',
      profitLossRatio: '3:1',
      expectedValueMOIC: '2.1x',
      riskAdjustedAnnualized: '40%',
      bookRoiByYear: [1, 2, 3, 4, 5],
    },
  };
}

function candidate(keyword: string) {
  return {
    trendScore: 90,
    snapshot: {
      sourceTrendId: `t-${keyword}`,
      keyword,
      searchVolume: 1000,
      growthRate: 50,
      category: 'trending',
      timeRange: '4h',
      region: 'US',
      rank: 1,
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'batch-test-'));
  process.env.SNAPSHOT_BACKEND = 'fs';
  process.env.SNAPSHOT_DIR = dir;
  resetSnapshotStore();
  vi.clearAllMocks();
  isLlmConfigured.mockReturnValue(true);
  bpServiceMock.resetStaleGenerating.mockResolvedValue(0);
  bpServiceMock.getRecentlyCompletedKeywordNorms.mockResolvedValue(new Set());
  bpServiceMock.getRecentlyFailedKeywordNorms.mockResolvedValue(new Set());
  bpServiceMock.getCompletedKeywordNormsAmong.mockResolvedValue(new Set());
  bpServiceMock.getRecentBusinessModels.mockResolvedValue([]);
  bpServiceMock.listCanonicalBusinessModels.mockResolvedValue(new Map());
  bpServiceMock.insertBatchResults.mockImplementation(async (items: any[]) => ({
    inserted: items.length,
    reports: [],
  }));
});

afterEach(async () => {
  delete process.env.SNAPSHOT_BACKEND;
  delete process.env.SNAPSHOT_DIR;
  resetSnapshotStore();
  await rm(dir, { recursive: true, force: true });
});

const options = { batchSize: 2, generateUntil: Date.now() + 60_000 };

describe('runBpBatch phases', () => {
  it('generates every candidate and flushes once, leaving no buffer behind', async () => {
    bpServiceMock.pickEligibleTrendCandidates.mockResolvedValue([
      candidate('alpha'),
      candidate('beta'),
    ]);
    generateJson
      .mockResolvedValueOnce({ data: validBpPayload('模式A'), model: 'm', provider: 'p', tokensUsed: 10 })
      .mockResolvedValueOnce({ data: validBpPayload('模式B'), model: 'm', provider: 'p', tokensUsed: 20 });

    const summary = await runBpBatch(options);

    expect(summary.generated).toBe(2);
    expect(summary.failed).toBe(0);
    // The whole point of the refactor: exactly one write round-trip per batch.
    expect(bpServiceMock.insertBatchResults).toHaveBeenCalledTimes(1);
    expect(bpServiceMock.insertBatchResults.mock.calls[0][0]).toHaveLength(2);
    expect(await listSnapshotKeys('bp/pending/')).toHaveLength(0);
  });

  it('does not touch the database between LLM calls', async () => {
    bpServiceMock.pickEligibleTrendCandidates.mockResolvedValue([
      candidate('alpha'),
      candidate('beta'),
    ]);
    let dbCallsDuringLlm = 0;
    generateJson.mockImplementation(async () => {
      dbCallsDuringLlm +=
        bpServiceMock.pickEligibleTrendCandidates.mock.calls.length - 1 +
        bpServiceMock.insertBatchResults.mock.calls.length +
        bpServiceMock.listCanonicalBusinessModels.mock.calls.length - 1;
      return { data: validBpPayload(`模式${Math.random()}`), model: 'm' };
    });

    await runBpBatch(options);
    expect(dbCallsDuringLlm).toBe(0);
  });

  it('records a duplicate business model as a pointer to the canonical report', async () => {
    bpServiceMock.pickEligibleTrendCandidates.mockResolvedValue([candidate('alpha')]);
    bpServiceMock.listCanonicalBusinessModels.mockResolvedValue(
      new Map([
        [
          '模式a',
          { id: 'canon-1', businessModelNorm: '模式a', title: '原标题', summary: '原摘要', selectedOpportunity: '原机会' },
        ],
      ])
    );
    generateJson.mockResolvedValue({ data: validBpPayload('模式A'), model: 'm' });

    const summary = await runBpBatch(options);

    expect(summary.duplicates).toBe(1);
    expect(summary.generated).toBe(0);
    const inserted = bpServiceMock.insertBatchResults.mock.calls[0][0][0];
    expect(inserted.canonicalReportId).toBe('canon-1');
    expect(inserted.contentJson).toBeNull();
    expect(inserted.title).toBe('原标题');
  });

  it('stores a failed row so the keyword failure counter advances', async () => {
    bpServiceMock.pickEligibleTrendCandidates.mockResolvedValue([candidate('alpha')]);
    generateJson.mockRejectedValue(new Error('upstream exploded'));

    const summary = await runBpBatch(options);

    expect(summary.failed).toBe(1);
    const inserted = bpServiceMock.insertBatchResults.mock.calls[0][0][0];
    expect(inserted.status).toBe('failed');
    expect(inserted.error).toContain('upstream exploded');
  });

  it('stops starting generations once the deadline has passed', async () => {
    bpServiceMock.pickEligibleTrendCandidates.mockResolvedValue([
      candidate('alpha'),
      candidate('beta'),
      candidate('gamma'),
    ]);
    generateJson.mockResolvedValue({ data: validBpPayload('模式X'), model: 'm' });

    const summary = await runBpBatch({ batchSize: 3, generateUntil: Date.now() - 1 });

    expect(generateJson).not.toHaveBeenCalled();
    expect(summary.generated).toBe(0);
    expect(bpServiceMock.insertBatchResults).not.toHaveBeenCalled();
  });

  it('skips the run and never calls the LLM when no candidate is eligible', async () => {
    bpServiceMock.pickEligibleTrendCandidates.mockResolvedValue([]);

    const summary = await runBpBatch(options);

    expect(summary.skipped).toBe(1);
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('reports LLM_NOT_CONFIGURED without opening a wake window', async () => {
    isLlmConfigured.mockReturnValue(false);

    const summary = await runBpBatch(options);

    expect(summary.errors).toContain('LLM_NOT_CONFIGURED');
    expect(bpServiceMock.resetStaleGenerating).not.toHaveBeenCalled();
  });
});

describe('write-behind buffer', () => {
  it('keeps the buffer when the flush fails, and reports nothing as generated', async () => {
    bpServiceMock.pickEligibleTrendCandidates.mockResolvedValue([candidate('alpha')]);
    generateJson.mockResolvedValue({ data: validBpPayload('模式A'), model: 'm' });
    bpServiceMock.insertBatchResults.mockRejectedValue(new Error('connection terminated'));

    const summary = await runBpBatch(options);

    // Counters must not claim reports that never reached Postgres.
    expect(summary.generated).toBe(0);
    expect(summary.errors.some((e) => e.startsWith('flush:'))).toBe(true);
    const buffers = await listSnapshotKeys('bp/pending/');
    expect(buffers).toHaveLength(1);
    const buffered = await readSnapshot<any>(buffers[0]);
    expect(buffered?.data.results).toHaveLength(1);
  });

  it('replays a buffer left by a crashed run, then deletes it', async () => {
    await writeSnapshot('bp/pending/crashed-run', {
      batchId: 'crashed-run',
      startedAt: new Date().toISOString(),
      results: [{ snapshot: candidate('orphan').snapshot, status: 'completed', title: 't' }],
    });

    const replayed = await replayPendingBatches();

    expect(replayed).toBe(1);
    expect(bpServiceMock.insertBatchResults).toHaveBeenCalledTimes(1);
    expect(await listSnapshotKeys('bp/pending/')).toHaveLength(0);
  });

  it('retains the buffer when the replay insert fails, so nothing is lost', async () => {
    await writeSnapshot('bp/pending/crashed-run', {
      batchId: 'crashed-run',
      startedAt: new Date().toISOString(),
      results: [{ snapshot: candidate('orphan').snapshot, status: 'completed', title: 't' }],
    });
    bpServiceMock.insertBatchResults.mockRejectedValue(new Error('db down'));

    const replayed = await replayPendingBatches();

    expect(replayed).toBe(0);
    expect(await listSnapshotKeys('bp/pending/')).toHaveLength(1);
  });

  it('discards an empty buffer rather than replaying it forever', async () => {
    await writeSnapshot('bp/pending/empty-run', {
      batchId: 'empty-run',
      startedAt: new Date().toISOString(),
      results: [],
    });

    const replayed = await replayPendingBatches();

    expect(replayed).toBe(0);
    expect(bpServiceMock.insertBatchResults).not.toHaveBeenCalled();
    expect(await listSnapshotKeys('bp/pending/')).toHaveLength(0);
  });

  it('replays an older buffer at the start of a new batch', async () => {
    await writeSnapshot('bp/pending/older-run', {
      batchId: 'older-run',
      startedAt: new Date().toISOString(),
      results: [{ snapshot: candidate('orphan').snapshot, status: 'completed', title: 't' }],
    });
    bpServiceMock.pickEligibleTrendCandidates.mockResolvedValue([]);

    const summary = await runBpBatch(options);

    expect(summary.replayed).toBe(1);
  });
});

/** Populate the DB-free dedupe cache the degraded path reads. */
async function seedDedupeCache(
  overrides: Partial<{
    capturedAt: string;
    completedKeywordNorms: string[];
    failedKeywordNorms: string[];
    avoidModels: string[];
    canonicalModels: any[];
  }> = {}
) {
  await writeSnapshot('bp/dedupe-state', {
    capturedAt: new Date().toISOString(),
    completedKeywordNorms: [],
    failedKeywordNorms: [],
    avoidModels: [],
    canonicalModels: [],
    ...overrides,
  });
}

/** Make the prepare phase fail the way a quota-exhausted Neon does. */
function breakDatabase() {
  bpServiceMock.resetStaleGenerating.mockRejectedValue(new Error('DB unavailable (circuit breaker open)'));
  bpServiceMock.insertBatchResults.mockRejectedValue(new Error('DB unavailable (circuit breaker open)'));
}

describe('generating through a database outage', () => {
  it('plans from the cached dedupe state and buffers the result', async () => {
    await seedDedupeCache();
    breakDatabase();
    bpServiceMock.pickEligibleTrendCandidates.mockResolvedValue([candidate('gamma')]);
    generateJson.mockResolvedValue({ data: validBpPayload('模式G'), model: 'm' });

    const summary = await runBpBatch(options);

    expect(summary.degraded).toBe(true);
    expect(summary.buffered).toBe(true);
    // The LLM ran and its output survived, which is the whole point.
    expect(generateJson).toHaveBeenCalledTimes(1);
    const buffers = await listSnapshotKeys('bp/pending/');
    expect(buffers).toHaveLength(1);
    expect((await readSnapshot<any>(buffers[0]))?.data.results).toHaveLength(1);
    // No database scan may be attempted while it is known to be down.
    expect(bpServiceMock.pickEligibleTrendCandidates.mock.calls[0][3]).toMatchObject({ allowDbScan: false });
  });

  it('does not guess at what is already analyzed when no cache exists', async () => {
    breakDatabase();
    bpServiceMock.pickEligibleTrendCandidates.mockResolvedValue([candidate('gamma')]);

    const summary = await runBpBatch(options);

    expect(summary.degraded).toBe(false);
    expect(summary.generated).toBe(0);
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('refuses a cache that has missed too many days of writes', async () => {
    await seedDedupeCache({ capturedAt: new Date(Date.now() - 100 * 3_600_000).toISOString() });
    breakDatabase();
    bpServiceMock.pickEligibleTrendCandidates.mockResolvedValue([candidate('gamma')]);

    const summary = await runBpBatch(options);

    expect(summary.degraded).toBe(false);
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('skips keywords a previous outage run already buffered', async () => {
    await seedDedupeCache({ completedKeywordNorms: ['history'] });
    await writeSnapshot('bp/pending/earlier-outage-run', {
      batchId: 'earlier-outage-run',
      startedAt: new Date().toISOString(),
      results: [{ snapshot: candidate('Alpha').snapshot, status: 'completed', title: 't' }],
    });
    breakDatabase();
    bpServiceMock.pickEligibleTrendCandidates.mockResolvedValue([]);

    await runBpBatch(options);

    const skip: Set<string> = bpServiceMock.pickEligibleTrendCandidates.mock.calls[0][1];
    // Without this the same hotword would be re-analyzed in every outage window.
    expect(skip.has('alpha')).toBe(true);
    expect(skip.has('history')).toBe(true);
  });

  it('re-checks the live archive before flushing cache-planned work', async () => {
    await seedDedupeCache();
    // Prepare fails, then the database comes back before the flush — so the
    // cached dedupe decision has to be re-validated.
    bpServiceMock.resetStaleGenerating.mockRejectedValue(new Error('DB unavailable'));
    bpServiceMock.pickEligibleTrendCandidates.mockResolvedValue([candidate('gamma')]);
    generateJson.mockResolvedValue({ data: validBpPayload('模式G'), model: 'm' });
    bpServiceMock.getCompletedKeywordNormsAmong.mockResolvedValue(new Set(['gamma']));

    await runBpBatch(options);

    expect(bpServiceMock.insertBatchResults.mock.calls[0][0]).toEqual([]);
  });

  it('caches the dedupe state on a healthy run, for the next outage', async () => {
    bpServiceMock.getRecentlyCompletedKeywordNorms.mockResolvedValue(new Set(['done']));
    bpServiceMock.getRecentBusinessModels.mockResolvedValue(['模式旧']);
    bpServiceMock.pickEligibleTrendCandidates.mockResolvedValue([]);

    await runBpBatch(options);

    const cached = await readSnapshot<any>('bp/dedupe-state');
    expect(cached?.data.completedKeywordNorms).toEqual(['done']);
    expect(cached?.data.avoidModels).toEqual(['模式旧']);
  });
});

describe('buffer inspection (used by the recovery job)', () => {
  it('reports buffered keywords and counts without touching the database', async () => {
    await writeSnapshot('bp/pending/run-a', {
      batchId: 'run-a',
      startedAt: new Date().toISOString(),
      results: [
        { snapshot: candidate('Alpha One').snapshot, status: 'completed', title: 't' },
        { snapshot: candidate('beta').snapshot, status: 'failed', error: 'e' },
      ],
    });

    expect([...(await bufferedKeywordNorms())].sort()).toEqual(['alpha one', 'beta']);
    expect(await pendingBufferedReports()).toEqual({ batches: 1, reports: 2 });
  });

  it('ignores empty buffers when reporting a backlog', async () => {
    await writeSnapshot('bp/pending/run-empty', {
      batchId: 'run-empty',
      startedAt: new Date().toISOString(),
      results: [],
    });

    expect(await pendingBufferedReports()).toEqual({ batches: 0, reports: 0 });
  });
});

describe('replay dedupe guard', () => {
  it('drops a buffered plan whose keyword was analyzed in the meantime', async () => {
    await writeSnapshot('bp/pending/stale-run', {
      batchId: 'stale-run',
      startedAt: new Date().toISOString(),
      results: [{ snapshot: candidate('orphan').snapshot, status: 'completed', title: 't' }],
    });
    bpServiceMock.getCompletedKeywordNormsAmong.mockResolvedValue(new Set(['orphan']));

    await replayPendingBatches();

    expect(bpServiceMock.insertBatchResults.mock.calls[0][0]).toEqual([]);
    // The buffer is still cleared: its work is accounted for either way.
    expect(await listSnapshotKeys('bp/pending/')).toHaveLength(0);
  });

  it('still writes failed placeholders, which carry the failure counter', async () => {
    await writeSnapshot('bp/pending/stale-run', {
      batchId: 'stale-run',
      startedAt: new Date().toISOString(),
      results: [
        { snapshot: candidate('orphan').snapshot, status: 'completed', title: 't' },
        { snapshot: candidate('orphan').snapshot, status: 'failed', error: 'boom' },
      ],
    });
    bpServiceMock.getCompletedKeywordNormsAmong.mockResolvedValue(new Set(['orphan']));

    await replayPendingBatches();

    const inserted = bpServiceMock.insertBatchResults.mock.calls[0][0];
    expect(inserted).toHaveLength(1);
    expect(inserted[0].status).toBe('failed');
  });
});

describe('trailingFailures', () => {
  it('counts only the failures at the tail', () => {
    const f = { status: 'failed' } as any;
    const c = { status: 'completed' } as any;
    expect(trailingFailures([])).toBe(0);
    expect(trailingFailures([c, c])).toBe(0);
    expect(trailingFailures([f, c, f, f])).toBe(2);
    expect(trailingFailures([f, f, f])).toBe(3);
  });
});
