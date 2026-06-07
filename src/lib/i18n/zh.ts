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
    bp: '商业计划书',
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
      '4h': '过去 4 小时',
      '24h': '过去 24 小时',
      '48h': '过去 48 小时'
    },
    trendingWindow: '趋势窗口',
    collectedWithin: {
      label: '数据采集时间',
      all: '不限',
      '6h': '6 小时内',
      '12h': '12 小时内',
      '24h': '24 小时内',
      '48h': '48 小时内'
    },
    filters: {
      searchPlaceholder: '搜索关键词...',
      categoryAll: '所有分类',
      apply: '应用筛选'
    },
    pagination: {
        prev: '上一页',
        next: '下一页',
        showing: '显示',
        to: '至',
        of: '共',
        results: '条结果'
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
      invalidCredentials: '邮箱或密码错误',
      generic: '发生错误，请稍后重试'
    }
  },
  bp: {
    title: '商业计划书',
    subtitle: '由热搜第一名的关键词自动生成',
    listTitle: '历史商业计划书',
    generateCta: '一键生成商业计划书',
    generateForTop: '为榜首热词生成商业计划书',
    generating: '正在生成商业计划书，请稍候…',
    generatingHint: '本过程由 AI 完成头脑风暴、评分遴选与撰写，通常需要 20–60 秒。',
    failed: '生成失败，请稍后重试',
    notConfigured: 'AI 服务未配置，暂时无法生成',
    loginRequired: '请先登录后再生成',
    empty: '暂无商业计划书，去首页为榜首热词生成一份吧。',
    backToList: '返回列表',
    viewDetail: '查看详情',
    status: { pending: '待生成', generating: '生成中', completed: '已完成', failed: '失败' },
    columns: { keyword: '关键词', title: '标题', status: '状态', selected: '选定机会', time: '时间' },
    sections: {
      summary: '执行摘要',
      sourceTrend: '来源热词',
      scoreMatrix: '机会评分矩阵',
      selectedOpportunity: '选定机会',
      market: '市场分析',
      businessModel: '商业模式',
      financials: '五年财务概要',
      seedReturn: '种子轮回报指标'
    },
    scores: {
      market: '市场规模', roi: '投入产出比', onlineability: '可线上化',
      feasibility: '技术可行性', speed: '上市速度', moat: '护城河', weighted: '加权总分'
    },
    market: { tam: 'TAM 总市场', sam: 'SAM 可服务市场', som: 'SOM 可获取市场' },
    financials: { year: '年度', revenue: '收入', ebitda: 'EBITDA' },
    seed: {
      roiByYear: '逐年账面 ROI（第1-5年）',
      annualizedBook: '账面年化收益',
      winRate: '胜率（盈利现金退出概率）',
      profitLossRatio: '盈亏比',
      ev: '期望收益倍数 EV',
      riskAdjusted: '风险调整年化',
      year: '第{n}年'
    }
  },
  feedback: {
      title: '联系我们',
      name: '姓名',
      email: '邮箱',
      subject: '主题',
      message: '留言',
      submit: '提交反馈',
      success: '反馈提交成功！感谢您的建议。',
      error: '提交失败，请稍后重试。'
  },
  footer: {
      privacy: '隐私政策',
      terms: '服务条款',
      copyright: '© 2024 Trend Now. 保留所有权利。'
  }
};

