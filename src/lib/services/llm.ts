/**
 * Minimal OpenAI-compatible Chat Completions client (no SDK dependency).
 *
 * Configured purely via environment variables so the provider can be swapped:
 *   LLM_API_KEY   (required) - bearer token; absence is a hard error (no fallback)
 *   LLM_API_BASE  (optional) - default: Aliyun DashScope OpenAI-compatible endpoint
 *   LLM_MODEL     (optional) - default: qwen-plus
 *   LLM_TIMEOUT_MS(optional) - default: 45000
 */

export class LlmError extends Error {
  code: 'LLM_NOT_CONFIGURED' | 'LLM_TIMEOUT' | 'LLM_BAD_RESPONSE' | 'LLM_HTTP_ERROR';
  constructor(code: LlmError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'LlmError';
  }
}

export interface LlmJsonResult<T> {
  data: T;
  model: string;
  tokensUsed?: number;
  raw: string;
}

function getConfig() {
  const apiKey = process.env.LLM_API_KEY?.trim();
  const base = (process.env.LLM_API_BASE?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
  const model = process.env.LLM_MODEL?.trim() || 'qwen-plus';
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 45000);
  return { apiKey, base, model, timeoutMs };
}

export function isLlmConfigured(): boolean {
  return !!process.env.LLM_API_KEY?.trim();
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

interface ChatOptions {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

async function chatOnce(opts: ChatOptions): Promise<{ content: string; model: string; tokensUsed?: number }> {
  const { apiKey, base, model, timeoutMs } = getConfig();
  if (!apiKey) {
    throw new LlmError('LLM_NOT_CONFIGURED', 'LLM_API_KEY is not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
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
      throw new LlmError('LLM_HTTP_ERROR', `LLM HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    const json: any = await res.json();
    const content: string = json?.choices?.[0]?.message?.content ?? '';
    const tokensUsed: number | undefined = json?.usage?.total_tokens;
    const usedModel: string = json?.model || model;
    if (!content) throw new LlmError('LLM_BAD_RESPONSE', 'Empty completion content');
    return { content, model: usedModel, tokensUsed };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new LlmError('LLM_TIMEOUT', `LLM request timed out after ${timeoutMs}ms`);
    }
    throw new LlmError('LLM_HTTP_ERROR', (err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Request a JSON object from the LLM. Retries once on timeout / unparseable output.
 * Throws LlmError on missing key (no template fallback, per spec).
 */
export async function generateJson<T = any>(opts: ChatOptions): Promise<LlmJsonResult<T>> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { content, model, tokensUsed } = await chatOnce(opts);
      const jsonStr = extractJsonObject(content) ?? content;
      try {
        const data = JSON.parse(jsonStr) as T;
        return { data, model, tokensUsed, raw: content };
      } catch {
        lastErr = new LlmError('LLM_BAD_RESPONSE', 'Could not parse JSON from LLM response');
      }
    } catch (err) {
      lastErr = err as Error;
      // Do not retry a configuration error — it will never succeed.
      if (err instanceof LlmError && err.code === 'LLM_NOT_CONFIGURED') throw err;
    }
  }
  throw lastErr ?? new LlmError('LLM_BAD_RESPONSE', 'Unknown LLM failure');
}
