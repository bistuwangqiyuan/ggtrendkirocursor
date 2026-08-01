/**
 * Which of the two deployments this instance is.
 *
 * The site runs on two Netlify accounts so that one account's exhausted build
 * credits or a platform incident cannot take the product offline. Both accounts
 * deploy the same code against the same Neon database, which makes the write
 * pipeline the dangerous part: two copies of the three-hourly batch would wake
 * Neon twice as often and spend LLM tokens twice for the same hotwords. The
 * dedupe logic would discard the duplicate reports afterwards, but the money and
 * the compute time would already be gone.
 *
 * So exactly one deployment writes. The other serves pages from its own Blobs
 * snapshots and takes payments, which needs no cron at all.
 *
 * Reads and payments are unaffected by the role: every deployment must be able
 * to serve a page and sell a download, or failover would be pointless.
 */

export type SiteRole = 'writer' | 'reader';

/**
 * Defaults to `writer` when unset, so the existing single-site deployment keeps
 * collecting trends if the variable is ever lost. A missing variable silencing
 * the pipeline would be the more expensive mistake: nothing would complain until
 * someone noticed the reports had stopped.
 */
export function siteRole(): SiteRole {
  return process.env.SITE_ROLE?.trim().toLowerCase() === 'reader' ? 'reader' : 'writer';
}

export function isWriter(): boolean {
  return siteRole() === 'writer';
}
