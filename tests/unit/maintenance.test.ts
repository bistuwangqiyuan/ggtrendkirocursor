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
  pruneOldLogs: vi.fn(async () => 0),
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

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rowCount: 0, rows: [] });
  getTrendsTableName.mockResolvedValue('google_trends');
  getTimestampColumnName.mockResolvedValue('trend_timestamp');
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
    query.mockResolvedValue({ rowCount: 42, rows: [] });

    const deleted = await pruneTrends(30);

    expect(deleted).toBe(42);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql).replace(/\s+/g, ' ')).toContain(
      'DELETE FROM google_trends WHERE COALESCE(trend_timestamp, created_at)'
    );
    expect(params).toEqual(['30']);
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
    query.mockResolvedValue({ rowCount: 5, rows: [] });

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
    query.mockResolvedValue({ rowCount: 3, rows: [] });
    vi.mocked(pruneOldLogs).mockResolvedValue(2);

    const result = await runMaintenance();

    expect(result.newsletterTableEnsured).toBe(true);
    expect(result.trendsDeleted).toBe(3);
    expect(result.siteChecksDeleted).toBe(3);
    expect(result.logsDeleted).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it('isolates a failing step so the rest still run', async () => {
    // First call is the newsletter CREATE EXTENSION; fail it and nothing else.
    query.mockRejectedValueOnce(new Error('permission denied for schema public'));
    query.mockResolvedValue({ rowCount: 1, rows: [] });

    const result = await runMaintenance();

    expect(result.newsletterTableEnsured).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('newsletter');
    expect(result.trendsDeleted).toBe(1);
    expect(result.siteChecksDeleted).toBe(1);
  });

  it('never throws, even when every step fails', async () => {
    query.mockRejectedValue(new Error('connection terminated unexpectedly'));
    vi.mocked(pruneOldLogs).mockRejectedValue(new Error('blobs unavailable'));

    const result = await runMaintenance();

    expect(result.errors).toHaveLength(4);
    expect(result.trendsDeleted).toBe(0);
  });
});
