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
    bp: 'Business Plans',
    flagship: 'Our Business Plan',
    login: 'Login',
    register: 'Register',
    logout: 'Logout'
  },
  trends: {
    title: 'Trends Data',
    keyword: 'Keyword',
    searchVolume: 'Search Volume',
    growthRate: 'Growth Rate',
    category: 'Category',
    timestamp: 'Time',
    timeRange: {
      '4h': 'Past 4 Hours',
      '24h': 'Past 24 Hours',
      '48h': 'Past 48 Hours'
    },
    trendingWindow: 'Trending window',
    collectedWithin: {
      label: 'Data collected within',
      all: 'Any time',
      '6h': 'Last 6 hours',
      '12h': 'Last 12 hours',
      '24h': 'Last 24 hours',
      '48h': 'Last 48 hours'
    },
    filters: {
        searchPlaceholder: 'Search keywords...',
        categoryAll: 'All Categories',
        apply: 'Apply Filters'
    },
    pagination: {
        prev: 'Previous',
        next: 'Next',
        showing: 'Showing',
        to: 'to',
        of: 'of',
        results: 'results'
    }
  },
  auth: {
    login: 'Login',
    register: 'Register',
    email: 'Email',
    password: 'Password',
    username: 'Username',
    confirmPassword: 'Confirm Password',
    loginButton: 'Login',
    registerButton: 'Register',
    errors: {
      invalidEmail: 'Please enter a valid email address',
      passwordTooShort: 'Password must be at least 8 characters',
      passwordMismatch: 'Passwords do not match',
      userExists: 'Username or email already exists',
      invalidCredentials: 'Invalid email or password',
      generic: 'An error occurred, please try again later'
    }
  },
  bp: {
    title: 'Business Plan',
    subtitle: 'Auto-generated from the #1 trending keyword',
    listTitle: 'Generated Business Plans',
    generateCta: 'Generate Business Plan',
    generateForTop: 'Generate a BP for the top trend',
    generating: 'Generating your business plan, please wait…',
    generatingHint: 'AI brainstorms, scores, selects and writes the plan — usually 20–60 seconds.',
    failed: 'Generation failed, please try again later',
    notConfigured: 'AI service is not configured; generation is unavailable',
    loginRequired: 'Please log in to generate',
    empty: 'No business plans yet. Generate one for the top trend from the home page.',
    backToList: 'Back to list',
    viewDetail: 'View detail',
    exportPdf: 'Export PDF',
    exportHint: 'Choose "Save as PDF" in the print dialog to get a beautifully typeset report.',
    coverEyebrow: 'Google Trends · Fully-automated AI Business Plan',
    status: { pending: 'Pending', generating: 'Generating', completed: 'Completed', failed: 'Failed' },
    columns: { keyword: 'Keyword', title: 'Title', status: 'Status', selected: 'Selected opportunity', time: 'Time' },
    sections: {
      summary: 'Executive Summary',
      sourceTrend: 'Source Trend',
      scoreMatrix: 'Opportunity Score Matrix',
      selectedOpportunity: 'Selected Opportunity',
      market: 'Market Analysis',
      businessModel: 'Business Model',
      financials: '5-Year Financial Summary',
      seedReturn: 'Seed-Round Return Metrics'
    },
    scores: {
      market: 'Market size', roi: 'ROI', onlineability: 'Online-ability',
      feasibility: 'Feasibility', speed: 'Time to market', moat: 'Moat', weighted: 'Weighted score'
    },
    market: { tam: 'TAM', sam: 'SAM', som: 'SOM' },
    financials: { year: 'Year', revenue: 'Revenue', ebitda: 'EBITDA' },
    seed: {
      roiByYear: 'Book ROI by year (Y1-Y5)',
      annualizedBook: 'Annualized (book)',
      winRate: 'Win rate (profitable cash exit)',
      profitLossRatio: 'Profit/Loss ratio',
      ev: 'Expected value (MOIC)',
      riskAdjusted: 'Risk-adjusted annualized',
      year: 'Year {n}'
    }
  },
  feedback: {
      title: 'Contact Us',
      name: 'Name',
      email: 'Email',
      subject: 'Subject',
      message: 'Message',
      submit: 'Submit Feedback',
      success: 'Feedback submitted successfully! Thank you.',
      error: 'Submission failed, please try again later.'
  },
  footer: {
      privacy: 'Privacy Policy',
      terms: 'Terms of Service',
      copyright: '© 2024 Trend Now. All rights reserved.'
  }
};

