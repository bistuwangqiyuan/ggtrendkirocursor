# Trend Now

Trend Now is a real-time Google Trends data visualization platform built with Astro, React, and Netlify. It provides marketers and analysts with instant access to US search trends, featuring advanced filtering, multi-language support, and a modern responsive interface.

## Features

- **Real-time Trends**: View the latest Google Trends data (past 4h, 24h, 48h).
- **Advanced Filtering**: Filter by time range, category, and keyword search.
- **User System**: Secure registration and login (bcrypt hashing, session cookies).
- **Internationalization**: Full support for English and Chinese (switchable).
- **Responsive Design**: Optimized for Mobile, Tablet, and Desktop.
- **SEO Optimized**: Server-Side Rendering (SSR), semantic HTML, and structured data.
- **Feedback System**: Integrated user feedback submission.
- **AI Business Plans**: Turn the #1 trending keyword into a structured, investor-grade business plan via an LLM (opportunity brainstorm -> six-dimension scoring -> selection -> BP), persisted to the database and viewable on-site at `/bp`.
- **Scheduled Auto-Generation**: A Netlify Scheduled Function kicks off a background batch (15-min budget, generation runs in-process) every 3 hours (8 runs x 5 BPs = up to 40 hotwords analyzed per day). It scans trends **collected within the last 48h**, skips keywords that already have a completed BP anywhere in history (all-history dedupe: each hotword is analyzed at most once), circuit-breaks keywords that failed twice in the last 24h, and picks hotwords with a composite score above 60.
- **Verifiable Financials**: Seed-round return metrics are recomputed server-side with declared formulas; deviations get a calibration note. Any report can be independently re-verified with `python scripts/verify_bp_math.py --id <report-id>`.
- **Abuse Protection**: Ops endpoints require an environment secret (`ADMIN_SECRET`), and write endpoints (login/register/feedback/newsletter/BP generation) are rate limited.
- **LLM Auto-Failover**: Configure multiple OpenAI-compatible endpoints; the service switches to the next one automatically on timeout / HTTP / auth errors.
- **Hotword SEO Landing Pages**: Every collected trending keyword gets a dedicated landing page at `/t/[slug]` (search stats, trending history, FAQ + Breadcrumb JSON-LD) that captures organic search traffic for the keyword and funnels visitors to the AI business-plan report and registration. All landing pages are listed in the sitemap; `/t` is the browsable index.
- **Site Monitoring**: Uptime + SEO health monitoring for your own deployed sites (Vercel/Netlify/any domain). Register sites via `POST /api/monitor/sites` (admin secret), a scheduled function probes each site every 6h (HTTP status, latency, title/description/canonical/viewport/H1/OG/JSON-LD/robots.txt/sitemap checks, 0–100 SEO score), and the `/monitor` dashboard shows the latest state per site.
- **Performance**: Low latency, partial hydration with Astro Islands.

## Tech Stack

