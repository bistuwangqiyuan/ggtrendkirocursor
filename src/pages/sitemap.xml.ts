import type { APIRoute } from 'astro';
import { listBpFromSnapshot, listKeywordsForSitemapFromSnapshot } from '../lib/cache/snapshotReaders';
import { computeCacheHeaders, CACHE_PROFILES } from '../lib/cache/httpCache';

export const prerender = false;

/**
 * Dynamic sitemap. Static marketing/legal routes plus the completed BP detail
 * pages and the hotword landing pages (/t/[slug], the SEO traffic-capture
 * surface). Low-value auth pages (/login, /register) are intentionally omitted.
 *
 * Built entirely from snapshots: crawlers fetch this often, and it must not be
 * the one route that keeps waking the Neon compute. Degrades to the static list
 * when a snapshot is missing.
 */

const STATIC_ROUTES: { path: string; changefreq: string; priority: string }[] = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/product', changefreq: 'monthly', priority: '0.9' },
  { path: '/pricing', changefreq: 'monthly', priority: '0.9' },
  { path: '/trends', changefreq: 'hourly', priority: '0.9' },
  { path: '/t', changefreq: 'hourly', priority: '0.9' },
  { path: '/bp', changefreq: 'daily', priority: '0.8' },
  { path: '/faq', changefreq: 'monthly', priority: '0.7' },
  { path: '/about', changefreq: 'monthly', priority: '0.6' },
  { path: '/contact', changefreq: 'monthly', priority: '0.6' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.3' },
  { path: '/terms', changefreq: 'yearly', priority: '0.3' },
];

const MAX_BP_ENTRIES = 500;
const MAX_LANDING_ENTRIES = 500;

export const GET: APIRoute = async () => {
  const origin = 'https://ggtrendkirocursor.netlify.app';

  const entries: string[] = STATIC_ROUTES.map(
    (r) =>
      `  <url>\n    <loc>${origin}${r.path}</loc>\n    <changefreq>${r.changefreq}</changefreq>\n    <priority>${r.priority}</priority>\n  </url>`
  );

  try {
    const bp = await listBpFromSnapshot(1, MAX_BP_ENTRIES, 'createdAt', 'desc', 'completed');
    for (const r of bp.data.reports) {
      const lastmod =
        r.createdAt instanceof Date && !isNaN(r.createdAt.getTime())
          ? r.createdAt.toISOString().slice(0, 10)
          : '';
      entries.push(
        `  <url>\n    <loc>${origin}/bp/${r.id}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>`
      );
    }
  } catch (error) {
    console.error('sitemap: BP entries skipped:', (error as Error).message);
  }

  try {
    const landing = await listKeywordsForSitemapFromSnapshot(MAX_LANDING_ENTRIES);
    for (const l of landing.data) {
      const lastmod =
        l.lastSeen instanceof Date && !isNaN(l.lastSeen.getTime())
          ? l.lastSeen.toISOString().slice(0, 10)
          : '';
      entries.push(
        `  <url>\n    <loc>${origin}/t/${encodeURIComponent(l.slug)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n    <changefreq>daily</changefreq>\n    <priority>0.7</priority>\n  </url>`
      );
    }
  } catch (error) {
    console.error('sitemap: landing entries skipped:', (error as Error).message);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      ...computeCacheHeaders(CACHE_PROFILES.sitemap),
    },
  });
};
