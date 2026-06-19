/**
 * Automatic model selection + upgrade.
 *
 * Goal: always run on the best available model for each configured provider,
 * and auto-upgrade to newer generations as they ship (e.g. glm-4 -> glm-5.2)
 * WITHOUT a code change. We discover models at runtime from each provider's
 * OpenAI-compatible `/v1/models` endpoint, rank them with a version+tier
 * heuristic, and pick the best one in the same model family as the configured
 * model. Results are cached (default 12h) per provider; on any failure we fall
 * back to the configured model and never downgrade below it.
 *
 * Cross-provider preference (which provider to try first) uses a curated,
 * env-overridable rank — see `providerRank`.
 */

export interface ModelEndpointLike {
  name?: string;
  base: string;
  apiKey: string;
  model: string;
  /** Override family detection (e.g. 'glm', 'qwen'). */
  family?: string;
  /** Set false (or pin=true) to disable auto-upgrade for this endpoint. */
  autoUpgrade?: boolean;
  pin?: boolean;
}

const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const NEGATIVE_CACHE_TTL_MS = 30 * 60 * 1000; // 30m after a failed probe
const MODELS_FETCH_TIMEOUT_MS = 6000;

/**
 * Curated cross-provider quality ranking (higher = preferred first). This is a
 * pragmatic default in lieu of a live leaderboard; override per-deployment via
 * the LLM_PROVIDER_RANK env (JSON map, e.g. {"glm":99,"qwen":80}).
 */
const DEFAULT_PROVIDER_RANK: Record<string, number> = {
  gpt: 95,
  claude: 94,
  gemini: 92,
  glm: 90,
  deepseek: 88,
  qwen: 86,
  grok: 84,
  kimi: 80,
  doubao: 78,
};

/** Specialized / non-general-chat variants we never auto-select (kept compatible
 * with the app's response_format=json_object + temperature chat contract). The
 * configured model is always exempt (see pickBestModel). */
const EXCLUDE_RE =
  /(embedding|embed|rerank|vision|-v\b|-v\d|image|cogview|flux|stable|paint|audio|tts|asr|whisper|voice|realtime|moderation|guard|ocr|video|search|coder|code-|-code|math|rerank|detect|caption)/i;

/** Tier keywords -> weight. Flagship tiers win within a generation. */
const TIER_RULES: { re: RegExp; weight: number }[] = [
  { re: /(ultra|max|opus|flagship|0?pro\b|preview-pro)/i, weight: 9 },
  { re: /(pro|plus|advanced|sonnet|large)/i, weight: 7 },
  { re: /(turbo)/i, weight: 4 },
  { re: /(air|flash|lite|mini|nano|tiny|small|haiku|fast|economy)/i, weight: 2 },
];
const BASE_TIER_WEIGHT = 6;

/** Detect a provider/model family from the model id and/or base URL. Pure. */
export function detectModelFamily(model: string, base = ''): string {
  const s = `${model || ''} ${base || ''}`.toLowerCase();
  if (/glm|zhipu|bigmodel|chatglm/.test(s)) return 'glm';
  if (/qwen|dashscope|tongyi|qwq/.test(s)) return 'qwen';
  if (/deepseek/.test(s)) return 'deepseek';
  if (/claude|anthropic/.test(s)) return 'claude';
  if (/gemini|googleapis|generativelanguage/.test(s)) return 'gemini';
  if (/moonshot|kimi/.test(s)) return 'kimi';
  if (/doubao|volc|ark\b/.test(s)) return 'doubao';
  if (/grok|x\.ai|xai/.test(s)) return 'grok';
  if (/gpt|openai|o[134]\b|chatgpt/.test(s)) return 'gpt';
  // Fallback: first alphabetic token of the model id.
  const tok = (model || '').toLowerCase().match(/[a-z]+/)?.[0];
  return tok || 'unknown';
}

/** Curated provider rank with optional env override (LLM_PROVIDER_RANK JSON). Pure-ish. */
export function providerRank(family: string, env = process.env.LLM_PROVIDER_RANK): number {
  if (env) {
    try {
      const map = JSON.parse(env);
      if (map && typeof map === 'object' && typeof map[family] === 'number') {
        return map[family];
      }
    } catch {
      /* ignore malformed override */
    }
  }
  return DEFAULT_PROVIDER_RANK[family] ?? 50;
}

/** Extract a (major, minor) version from a model id, ignoring date snapshots and
 * parameter sizes (e.g. the 72 in "72b"). Pure. */
export function extractModelVersion(id: string): { major: number; minor: number } {
  const noDate = (id || '')
    .toLowerCase()
    .replace(/\b20\d{2}[-_]?\d{2}[-_]?\d{2}\b/g, ' ') // full date: 2026-04-01 / 20260401
    .replace(/[-_]\d{4,8}\b/g, ' ') // snapshot tag: -1201 / -2604 / -250601 (never a real version)
    .replace(/\b\d+(?:\.\d+)?\s*[bmk]\b/g, ' '); // param size / context: 72b, 7b, 1m, 128k (not a version)
  const m = noDate.match(/(\d+)(?:[._-](\d+))?/);
  if (!m) return { major: 0, minor: 0 };
  const major = parseInt(m[1], 10) || 0;
  let minor = m[2] ? parseInt(m[2], 10) || 0 : 0;
  // A large "minor" is almost certainly a parameter count (72b, 235b) — ignore.
  if (minor > 20) minor = 0;
  return { major, minor };
}

