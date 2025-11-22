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

Create a `.env` file in the root directory with the following variables:

```env
# Database Connection String
DATABASE_URL=postgresql://user:password@host:5432/dbname?sslmode=require

# Node Environment
NODE_ENV=development
```

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

## Testing

Run the test suite:

```bash
pnpm test
```

## License

MIT
