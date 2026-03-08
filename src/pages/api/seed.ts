import type { APIRoute } from 'astro';
import { pool } from '../../lib/db/client';
import { uniqueNamesGenerator, adjectives, colors, animals } from 'unique-names-generator';

const CATEGORIES = [
  'technology',
  'entertainment',
  'business',
  'health',
  'sports',
  'science',
  'politics',
  'lifestyle'
];

const TIME_RANGES = ['past_4_hours', 'past_24_hours', 'past_48_hours'];

function getRandomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomFloat(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

export const POST: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  if (url.searchParams.get('secret') !== 'trendnow-seed') {
      return new Response('Unauthorized', { status: 401 });
  }

  try {
    const client = await pool.connect();
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS trends_trending_now (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        keyword VARCHAR(255) NOT NULL,
        search_volume BIGINT NOT NULL,
        growth_rate DECIMAL(10, 2),
        category VARCHAR(100),
        time_range VARCHAR(50),
        region VARCHAR(10) DEFAULT 'US',
        timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query('DELETE FROM trends_trending_now');

    const totalRecords = 2500;
    const batchSize = 50;

    for (let batch = 0; batch < totalRecords; batch += batchSize) {
      const count = Math.min(batchSize, totalRecords - batch);
      const values: any[] = [];
      const placeholders: string[] = [];

      for (let i = 0; i < count; i++) {
        const offset = i * 7;
        placeholders.push(`($${offset+1}, $${offset+2}, $${offset+3}, $${offset+4}, $${offset+5}, $${offset+6}, $${offset+7})`);

        values.push(
          uniqueNamesGenerator({ dictionaries: [adjectives, colors, animals], separator: ' ', length: 2, style: 'capital' }),
          getRandomInt(1000, 10000000),
          parseFloat(getRandomFloat(-50, 500).toFixed(2)),
          CATEGORIES[getRandomInt(0, CATEGORIES.length - 1)],
          TIME_RANGES[getRandomInt(0, TIME_RANGES.length - 1)],
          'US',
          new Date(Date.now() - getRandomInt(0, 48 * 60 * 60 * 1000))
        );
      }

      await client.query(
        `INSERT INTO trends_trending_now (keyword, search_volume, growth_rate, category, time_range, region, timestamp)
         VALUES ${placeholders.join(', ')}`,
        values
      );
    }

    client.release();

    return new Response(JSON.stringify({
      success: true,
      message: `Successfully seeded ${totalRecords} trends`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('Seed error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
