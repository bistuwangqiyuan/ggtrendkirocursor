# 设计文档

## 概述

Trend Now 是一个基于 Astro 框架构建的服务器端渲染（SSR）应用，专注于展示美国 Google Trends 实时数据。系统采用现代 Jamstack 架构，部署在 Netlify 平台，利用 Netlify 的边缘函数和 Neon PostgreSQL 数据库提供高性能、SEO 友好的用户体验。

### 核心技术栈

- **前端框架**: Astro 5.x（SSR 模式）+ React 19（交互组件）
- **样式方案**: Tailwind CSS 4.x
- **部署平台**: Netlify（边缘函数 + 静态资源）
- **数据库**: Neon PostgreSQL（Netlify 集成）
- **认证方案**: 基于会话的 Cookie 认证
- **国际化**: 自定义 i18n 实现（中文/英文）

### 设计原则

1. **SEO 优先**: 所有页面采用 SSR，确保搜索引擎可完整抓取内容
2. **性能优化**: 利用 Astro 的部分水合（Partial Hydration）减少 JavaScript 负载
3. **渐进增强**: 核心功能无需 JavaScript 即可工作，JavaScript 仅用于增强交互
4. **安全第一**: 所有用户输入验证、SQL 注入防护、XSS 防护
5. **可访问性**: 遵循 WCAG 2.1 AA 标准

## 架构

### 系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│                         用户浏览器                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Astro Pages │  │ React Islands│  │  CSS/Assets  │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                      Netlify CDN/Edge                        │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Netlify Edge Functions                   │  │
│  │  - 地理位置路由                                        │  │
│  │  - 缓存控制                                           │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Astro SSR Application                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Pages      │  │  API Routes  │  │  Middleware  │      │
│  │  (SSR)       │  │  (Serverless)│  │  (Auth)      │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Services    │  │  Utils       │  │  i18n        │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Neon PostgreSQL                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  users       │  │  feedback    │  │ google_trends│      │
│  │  (新建)      │  │  (新建)      │  │  (已存在)    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

### 请求流程

1. **页面请求流程**:

   - 用户请求 → Netlify CDN → Edge Functions（可选）→ Astro SSR → 数据库查询 → 渲染 HTML → 返回响应

2. **API 请求流程**:

   - 客户端 JavaScript → API 路由（Serverless Function）→ 数据库操作 → JSON 响应

3. **认证流程**:
   - 登录请求 → 验证凭据 → 生成会话令牌 → 设置 HttpOnly Cookie → 重定向

### 目录结构

```
src/
├── components/           # Astro 和 React 组件
│   ├── layout/          # 布局组件（Header, Footer）
│   ├── trends/          # 趋势数据相关组件
│   ├── auth/            # 认证相关组件
│   └── ui/              # 通用 UI 组件
├── pages/               # Astro 页面（自动路由）
│   ├── index.astro      # 首页（趋势数据展示）
│   ├── about.astro      # 关于我们
│   ├── contact.astro    # 联系我们
│   ├── privacy.astro    # 隐私政策
│   ├── terms.astro      # 服务条款
│   ├── login.astro      # 登录页
│   ├── register.astro   # 注册页
│   └── api/             # API 路由
│       ├── auth/
│       │   ├── login.ts
│       │   ├── register.ts
│       │   └── logout.ts
│       ├── trends/
│       │   └── list.ts  # 趋势数据 API
│       └── feedback/
│           └── submit.ts
├── lib/                 # 核心业务逻辑
│   ├── db/              # 数据库相关
│   │   ├── client.ts    # 数据库连接
│   │   ├── schema.ts    # 表结构定义
│   │   └── queries.ts   # SQL 查询
│   ├── services/        # 业务服务层
│   │   ├── auth.ts      # 认证服务
│   │   ├── trends.ts    # 趋势数据服务
│   │   └── feedback.ts  # 反馈服务
│   ├── utils/           # 工具函数
│   │   ├── validation.ts # 输入验证
│   │   ├── security.ts   # 安全工具
│   │   └── format.ts     # 格式化工具
│   └── i18n/            # 国际化
│       ├── index.ts     # i18n 核心
│       ├── zh.ts        # 中文翻译
│       └── en.ts        # 英文翻译
├── middleware/          # Astro 中间件
│   └── auth.ts          # 认证中间件
└── types/               # TypeScript 类型定义
    └── index.ts
```

## 组件和接口

### 核心组件

#### 1. 布局组件

**Header.astro**

- 功能: 网站顶部导航栏
- Props: `currentPath: string`, `locale: 'zh' | 'en'`, `user?: User`
- 包含: Logo、主导航菜单、语言切换、登录/用户菜单

**Footer.astro**

- 功能: 网站底部信息
- Props: `locale: 'zh' | 'en'`
- 包含: 链接（关于、联系、隐私、条款）、版权信息、社交媒体链接

**Layout.astro**

- 功能: 页面主布局包装器
- Props: `title: string`, `description: string`, `locale: 'zh' | 'en'`
- 包含: HTML 头部、SEO 标签、Header、主内容区、Footer

#### 2. 趋势数据组件

**TrendsTable.astro**

- 功能: 服务器端渲染的趋势数据表格
- Props: `trends: Trend[]`, `locale: 'zh' | 'en'`
- 特性: 语义化 HTML 表格、无障碍支持

**TrendsFilters.tsx** (React Island)

- 功能: 客户端交互的筛选器
- Props: `initialFilters: FilterState`, `onFilterChange: (filters: FilterState) => void`
- 状态: 时间范围、关键词搜索、分类选择
- 特性: 实时筛选、URL 同步

**Pagination.tsx** (React Island)

- 功能: 分页控件
- Props: `currentPage: number`, `totalPages: number`, `onPageChange: (page: number) => void`
- 特性: 键盘导航、无障碍支持

#### 3. 认证组件

**LoginForm.tsx** (React Island)

- 功能: 登录表单
- 状态: `email: string`, `password: string`, `error: string | null`
- 验证: 客户端和服务器端双重验证
- 特性: 表单验证、错误提示、加载状态

**RegisterForm.tsx** (React Island)

- 功能: 注册表单
- 状态: `username: string`, `email: string`, `password: string`, `confirmPassword: string`
- 验证: 实时验证、密码强度检查
- 特性: 表单验证、错误提示、成功重定向

#### 4. 反馈组件

