/**
 * URL slugs for hotword landing pages (/t/[slug]).
 *
 * The slug must be deterministically recomputable from the stored keyword so
 * a landing-page lookup can match "slug -> keyword" without a dedicated
 * column: we fetch candidate rows and compare slugifyKeyword(keyword) === slug.
 * Unicode letters/numbers are preserved (Google Trends keywords are mostly
 * ASCII, but titles like "东京奥运" must not collapse to an empty slug).
 */
export function slugifyKeyword(keyword: string): string {
  return keyword
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Convert a slug into a tolerant ILIKE pattern for the candidate-row fetch:
 * every hyphen run could have been any punctuation/whitespace in the original
 * keyword. Escapes ILIKE wildcards that survive slugification (none should,
 * but stay safe).
 */
export function slugToLikePattern(slug: string): string {
  const escaped = slug.replace(/[\\%_]/g, (m) => `\\${m}`);
  return escaped.replace(/-+/g, '%');
}
