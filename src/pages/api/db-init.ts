import type { APIRoute } from 'astro';
import { pool } from '../../lib/db/client';
import { authorizeAdminRequest } from '../../lib/utils/adminAuth';
import {
  BASE_STATEMENTS,
  RECREATE_STATEMENTS,
  RECREATE_BP_STATEMENTS,
  REQUIRED_COLUMNS,
} from '../../lib/db/schema';

async function inspectColumns(client: any): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of Object.keys(REQUIRED_COLUMNS)) {
    try {
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table]
      );
      out[table] = cols.rows.map((r: any) => r.column_name);
    } catch (e: any) {
      out[table] = [`<error: ${e.message}>`];
    }
  }
  return out;
}

function detectMismatches(before: Record<string, string[]>): Record<string, string[]> {
  const mismatches: Record<string, string[]> = {};
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const have = before[table] ?? [];
    const missing = required.filter((c) => !have.includes(c));
    if (missing.length > 0) mismatches[table] = missing;
  }
  return mismatches;
}

export const POST: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const auth = authorizeAdminRequest(request);
  if (!auth.ok) {
    return new Response(auth.message, { status: auth.status });
  }

  const migrateParam = url.searchParams.get('migrate'); // 'auth' | 'bp' | null

  let client: any;
  try {
    client = await pool.connect();

    const before = await inspectColumns(client);
    const mismatches = detectMismatches(before);

    const statements = migrateParam === 'auth'
      ? RECREATE_STATEMENTS
      : migrateParam === 'bp'
        ? RECREATE_BP_STATEMENTS
        : BASE_STATEMENTS;
    const results: string[] = [];
    for (const stmt of statements) {
      const label = stmt.split('\n').find((l) => l.trim())?.trim().substring(0, 60) ?? '';
      try {
        await client.query(stmt);
        results.push(`OK: ${label}`);
      } catch (e: any) {
        results.push(`SKIP: ${label} -> ${e.message}`);
      }
    }

    const after = await inspectColumns(client);

    return new Response(JSON.stringify({
      success: true,
      mode: migrateParam === 'auth' ? 'recreate-auth' : migrateParam === 'bp' ? 'recreate-bp' : 'idempotent',
      detectedMismatches: mismatches,
      before,
      after,
      details: results,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('DB init error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      detail: error.detail || null,
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  } finally {
    if (client) client.release();
  }
};