**FeedbackForm.tsx** (React Island)

- 功能: 用户反馈表单
- 状态: `name: string`, `email: string`, `subject: string`, `message: string`
- 特性: 表单验证、提交确认、错误处理

### 服务接口

#### AuthService

```typescript
interface AuthService {
  // 用户注册
  register(username: string, email: string, password: string): Promise<Result<User, AuthError>>;

  // 用户登录
  login(email: string, password: string): Promise<Result<Session, AuthError>>;

  // 验证会话
  validateSession(token: string): Promise<Result<User, AuthError>>;

  // 用户登出
  logout(token: string): Promise<Result<void, AuthError>>;

  // 密码哈希
  hashPassword(password: string): Promise<string>;

  // 密码验证
  verifyPassword(password: string, hash: string): Promise<boolean>;
}
```

#### TrendsService

```typescript
interface TrendsService {
  // 获取趋势数据列表
  getTrends(params: TrendsQueryParams): Promise<Result<PaginatedTrends, DatabaseError>>;

  // 获取单条趋势数据
  getTrendById(id: string): Promise<Result<Trend, DatabaseError>>;

  // 获取可用的分类列表
  getCategories(): Promise<Result<string[], DatabaseError>>;

  // 获取趋势统计信息
  getTrendsStats(timeRange: TimeRange): Promise<Result<TrendsStats, DatabaseError>>;
}

interface TrendsQueryParams {
  timeRange: 'past_4_hours' | 'past_24_hours' | 'past_48_hours';
  keyword?: string;
  category?: string;
  excludeCategories?: string[]; // 默认排除 ['sports', 'entertainment']
  sortBy?: 'search_volume' | 'growth_rate' | 'timestamp';
  sortOrder?: 'asc' | 'desc';
  page: number;
  pageSize: number;
}
```

#### FeedbackService

```typescript
interface FeedbackService {
  // 提交反馈
  submitFeedback(feedback: FeedbackInput): Promise<Result<Feedback, DatabaseError>>;

  // 获取反馈列表（管理用途，本期不实现）
  // getFeedbackList(): Promise<Result<Feedback[], DatabaseError>>;
}

interface FeedbackInput {
  name: string;
  email: string;
  subject: string;
  message: string;
  userId?: string; // 可选，如果用户已登录
}
```

### API 路由接口

#### POST /api/auth/register

**请求体**:

```typescript
{
  username: string; // 3-20 字符
  email: string; // 有效邮箱格式
  password: string; // 最少 8 字符
}
```

**响应**:

```typescript
// 成功 (201)
{
  success: true;
  user: {
    id: string;
    username: string;
    email: string;
  }
}

// 失败 (400/409)
{
  success: false;
  error: string;
  field?: string; // 错误字段
}
```

#### POST /api/auth/login

**请求体**:

```typescript
{
  email: string;
  password: string;
}
```

**响应**:

```typescript
// 成功 (200) + Set-Cookie
{
  success: true;
  user: {
    id: string;
    username: string;
    email: string;
  }
}

// 失败 (401)
{
  success: false;
  error: string;
}
```

#### POST /api/auth/logout

**响应**:

```typescript
// 成功 (200) + Clear-Cookie
{
  success: true;
}
```

#### GET /api/trends/list

**查询参数**:

```typescript
{
  timeRange?: 'past_4_hours' | 'past_24_hours' | 'past_48_hours'; // 默认 past_4_hours
  keyword?: string;
  category?: string;
  sortBy?: 'search_volume' | 'growth_rate' | 'timestamp'; // 默认 search_volume
  sortOrder?: 'asc' | 'desc'; // 默认 desc
  page?: number; // 默认 1
  pageSize?: number; // 默认 20
}
```

**响应**:

```typescript
// 成功 (200)
{
  success: true;
  data: {
    trends: Trend[];
    pagination: {
      currentPage: number;
      totalPages: number;
      totalItems: number;
      pageSize: number;
    }
  }
}

// 失败 (500)
{
  success: false;
  error: string;
}
```

#### POST /api/feedback/submit

**请求体**:

```typescript
{
  name: string;
  email: string;
  subject: string;
  message: string;
}
```

**响应**:

```typescript
// 成功 (201)
{
  success: true;
  message: string;
}

// 失败 (400/500)
{
  success: false;
  error: string;
  field?: string;
}
```

## 数据模型

### 数据库表结构

