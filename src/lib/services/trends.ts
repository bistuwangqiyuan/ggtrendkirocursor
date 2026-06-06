import { query, queryOne, getTrendsTableName, getTimestampColumnName, pool } from '../db/client';
import type { Trend, PaginatedTrends, TrendsStats, TrendsQueryParams, Result, DatabaseError, TimeRange } from '../../types';

/**
 * Different deployments store time_range either as the short form ('4h') or the
 * long form ('past_4_hours'). Match against all known variants so filtering works
 * regardless of which schema the live table uses.
 */
const TIME_RANGE_VARIANTS: Record<string, string[]> = {
  '4h': ['4h', 'past_4_hours'],
  '24h': ['24h', 'past_24_hours'],
  '48h': ['48h', 'past_48_hours'],
  past_4_hours: ['past_4_hours', '4h'],
  past_24_hours: ['past_24_hours', '24h'],
  past_48_hours: ['past_48_hours', '48h'],
};

function timeRangeVariants(tr: string): string[] {
  return TIME_RANGE_VARIANTS[tr] ?? [tr];
}

/**
 * Data collection-time windows: filter rows whose collection timestamp falls
 * within the last N hours of NOW(). This is distinct from `time_range` (the
 * keyword trending window) — it operates on the real timestamp column.
 */
const COLLECTED_WITHIN_HOURS: Record<string, number> = {
  '6h': 6,
  '12h': 12,
  '24h': 24,
  '48h': 48,
};

const SORT_COLUMN_MAP: Record<string, string> = {
  search_volume: 'search_volume',
  growth_rate: 'growth_rate',
  timestamp: 'timestamp',
};

export class TrendsService {
  async getTrends(params: TrendsQueryParams): Promise<Result<PaginatedTrends, DatabaseError>> {
    try {
      const tableName = await getTrendsTableName();
      const timestampCol = await getTimestampColumnName(tableName);
      const {
        timeRange,
        collectedWithin,
        keyword,
        category,
        excludeCategories,
        sortBy = 'search_volume',
        sortOrder = 'desc',
        page = 1,
        pageSize = 20
      } = params;

      let whereClauses: string[] = [];
      let values: any[] = [];
      let paramIndex = 1;

      if (timeRange) {
        whereClauses.push(`time_range = ANY($${paramIndex++})`);
        values.push(timeRangeVariants(timeRange));
      }

      if (collectedWithin && COLLECTED_WITHIN_HOURS[collectedWithin]) {
        const tsRef = timestampCol === 'timestamp' ? '"timestamp"' : 'trend_timestamp';
        whereClauses.push(`${tsRef} >= NOW() - make_interval(hours => $${paramIndex++})`);
        values.push(COLLECTED_WITHIN_HOURS[collectedWithin]);
      }

      if (keyword) {
        whereClauses.push(`keyword ILIKE $${paramIndex++}`);
        values.push(`%${keyword}%`);
      }

      if (category) {
        whereClauses.push(`category = $${paramIndex++}`);
        values.push(category);
      } else if (excludeCategories && excludeCategories.length > 0) {
        whereClauses.push(`category != ALL($${paramIndex++})`);
        values.push(excludeCategories);
      }

      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      
      const countSql = `SELECT COUNT(*) as total FROM "${tableName}" ${whereSql}`;
      const countResult = await queryOne<{ total: string }>(countSql, values);
      const totalItems = parseInt(countResult?.total || '0', 10);
      const totalPages = Math.ceil(totalItems / pageSize);

      const safeSortBy = SORT_COLUMN_MAP[sortBy] || 'search_volume';
      const safeSortOrder = sortOrder === 'asc' ? 'ASC' : 'DESC';
      const orderByCol = safeSortBy === 'timestamp' ? (timestampCol === 'timestamp' ? '"timestamp"' : 'trend_timestamp') : safeSortBy;
      const offset = (page - 1) * pageSize;
      const tsSelect = timestampCol === 'timestamp' ? '"timestamp" as "timestamp"' : 'trend_timestamp as "timestamp"';

      const dataSql = `
        SELECT id, keyword,
               search_volume as "searchVolume",
               growth_rate as "growthRate",
               category,
               time_range as "timeRange",
               region,
               ${tsSelect},
               created_at as "createdAt"
        FROM "${tableName}"
        ${whereSql}
        ORDER BY ${orderByCol} ${safeSortOrder}
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `;

      values.push(pageSize, offset);
      let trends: Trend[];
      try {
        const res = await pool.query(dataSql, values);
        trends = (res.rows as any[]).map((row) => ({
          id: row.id,
          keyword: row.keyword,
          searchVolume: typeof row.searchVolume === 'number' ? row.searchVolume : Number(row.searchVolume) || 0,
          growthRate: typeof row.growthRate === 'number' ? row.growthRate : parseFloat(row.growthRate) || 0,
          category: row.category ?? '',
          timeRange: row.timeRange ?? '',
          region: row.region ?? '',
          timestamp: row.timestamp instanceof Date ? row.timestamp : new Date(row.timestamp),
          createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt ?? 0),
        })) as Trend[];
      } catch (err) {
        console.error('getTrends data query error:', (err as Error).message, 'sql:', dataSql.substring(0, 200));
        throw err;
      }

      return {
        success: true,
        data: {
          trends,
          pagination: { currentPage: page, totalPages, totalItems, pageSize }
        }
      };
    } catch (error) {
      console.error('getTrends error:', error);
      return {
        success: false,
        error: { code: 'QUERY_ERROR', message: 'Failed to fetch trends data' }
      };
    }
  }

  async getCategories(): Promise<Result<string[], DatabaseError>> {
    try {
      const tableName = await getTrendsTableName();
      const sql = `SELECT DISTINCT category FROM "${tableName}" ORDER BY category ASC`;
      const rows = await query<{ category: string }>(sql);
      return {
        success: true,
        data: rows.map(r => r.category)
      };
    } catch (error) {
      console.error('getCategories error:', error);
      return { success: false, error: { code: 'QUERY_ERROR', message: 'Failed to fetch categories' } };
    }
  }

  async getTrendsStats(timeRange: TimeRange): Promise<Result<TrendsStats, DatabaseError>> {
    try {
      const tableName = await getTrendsTableName();
      const variants = timeRangeVariants(timeRange);
      const countSql = `SELECT COUNT(*) as total FROM "${tableName}" WHERE time_range = ANY($1)`;
      const countRes = await queryOne<{ total: string }>(countSql, [variants]);
      const totalTrends = parseInt(countRes?.total || '0', 10);

      const avgSql = `SELECT AVG(growth_rate) as avg_growth FROM "${tableName}" WHERE time_range = ANY($1)`;
      const avgRes = await queryOne<{ avg_growth: string }>(avgSql, [variants]);
      const averageGrowthRate = parseFloat(avgRes?.avg_growth || '0');

      const catSql = `
        SELECT category, COUNT(*) as count 
        FROM "${tableName}" 
        WHERE time_range = ANY($1) 
        GROUP BY category 
        ORDER BY count DESC 
        LIMIT 5
      `;
      const topCategories = await query<{ category: string; count: string }>(catSql, [variants]);

      return {
        success: true,
        data: {
          totalTrends,
          averageGrowthRate,
          topCategories: topCategories.map(c => ({ category: c.category, count: parseInt(c.count, 10) })),
          timeRange
        }
      };
    } catch (error) {
      console.error('getTrendsStats error:', error);
      return { success: false, error: { code: 'QUERY_ERROR', message: 'Failed to fetch stats' } };
    }
  }
}

export const trendsService = new TrendsService();
