import { pool } from '../src/lib/db/client';
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

async function seedDatabase() {
  console.log('Starting database seeding...');

  try {
    const client = await pool.connect();
    console.log('Connected to database.');

    // 1. Drop existing table to ensure fresh schema
    console.log('Dropping existing table...');
    await client.query('DROP TABLE IF EXISTS trends_trending_now CASCADE');

    // 2. Create trends_trending_now table
    console.log('Creating table...');
    await client.query(`
      CREATE TABLE trends_trending_now (
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
    
    // Create indices separately to catch errors individually
    await client.query('CREATE INDEX idx_trends_trending_now_timestamp ON trends_trending_now(timestamp)');
    await client.query('CREATE INDEX idx_trends_trending_now_time_range ON trends_trending_now(time_range)');
    await client.query('CREATE INDEX idx_trends_trending_now_category ON trends_trending_now(category)');
    await client.query('CREATE INDEX idx_trends_trending_now_search_volume ON trends_trending_now(search_volume)');

    // 3. Generate Data
    console.log('Generating 2000+ trends...');
    const totalRecords = 2500;
    
    for (let i = 0; i < totalRecords; i++) {
      const keyword = uniqueNamesGenerator({
        dictionaries: [adjectives, colors, animals],
        separator: ' ',
        length: 2,
        style: 'capital'
      });

      const searchVolume = getRandomInt(1000, 10000000);
      const growthRate = parseFloat(getRandomFloat(-50, 500).toFixed(2));
      const category = CATEGORIES[getRandomInt(0, CATEGORIES.length - 1)];
      const timeRange = TIME_RANGES[getRandomInt(0, TIME_RANGES.length - 1)];
      const region = 'US';
      const timestamp = new Date(Date.now() - getRandomInt(0, 48 * 60 * 60 * 1000));

      await client.query(
        `INSERT INTO trends_trending_now (keyword, search_volume, growth_rate, category, time_range, region, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [keyword, searchVolume, growthRate, category, timeRange, region, timestamp]
      );
      
      if ((i + 1) % 100 === 0) {
        console.log(`Generated ${i + 1} records...`);
      }
    }

    console.log('Seeding completed successfully!');
    client.release();
  } catch (error) {
    console.error('Seeding failed:', error);
  } finally {
    process.exit(0);
  }
}

seedDatabase();