- **Framework**: [Astro 5](https://astro.build) (SSR Mode)
- **UI Library**: [React 19](https://react.dev)
- **Styling**: [Tailwind CSS 4](https://tailwindcss.com)
- **Database**: PostgreSQL (Neon via Netlify)
- **Authentication**: Custom Session-based Auth with `bcryptjs`
- **Testing**: Vitest, Fast-Check (Property-based testing)
- **Deployment**: Netlify (Edge Functions & Serverless)

## Prerequisites

- Node.js v18.20.8+
- PostgreSQL Database (Neon recommended)

## Environment Variables

Create a `.env` file in the root directory with the following variables (see [`.env.example`](.env.example) for the full template):

```env
# Database Connection String
DATABASE_URL=postgresql://user:password@host:5432/dbname?sslmode=require

# Node Environment
NODE_ENV=development

# --- AI Business Plan (BP) feature ---

# Option A: single OpenAI-compatible endpoint
LLM_API_KEY=sk-xxxx
LLM_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1   # default if unset
LLM_MODEL=qwen-plus                                              # default if unset

# Option B: multiple endpoints with auto-failover (takes precedence over Option A)
# On failure (timeout / HTTP 4xx-5xx / auth), the next endpoint is tried automatically.
# LLM_API_ENDPOINTS=[{"name":"dashscope","base":"https://dashscope.aliyuncs.com/compatible-mode/v1","key":"sk-xxx","model":"qwen-plus"},{"name":"openai","base":"https://api.openai.com/v1","key":"sk-yyy","model":"gpt-4o-mini"}]

LLM_TIMEOUT_MS=45000

# Secret that authorizes scheduled BP generation (POST /api/bp/cron).
# Use a long random value. Required for the every-6h scheduled function to run.
CRON_SECRET=your-long-random-secret

# Secret for the destructive ops endpoints (/api/db-init, /api/seed).
# Falls back to CRON_SECRET when unset; with neither set the endpoints are
# disabled (fail closed, 503).
ADMIN_SECRET=your-admin-secret
```

Notes:
- Without `LLM_API_KEY` (or `LLM_API_ENDPOINTS`), the BP generation endpoints fail closed with HTTP 503 and never fall back to templates.
- Without `CRON_SECRET`, `POST /api/bp/cron` returns 503 and the scheduled function is effectively disabled (fail-closed).

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd trend-now
   ```

2. Install dependencies (using pnpm):
   ```bash
   pnpm install
   ```

3. Initialize Database:
   Run the SQL script in `scripts/init-db.sql` against your PostgreSQL database to create the required tables.

4. Start Development Server:
   ```bash
   pnpm run dev
   ```

## Deployment

This project is designed to be deployed on Netlify.

1. Link your project to Netlify:
   ```bash
   netlify link
   ```

2. Set Environment Variables in Netlify Dashboard.

3. Deploy:
   ```bash
   pnpm run build
   netlify deploy --prod
   ```

## AI Business Plan (BP) Feature

The BP feature converts the #1 trending keyword into a structured business plan. Spec docs live in [`.kiro/specs/hotword-to-bp/`](.kiro/specs/hotword-to-bp/).

### Endpoints

| Method / Path | Auth | Purpose |
| --- | --- | --- |
| `POST /api/bp/generate` | Logged-in user | Generate a BP for a keyword / the top trend |
| `POST /api/bp/cron` | `Authorization: Bearer ${CRON_SECRET}` | Scheduled trigger (no user session) |
| `GET /api/bp/list` | Public | Paginated list of generated BPs (`page`, `pageSize`/`limit`, `sort`, `order`, `status`) |
| `GET /api/bp/[id]` | Public | A single BP report + opportunities |

On-site pages: `/bp` (list) and `/bp/[id]` (detail, with generating-state polling).

### Database provisioning (one-time, after deploy)

The BP feature needs the `bp_reports` and `bp_opportunities` tables. They are created idempotently by the init endpoint.

The ops endpoints (`/api/db-init`, `/api/seed`) are guarded by the `ADMIN_SECRET` environment variable (falling back to `CRON_SECRET`); set it in the Netlify dashboard. With neither configured the endpoints are disabled (fail closed, 503).

```bash
# Create tables if missing (idempotent)
curl -X POST "https://<your-site>/api/db-init?secret=$ADMIN_SECRET" -H "Origin: https://<your-site>"

# If a legacy/incompatible bp_opportunities schema exists, rebuild both tables (DESTRUCTIVE):
curl -X POST "https://<your-site>/api/db-init?secret=$ADMIN_SECRET&migrate=bp" -H "Origin: https://<your-site>"
```

### Scheduled auto-generation

[`netlify/functions/bp-scheduled.ts`](netlify/functions/bp-scheduled.ts) runs every 3 hours (`0 */3 * * *`, UTC) and triggers the `bp-batch-background` function (batch size `BP_BATCH_SIZE`, default 5) with the `CRON_SECRET`, for up to 40 BPs per day. To enable it in production, set both `CRON_SECRET` and an LLM key (`LLM_API_KEY` or `LLM_API_ENDPOINTS`) in the Netlify dashboard, then redeploy.

`bp-batch-background` is the site's only database write window. In one invocation it collects trends, generates the BP batch, probes the monitored sites, applies data retention, and rebuilds the read snapshots. The separate `trends-collector` and `site-monitor` schedules were folded into it because Neon's free plan bills compute *time* — each extra schedule woke the database and left a 5-minute idle timer behind it.

### Read path and Neon compute budget

Pages and read-only APIs never query Postgres. Scheduled jobs write JSON snapshots to Netlify Blobs (`src/lib/cache/`), pages read those, and Netlify's CDN caches the result (`src/lib/cache/httpCache.ts`). `ALLOW_DB_READ_FALLBACK` (default `false`) controls whether a missing snapshot may fall back to a query; leaving it off is what keeps crawler traffic from pinning the compute awake.

```bash
# Reproducible budget model: CU-hours before vs. after, with a sensitivity table
python scripts/neon-budget.py

# Hard proof of the above: boots the app against an unroutable DATABASE_URL and
# asserts every read-only route still returns 200 with correct content
npm run test:outage

# Snapshot freshness (public, DB-free), and DB wake-up attribution (admin)
curl https://<your-site>/api/snapshots/status
curl -H "Authorization: Bearer $ADMIN_SECRET" "https://<your-site>/api/admin/errors?date=$(date -u +%F)"
```

Snapshots are rebuilt incrementally against a manifest, so the scheduled job only rewrites what changed. Filling an empty store is a different job — thousands of landing pages and hundreds of reports exceed one function's time budget, so `/api/snapshots/rebuild` stops at its deadline and reports which sections were `truncated`. `scripts/snapshot-bootstrap.mjs` drives it until nothing is left over; use it after a first deploy, after switching `DATABASE_URL`, or if the store is ever wiped:

```bash
BASE_URL=https://<your-site> CRON_SECRET=<secret> node scripts/snapshot-bootstrap.mjs
```

### Neon project isolation (one-time)

The 100 CU-hour allowance and the 0.5 GB storage cap are both per *project*, and this project also hosts a sibling application. `scripts/neon-audit.mjs` measures the split without writing anything:

```bash
AUDIT_DATABASE_URL=<url> npx tsx scripts/neon-audit.mjs
```

On 2026-07-26 it reported the sibling holding 53.9 MB of 61.0 MB (88% of stored data) and writing to 7 of its tables within the last 7 days — including writes minutes apart during a working session. Since Neon bills compute *time* and suspends only after 5 idle minutes, those writes keep the shared compute awake no matter what this site does, which is why savings here cannot be attributed or even guaranteed while the project is shared.

The audit also flags foreign keys that cross the boundary. Two do: `subscriptions.user_id` and `opportunity_pushes.user_id` both point at `users`, and the sibling has added its own auth columns to that table (`encrypted_password`, `avatar_url`, `full_name`, `last_sign_in_at`). **`users` is therefore co-owned.** Migrating forks it: each side keeps a full copy and they stop converging. That is acceptable here only because the two apps already authenticate independently — this app uses `password_hash` plus the `sessions` table, the sibling uses its own columns and never touches `sessions` — but it is a deliberate decision, not a detail.

`scripts/neon-migrate.mjs` copies only the nine tables this site owns into a new project, using the shared schema in `src/lib/db/schema.ts`. It never modifies the source and is safe to re-run.

```bash
SOURCE_DATABASE_URL=<old> npx tsx scripts/neon-migrate.mjs --dry-run   # counts + schema drift
SOURCE_DATABASE_URL=<old> TARGET_DATABASE_URL=<new> npx tsx scripts/neon-migrate.mjs
SOURCE_DATABASE_URL=<old> TARGET_DATABASE_URL=<new> npx tsx scripts/neon-migrate.mjs --verify
```

The dry run prints a schema-drift report: columns the live table has but this app's schema does not (they are **not** copied) and columns this app needs but the source lacks. Check it before migrating — that is where the co-owned `users` and `feedback` columns show up.

Verification compares row counts *and* a per-table content fingerprint (row hashes sorted, then folded), so a value mangled in transit fails the run instead of passing on matching counts. Values move as text with explicit casts on arrival, because letting the driver decode them loses data: node-postgres turns `timestamptz` into a JS `Date`, whose millisecond resolution silently truncates Postgres microseconds.

Before switching production over, point a local server at the new database and check the app can actually read what was copied:

```bash
DATABASE_URL=<new> ADMIN_SECRET=<secret> npx astro dev --port 4399
BASE_URL=http://localhost:4399 ADMIN_SECRET=<secret> npm run test:migrated
```

That rebuilds every snapshot from the new database and asserts each read route renders real content (not the "data pending" placeholder). Then set `DATABASE_URL` on this site in the Netlify dashboard, redeploy, `POST /api/db-init?secret=$ADMIN_SECRET` to confirm the schema, run `scripts/snapshot-bootstrap.mjs`, and keep the old project as a rollback path for a few days. `DATABASE_URL` takes precedence over `NETLIFY_DATABASE_URL` (see `src/lib/db/client.ts`), and setting it at *site* scope leaves the team-wide `NETLIFY_DATABASE_URL` — and therefore the sibling app — untouched.

Provision the new project in the Neon console, not through `netlify database`. They are different products: Neon's own free plan gives 100 CU-hours per project on a compute that autoscales down to 0.25 CU (≈400 awake hours/month), while Netlify Database's free tier allows 48 compute units per billing period on a minimum of 1 CU (≈48 awake hours/month) — below this site's ~76 hours/month of scheduled write windows.

You can verify the schedule under Netlify -> Functions -> `bp-scheduled`, or trigger it manually:

```bash
curl -X POST "https://<your-site>/api/bp/cron" \
  -H "Authorization: Bearer $CRON_SECRET" -H "Origin: https://<your-site>"
# -> { "success": true, "action": "generated" | "skipped", "reportId": "...", "keyword": "...", "trendScore": 72, "rank": 3 }
```

## Testing

Unit tests (Vitest):

```bash
pnpm test
```

Live end-to-end smoke test against a deployment (defaults to the production URL):

```bash
# Basic run (BP cron generation probes are skipped without the secret)
node tests/e2e/live-smoke.mjs

# Full run including authenticated cron generation (R-BP7/8/9)
BASE_URL=https://<your-site> E2E_CRON_SECRET=<same-as-CRON_SECRET> node tests/e2e/live-smoke.mjs
```

The smoke test exits non-zero only on `FAIL`; checks blocked by external dependencies (DB quota, missing secrets) are reported as `BLOCKED` and do not fail the run. A human-readable report is written to `tests/e2e/last-run.md`.

DB-outage drill (local, no credentials needed) — starts the app with an unroutable `DATABASE_URL` and fixture snapshots, then asserts all read-only routes serve correct content:

```bash
npm run test:outage
```

## License

MIT
