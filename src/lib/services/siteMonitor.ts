import { query, queryOne } from '../db/client';

/**
 * Website uptime + SEO health monitor.
 *
 * Watches the user's own deployed sites (Vercel/Netlify/etc. — any URL with a
 * domain): a scheduled function fetches each site's homepage, robots.txt and
 * sitemap.xml, extracts on-page SEO signals, and stores a check record. The
 * /monitor dashboard renders the latest state per site.
 *
 * Sites are registered through the admin API (POST /api/monitor/sites) since
 * hosting-provider account APIs are not available to this app.
 */

export interface MonitoredSite {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: Date;
}

/** One boolean per SEO signal the checker inspects on the homepage/host. */
export interface SeoChecks {
  https: boolean;
  title: boolean;
  metaDescription: boolean;
  canonical: boolean;
  viewport: boolean;
  h1: boolean;
  og: boolean;
  jsonLd: boolean;
  robotsTxt: boolean;
  sitemap: boolean;
}

export interface SiteCheckResult {
  siteId: string;
  ok: boolean;
  httpStatus: number;
  responseMs: number;
  seoScore: number;
  seoChecks: SeoChecks;
  error: string | null;
}

export interface SiteWithLatestCheck extends MonitoredSite {
  lastCheck: (Omit<SiteCheckResult, 'siteId'> & { checkedAt: Date }) | null;
}

export const SEO_CHECK_KEYS: (keyof SeoChecks)[] = [
  'https', 'title', 'metaDescription', 'canonical', 'viewport',
  'h1', 'og', 'jsonLd', 'robotsTxt', 'sitemap',
];

/**
 * Pure HTML analysis, unit-testable. Signals mirror what search engines
 * actually require for indexing and rich results.
 */
export function analyzeSeoHtml(html: string): Omit<SeoChecks, 'https' | 'robotsTxt' | 'sitemap'> {
  return {
    title: /<title[^>]*>[^<]{3,}<\/title>/i.test(html),
    metaDescription: /<meta[^>]+name=["']description["'][^>]*content=["'][^"']{10,}/i.test(html)
      || /<meta[^>]+content=["'][^"']{10,}["'][^>]*name=["']description["']/i.test(html),
    canonical: /<link[^>]+rel=["']canonical["']/i.test(html),
    viewport: /<meta[^>]+name=["']viewport["']/i.test(html),
    h1: /<h1[\s>]/i.test(html),
    og: /property=["']og:title["']/i.test(html) || /property=["']og:description["']/i.test(html),
    jsonLd: /application\/ld\+json/i.test(html),
  };
}

/** Score = passed checks / total checks, 0–100. */
export function computeSeoScore(checks: SeoChecks): number {
  const passed = SEO_CHECK_KEYS.filter((k) => checks[k]).length;
  return Math.round((passed / SEO_CHECK_KEYS.length) * 100);
}

/** Only allow http(s) URLs with a hostname; anything else is rejected on registration. */
export function validateSiteUrl(raw: string): { ok: true; url: string } | { ok: false; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, message: 'Invalid URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, message: 'URL must be http(s)' };
  }
  // Real deployments have dotted domains; `localhost` is allowed so the whole
  // register->probe->dashboard loop can be exercised against a dev server.
  if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') {
    return { ok: false, message: 'URL must have a real domain' };
  }
  return { ok: true, url: parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname) };
}

const FETCH_TIMEOUT_MS = 12_000;

async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'TrendNow-SiteMonitor/1.0 (+https://ggtrendkirocursor.netlify.app)' },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe one site: homepage (status, latency, on-page SEO), then robots.txt and
 * sitemap.xml on the same origin. Network failures produce ok=false with the
 * error message rather than throwing.
 */
export async function probeSite(url: string): Promise<Omit<SiteCheckResult, 'siteId'>> {
  const emptyChecks: SeoChecks = {
    https: url.startsWith('https:'),
    title: false, metaDescription: false, canonical: false, viewport: false,
    h1: false, og: false, jsonLd: false, robotsTxt: false, sitemap: false,
  };

  const started = Date.now();
  let res: Response;
  let html = '';
  try {
    res = await fetchWithTimeout(url);
    html = await res.text();
  } catch (e) {
    return {
      ok: false,
      httpStatus: 0,
      responseMs: Date.now() - started,
      seoScore: 0,
      seoChecks: emptyChecks,
      error: (e as Error).message,
    };
  }
  const responseMs = Date.now() - started;

  const onPage = analyzeSeoHtml(html);

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = url;
  }

  let robotsTxt = false;
  let sitemap = false;
  try {
    const r = await fetchWithTimeout(`${origin}/robots.txt`, 8000);
    robotsTxt = r.status === 200;
  } catch { /* down counts as missing */ }
  try {
    const s = await fetchWithTimeout(`${origin}/sitemap.xml`, 8000);
    sitemap = s.status === 200;
  } catch { /* down counts as missing */ }

  const seoChecks: SeoChecks = { ...emptyChecks, ...onPage, robotsTxt, sitemap };
  return {
    ok: res.status >= 200 && res.status < 400,
    httpStatus: res.status,
    responseMs,
    seoScore: computeSeoScore(seoChecks),
    seoChecks,
    error: res.status >= 400 ? `HTTP ${res.status}` : null,
  };
}