function tierWeight(id: string): number {
  for (const { re, weight } of TIER_RULES) {
    if (re.test(id)) return weight;
  }
  return BASE_TIER_WEIGHT;
}

function hasDateSnapshot(id: string): boolean {
  return /\b20\d{2}[-_]?\d{2}[-_]?\d{2}\b|-\d{4}\b|latest/i.test(id);
}

/** Quality score: newer version (generation then minor) dominates, tier breaks
 * ties within the same version; clean aliases slightly preferred over dated
 * snapshots. Pure. */
export function scoreModel(id: string): number {
  const { major, minor } = extractModelVersion(id);
  const tier = tierWeight(id);
  const datedPenalty = hasDateSnapshot(id) ? 5 : 0;
  return major * 100000 + minor * 1000 + tier * 10 - datedPenalty;
}

function isEligibleModel(id: string): boolean {
  if (!id) return false;
  return !EXCLUDE_RE.test(id);
}

/**
 * Choose the best model id in `family` from discovered `candidateIds`, never
 * downgrading below `configuredModel` (which is always considered and is exempt
 * from the specialized-variant exclusion). Returns the configured model if no
 * candidate scores higher. Pure.
 */
export function pickBestModel(
  candidateIds: string[],
  family: string,
  configuredModel: string
): string {
  const seen = new Set<string>();
  const pool: string[] = [];
  // Configured model is always in the pool (the never-downgrade floor).
  if (configuredModel) {
    pool.push(configuredModel);
    seen.add(configuredModel.toLowerCase());
  }
  for (const raw of candidateIds || []) {
    const id = (raw || '').trim();
    if (!id || seen.has(id.toLowerCase())) continue;
    if (detectModelFamily(id) !== family) continue;
    if (!isEligibleModel(id)) continue;
    seen.add(id.toLowerCase());
    pool.push(id);
  }
  if (pool.length === 0) return configuredModel;

  let best = configuredModel || pool[0];
  let bestScore = configuredModel ? scoreModel(configuredModel) : -Infinity;
  for (const id of pool) {
    const sc = scoreModel(id);
    if (sc > bestScore || (sc === bestScore && id.length < best.length)) {
      best = id;
      bestScore = sc;
    }
  }
  return best;
}

// ---- runtime resolution (impure: network + cache) ----

interface CacheEntry {
  model: string;
  expiresAt: number;
}
/** cacheKey (base|family) -> resolved model + expiry. Module-level so warm
 * serverless instances reuse it. */
const resolvedModelCache = new Map<string, CacheEntry>();

function cacheTtlMs(): number {
  const n = Number(process.env.LLM_MODELS_CACHE_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CACHE_TTL_MS;
}

function autoUpgradeEnabled(ep: ModelEndpointLike): boolean {
  if (ep.pin === true || ep.autoUpgrade === false) return false;
  const flag = (process.env.LLM_MODEL_AUTOUPGRADE ?? 'true').trim().toLowerCase();
  return flag !== 'false' && flag !== '0' && flag !== 'off';
}

function familyOf(ep: ModelEndpointLike): string {
  return (ep.family && ep.family.trim()) || detectModelFamily(ep.model, ep.base);
}

type FetchLike = typeof fetch;

/** Fetch the provider's model ids from its OpenAI-compatible /models endpoint. */
async function fetchProviderModelIds(ep: ModelEndpointLike, fetchImpl: FetchLike): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${ep.base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${ep.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    return list
      .map((m) => (typeof m === 'string' ? m : m?.id))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Synchronously read the cached resolved model (if fresh) without probing. */
export function getCachedResolvedModel(ep: ModelEndpointLike, now = Date.now()): string | null {
  if (!autoUpgradeEnabled(ep)) return ep.model;
  const key = `${ep.base}|${familyOf(ep)}`;
  const hit = resolvedModelCache.get(key);
  return hit && hit.expiresAt > now ? hit.model : null;
}

/**
 * Resolve the best model for an endpoint: cached -> probe /models -> rank ->
 * cache. Never throws and never downgrades below the configured model.
 */
export async function resolveBestModel(
  ep: ModelEndpointLike,
  fetchImpl: FetchLike = fetch,
  now = Date.now()
): Promise<string> {
  if (!autoUpgradeEnabled(ep)) return ep.model;

  const family = familyOf(ep);
  const key = `${ep.base}|${family}`;
  const cached = resolvedModelCache.get(key);
  if (cached && cached.expiresAt > now) return cached.model;

  try {
    const ids = await fetchProviderModelIds(ep, fetchImpl);
    if (ids.length === 0) {
      // Negative cache: don't hammer a provider that won't list models.
      resolvedModelCache.set(key, { model: ep.model, expiresAt: now + NEGATIVE_CACHE_TTL_MS });
      return ep.model;
    }
    const best = pickBestModel(ids, family, ep.model);
    resolvedModelCache.set(key, { model: best, expiresAt: now + cacheTtlMs() });
    return best;
  } catch {
    resolvedModelCache.set(key, { model: ep.model, expiresAt: now + NEGATIVE_CACHE_TTL_MS });
    return ep.model;
  }
}

/** Clear the resolved-model cache (tests/diagnostics). */
export function resetModelRegistry(): void {
  resolvedModelCache.clear();
}
