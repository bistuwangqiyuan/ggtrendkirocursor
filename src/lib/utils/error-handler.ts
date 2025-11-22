export function logError(error: any, context?: any) {
  console.error(JSON.stringify({
    level: 'ERROR',
    timestamp: new Date().toISOString(),
    message: error.message || 'Unknown error',
    stack: error.stack,
    context
  }));
}

export function getUserFriendlyErrorMessage(error: any, locale: 'zh' | 'en' = 'zh'): string {
  // Add mapping logic based on error codes if needed
  return locale === 'zh' 
    ? (error.message || '系统出现错误，我们正在处理') 
    : (error.message || 'An error occurred, we are working on it');
}

