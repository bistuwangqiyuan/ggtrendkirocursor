import React from 'react';

interface PaginationProps {
  basePath?: string;
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  locale: 'zh' | 'en';
  translations: any;
}

export function Pagination({ basePath = '/trends', currentPage, totalPages, totalItems, pageSize, locale, translations }: PaginationProps) {
  const t = translations.trends.pagination;

  const handlePageChange = (page: number) => {
    const params = new URLSearchParams(window.location.search);
    params.set('page', page.toString());
    window.location.href = `${basePath}?${params.toString()}`;
  };

  const startItem = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(currentPage * pageSize, totalItems);

  return (
    <div className="flex flex-col sm:flex-row justify-between items-center mt-6 gap-4">
      <div className="text-sm text-gray-400">
        {t.showing} <span className="font-medium text-white">{startItem}</span> {t.to} <span className="font-medium text-white">{endItem}</span> {t.of} <span className="font-medium text-white">{totalItems}</span> {t.results}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => handlePageChange(currentPage - 1)}
          disabled={currentPage <= 1}
          className="px-3 py-1 rounded border border-gray-700 bg-gray-800 text-sm font-medium text-gray-300 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t.prev}
        </button>

        <div className="flex items-center gap-1">
          <span className="px-3 py-1 rounded border border-blue-500 bg-blue-600 text-white text-sm font-medium">
            {currentPage}
          </span>
          <span className="text-gray-500">/</span>
          <span className="px-3 py-1 text-gray-400 text-sm">
            {totalPages}
          </span>
        </div>

        <button
          onClick={() => handlePageChange(currentPage + 1)}
          disabled={currentPage >= totalPages}
          className="px-3 py-1 rounded border border-gray-700 bg-gray-800 text-sm font-medium text-gray-300 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t.next}
        </button>
      </div>
    </div>
  );
}
