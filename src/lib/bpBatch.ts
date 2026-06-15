/** Default number of BPs generated per scheduled batch run. */
export const DEFAULT_BP_BATCH_SIZE = 10;

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
