/**
 * Default number of BPs generated per scheduled batch run. The schedule fires
 * every 3 hours (8 runs/day), so the default yields up to 40 BPs per day while
 * keeping each run (~2 min per BP on reasoning-tier models) inside the
 * background function's 11-minute working budget.
 */
export const DEFAULT_BP_BATCH_SIZE = 5;

/** Hard ceiling so a misconfigured env var can't blow the function budget. */
export const MAX_BP_BATCH_SIZE = 10;

/**
 * Resolve and clamp the batch size from a raw env value. Non-numeric or
 * out-of-range inputs fall back to the default / nearest bound. Pure + tested.
 */
export function clampBatchSize(
  raw: unknown,
  def = DEFAULT_BP_BATCH_SIZE,
  max = MAX_BP_BATCH_SIZE
): number {
  const n =
    typeof raw === 'number' ? raw
    : typeof raw === 'string' && raw.trim() !== '' ? Number(raw)
    : NaN;
  if (!Number.isFinite(n)) return def;
  const floored = Math.floor(n);
  if (floored < 1) return 1;
  if (floored > max) return max;
  return floored;
}
