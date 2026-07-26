/**
 * Day-partitioned error log and database wake-up meter, stored in Netlify Blobs.
 *
 * TWO HARD RULES, both non-negotiable:
 *
 * 1. Never touch Postgres. Errors are most numerous exactly when the database is
 *    unavailable; writing them to the database would fail, trip the circuit
 *    breaker, and turn one incident into a cascade. Blobs also cost no Neon
 *    compute, so logging can't work against the quota it exists to protect.
 *
 * 2. Never throw. A logger that raises turns a handled error into a 500. Every
 *    entry point here swallows its own failures.
 *
 * Writes are buffered per request and flushed as one blob per day-partition, so
 * a page that logs three errors performs one write, not three.
 */
import { deleteSnapshot, listSnapshotKeys, readSnapshot, writeSnapshot } from '../cache/snapshot';

export type ErrorLevel = 'error' | 'warn' | 'info';

export interface ErrorEntry {
  at: string;
  level: ErrorLevel;
  /** Logical source, e.g. 'read-path', 'bp-batch', 'db'. */
  source: string;
  message: string;
  /** Request path when known. */
  route?: string;
  /** Small structured context; large values are truncated. */
  context?: Record<string, string | number | boolean | null>;
}

/** A wake-up event: one moment a request/job caused the DB compute to be used. */
export interface WakeEvent {
  at: string;
  /** 'cron' | 'page' | 'api' | 'auth' | 'unknown' — see dbContext.ts */
  reason: string;
  route?: string;
  durationMs?: number;
}

interface DayLog {
  entries: ErrorEntry[];
  wakes: WakeEvent[];
}

const EMPTY_DAY: DayLog = { entries: [], wakes: [] };

/** Cap per day so a runaway loop can't grow the blob without bound. */
const MAX_ENTRIES_PER_DAY = 2000;
const MAX_WAKES_PER_DAY = 5000;
const MAX_MESSAGE_LENGTH = 1000;

function dayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function logKey(day: string): string {
  return `errors/${day}`;
}

/** Buffered writes, flushed together. Keyed by day so a midnight rollover is safe. */
const buffer = new Map<string, DayLog>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function bufferFor(day: string): DayLog {
  let existing = buffer.get(day);
  if (!existing) {
    existing = { entries: [], wakes: [] };
    buffer.set(day, existing);
  }
  return existing;
}

/**
 * Schedule a flush shortly after the current turn. Serverless functions can be
 * frozen right after responding, so callers on a critical path should also await
 * flushErrorLog() explicitly.
 */
function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flushErrorLog();
  }, 50);
  // Don't hold the process open just for a log flush.
  (flushTimer as any).unref?.();
}

function truncate(value: string): string {
  return value.length > MAX_MESSAGE_LENGTH ? `${value.slice(0, MAX_MESSAGE_LENGTH)}…` : value;
}

/** Record an error. Safe to call from anywhere, including a DB failure handler. */
export function recordError(
  source: string,
  error: unknown,
  options: { level?: ErrorLevel; route?: string; context?: ErrorEntry['context'] } = {}
): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const entry: ErrorEntry = {
      at: new Date().toISOString(),
      level: options.level ?? 'error',
      source,
      message: truncate(message),
      route: options.route,
      context: options.context,
    };
    const day = bufferFor(dayKey());
    if (day.entries.length < MAX_ENTRIES_PER_DAY) day.entries.push(entry);
    scheduleFlush();
  } catch {
    // A logger must never be the thing that fails.
  }
}

/**
 * Record that the database compute was used. This is the objective evidence for
 * the optimisation: after the migration, the count of wake events whose reason is
 * a page read should be zero.
 */
export function recordDbWake(reason: string, options: { route?: string; durationMs?: number } = {}): void {
  try {
    const day = bufferFor(dayKey());
    if (day.wakes.length < MAX_WAKES_PER_DAY) {
      day.wakes.push({
        at: new Date().toISOString(),
        reason,
        route: options.route,
        durationMs: options.durationMs,
      });
    }
    scheduleFlush();
  } catch {
    // Metering must never break the request it measures.
  }
}

