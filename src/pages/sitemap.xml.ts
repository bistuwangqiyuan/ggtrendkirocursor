import type { APIRoute } from 'astro';
import { query } from '../lib/db/client';

export const prerender = false;

/**
 * Dynamic sitemap. Static marketing/legal routes plus the completed BP detail
 * pages (canonical reports only — duplicate pointers add no crawl value).
 * Low-value auth pages (/login, /register) are intentionally omitted.
 * Degrades to the static list if the DB is unavailable.
 */

const STATIC_ROUTES: { path: string; changefreq: string; priority: string }[] = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/product', changefreq: 'monthly', priority: '0.9' },
  { path: '/pricing', changefreq: 'monthly', priority: '0.9' },
  { path: '/trends', changefreq: 'hourly', priority: '0.9' },
  { path: '/bp', changefreq: 'daily', priority: '0.8' },
  { path: '/faq', changefreq: 'monthly', priority: '0.7' },
  { path: '/about', changefreq: 'monthly', priority: '0.6' },
  { path: '/contact', changefreq: 'monthly', priority: '0.6' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.3' },
  { path: '/terms', changefreq: 'yearly', priority: '0.3' },
];

const MAX_BP_ENTRIES = 500;

export const GET: APIRoute = async () => {
  const origin = 'https://ggtrendkirocursor.netlify.app';

  const entries: string[] = STATIC_ROUTES.map(
    (r) =>
      `  <url>\n    <loc>${origin}${r.path}</loc>\n    <changefreq>${r.changefreq}</changefreq>\n    <priority>${r.priority}</priority>\n  </url>`
  );

  try {
    const rows = await query<{ id: string; updated_at: Date }>(
      `SELECT id, updated_at FROM bp_reports
       WHERE status = 'completed' AND canonical_report_id IS NULL
       ORDER BY created_at DESC
       LIMIT $1`,
      [MAX_BP_ENTRIES]
    );
    for (const r of rows) {
      const lastmod =
        r.updated_at instanceof Date ? r.updated_at.toISOString().slice(0, 10) : '';
      entries.push(
        `  <url>\n    <loc>${origin}/bp/${r.id}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>`
      );
    }
  } catch (error) {
    // DB unavailable: serve the static part rather than a 500.
    console.error('sitemap: BP entries skipped:', (error as Error).message);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