#### users 表（新建）

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  locale VARCHAR(5) DEFAULT 'zh',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
```

#### sessions 表（新建）

```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  ip_address VARCHAR(45),
  user_agent TEXT
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
```

#### feedback 表（新建）

```sql
CREATE TABLE feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL,
  subject VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending', -- pending, reviewed, resolved
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_feedback_user_id ON feedback(user_id);
CREATE INDEX idx_feedback_created_at ON feedback(created_at);
CREATE INDEX idx_feedback_status ON feedback(status);
```

#### google_trends 表（已存在，不修改）

假设现有表结构如下（根据实际情况调整查询）:

```sql
-- 假设的现有表结构
CREATE TABLE google_trends (
  id UUID PRIMARY KEY,
  keyword VARCHAR(255) NOT NULL,
  search_volume BIGINT NOT NULL,
  growth_rate DECIMAL(10, 2),
  category VARCHAR(100),
  time_range VARCHAR(50), -- 'past_4_hours', 'past_24_hours', 'past_48_hours'
  region VARCHAR(10) DEFAULT 'US',
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 假设的索引
CREATE INDEX idx_google_trends_timestamp ON google_trends(timestamp);
CREATE INDEX idx_google_trends_time_range ON google_trends(time_range);
CREATE INDEX idx_google_trends_category ON google_trends(category);
CREATE INDEX idx_google_trends_search_volume ON google_trends(search_volume);
```

### TypeScript 类型定义

```typescript
// src/types/index.ts

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
```

### 数据验证规则

```typescript
// src/lib/utils/validation.ts

export const ValidationRules = {
  username: {
    minLength: 3,
    maxLength: 20,
    pattern: /^[a-zA-Z0-9_-]+$/,
    message: {
      zh: '用户名必须为 3-20 个字符，只能包含字母、数字、下划线和连字符',
      en: 'Username must be 3-20 characters and contain only letters, numbers, underscores, and hyphens'
    }
  },
  email: {
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    message: {
      zh: '请输入有效的邮箱地址',
      en: 'Please enter a valid email address'
    }
  },
  password: {
    minLength: 8,
    maxLength: 128,
    pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/,
    message: {
      zh: '密码必须至少 8 个字符，包含大小写字母和数字',
      en: 'Password must be at least 8 characters with uppercase, lowercase, and numbers'
    }
  },
  feedbackName: {
    minLength: 2,
    maxLength: 100,
    message: {
      zh: '姓名必须为 2-100 个字符',
      en: 'Name must be 2-100 characters'
    }
  },
  feedbackSubject: {
    minLength: 5,
    maxLength: 200,
    message: {
      zh: '主题必须为 5-200 个字符',
      en: 'Subject must be 5-200 characters'
    }
  },
  feedbackMessage: {
    minLength: 10,
    maxLength: 2000,
    message: {
      zh: '消息内容必须为 10-2000 个字符',
      en: 'Message must be 10-2000 characters'
    }
  }
};
```

## 正确性属性

_属性是系统在所有有效执行中应保持为真的特征或行为——本质上是关于系统应该做什么的形式化陈述。属性作为人类可读规范和机器可验证正确性保证之间的桥梁。_

### 属性 1: 有效注册创建用户记录

*对于任何*有效的用户名、邮箱和密码组合，调用注册功能应在数据库中创建新用户记录，且密码应被哈希存储而非明文。
**验证需求: 1.1, 12.1**

### 属性 2: 无效注册被拒绝

*对于任何*不符合验证规则的注册输入（无效邮箱格式、密码长度<8、用户名已存在），系统应拒绝注册并返回具体的错误信息。
**验证需求: 1.2**

### 属性 3: 有效登录创建会话

*对于任何*已注册用户，使用正确的邮箱和密码登录应创建会话令牌，且该令牌应设置 HttpOnly 和 Secure 标志。
**验证需求: 1.3, 12.2**

### 属性 4: 无效登录被拒绝

*对于任何*错误的登录凭据组合（不存在的邮箱、错误的密码），系统应拒绝登录请求并返回错误提示。
**验证需求: 1.4**

### 属性 5: 登出清除会话

*对于任何*有效的会话令牌，执行登出操作应使该令牌失效，后续使用该令牌的请求应被拒绝。
**验证需求: 1.5**

### 属性 6: 分页正确显示

*对于任何*超过页面大小的数据集，系统应提供分页控件，且每页显示的数据量应等于页面大小（最后一页除外）。
**验证需求: 2.2**

### 属性 7: 分页加载正确数据

*对于任何*有效的页码，点击分页控件应加载该页的数据，且数据应与数据库中对应页的记录一致。
**验证需求: 2.3**

### 属性 8: 趋势数据包含所有必需字段

*对于任何*趋势数据记录，渲染后的表格行应包含关键词、搜索量、增长速度、分类和时间戳字段。
**验证需求: 2.5**

### 属性 9: 时间范围筛选正确

*对于任何*时间范围选择（past_4_hours、past_24_hours、past_48_hours），返回的所有趋势数据的时间戳应在该时间范围内。
**验证需求: 3.1**

### 属性 10: 关键词搜索正确

*对于任何*关键词搜索文本，返回的所有趋势记录的关键词字段应包含该搜索文本（不区分大小写）。
**验证需求: 3.2**

### 属性 11: 分类筛选正确

*对于任何*分类选择，返回的所有趋势数据应属于该分类。
**验证需求: 3.3**

### 属性 12: 排序功能正确

*对于任何*排序列（搜索量、增长速度、时间戳）和排序方向（升序、降序），返回的数据应按该列正确排序。
**验证需求: 3.4**

### 属性 13: 组合筛选正确

*对于任何*多个筛选条件的组合（时间范围 + 关键词 + 分类），返回的所有数据应同时满足所有筛选条件。
**验证需求: 3.5**

### 属性 14: 语言切换保持界面文本一致

*对于任何*页面，切换语言后所有界面文本应切换为目标语言，且不应出现混合语言的情况。
**验证需求: 4.3**

### 属性 15: 语言切换保持状态不变

*对于任何*页面状态（筛选条件、分页位置、表单输入），切换语言后这些状态应保持不变。
**验证需求: 4.4**

### 属性 16: 已登录用户语言偏好持久化

*对于任何*已登录用户，切换语言后该偏好应保存到数据库，下次登录时应自动使用该语言。
**验证需求: 4.5**

### 属性 17: SSR 返回完整 HTML

*对于任何*页面请求，服务器应返回包含实际内容的完整 HTML，而非仅包含 JavaScript 加载器的空壳。
**验证需求: 5.1**

### 属性 18: 页面包含 SEO meta 标签

*对于任何*页面，生成的 HTML 应包含 title、description、keywords 和 Open Graph 标签。
**验证需求: 5.2**

### 属性 19: 页面包含结构化数据

*对于任何*页面，生成的 HTML 应包含有效的 JSON-LD 结构化数据标记。
**验证需求: 5.3**

### 属性 20: 页头包含所有必需元素

*对于任何*页面，渲染的页头应包含 Logo、主导航菜单和语言切换按钮。
**验证需求: 7.1**

### 属性 21: 页脚包含所有必需链接

*对于任何*页面，渲染的页脚应包含关于我们、联系我们、隐私政策、服务条款和版权信息的链接。
**验证需求: 7.2**

### 属性 22: 导航高亮当前页面

*对于任何*导航菜单项，当用户在对应页面时，该菜单项应被高亮显示。
**验证需求: 7.3**

### 属性 23: 有效反馈被保存

*对于任何*完整且有效的反馈表单提交，系统应将反馈保存到数据库并返回成功消息。
**验证需求: 8.2**

### 属性 24: 不完整反馈被拒绝

*对于任何*缺少必填字段的反馈表单，系统应阻止提交并高亮显示所有缺失的字段。
**验证需求: 8.3**

### 属性 25: 反馈提交后表单被清空

*对于任何*成功提交的反馈，表单的所有字段应被清空，以便用户提交新的反馈。
**验证需求: 8.5**

### 属性 26: SQL 注入被防护

*对于任何*包含 SQL 特殊字符的用户输入，系统应使用参数化查询，确保这些字符不会被解释为 SQL 命令。
**验证需求: 9.2, 12.4**

### 属性 27: 图片使用现代格式和懒加载

*对于任何*图片元素，应使用 WebP 或 AVIF 格式，且应包含 loading="lazy" 属性（首屏图片除外）。
**验证需求: 10.3**

### 属性 28: 表单验证错误正确显示

*对于任何*表单的无效输入，系统应在对应字段旁显示具体的验证错误信息。
**验证需求: 11.3**

### 属性 29: XSS 攻击被防护

*对于任何*包含 HTML 或 JavaScript 代码的用户输入，系统应正确转义这些内容，确保它们不会被浏览器执行。
**验证需求: 12.3**

### 属性 30: 过期会话被拒绝

*对于任何*超过 30 天未活动的会话令牌，系统应拒绝使用该令牌的请求并要求重新登录。
**验证需求: 12.5**

### 属性 31: 趋势表格结构正确

*对于任何*趋势数据集，渲染的表格应包含正确的列标题和数据行，且每行应对应一条趋势记录。
**验证需求: 13.1**

### 属性 32: 数字格式化正确

*对于任何*大于 999 的数值（搜索量、增长速度），显示时应包含千位分隔符。
**验证需求: 13.2**

### 属性 33: 时间显示格式正确

*对于任何*时间戳，系统应同时显示相对时间（如"2 小时前"）和绝对时间，且相对时间应根据当前时间正确计算。
**验证需求: 13.3**

### 属性 34: HTML 使用语义化标签

*对于任何*页面，HTML 结构应使用语义化标签（header、nav、main、footer、article、section）而非通用的 div。
**验证需求: 14.1**

### 属性 35: 交互元素包含 ARIA 属性

*对于任何*交互元素（按钮、链接、表单控件），应包含适当的 ARIA 标签和角色属性以支持屏幕阅读器。
**验证需求: 14.2**

### 属性 36: 表单控件关联 label

*对于任何*表单控件（input、select、textarea），应有对应的 label 元素通过 for 属性或嵌套方式关联。
**验证需求: 14.3**

### 属性 37: 交互元素支持键盘导航

*对于任何*交互元素，应可通过 Tab 键访问，且应有清晰的焦点指示器。
**验证需求: 14.4**

## 错误处理

### 错误分类

系统采用分层错误处理策略，将错误分为以下类别：

1. **验证错误（Validation Errors）**: 用户输入不符合规则
2. **认证错误（Authentication Errors）**: 登录、注册、会话相关错误
3. **数据库错误（Database Errors）**: 数据库连接、查询失败
4. **网络错误（Network Errors）**: API 请求超时、连接失败
5. **系统错误（System Errors）**: 未预期的运行时错误

### 错误处理策略

#### 1. 验证错误处理

**客户端验证**:

- 实时验证（onChange）: 提供即时反馈
- 提交验证（onSubmit）: 最终检查
- 错误显示: 字段旁显示具体错误信息，使用红色文本和图标

**服务器端验证**:

- 所有客户端验证规则在服务器端重复执行
- 返回结构化错误信息，包含字段名和错误消息
- HTTP 状态码: 400 Bad Request

```typescript
// 验证错误响应格式
{
  success: false,
  error: "Validation failed",
  validationErrors: [
    { field: "email", message: "Invalid email format" },
    { field: "password", message: "Password must be at least 8 characters" }
  ]
}
```

#### 2. 认证错误处理

**错误类型**:

- `INVALID_CREDENTIALS`: 邮箱或密码错误
- `USER_EXISTS`: 用户名或邮箱已被注册
- `INVALID_TOKEN`: 会话令牌无效或已过期
- `SESSION_EXPIRED`: 会话已过期

**处理方式**:

- 显示友好的错误消息（不泄露敏感信息）
- 登录失败: "邮箱或密码错误"（不指明具体哪个错误）
- 会话过期: 自动重定向到登录页，显示提示信息
- HTTP 状态码: 401 Unauthorized（认证失败）、409 Conflict（用户已存在）

#### 3. 数据库错误处理

**错误场景**:

- 连接失败: 数据库不可用
- 查询超时: 查询执行时间过长
- 约束违反: 唯一键冲突、外键约束
- 数据不存在: 查询结果为空

**处理方式**:

- 记录详细错误日志（包含堆栈跟踪）
- 向用户显示通用错误消息: "数据加载失败，请稍后重试"
- 实施重试机制（最多 3 次，指数退避）
- HTTP 状态码: 500 Internal Server Error（服务器错误）、404 Not Found（数据不存在）

```typescript
// 数据库错误处理示例
async function getTrends(params: TrendsQueryParams): Promise<Result<PaginatedTrends, DatabaseError>> {
  try {
    const result = await db.query(/* ... */);
    return { success: true, data: result };
  } catch (error) {
    logger.error('Database query failed', { error, params });
    return {
      success: false,
      error: {
        code: 'QUERY_ERROR',
        message: 'Failed to fetch trends data'
      }
    };
  }
}
```

#### 4. 网络错误处理

**错误场景**:

- 请求超时: 超过 30 秒无响应
- 连接失败: 无法连接到服务器
- 服务不可用: 503 状态码

**处理方式**:

- 显示具体的网络错误提示
- 提供重试按钮
- 客户端超时设置: 30 秒
- 显示加载状态，防止重复提交

#### 5. 系统错误处理

**错误边界（Error Boundary）**:

- React 组件使用 Error Boundary 捕获渲染错误
- 显示友好的错误页面，提供返回首页链接
- 记录错误到日志系统

**全局错误处理**:

- 未捕获的 Promise 拒绝
- 未处理的异常
- 显示通用错误页面: "系统出现错误，我们正在处理"

### 错误日志

**日志级别**:

- ERROR: 系统错误、数据库错误
- WARN: 验证失败、认证失败
- INFO: 正常操作（登录、注册、数据查询）
- DEBUG: 开发调试信息

**日志内容**:

```typescript
{
  level: 'ERROR',
  timestamp: '2024-01-15T10:30:00Z',
  message: 'Database connection failed',
  context: {
    operation: 'getTrends',
    params: { timeRange: 'past_4_hours' },
    error: {
      name: 'ConnectionError',
      message: 'Connection timeout',
      stack: '...'
    }
  },
  userId: 'uuid-if-authenticated',
  requestId: 'unique-request-id'
}
```

### 用户友好的错误消息

**中文错误消息**:

- 数据库错误: "数据加载失败，请稍后重试"
- 网络错误: "网络连接超时，请检查您的网络"
- 验证错误: "请输入有效的邮箱地址"
- 认证错误: "邮箱或密码错误"
- 404 错误: "页面不存在"
- 系统错误: "系统出现错误，我们正在处理"

**英文错误消息**:

- Database error: "Failed to load data, please try again later"
- Network error: "Network connection timeout, please check your connection"
- Validation error: "Please enter a valid email address"
- Authentication error: "Invalid email or password"
- 404 error: "Page not found"
- System error: "An error occurred, we are working on it"

## 测试策略

### 测试金字塔

```
        ┌─────────────────┐
        │  E2E Tests (5%) │  端到端测试
        └─────────────────┘
       ┌───────────────────┐
       │Integration (15%)  │  集成测试
       └───────────────────┘
      ┌─────────────────────┐
      │  Unit Tests (40%)   │  单元测试
      └─────────────────────┘
     ┌──────────────────────────┐
     │Property-Based Tests (40%)│  基于属性的测试
     └──────────────────────────┘
```

### 1. 基于属性的测试（Property-Based Testing）

**测试库**: `fast-check`（JavaScript/TypeScript 的 PBT 库）

**配置**:

```typescript
// 每个属性测试运行至少 100 次迭代
fc.assert(
  fc.property(/* generators */, /* test function */),
  { numRuns: 100 }
);
```

**测试标注格式**:

```typescript
// **Feature: trend-now, Property 1: 有效注册创建用户记录**
test('valid registration creates user record', () => {
  fc.assert(
    fc.property(
      fc.record({
        username: fc.string({ minLength: 3, maxLength: 20 }),
        email: fc.emailAddress(),
        password: fc.string({ minLength: 8, maxLength: 128 })
      }),
      async (input) => {
        const result = await authService.register(input.username, input.email, input.password);
        expect(result.success).toBe(true);
        // 验证数据库中存在用户记录
        const user = await db.query('SELECT * FROM users WHERE email = $1', [input.email]);
        expect(user).toBeDefined();
        // 验证密码被哈希
        expect(user.password_hash).not.toBe(input.password);
      }
    ),
    { numRuns: 100 }
  );
});
```

**生成器（Generators）策略**:

1. **智能约束生成器**: 生成符合业务规则的数据

```typescript
// 有效用户名生成器
const validUsername = fc.string({ minLength: 3, maxLength: 20 }).filter((s) => /^[a-zA-Z0-9_-]+$/.test(s));

// 有效邮箱生成器
const validEmail = fc.emailAddress();

// 有效密码生成器（包含大小写字母和数字）
const validPassword = fc.string({ minLength: 8, maxLength: 128 }).filter((s) => /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/.test(s));
```

2. **边缘情况生成器**: 专门生成边缘情况

```typescript
// 无效邮箱生成器
const invalidEmail = fc.oneof(
  fc.constant(''),
  fc.constant('invalid'),
  fc.constant('@example.com'),
  fc.constant('user@'),
  fc.string().filter((s) => !s.includes('@'))
);

// 短密码生成器
const shortPassword = fc.string({ maxLength: 7 });

// 空白字符串生成器
const whitespaceString = fc.string().map((s) => ' '.repeat(s.length));
```

3. **组合生成器**: 生成复杂的数据结构

```typescript
// 趋势数据生成器
const trendGenerator = fc.record({
  keyword: fc.string({ minLength: 1, maxLength: 255 }),
  searchVolume: fc.integer({ min: 0, max: 10000000 }),
  growthRate: fc.float({ min: -100, max: 1000 }),
  category: fc.constantFrom('technology', 'health', 'business', 'sports', 'entertainment'),
  timeRange: fc.constantFrom('past_4_hours', 'past_24_hours', 'past_48_hours'),
  timestamp: fc.date({ min: new Date('2024-01-01'), max: new Date() })
});
```

**核心属性测试**:

- **属性 1-5**: 认证系统（注册、登录、登出）
- **属性 6-8**: 分页和数据展示
- **属性 9-13**: 数据筛选和排序
- **属性 14-16**: 国际化
- **属性 17-19**: SEO 和 SSR
- **属性 20-22**: 页面结构和导航
- **属性 23-25**: 反馈系统
- **属性 26, 29**: 安全性（SQL 注入、XSS）
- **属性 27**: 性能优化
- **属性 28**: 表单验证
- **属性 30**: 会话管理
- **属性 31-33**: 数据格式化
- **属性 34-37**: 无障碍性

### 2. 单元测试（Unit Testing）

**测试框架**: Vitest（与 Vite 集成良好）

**测试范围**:

- 工具函数（验证、格式化、安全）
- 服务层函数（认证、趋势数据、反馈）
- React 组件（使用 React Testing Library）
- API 路由处理器

**示例**:

```typescript
// src/lib/utils/validation.test.ts
describe('Validation Utils', () => {
  test('validates email format', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('invalid')).toBe(false);
  });

  test('validates password strength', () => {
    expect(isValidPassword('Abc12345')).toBe(true);
    expect(isValidPassword('weak')).toBe(false);
  });
});

