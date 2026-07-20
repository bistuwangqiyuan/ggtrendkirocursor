import { describe, it, expect } from 'vitest';
import {
  analyzeSeoHtml,
  computeSeoScore,
  validateSiteUrl,
  SEO_CHECK_KEYS,
  type SeoChecks,
} from '../../src/lib/services/siteMonitor';

const FULL_SEO_HTML = `<!doctype html>
<html lang="en">
<head>
  <title>My Fine Site</title>
  <meta name="description" content="A meaningful description over ten chars." />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="canonical" href="https://example.com/" />
  <meta property="og:title" content="My Fine Site" />
  <script type="application/ld+json">{"@context":"https://schema.org"}</script>
</head>
<body><h1>Hello</h1></body>
</html>`;

describe('analyzeSeoHtml', () => {
  it('detects all on-page signals in a well-formed page', () => {
    const r = analyzeSeoHtml(FULL_SEO_HTML);
    expect(r).toEqual({
      title: true,
      metaDescription: true,
      canonical: true,
      viewport: true,
      h1: true,
      og: true,
      jsonLd: true,
    });
  });

  it('reports everything missing on an empty page', () => {
    const r = analyzeSeoHtml('<html><body>hi</body></html>');
    expect(Object.values(r).every((v) => v === false)).toBe(true);
  });

  it('rejects an empty title and a too-short description', () => {
    const html = '<title></title><meta name="description" content="short" />';
    const r = analyzeSeoHtml(html);
    expect(r.title).toBe(false);
    expect(r.metaDescription).toBe(false);
  });

  it('detects description with attributes in reversed order', () => {
    const html = '<meta content="a nice long description here" name="description">';
    expect(analyzeSeoHtml(html).metaDescription).toBe(true);
  });
});

describe('computeSeoScore', () => {
  const allTrue = Object.fromEntries(SEO_CHECK_KEYS.map((k) => [k, true])) as SeoChecks;
  const allFalse = Object.fromEntries(SEO_CHECK_KEYS.map((k) => [k, false])) as SeoChecks;

  it('is 100 when all checks pass and 0 when none do', () => {
    expect(computeSeoScore(allTrue)).toBe(100);
    expect(computeSeoScore(allFalse)).toBe(0);
  });

  it('scales linearly with passed checks', () => {
    const half = { ...allFalse, https: true, title: true, metaDescription: true, canonical: true, viewport: true };
    expect(computeSeoScore(half)).toBe(50);
  });
});

describe('validateSiteUrl', () => {
  it('accepts a normal https URL and normalizes to origin', () => {
    const r = validateSiteUrl('https://myapp.vercel.app/');
    expect(r).toEqual({ ok: true, url: 'https://myapp.vercel.app' });
  });

  it('keeps a non-root path', () => {
    const r = validateSiteUrl('https://example.com/app');
    expect(r).toEqual({ ok: true, url: 'https://example.com/app' });
  });

  it('rejects non-http protocols', () => {
    expect(validateSiteUrl('ftp://example.com').ok).toBe(false);
    expect(validateSiteUrl('javascript:alert(1)').ok).toBe(false);
  });

  it('rejects malformed URLs and bare hostnames without a dot', () => {
    expect(validateSiteUrl('not a url').ok).toBe(false);
    expect(validateSiteUrl('https://intranet-host').ok).toBe(false);
  });

  it('allows localhost as a dev target', () => {
    expect(validateSiteUrl('http://localhost:4321').ok).toBe(true);
  });
});
