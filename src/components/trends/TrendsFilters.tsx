import React, { useState, useEffect } from 'react';

interface TrendsFiltersProps {
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

export function TrendsFilters({ initialFilters, categories, locale, translations }: TrendsFiltersProps) {
  const [filters, setFilters] = useState(initialFilters);
  const [isPending, setIsPending] = useState(false);

  const t = translations.trends;

  const updateURL = (newFilters: typeof filters) => {
    const params = new URLSearchParams(window.location.search);
    if (newFilters.timeRange) params.set('timeRange', newFilters.timeRange);
    if (newFilters.collectedWithin) params.set('collectedWithin', newFilters.collectedWithin);
    else params.delete('collectedWithin');
    if (newFilters.keyword) params.set('keyword', newFilters.keyword);
    else params.delete('keyword');
    if (newFilters.category) params.set('category', newFilters.category);
    else params.delete('category');
    
    // Reset page on filter change
    params.set('page', '1');

    // View Transitions handling handled by Astro ClientRouter usually intercepting link clicks.
    // But for programmatic update, we can just set window.location.
    // Or use navigate() if available from 'astro:transitions/client'.
    // Since this is a React component, standard window.location works but causes full reload unless intercepted.
    // Astro 5 ClientRouter intercepts popstate, but pushState might not trigger it automatically.
    // Actually, modifying query params and creating a new URL, then navigating to it.
    window.location.href = `/?${params.toString()}`;
  };

  const handleChange = (key: keyof typeof filters, value: string) => {
    const newFilters = { ...filters, [key]: value };
    setFilters(newFilters);
    // Debounce keyword search, immediate for others
    if (key === 'keyword') {
      // Implementation note: debouncing handled by effect or just submit on enter/blur for simplicity in this MVP
    } else {
      updateURL(newFilters);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    updateURL(filters);
  };

  return (
    <div class="bg-gray-900/50 border border-gray-800 p-4 rounded-lg mb-6 flex flex-col lg:flex-row gap-4 lg:items-end justify-between">
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-medium uppercase tracking-wider text-gray-500">{t.trendingWindow}</span>
        <div class="flex flex-wrap gap-2">
          {(['4h', '24h', '48h'] as const).map((range) => (
            <button
              key={range}
              onClick={() => handleChange('timeRange', range)}
              class={`px-4 py-2 rounded-md text-sm font-medium transition-colors border ${
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

      <form onSubmit={handleSearch} class="flex flex-wrap gap-3 items-end w-full lg:w-auto">
        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-medium uppercase tracking-wider text-gray-500">{t.collectedWithin.label}</label>
          <select
            value={filters.collectedWithin}
            onChange={(e) => handleChange('collectedWithin', e.target.value)}
            class="bg-gray-800 border border-gray-700 text-white text-sm rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
          >
            <option value="">{t.collectedWithin.all}</option>
            {COLLECTED_WITHIN_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>{t.collectedWithin[opt]}</option>
            ))}
          </select>
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-medium uppercase tracking-wider text-gray-500">{t.category}</label>
          <select
            value={filters.category}
            onChange={(e) => handleChange('category', e.target.value)}
            class="bg-gray-800 border border-gray-700 text-white text-sm rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
          >
            <option value="">{t.filters.categoryAll}</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </div>
        
        <div class="flex flex-col gap-1.5 flex-grow md:w-64">
          <label class="text-xs font-medium uppercase tracking-wider text-gray-500">{t.keyword}</label>
          <div class="relative">
            <input
              type="text"
              placeholder={t.filters.searchPlaceholder}
              value={filters.keyword}
              onChange={(e) => setFilters({ ...filters, keyword: e.target.value })}
              class="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-md pl-3 pr-10 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
            />
            <button 
              type="submit"
              class="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white"
            >
               <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