// src/lib/services/auth.test.ts
describe('AuthService', () => {
  test('hashes password before storing', async () => {
    const password = 'TestPass123';
    const hash = await authService.hashPassword(password);
    expect(hash).not.toBe(password);
    expect(hash.length).toBeGreaterThan(50);
  });

  test('verifies password correctly', async () => {
    const password = 'TestPass123';
    const hash = await authService.hashPassword(password);
    expect(await authService.verifyPassword(password, hash)).toBe(true);
    expect(await authService.verifyPassword('wrong', hash)).toBe(false);
  });
});
```

### 3. 集成测试（Integration Testing）

**测试范围**:

- API 路由 + 数据库交互
- 认证中间件 + 受保护路由
- 完整的用户流程（注册 → 登录 → 操作 → 登出）

**测试环境**:

- 使用测试数据库（独立的 Neon 数据库实例）
- 每个测试前清理数据库
- 使用真实的数据库连接（不使用 mock）

**示例**:

```typescript
// tests/integration/auth.test.ts
describe('Authentication Flow', () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  test('complete registration and login flow', async () => {
    // 注册
    const registerResponse = await fetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: 'testuser',
        email: 'test@example.com',
        password: 'TestPass123'
      })
    });
    expect(registerResponse.status).toBe(201);

    // 登录
    const loginResponse = await fetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'test@example.com',
        password: 'TestPass123'
      })
    });
    expect(loginResponse.status).toBe(200);
    const cookies = loginResponse.headers.get('set-cookie');
    expect(cookies).toContain('session_token');

    // 访问受保护资源
    const protectedResponse = await fetch('/api/user/profile', {
      headers: { Cookie: cookies }
    });
    expect(protectedResponse.status).toBe(200);
  });
});
```

### 4. 端到端测试（E2E Testing）

**测试框架**: Playwright

**测试范围**:

- 关键用户流程
- 跨浏览器兼容性
- 响应式设计验证

**示例场景**:

1. 用户注册并登录
2. 浏览趋势数据并应用筛选
3. 切换语言
4. 提交反馈

**示例**:

```typescript
// tests/e2e/trends.spec.ts
test('user can filter trends by time range', async ({ page }) => {
  await page.goto('/');

  // 等待数据加载
  await page.waitForSelector('table');

  // 选择时间范围
  await page.selectOption('[name="timeRange"]', 'past_24_hours');

  // 验证 URL 更新
  expect(page.url()).toContain('timeRange=past_24_hours');

  // 验证数据更新
  const rows = await page.locator('tbody tr').count();
  expect(rows).toBeGreaterThan(0);
});
```

### 测试覆盖率目标

- **整体代码覆盖率**: ≥ 80%
- **关键路径覆盖率**: 100%（认证、数据查询、安全功能）
- **分支覆盖率**: ≥ 75%
- **函数覆盖率**: ≥ 85%

### 持续集成

**CI 流程**:

1. 代码提交触发 CI
2. 运行 linter 和类型检查
3. 运行单元测试和属性测试
4. 运行集成测试
5. 构建应用
6. 运行 E2E 测试
7. 生成测试覆盖率报告
8. 如果所有测试通过，部署到 Netlify

**测试执行顺序**:

```bash
# 1. 静态检查
npm run lint
npm run type-check

