import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const query = vi.fn();
const getTrendsTableName = vi.fn(async () => 'google_trends');
const getTimestampColumnName = vi.fn(async () => 'trend_timestamp');

vi.mock('../../src/lib/db/client', () => ({
  query,
  getTrendsTableName,
  getTimestampColumnName,
}));

vi.mock('../../src/lib/observability/errorLog', () => ({
  recordError: vi.fn(),
  pruneOldLogs: vi.fn(async () => [] as string[]),
  retentionDays: vi.fn(() => 30),
}));

const {
  ensureNewsletterTable,
  pruneTrends,
  pruneSiteChecks,
  runMaintenance,
  TRENDS_RETENTION_DEFAULT_DAYS,
  SITE_CHECKS_RETENTION_DEFAULT_DAYS,
} = await import('../../src/lib/services/maintenance');
const { pruneOldLogs } = await import('../../src/lib/observability/errorLog');

/** SQL text of every query() call, whitespace-collapsed for easy matching. */
function sqlCalls(): string[] {
  return query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));
}

/**
 * `query()` resolves to the ROWS, not to a pg result object. Deleting N rows with
 * RETURNING therefore looks like an N-element array — and reading `.rowCount` off
 * it, as this suite used to mock, silently yields undefined. That mismatch is why
 * production reported "0 pruned" on every run while actually deleting thousands.
 */
function rows(count: number): { id: string }[] {
  return Array.from({ length: count }, (_, i) => ({ id: `row-${i}` }));
}

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue(rows(0));
  getTrendsTableName.mockResolvedValue('google_trends');
  getTimestampColumnName.mockResolvedValue('trend_timestamp');
  vi.mocked(pruneOldLogs).mockResolvedValue([]);
  delete process.env.TRENDS_RETENTION_DAYS;
  delete process.env.SITE_CHECKS_RETENTION_DAYS;
});

afterEach(() => {
  delete process.env.TRENDS_RETENTION_DAYS;
  delete process.env.SITE_CHECKS_RETENTION_DAYS;
});

describe('ensureNewsletterTable', () => {
  it('creates the table and index idempotently', async () => {
    await ensureNewsletterTable();
    const sql = sqlCalls();
    expect(sql.some((s) => s.includes('CREATE TABLE IF NOT EXISTS newsletter_subscribers'))).toBe(true);
    expect(sql.some((s) => s.includes('CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_email'))).toBe(true);
  });
});

describe('pruneTrends', () => {
  it('deletes by the trend timestamp, falling back to created_at', async () => {
    query.mockResolvedValue(rows(42));

    const deleted = await pruneTrends(30);

    expect(deleted).toBe(42);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql).replace(/\s+/g, ' ')).toContain(
      'DELETE FROM google_trends WHERE COALESCE(trend_timestamp, created_at)'
    );
    expect(params).toEqual(['30']);
  });

  it('counts deleted rows via RETURNING, not a row count field', async () => {
    // The bug this guards: `.rowCount` on a rows array is undefined, so every
    // prune reported 0 and storage growth looked like a retention failure.
    query.mockResolvedValue(rows(7));
    expect(await pruneTrends(30)).toBe(7);
    expect(String(query.mock.calls[0][0])).toContain('RETURNING');
  });

  it('uses the quoted legacy "timestamp" column when that is the schema', async () => {
    getTimestampColumnName.mockResolvedValue('timestamp');

    await pruneTrends(30);

    expect(String(query.mock.calls[0][0])).toContain('COALESCE("timestamp", created_at)');
  });

  it('reads the retention window from the environment', async () => {
    process.env.TRENDS_RETENTION_DAYS = '7';
    await pruneTrends();
    expect(query.mock.calls[0][1]).toEqual(['7']);
  });

  it('ignores a zero or negative window, which would wipe the table', async () => {
    process.env.TRENDS_RETENTION_DAYS = '0';
    await pruneTrends();
    expect(query.mock.calls[0][1]).toEqual([String(TRENDS_RETENTION_DEFAULT_DAYS)]);

    query.mockClear();
    process.env.TRENDS_RETENTION_DAYS = '-5';
    await pruneTrends();
    expect(query.mock.calls[0][1]).toEqual([String(TRENDS_RETENTION_DEFAULT_DAYS)]);
  });

  it('ignores a non-numeric window', async () => {
    process.env.TRENDS_RETENTION_DAYS = 'forever';
    await pruneTrends();
    expect(query.mock.calls[0][1]).toEqual([String(TRENDS_RETENTION_DEFAULT_DAYS)]);
  });
});

describe('pruneSiteChecks', () => {
  it('always keeps the newest check per site', async () => {
    query.mockResolvedValue(rows(5));

    const deleted = await pruneSiteChecks(90);

    expect(deleted).toBe(5);
    const sql = String(query.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain('DELETE FROM site_checks');
    // Without this guard, a long-quiet site would lose its status on /monitor.
    expect(sql).toContain('ORDER BY checked_at DESC LIMIT 1');
    expect(query.mock.calls[0][1]).toEqual(['90']);
  });

  it('defaults to the documented 90-day window', async () => {
    await pruneSiteChecks();
    expect(query.mock.calls[0][1]).toEqual([String(SITE_CHECKS_RETENTION_DEFAULT_DAYS)]);
  });
});

describe('runMaintenance', () => {
  it('reports what each step did', async () => {
    query.mockResolvedValue(rows(3));
    vi.mocked(pruneOldLogs).mockResolvedValue(['2026-06-01', '2026-06-02']);

    const result = await runMaintenance();

    expect(result.newsletterTableEnsured).toBe(true);
    expect(result.trendsDeleted).toBe(3);
    expect(result.siteChecksDeleted).toBe(3);
    expect(result.opsAlertsDeleted).toBe(3);
    expect(result.logsDeleted).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it('creates the durable incident table, which older databases lack', async () => {
    await runMaintenance();
    expect(sqlCalls().some((s) => s.includes('CREATE TABLE IF NOT EXISTS ops_alerts'))).toBe(true);
  });

  it('isolates a failing step so the rest still run', async () => {
    // First call is the newsletter CREATE EXTENSION; fail it and nothing else.
    query.mockRejectedValueOnce(new Error('permission denied for schema public'));
    query.mockResolvedValue(rows(1));

    const result = await runMaintenance();

    expect(result.newsletterTableEnsured).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('newsletter');
    expect(result.trendsDeleted).toBe(1);
    expect(result.siteChecksDeleted).toBe(1);
  });

  it('never throws, even when every database step fails', async () => {
    query.mockRejectedValue(new Error('connection terminated unexpectedly'));
    vi.mocked(pruneOldLogs).mockRejectedValue(new Error('blobs unavailable'));

    const result = await runMaintenance();

    // newsletter, ops-alerts, orders, trends, site-checks, error-log,
    // ops-alert-retention. Additive migrations swallow per-statement failures by
    // design, and the intake queue lives in Blobs rather than Postgres.
    expect(result.errors).toHaveLength(7);
    expect(result.trendsDeleted).toBe(0);
  });
});
