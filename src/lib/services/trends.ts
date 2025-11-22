import { query, queryOne } from '../db/client';
import type { Trend, PaginatedTrends, TrendsStats, TrendsQueryParams, Result, DatabaseError, TimeRange } from '../../types';

export class TrendsService {
  async getTrends(params: TrendsQueryParams): Promise<Result<PaginatedTrends, DatabaseError>> {
    try {
      const {
        timeRange,
        keyword,
        category,
        excludeCategories = ['sports', 'entertainment'],
        sortBy = 'search_volume',
        sortOrder = 'desc',
        page = 1,
        pageSize = 20
      } = params;

      let whereClauses: string[] = [];
      let values: any[] = [];
      let paramIndex = 1;

      // Time range filter
      whereClauses.push(`time_range = $${paramIndex++}`);
      values.push(timeRange);

      // Keyword filter
      if (keyword) {
        whereClauses.push(`keyword ILIKE $${paramIndex++}`);
        values.push(`%${keyword}%`);
      }

      // Category filter
      if (category) {
        whereClauses.push(`category = $${paramIndex++}`);
        values.push(category);
      } else if (excludeCategories && excludeCategories.length > 0) {
        // Exclude categories
        whereClauses.push(`category != ALL($${paramIndex++})`);
        values.push(excludeCategories);
      }

      // Construct query
      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      
      // Count query
      const countSql = `SELECT COUNT(*) as total FROM trends_trending_now ${whereSql}`;
      const countResult = await queryOne<{ total: string }>(countSql, values);
      const totalItems = parseInt(countResult?.total || '0', 10);
      const totalPages = Math.ceil(totalItems / pageSize);

      // Data query
      // Validate sort column to prevent SQL injection
      const validSortColumns = ['search_volume', 'growth_rate', 'timestamp'];
      const safeSortBy = validSortColumns.includes(sortBy) ? sortBy : 'search_volume';
      const safeSortOrder = sortOrder === 'asc' ? 'ASC' : 'DESC';

      const offset = (page - 1) * pageSize;
      
      const dataSql = `
        SELECT id, keyword, search_volume as "searchVolume", growth_rate as "growthRate", category, time_range as "timeRange", region, timestamp, created_at as "createdAt"
        FROM trends_trending_now
        ${whereSql}
        ORDER BY ${safeSortBy} ${safeSortOrder}
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `;
      
      values.push(pageSize, offset);

      const trends = await query<Trend>(dataSql, values);

      return {
        success: true,
        data: {
          trends,
          pagination: {
            currentPage: page,
            totalPages,
            totalItems,
            pageSize
          }
        }
      };

    } catch (error) {
      console.error('getTrends error:', error);
      return {
        success: false,
        error: {
          code: 'QUERY_ERROR',
          message: 'Failed to fetch trends data'
        }
      };
    }
  }

  async getCategories(): Promise<Result<string[], DatabaseError>> {
    try {
      const sql = `SELECT DISTINCT category FROM trends_trending_now ORDER BY category ASC`;
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
      // Total trends count
      const countSql = `SELECT COUNT(*) as total FROM trends_trending_now WHERE time_range = $1`;
      const countRes = await queryOne<{ total: string }>(countSql, [timeRange]);
      const totalTrends = parseInt(countRes?.total || '0', 10);

      // Avg growth rate
      const avgSql = `SELECT AVG(growth_rate) as avg_growth FROM trends_trending_now WHERE time_range = $1`;
      const avgRes = await queryOne<{ avg_growth: string }>(avgSql, [timeRange]);
      const averageGrowthRate = parseFloat(avgRes?.avg_growth || '0');

      // Top categories
      const catSql = `
        SELECT category, COUNT(*) as count 
        FROM trends_trending_now 
        WHERE time_range = $1 
        GROUP BY category 
        ORDER BY count DESC 
        LIMIT 5
      `;
      const topCategories = await query<{ category: string; count: string }>(catSql, [timeRange]);

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
