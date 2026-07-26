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

const { runBpBatch, replayPendingBatches, trailingFailures } = await import(
  '../../src/lib/services/bpBatchRunner'
);
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
