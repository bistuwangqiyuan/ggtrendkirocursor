import React, { useState } from 'react';

interface TrendsFiltersProps {
  basePath?: string;
  initialFilters: {
    timeRange: string;
    collectedWithin: string;
    keyword: string;
    category: string;
  };
  categories: string[];
  locale: 'zh' | 'en';
  translations: any;
}

const COLLECTED_WITHIN_OPTIONS = ['6h', '12h', '24h', '48h'] as const;

export function TrendsFilters({ basePath = '/trends', initialFilters, categories, locale, translations }: TrendsFiltersProps) {
  const [filters, setFilters] = useState(initialFilters);

  const t = translations.trends;

  const updateURL = (newFilters: typeof filters) => {
    const params = new URLSearchParams(window.location.search);
    if (newFilters.timeRange) params.set('timeRange', newFilters.timeRange);
    // 'all' is an explicit choice (server defaults to 48h when the param is
    // absent, so removing it would silently re-apply the freshness default).
    if (newFilters.collectedWithin) params.set('collectedWithin', newFilters.collectedWithin);
    else params.delete('collectedWithin');
    if (newFilters.keyword) params.set('keyword', newFilters.keyword);
    else params.delete('keyword');
    if (newFilters.category) params.set('category', newFilters.category);
    else params.delete('category');

    // Reset page on filter change
    params.set('page', '1');

    window.location.href = `${basePath}?${params.toString()}`;
  };

  const handleChange = (key: keyof typeof filters, value: string) => {
    const newFilters = { ...filters, [key]: value };
    setFilters(newFilters);
    if (key !== 'keyword') {
      updateURL(newFilters);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    updateURL(filters);
  };

  return (
    <div className="bg-gray-900/50 border border-gray-800 p-4 rounded-lg mb-6 flex flex-col lg:flex-row gap-4 lg:items-end justify-between">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wider text-gray-500">{t.trendingWindow}</span>
        <div className="flex flex-wrap gap-2">
          {(['4h', '24h', '48h'] as const).map((range) => (
            <button
              key={range}
              onClick={() => handleChange('timeRange', range)}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors border ${
                filters.timeRange === range
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700'
              }`}
            >
              {t.timeRange[range]}
            </button>
          ))}
        </div>
      </div>

      <form onSubmit={handleSearch} className="flex flex-wrap gap-3 items-end w-full lg:w-auto">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="filter-collected-within" className="text-xs font-medium uppercase tracking-wider text-gray-500">{t.collectedWithin.label}</label>
          <select
            id="filter-collected-within"
            value={filters.collectedWithin}
            onChange={(e) => handleChange('collectedWithin', e.target.value)}
            className="bg-gray-800 border border-gray-700 text-white text-sm rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
          >
            {COLLECTED_WITHIN_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>{t.collectedWithin[opt]}</option>
            ))}
            <option value="all">{t.collectedWithin.all}</option>
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="filter-category" className="text-xs font-medium uppercase tracking-wider text-gray-500">{t.category}</label>
          <select
            id="filter-category"
            value={filters.category}
            onChange={(e) => handleChange('category', e.target.value)}
            className="bg-gray-800 border border-gray-700 text-white text-sm rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
          >
            <option value="">{t.filters.categoryAll}</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5 flex-grow md:w-64">
          <label htmlFor="filter-keyword" className="text-xs font-medium uppercase tracking-wider text-gray-500">{t.keyword}</label>
          <div className="relative">
            <input
              id="filter-keyword"
              type="text"
              placeholder={t.filters.searchPlaceholder}
              value={filters.keyword}
              onChange={(e) => setFilters({ ...filters, keyword: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-md pl-3 pr-10 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
            />
            <button
              type="submit"
              aria-label={locale === 'zh' ? '搜索' : 'Search'}
              className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white"
            >
               <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
