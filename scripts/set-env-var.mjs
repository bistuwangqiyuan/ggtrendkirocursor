// Set a Netlify env var via the API with an exact string value (avoids
// PowerShell quote-stripping that corrupts JSON values passed to `netlify
// env:set`). Usage: node scripts/set-env-var.mjs KEY < value-file
// The value is read from stdin so quoting is never an issue.
import { readFileSync } from 'node:fs';

const key = process.argv[2];
if (!key) {
    console.error('usage: node scripts/set-env-var.mjs KEY < value-file');
    process.exit(2);
}
const value = readFileSync(0, 'utf8').replace(/^\uFEFF/, '').trim();

const cfg = JSON.parse(readFileSync(`${process.env.APPDATA}\\netlify\\Config\\config.json`, 'utf8'));
const token = cfg.users[cfg.userId].auth.token;
const state = JSON.parse(readFileSync('.netlify/state.json', 'utf8'));
const siteId = state.siteId;

// Look up the account slug for the env-vars API.
const siteRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}`, {
    headers: { Authorization: `Bearer ${token}` },
});
const site = await siteRes.json();
const accountSlug = site.account_slug;

const res = await fetch(
    `https://api.netlify.com/api/v1/accounts/${accountSlug}/env/${encodeURIComponent(key)}?site_id=${siteId}`,
    {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, values: [{ context: 'all', value }] }),
    },
);
if (!res.ok) {
    console.error(`FAILED: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
}
console.log(`OK: ${key} set (${value.length} chars)`);