# 2. 单元测试和属性测试
npm run test:unit

# 3. 集成测试
npm run test:integration

# 4. 构建
npm run build

# 5. E2E 测试
npm run test:e2e
```

## SEO 优化策略

### 1. 服务器端渲染（SSR）

**实现方式**:

- 所有页面使用 Astro SSR 模式
- 确保搜索引擎爬虫获取完整的 HTML 内容
- 关键内容在 HTML 中直接渲染，不依赖 JavaScript

**Astro 配置**:

```javascript
// astro.config.mjs
export default defineConfig({
  output: 'server', // SSR 模式
  adapter: netlify()
});
```

### 2. Meta 标签优化

**每个页面必需的 Meta 标签**:

```html
<!-- 基础 Meta 标签 -->
<title>Trend Now - 美国 Google Trends 实时数据</title>
<meta name="description" content="查看美国最新的 Google Trends 数据，包括过去 4 小时、24 小时和 48 小时的热门搜索趋势" />
<meta name="keywords" content="Google Trends, 趋势数据, 热门搜索, 美国趋势" />

<!-- Open Graph 标签（社交媒体分享） -->
<meta property="og:title" content="Trend Now - 美国 Google Trends 实时数据" />
<meta property="og:description" content="查看美国最新的 Google Trends 数据" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://trend-now.netlify.app/" />
<meta property="og:image" content="https://trend-now.netlify.app/og-image.jpg" />

