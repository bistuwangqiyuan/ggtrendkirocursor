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
  timeRange: '4h' | '24h' | '48h';
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

export type TimeRange = '4h' | '24h' | '48h';

export type CollectedWithin = '6h' | '12h' | '24h' | '48h';

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
  timeRange?: '4h' | '24h' | '48h' | string;
  collectedWithin?: CollectedWithin | string;
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

// ----- Hot word -> Business Plan (BP) -----

export type BpStatus = 'pending' | 'generating' | 'completed' | 'failed';

export interface BpScores {
  market: number;
  roi: number;
  onlineability: number;
  feasibility: number;
  speed: number;
  moat: number;
}

export interface BpOpportunity {
  id?: string;
  reportId?: string;
  name: string;
  description: string;
  scores: BpScores;
  weightedScore: number;
  isSelected: boolean;
  rank: number;
}

export interface BpSeedReturn {
  /** Book ROI per year [Y1..Y5] in percent, e.g. [50,140,380,495,665]. */
  bookRoiByYear: number[];
  annualizedBook: string;
  /** Win rate = probability of a profitable cash exit. */
  winRate: string;
  profitLossRatio: string;
  expectedValueMOIC: string;
  riskAdjustedAnnualized: string;
  notes?: string;
}

export interface BpFinancialYear {
  year: number;
  revenue: string;
  ebitda: string;
}

export interface BpContent {
  title: string;
  summary: string;
  selectedOpportunity: string;
  opportunities: BpOpportunity[];
  market: { tam: string; sam: string; som: string; notes?: string };
  businessModel: string;
  financials: { years: BpFinancialYear[] };
  seedReturn: BpSeedReturn;
}

export interface BpTrendSnapshot {
  sourceTrendId?: string;
  keyword: string;
  searchVolume: number;
  growthRate: number;
  category: string;
  timeRange: string;
  region: string;
  rank: number;
}

export interface BpReport extends BpTrendSnapshot {
  id: string;
  keywordNorm: string;
  status: BpStatus;
  title?: string;
  summary?: string;
  selectedOpportunity?: string;
  contentJson?: BpContent | null;
  model?: string;
  tokensUsed?: number;
  error?: string | null;
  userId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  opportunities?: BpOpportunity[];
}

export interface BpReportListItem {
  id: string;
  keyword: string;
  title?: string;
  status: BpStatus;
  selectedOpportunity?: string;
  createdAt: Date;
}

export interface GenerateBpInput {
  keyword?: string;
  trendId?: string;
  timeRange?: string;
  userId?: string;
}

export interface BpError {
  code: string;
  message: string;
  reportId?: string;
}

export interface PaginatedBpReports {
  reports: BpReportListItem[];
  pagination: {
    currentPage: number;
    totalPages: number;
    totalItems: number;
    pageSize: number;
  };
}

