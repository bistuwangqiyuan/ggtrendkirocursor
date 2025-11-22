export interface User {
  id: string;
  username: string;
  email: string;
  locale: 'zh' | 'en';
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
}

export interface Session {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
  ipAddress?: string;
  userAgent?: string;
}

export interface Trend {
  id: string;
  keyword: string;
  searchVolume: number;
  growthRate: number;
  category: string;
  timeRange: 'past_4_hours' | 'past_24_hours' | 'past_48_hours';
  region: string;
  timestamp: Date;
  createdAt: Date;
}

export interface Feedback {
  id: string;
  userId?: string;
  name: string;
  email: string;
  subject: string;
  message: string;
  status: 'pending' | 'reviewed' | 'resolved';
  createdAt: Date;
}

export interface PaginatedTrends {
  trends: Trend[];
  pagination: {
    currentPage: number;
    totalPages: number;
    totalItems: number;
    pageSize: number;
  };
}

export interface TrendsStats {
  totalTrends: number;
  topCategories: Array<{ category: string; count: number }>;
  averageGrowthRate: number;
  timeRange: string;
}

export type TimeRange = 'past_4_hours' | 'past_24_hours' | 'past_48_hours';

export type Result<T, E = Error> = { success: true; data: T } | { success: false; error: E };

export interface AuthError {
  code: 'INVALID_CREDENTIALS' | 'USER_EXISTS' | 'INVALID_TOKEN' | 'SESSION_EXPIRED';
  message: string;
  field?: string;
}

export interface DatabaseError {
  code: 'CONNECTION_ERROR' | 'QUERY_ERROR' | 'NOT_FOUND';
  message: string;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface TrendsQueryParams {
  timeRange: 'past_4_hours' | 'past_24_hours' | 'past_48_hours';
  keyword?: string;
  category?: string;
  excludeCategories?: string[];
  sortBy?: 'search_volume' | 'growth_rate' | 'timestamp';
  sortOrder?: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export interface FeedbackInput {
  name: string;
  email: string;
  subject: string;
  message: string;
  userId?: string;
}