<!-- Twitter Card 标签 -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Trend Now - 美国 Google Trends 实时数据" />
<meta name="twitter:description" content="查看美国最新的 Google Trends 数据" />
<meta name="twitter:image" content="https://trend-now.netlify.app/og-image.jpg" />

<!-- 语言和地区 -->
<meta property="og:locale" content="zh_CN" />
<meta property="og:locale:alternate" content="en_US" />
<link rel="alternate" hreflang="zh" href="https://trend-now.netlify.app/" />
<link rel="alternate" hreflang="en" href="https://trend-now.netlify.app/en" />
<link rel="alternate" hreflang="x-default" href="https://trend-now.netlify.app/" />

<!-- 移动优化 -->
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="theme-color" content="#3B82F6" />

<!-- 搜索引擎指令 -->
<meta name="robots" content="index, follow" />
<link rel="canonical" href="https://trend-now.netlify.app/" />
```

### 3. 结构化数据（JSON-LD）

**网站结构化数据**:

```json
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "Trend Now",
  "url": "https://trend-now.netlify.app",
  "description": "美国 Google Trends 实时数据展示平台",
  "inLanguage": ["zh-CN", "en-US"],
  "potentialAction": {
    "@type": "SearchAction",
    "target": "https://trend-now.netlify.app/?keyword={search_term}",
    "query-input": "required name=search_term"
  }
}
```

**数据集结构化数据**:

```json
{
  "@context": "https://schema.org",
  "@type": "Dataset",
  "name": "Google Trends 美国数据",
  "description": "美国 Google 搜索趋势数据，包括关键词、搜索量和增长率",
  "url": "https://trend-now.netlify.app",
  "temporalCoverage": "2024-01-01/..",
  "spatialCoverage": {
    "@type": "Place",
    "name": "United States"
  }
}
```

**面包屑导航**:

```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {
      "@type": "ListItem",
      "position": 1,
      "name": "首页",
      "item": "https://trend-now.netlify.app"
    },
    {
      "@type": "ListItem",
      "position": 2,
      "name": "关于我们",
      "item": "https://trend-now.netlify.app/about"
    }
  ]
}
```

### 4. URL 结构优化

**语义化 URL 设计**:

```
/ - 首页（趋势数据）
/about - 关于我们
/contact - 联系我们
/privacy - 隐私政策
/terms - 服务条款
/login - 登录
/register - 注册

# 筛选使用 URL 参数（对 SEO 友好）
/?timeRange=past_24_hours&category=technology&page=2
```

**URL 规范化**:

- 使用 canonical 标签避免重复内容
- 统一使用小写字母
- 使用连字符（-）而非下划线（\_）
- 避免动态参数过多

### 5. 性能优化（Core Web Vitals）

**Largest Contentful Paint (LCP) < 2.5s**:

- 优先加载首屏内容
- 使用 SSR 减少客户端渲染时间
- 优化图片（WebP、AVIF、懒加载）
- 使用 CDN 加速静态资源

**First Input Delay (FID) < 100ms**:

- 减少 JavaScript 执行时间
- 使用 Astro Islands 实现部分水合
- 延迟加载非关键 JavaScript

**Cumulative Layout Shift (CLS) < 0.1**:

- 为图片和视频设置明确的宽高
- 避免在现有内容上方插入内容
- 使用 CSS aspect-ratio 保留空间

**实现策略**:

```astro
---
// 预加载关键资源
---
<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preconnect" href="https://your-neon-db.com" />