/** Merge buffered entries into their day blobs. Never throws. */
export async function flushErrorLog(): Promise<void> {
  if (buffer.size === 0) return;
  const pending = [...buffer.entries()];
  buffer.clear();
  for (const [day, pendingDay] of pending) {
    if (pendingDay.entries.length === 0 && pendingDay.wakes.length === 0) continue;
    try {
      const existing = (await readSnapshot<DayLog>(logKey(day)))?.data ?? EMPTY_DAY;
      const merged: DayLog = {
        entries: [...existing.entries, ...pendingDay.entries].slice(-MAX_ENTRIES_PER_DAY),
        wakes: [...(existing.wakes ?? []), ...pendingDay.wakes].slice(-MAX_WAKES_PER_DAY),
      };
      await writeSnapshot<DayLog>(logKey(day), merged);
    } catch (error) {
      // Put nothing back: retrying forever would grow memory during an outage.
      console.error('[errorLog] flush failed for', day, (error as Error).message);
    }
  }
}

export interface DayLogQuery {
  level?: ErrorLevel;
  source?: string;
  route?: string;
  limit?: number;
}

export interface DayLogResult {
  date: string;
  entries: ErrorEntry[];
  totalEntries: number;
  wakes: WakeEvent[];
  /** Wake counts grouped by reason — the headline metric. */
  wakesByReason: Record<string, number>;
  /** Entry counts grouped by level. */
  entriesByLevel: Record<string, number>;
}

/** Read one day's log, with optional filtering. Never throws. */
export async function readDayLog(date: string, filter: DayLogQuery = {}): Promise<DayLogResult> {
  // Flush first so entries from the current request are visible to an operator
  // reading the log in the same deployment.
  await flushErrorLog();
  const day = (await readSnapshot<DayLog>(logKey(date)))?.data ?? EMPTY_DAY;
  const all = day.entries ?? [];

  let entries = all;
  if (filter.level) entries = entries.filter((e) => e.level === filter.level);
  if (filter.source) entries = entries.filter((e) => e.source === filter.source);
  if (filter.route) entries = entries.filter((e) => e.route === filter.route);

  const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, MAX_ENTRIES_PER_DAY) : 200;
  // Newest first: an operator wants the latest failure, not the oldest.
  const sorted = [...entries].sort((a, b) => b.at.localeCompare(a.at));

  const wakes = day.wakes ?? [];
  const wakesByReason: Record<string, number> = {};
  for (const w of wakes) wakesByReason[w.reason] = (wakesByReason[w.reason] ?? 0) + 1;
  const entriesByLevel: Record<string, number> = {};
  for (const e of all) entriesByLevel[e.level] = (entriesByLevel[e.level] ?? 0) + 1;

  return {
    date,
    entries: sorted.slice(0, limit),
    totalEntries: entries.length,
    wakes,
    wakesByReason,
    entriesByLevel,
  };
}

/** Dates that have a log, newest first. */
export async function listLogDates(): Promise<string[]> {
  const keys = await listSnapshotKeys('errors/');
  return keys
    .map((k) => k.slice('errors/'.length))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => b.localeCompare(a));
}

export function retentionDays(): number {
  const raw = Number(process.env.ERROR_LOG_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30;
}

/** Delete logs older than the retention window. Returns the deleted dates. */
export async function pruneOldLogs(now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - retentionDays() * 86_400_000);
  const cutoffDay = dayKey(cutoff);
  const deleted: string[] = [];
  for (const date of await listLogDates()) {
    if (date < cutoffDay) {
      if (await deleteSnapshot(logKey(date))) deleted.push(date);
    }
  }
  return deleted;
}

/** For tests. */
export function resetErrorLogBuffer(): void {
  buffer.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
}
