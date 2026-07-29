/**
 * Recency windows for the business-plan list.
 *
 * The archive grows by up to 40 reports a day and never shrinks, so an
 * unfiltered list buries this week's opportunities under months of older ones.
 * The site's purpose is finding online-service opportunities that are live
 * *now*, so the list defaults to the last week and lets a visitor widen it.
 *
 * Shared by the page and the read API so one parse governs both, and kept
 * separate from the trends collection window (hours, not days) because they
 * answer different questions.
 */

export const BP_WINDOW_DAYS: Record<string, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

/** Offered in the UI, in the order shown. `all` disables the filter. */
export const BP_WINDOW_OPTIONS = ['7d', '30d', '90d', '1y', 'all'] as const;
export type BpWindow = (typeof BP_WINDOW_OPTIONS)[number];

/**
 * A week of history. At up to 40 reports a day this still fills several pages,
 * and it is the shortest window that keeps a hotword's opportunity plausibly
 * still open. Longer windows stay one click away.
 */
export const BP_WINDOW_DEFAULT: BpWindow = '7d';

/** Coerce a query-string value to a supported window, falling back to the default. */
export function normalizeBpWindow(raw: string | null | undefined): BpWindow {
  const value = (raw ?? '').trim();
  return (BP_WINDOW_OPTIONS as readonly string[]).includes(value)
    ? (value as BpWindow)
    : BP_WINDOW_DEFAULT;
}

/** Days implied by a window, or undefined for `all` (no filtering). */
export function bpWindowDays(window: string): number | undefined {
  return BP_WINDOW_DAYS[window];
}