<!-- 图片优化 -->
<img
  src="/images/hero.webp"
  alt="Trend Now"
  width="1200"
  height="630"
  loading="eager" <!-- 首屏图片 -->
/>

<img
  src="/images/feature.webp"
  alt="Feature"
  width="800"
  height="600"
  loading="lazy" <!-- 非首屏图片 -->
/>
```

### 6. 内容优化

**标题层级**:

- 每页只有一个 H1 标签（页面主标题）
- 使用 H2-H6 建立清晰的内容层级
- 标题包含关键词但保持自然

**内容质量**:

- 提供有价值的趋势分析和洞察
- 定期更新内容（趋势数据实时更新）
- 使用清晰的语言，避免过度优化

**内部链接**:

- 在页脚提供主要页面链接
- 在内容中自然地链接到相关页面
- 使用描述性的锚文本

### 7. 移动优化

**移动友好性**:

- 响应式设计，适配所有设备
- 触摸目标至少 48x48 像素
- 避免使用 Flash 或其他不兼容技术
- 文本可读性（字体大小至少 16px）

**移动页面速度**:

- 压缩图片和资源
- 减少重定向
- 启用浏览器缓存
- 使用 HTTP/2

### 8. Sitemap 和 Robots.txt

**sitemap.xml**:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://trend-now.netlify.app/</loc>
    <lastmod>2024-01-15</lastmod>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://trend-now.netlify.app/about</loc>
    <lastmod>2024-01-15</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <!-- 其他页面 -->
</urlset>
```

**robots.txt**:

```
User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin/

Sitemap: https://trend-now.netlify.app/sitemap.xml
```

### 9. 国际化 SEO

**hreflang 标签**:

```html
<link rel="alternate" hreflang="zh" href="https://trend-now.netlify.app/" />
<link rel="alternate" hreflang="en" href="https://trend-now.netlify.app/en" />
<link rel="alternate" hreflang="x-default" href="https://trend-now.netlify.app/" />
```

**语言特定内容**:

- 中文页面使用中文 meta 标签和内容
- 英文页面使用英文 meta 标签和内容
- 避免机器翻译，使用人工翻译

### 10. 监控和分析

**SEO 工具集成**:

- Google Search Console: 监控索引状态和搜索表现
- Google Analytics: 跟踪流量和用户行为
- Lighthouse: 定期检查性能和 SEO 分数

**关键指标**:

- 索引页面数量
- 搜索展示次数和点击率
- 平均排名位置
- Core Web Vitals 分数
- 移动可用性

## 安全性设计

### 1. 密码安全

**哈希算法**: bcrypt（成本因子 12）

```typescript
import bcrypt from 'bcrypt';

const SALT_ROUNDS = 12;

async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, SALT_ROUNDS);
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(password, hash);
}
```

**密码策略**:

- 最少 8 个字符
- 必须包含大写字母、小写字母和数字
- 最大 128 个字符（防止 DoS 攻击）
- 不存储明文密码

### 2. 会话管理

**会话令牌**:

- 使用加密安全的随机数生成器
- 令牌长度: 32 字节（256 位）
- 存储在 HttpOnly Cookie 中

```typescript
import crypto from 'crypto';

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}
```

**Cookie 配置**:

```typescript
{
  httpOnly: true,      // 防止 JavaScript 访问
  secure: true,        // 仅 HTTPS 传输
  sameSite: 'lax',     // CSRF 防护
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 天
  path: '/'
}
```

**会话过期**:

- 绝对过期: 30 天
- 滑动过期: 每次活动延长 30 天
- 登出时立即删除会话

### 3. SQL 注入防护

**参数化查询**:

```typescript
// ❌ 错误：字符串拼接
const query = `SELECT * FROM users WHERE email = '${email}'`;

// ✅ 正确：参数化查询
const query = 'SELECT * FROM users WHERE email = $1';
const result = await db.query(query, [email]);
```

**ORM/查询构建器**:

- 使用 `pg` 库的参数化查询
- 或使用 Drizzle ORM 提供额外的类型安全

### 4. XSS 防护

**输出转义**:

- Astro 和 React 默认转义所有输出
- 避免使用 `dangerouslySetInnerHTML`
- 使用 DOMPurify 清理用户生成的 HTML（如果需要）

```typescript
import DOMPurify from 'isomorphic-dompurify';

function sanitizeHTML(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a'],
    ALLOWED_ATTR: ['href']
  });
}
```

**Content Security Policy (CSP)**:

```typescript
// Netlify 配置或中间件设置
{
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'", // Astro 需要 inline scripts
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self' https://your-neon-db.com",
    "frame-ancestors 'none'"
  ].join('; ')
}
```

### 5. CSRF 防护

**SameSite Cookie**:

- 设置 `sameSite: 'lax'` 或 `'strict'`
- 防止跨站请求携带 Cookie

**双重提交 Cookie（可选）**:

```typescript
// 生成 CSRF 令牌
function generateCSRFToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// 验证 CSRF 令牌
function verifyCSRFToken(token: string, cookieToken: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(cookieToken));
}
```

### 6. 速率限制

**API 速率限制**:

```typescript
// 使用内存存储或 Redis
const rateLimiter = {
  // 登录: 5 次/分钟
  login: { windowMs: 60 * 1000, max: 5 },
  // 注册: 3 次/小时
  register: { windowMs: 60 * 60 * 1000, max: 3 },
  // API 查询: 100 次/分钟
  api: { windowMs: 60 * 1000, max: 100 }
};
```

**实现**:

```typescript
const requestCounts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string, limit: { windowMs: number; max: number }): boolean {
  const now = Date.now();
  const record = requestCounts.get(ip);

  if (!record || now > record.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + limit.windowMs });
    return true;
  }

  if (record.count >= limit.max) {
    return false;
  }

  record.count++;
  return true;
}
```

### 7. 输入验证

**验证层级**:

1. 客户端验证（用户体验）
2. 服务器端验证（安全保障）
3. 数据库约束（最后防线）

**验证规则**:

