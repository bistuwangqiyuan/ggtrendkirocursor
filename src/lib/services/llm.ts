/**
 * OpenAI-compatible Chat Completions client with multi-endpoint auto-failover.
 *
 * Single endpoint (legacy):
 *   LLM_API_KEY, LLM_API_BASE, LLM_MODEL
 *
 * Multiple endpoints (auto-switch on failure):
 *   LLM_API_ENDPOINTS='[{"name":"dashscope","base":"https://...","key":"sk-...","model":"qwen-plus"},...]'
 *
 * Shared:
 *   LLM_TIMEOUT_MS (default 45000)
 */

const DEFAULT_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen-plus';
const DEFAULT_TIMEOUT_MS = 45000;
/** Skip endpoints that failed recently (ms). */
const ENDPOINT_COOLDOWN_MS = 120_000;
/** Longer skip for auth/quota failures (dead/exhausted keys) so valid APIs are preferred. */
const AUTH_QUOTA_COOLDOWN_MS = 900_000;

export class LlmError extends Error {
  code: 'LLM_NOT_CONFIGURED' | 'LLM_TIMEOUT' | 'LLM_BAD_RESPONSE' | 'LLM_HTTP_ERROR' | 'LLM_ALL_ENDPOINTS_FAILED';
  /** HTTP status when code is LLM_HTTP_ERROR (used to distinguish auth/quota faults). */
  httpStatus?: number;
  constructor(code: LlmError['code'], message: string, httpStatus?: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.name = 'LlmError';
  }
}

/** Auth/quota HTTP statuses indicate a dead or exhausted key; skip it for longer. */
export function isAuthOrQuotaStatus(status: number | undefined): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429;
}

export interface LlmEndpoint {
  name: string;
  base: string;
  apiKey: string;
  model: string;
}

export interface LlmJsonResult<T> {
  data: T;
  model: string;
  provider?: string;
  tokensUsed?: number;
  raw: string;
}

interface ChatOptions {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

/** Last successful endpoint index (in-memory; warm serverless instances reuse it). */
let preferredEndpointIndex = 0;
/** endpoint index -> epoch ms until which the endpoint is skipped */
const endpointCooldownUntil = new Map<number, number>();

function getTimeoutMs(): number {
  const n = Number(process.env.LLM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/** Parse configured LLM endpoints. Exported for unit tests. */
export function parseLlmEndpoints(): LlmEndpoint[] {
  const raw = process.env.LLM_API_ENDPOINTS?.trim();
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const endpoints = arr
          .map((e: any, i: number) => {
            const apiKey = String(e?.key ?? e?.apiKey ?? '').trim();
            if (!apiKey) return null;
            const base = String(e?.base ?? e?.apiBase ?? DEFAULT_BASE).trim().replace(/\/$/, '');
            return {
              name: String(e?.name ?? `endpoint-${i + 1}`).trim() || `endpoint-${i + 1}`,
              base: base || DEFAULT_BASE,
              apiKey,
              model: String(e?.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
            } satisfies LlmEndpoint;
          })
          .filter((e): e is LlmEndpoint => e !== null);
        if (endpoints.length > 0) return endpoints;
      }
    } catch {
      // fall through to legacy single-endpoint vars
    }
  }

  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) return [];

  return [{
    name: 'primary',
    base: (process.env.LLM_API_BASE?.trim() || DEFAULT_BASE).replace(/\/$/, ''),
    apiKey,
    model: process.env.LLM_MODEL?.trim() || DEFAULT_MODEL,
  }];
}

/** Order endpoints: preferred first, then others; skip cooled-down entries. */
export function orderEndpointsForAttempt(
  endpoints: LlmEndpoint[],
  preferred: number,
  cooldown: Map<number, number>,
  now = Date.now()
): { endpoint: LlmEndpoint; index: number }[] {
  if (endpoints.length === 0) return [];
  const safePreferred = ((preferred % endpoints.length) + endpoints.length) % endpoints.length;
  const order: number[] = [];
  for (let i = 0; i < endpoints.length; i++) {
    order.push((safePreferred + i) % endpoints.length);
  }
  return order
    .filter((idx) => (cooldown.get(idx) ?? 0) <= now)
    .map((idx) => ({ endpoint: endpoints[idx], index: idx }));
}

/** Whether failure should trigger switching to the next endpoint. */
export function isSwitchableLlmError(err: unknown): boolean {
  if (!(err instanceof LlmError)) return true;
  if (err.code === 'LLM_NOT_CONFIGURED') return false;
  if (err.code === 'LLM_BAD_RESPONSE') return false; // retry same endpoint once, then switch
  return true; // HTTP, timeout, all-endpoints
}

export function isLlmConfigured(): boolean {
  return parseLlmEndpoints().length > 0;
}

/** Extract the first balanced JSON object from a string (handles ```json fences / prose). */
export function extractJsonObject(text: string): string | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

function markEndpointFailure(index: number, cooldownMs: number = ENDPOINT_COOLDOWN_MS): void {
  endpointCooldownUntil.set(index, Date.now() + cooldownMs);
}

