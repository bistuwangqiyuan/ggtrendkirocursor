import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  const dbUrl = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
  return new Response(JSON.stringify({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      hasDbUrl: !!dbUrl,
      dbUrlLength: dbUrl?.length,
      nodeEnv: process.env.NODE_ENV
    }
  }), { status: 200 });
};

