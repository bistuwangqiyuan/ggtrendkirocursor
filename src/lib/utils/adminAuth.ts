/**
 * Authorization for destructive ops endpoints (/api/db-init, /api/seed).
 *
 * These endpoints can DROP/recreate tables and overwrite trends data, so they
 * are guarded by a secret from the environment (ADMIN_SECRET, falling back to
 * CRON_SECRET) instead of the old hard-coded literal that was published in the
 * repository. Fail-closed: with neither variable configured the endpoints are
 * disabled entirely (503).
 */

export interface AdminAuthResult {
  ok: boolean;
  /** 503 when no secret is configured, 401 on mismatch, 200 when ok. */
  status: number;
  message: string;
}

/** Pure check, unit-testable: compare a provided secret against configured ones. */
export function checkAdminSecret(
  provided: string | null | undefined,
  adminSecret: string | undefined,
  cronSecret: string | undefined
): AdminAuthResult {
  const configured = [adminSecret?.trim(), cronSecret?.trim()].filter(
    (s): s is string => !!s && s.length > 0
  );
  if (configured.length === 0) {
    return {
      ok: false,
      status: 503,
      message: 'Admin endpoints disabled: set ADMIN_SECRET (or CRON_SECRET) in the environment',
    };
  }
  const p = (provided || '').trim();
  if (!p || !configured.includes(p)) {
    return { ok: false, status: 401, message: 'Unauthorized' };
  }
  return { ok: true, status: 200, message: 'ok' };
}

/**
 * Extract the secret from a request (query `?secret=` or `Authorization: Bearer`)
 * and validate it against the environment.
 */
export function authorizeAdminRequest(request: Request): AdminAuthResult {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get('secret');
  const fromHeader = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const provided = fromQuery || fromHeader;
  return checkAdminSecret(provided, process.env.ADMIN_SECRET, process.env.CRON_SECRET);
}