```typescript
const validationRules = {
  username: {
    type: 'string',
    minLength: 3,
    maxLength: 20,
    pattern: /^[a-zA-Z0-9_-]+$/,
    sanitize: (value: string) => value.trim().toLowerCase()
  },
  email: {
    type: 'string',
    maxLength: 255,
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    sanitize: (value: string) => value.trim().toLowerCase()
  },
  password: {
    type: 'string',
    minLength: 8,
    maxLength: 128,
    pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/
  }
};
```

### 8. 数据库安全

**连接安全**:

- 使用 SSL/TLS 连接到 Neon 数据库
- 连接字符串存储在环境变量中
- 不在代码中硬编码凭据

**最小权限原则**:

- 应用使用的数据库用户只有必要的权限
- 读操作使用只读用户（如果可能）
- 定期审查和更新权限

**数据加密**:

- 敏感数据（密码）加密存储
- 使用 Neon 的静态加密功能
- 传输中使用 TLS

### 9. 错误处理安全

**不泄露敏感信息**:

```typescript
// ❌ 错误：暴露内部错误
catch (error) {
  return { error: error.message }; // 可能包含数据库结构等信息
}

// ✅ 正确：返回通用错误
catch (error) {
  logger.error('Database error', { error }); // 记录详细错误
  return { error: 'An error occurred' }; // 返回通用消息
}
```

**错误日志**:

- 记录详细错误到服务器日志
- 不在客户端显示堆栈跟踪
- 定期审查错误日志

### 10. 依赖安全

**依赖管理**:

- 定期更新依赖（使用 Renovate 或 Dependabot）
- 运行 `npm audit` 检查已知漏洞
- 使用 `package-lock.json` 锁定版本

**安全扫描**:

```bash
# 检查依赖漏洞
npm audit

# 自动修复
npm audit fix

# 查看详细报告
npm audit --json
```

## 部署配置

### Netlify 配置

**netlify.toml**:

```toml
[build]
  command = "npm run build"
  publish = "dist"

[build.environment]
  NODE_VERSION = "20"

[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/:splat"
  status = 200

[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"
    X-Content-Type-Options = "nosniff"
    X-XSS-Protection = "1; mode=block"
    Referrer-Policy = "strict-origin-when-cross-origin"
    Permissions-Policy = "geolocation=(), microphone=(), camera=()"

[[headers]]
  for = "/assets/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

[[headers]]
  for = "/*.js"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

[[headers]]
  for = "/*.css"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"
```

### 环境变量

**必需的环境变量**:

```bash
# 数据库
DATABASE_URL=postgresql://user:password@host:5432/database

# 会话
SESSION_SECRET=your-secret-key-here-change-in-production

# 环境
NODE_ENV=production
```

**在 Netlify 中设置**:

1. 进入 Site settings → Environment variables
2. 添加所有必需的环境变量
3. 确保不在代码中提交敏感信息

### 数据库迁移

**初始化脚本**:

```sql
-- scripts/init-db.sql

-- 创建 users 表
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  locale VARCHAR(5) DEFAULT 'zh',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);

-- 创建 sessions 表
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  ip_address VARCHAR(45),
  user_agent TEXT
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- 创建 feedback 表
CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL,
  subject VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_feedback_user_id ON feedback(user_id);
CREATE INDEX idx_feedback_created_at ON feedback(created_at);
CREATE INDEX idx_feedback_status ON feedback(status);
```

**运行迁移**:

```bash
# 使用 psql 连接到 Neon 数据库
psql $DATABASE_URL -f scripts/init-db.sql
```

## 国际化实现

### i18n 架构

**翻译文件结构**:

```typescript
// src/lib/i18n/zh.ts
export const zh = {
  common: {
    appName: 'Trend Now',
    loading: '加载中...',
    error: '错误',
    success: '成功'
  },
  nav: {
    home: '首页',
    about: '关于我们',
    contact: '联系我们',
    login: '登录',
    register: '注册',
    logout: '退出'
  },
  trends: {
    title: '趋势数据',
    keyword: '关键词',
    searchVolume: '搜索量',
    growthRate: '增长速度',
    category: '分类',
    timestamp: '时间',
    timeRange: {
      past_4_hours: '过去 4 小时',
      past_24_hours: '过去 24 小时',
      past_48_hours: '过去 48 小时'
    }
  },
  auth: {
    login: '登录',
    register: '注册',
    email: '邮箱',
    password: '密码',
    username: '用户名',
    confirmPassword: '确认密码',
    loginButton: '登录',
    registerButton: '注册',
    errors: {
      invalidEmail: '请输入有效的邮箱地址',
      passwordTooShort: '密码必须至少 8 个字符',
      passwordMismatch: '两次输入的密码不一致',
      userExists: '用户名或邮箱已被注册',
      invalidCredentials: '邮箱或密码错误'
    }
  }
};

// src/lib/i18n/en.ts
export const en = {
  common: {
    appName: 'Trend Now',
    loading: 'Loading...',
    error: 'Error',
    success: 'Success'
  },
  nav: {
    home: 'Home',
    about: 'About',
    contact: 'Contact',
    login: 'Login',
    register: 'Register',
    logout: 'Logout'
  }
  // ... 英文翻译
};
```

**i18n 核心函数**:

```typescript
// src/lib/i18n/index.ts
import { zh } from './zh';
import { en } from './en';

export type Locale = 'zh' | 'en';
export type Translations = typeof zh;

const translations: Record<Locale, Translations> = { zh, en };

export function getTranslations(locale: Locale): Translations {
  return translations[locale] || translations.zh;
}

export function t(locale: Locale, key: string): string {
  const keys = key.split('.');
  let value: any = getTranslations(locale);

  for (const k of keys) {
    value = value?.[k];
  }

  return value || key;
}
```

**在 Astro 中使用**:

```astro
---
// src/pages/index.astro
import { getTranslations } from '../lib/i18n';

const locale = Astro.cookies.get('locale')?.value || 'zh';
const t = getTranslations(locale);
---

<h1>{t.trends.title}</h1>
<p>{t.common.loading}</p>
```

**在 React 中使用**:

```typescript
// src/components/TrendsFilters.tsx
import { useTranslations } from '../hooks/useTranslations';

export function TrendsFilters() {
  const t = useTranslations();

  return (
    <div>
      <label>{t.trends.timeRange.past_4_hours}</label>
    </div>
  );
}
```
