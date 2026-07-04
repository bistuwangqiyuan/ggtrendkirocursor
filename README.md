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
- **Scheduled Auto-Generation**: A Netlify Scheduled Function kicks off a background batch (15-min budget, generation runs in-process) every 6 hours. It scans trends **collected within the last 48h**, skips keywords with a completed BP in the last 7 days, circuit-breaks keywords that failed twice in the last 24h, and picks hotwords with a composite score above 60.
- **Verifiable Financials**: Seed-round return metrics are recomputed server-side with declared formulas; deviations get a calibration note. Any report can be independently re-verified with `python scripts/verify_bp_math.py --id <report-id>`.
- **Abuse Protection**: Ops endpoints require an environment secret (`ADMIN_SECRET`), and write endpoints (login/register/feedback/newsletter/BP generation) are rate limited.
- **LLM Auto-Failover**: Configure multiple OpenAI-compatible endpoints; the service switches to the next one automatically on timeout / HTTP / auth errors.
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
| `GET /api/bp/list` | Public | Paginated list of generated BPs |
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

[`netlify/functions/bp-scheduled.ts`](netlify/functions/bp-scheduled.ts) runs every 6 hours (`0 */6 * * *`, UTC) and calls `POST /api/bp/cron` with the `CRON_SECRET`. To enable it in production, set both `CRON_SECRET` and an LLM key (`LLM_API_KEY` or `LLM_API_ENDPOINTS`) in the Netlify dashboard, then redeploy.

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

## License

MIT