function markEndpointSuccess(index: number): void {
  preferredEndpointIndex = index;
  endpointCooldownUntil.delete(index);
}

async function chatOnce(
  endpoint: LlmEndpoint,
  opts: ChatOptions,
  timeoutMs: number
): Promise<{ content: string; model: string; tokensUsed?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: endpoint.model,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 4000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LlmError('LLM_HTTP_ERROR', `LLM HTTP ${res.status} [${endpoint.name}]: ${body.slice(0, 300)}`, res.status);
    }

    const json: any = await res.json();
    const content: string = json?.choices?.[0]?.message?.content ?? '';
    const tokensUsed: number | undefined = json?.usage?.total_tokens;
    const usedModel: string = json?.model || endpoint.model;
    if (!content) throw new LlmError('LLM_BAD_RESPONSE', `Empty completion [${endpoint.name}]`);
    return { content, model: usedModel, tokensUsed };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new LlmError('LLM_TIMEOUT', `Timed out after ${timeoutMs}ms [${endpoint.name}]`);
    }
    throw new LlmError('LLM_HTTP_ERROR', `[${endpoint.name}] ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function tryEndpointOnce<T>(
  endpoint: LlmEndpoint,
  index: number,
  opts: ChatOptions,
  timeoutMs: number
): Promise<LlmJsonResult<T>> {
  const { content, model, tokensUsed } = await chatOnce(endpoint, opts, timeoutMs);
  const jsonStr = extractJsonObject(content) ?? content;
  try {
    const data = JSON.parse(jsonStr) as T;
    markEndpointSuccess(index);
    return { data, model, provider: endpoint.name, tokensUsed, raw: content };
  } catch {
    throw new LlmError('LLM_BAD_RESPONSE', `Could not parse JSON [${endpoint.name}]`);
  }
}

/**
 * Request JSON from the LLM, auto-switching across configured endpoints on failure.
 * Each endpoint gets up to 2 attempts (for transient parse errors). No template fallback.
 */
export async function generateJson<T = any>(opts: ChatOptions): Promise<LlmJsonResult<T>> {
  const endpoints = parseLlmEndpoints();
  if (endpoints.length === 0) {
    throw new LlmError('LLM_NOT_CONFIGURED', 'No LLM API configured (set LLM_API_KEY or LLM_API_ENDPOINTS)');
  }

  const timeoutMs = getTimeoutMs();
  const ordered = orderEndpointsForAttempt(endpoints, preferredEndpointIndex, endpointCooldownUntil);
  if (ordered.length === 0) {
    // All cooled down — try full list anyway
    ordered.push(...endpoints.map((endpoint, index) => ({ endpoint, index })));
  }

  const errors: string[] = [];

  for (const { endpoint, index } of ordered) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await tryEndpointOnce<T>(endpoint, index, opts, timeoutMs);
      } catch (err) {
        const msg = (err as Error).message || 'unknown';
        errors.push(msg);

        if (err instanceof LlmError && err.code === 'LLM_BAD_RESPONSE' && attempt === 0) {
          continue; // one retry on same endpoint for parse errors
        }

        if (isSwitchableLlmError(err)) {
          // Auth/quota faults (dead or exhausted keys) get a longer cooldown so the
          // rotation automatically prefers endpoints that actually work.
          const httpStatus = err instanceof LlmError ? err.httpStatus : undefined;
          markEndpointFailure(index, isAuthOrQuotaStatus(httpStatus) ? AUTH_QUOTA_COOLDOWN_MS : ENDPOINT_COOLDOWN_MS);
          break; // try next endpoint
        }
        throw err;
      }
    }
  }

  throw new LlmError(
    'LLM_ALL_ENDPOINTS_FAILED',
    `All ${endpoints.length} LLM endpoint(s) failed: ${errors.slice(-3).join(' | ')}`
  );
}

/** Reset in-memory failover state (for tests). */
export function resetLlmFailoverState(): void {
  preferredEndpointIndex = 0;
  endpointCooldownUntil.clear();
}

export interface LlmEndpointStatus {
  name: string;
  model: string;
  base: string;
  preferred: boolean;
  cooledDown: boolean;
  cooldownUntil: string | null;
}

/**
 * Read-only diagnostics snapshot of the configured endpoints and their failover
 * state. Never exposes API keys.
 */
export function getLlmEndpointStatus(now = Date.now()): {
  configured: boolean;
  count: number;
  endpoints: LlmEndpointStatus[];
} {
  const endpoints = parseLlmEndpoints();
  const safePreferred = endpoints.length > 0
    ? ((preferredEndpointIndex % endpoints.length) + endpoints.length) % endpoints.length
    : 0;
  return {
    configured: endpoints.length > 0,
    count: endpoints.length,
    endpoints: endpoints.map((e, i) => {
      const until = endpointCooldownUntil.get(i) ?? 0;
      return {
        name: e.name,
        model: e.model,
        base: e.base,
        preferred: i === safePreferred,
        cooledDown: until > now,
        cooldownUntil: until > now ? new Date(until).toISOString() : null,
      };
    }),
  };
}