export class SiteMonitorService {
  async listSites(): Promise<MonitoredSite[]> {
    const rows = await query<any>(
      `SELECT id, name, url, enabled, created_at FROM monitored_sites ORDER BY created_at ASC`
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      enabled: !!r.enabled,
      createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    }));
  }

  async addSite(name: string, url: string): Promise<MonitoredSite> {
    const row = await queryOne<any>(
      `INSERT INTO monitored_sites (name, url)
       VALUES ($1, $2)
       ON CONFLICT (url) DO UPDATE SET name = EXCLUDED.name, enabled = true
       RETURNING id, name, url, enabled, created_at`,
      [name, url]
    );
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      enabled: !!row.enabled,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    };
  }

  async removeSite(id: string): Promise<boolean> {
    const rows = await query<{ id: string }>(
      `DELETE FROM monitored_sites WHERE id = $1 RETURNING id`,
      [id]
    );
    return rows.length > 0;
  }

  /** Run a probe for every enabled site and persist the results. */
  async runChecks(): Promise<SiteCheckResult[]> {
    const sites = (await this.listSites()).filter((s) => s.enabled);
    const results: SiteCheckResult[] = [];
    for (const site of sites) {
      const probe = await probeSite(site.url);
      const result: SiteCheckResult = { siteId: site.id, ...probe };
      await query(
        `INSERT INTO site_checks (site_id, ok, http_status, response_ms, seo_score, seo_checks, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          result.siteId, result.ok, result.httpStatus, result.responseMs,
          result.seoScore, JSON.stringify(result.seoChecks), result.error,
        ]
      );
      results.push(result);
    }
    return results;
  }

  /** Sites joined with their most recent check, for the dashboard. */
  async listSitesWithLatestCheck(): Promise<SiteWithLatestCheck[]> {
    const rows = await query<any>(
      `SELECT s.id, s.name, s.url, s.enabled, s.created_at,
              c.ok, c.http_status, c.response_ms, c.seo_score, c.seo_checks, c.error, c.checked_at
       FROM monitored_sites s
       LEFT JOIN LATERAL (
         SELECT * FROM site_checks
         WHERE site_id = s.id
         ORDER BY checked_at DESC
         LIMIT 1
       ) c ON true
       ORDER BY s.created_at ASC`
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      enabled: !!r.enabled,
      createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
      lastCheck: r.checked_at
        ? {
            ok: !!r.ok,
            httpStatus: Number(r.http_status) || 0,
            responseMs: Number(r.response_ms) || 0,
            seoScore: Number(r.seo_score) || 0,
            seoChecks: typeof r.seo_checks === 'string' ? JSON.parse(r.seo_checks) : (r.seo_checks ?? {}),
            error: r.error ?? null,
            checkedAt: r.checked_at instanceof Date ? r.checked_at : new Date(r.checked_at),
          }
        : null,
    }));
  }
}

export const siteMonitorService = new SiteMonitorService();
