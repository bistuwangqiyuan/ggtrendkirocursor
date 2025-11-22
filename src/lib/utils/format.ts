import type { TimeRange } from '../../types';
import { t, type Locale } from '../i18n';

export function formatNumber(num: number): string {
  return new Intl.NumberFormat('en-US').format(num);
}

export function formatGrowthRate(rate: number): string {
  const prefix = rate > 0 ? '+' : '';
  return `${prefix}${rate}%`;
}

export function formatRelativeTime(date: Date, locale: Locale): string {
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  
  const units = [
    { name: 'year', seconds: 31536000 },
    { name: 'month', seconds: 2592000 },
    { name: 'day', seconds: 86400 },
    { name: 'hour', seconds: 3600 },
    { name: 'minute', seconds: 60 },
    { name: 'second', seconds: 1 }
  ];

  for (const unit of units) {
    const value = Math.floor(diffInSeconds / unit.seconds);
    if (value >= 1) {
      // Simple localization
      if (locale === 'zh') {
        const map: Record<string, string> = {
          year: '年', month: '个月', day: '天', hour: '小时', minute: '分钟', second: '秒'
        };
        return `${value} ${map[unit.name]}前`;
      } else {
        return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-value, unit.name as Intl.RelativeTimeFormatUnit);
      }
    }
  }
  
  return locale === 'zh' ? '刚刚' : 'Just now';
}

export function formatDateTime(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

export function formatTimeRangeLabel(range: TimeRange, locale: Locale): string {
  return t(locale, `trends.timeRange.${range}`);
}

