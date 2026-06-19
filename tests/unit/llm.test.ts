import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  parseLlmEndpoints,
  orderEndpointsForAttempt,
  isSwitchableLlmError,
  LlmError,
  resetLlmFailoverState,
  type LlmEndpoint,
} from '../../src/lib/services/llm';

const ENV_KEYS = ['LLM_API_KEY', 'LLM_API_BASE', 'LLM_MODEL', 'LLM_API_ENDPOINTS'] as const;

function saveEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

describe('parseLlmEndpoints', () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = saveEnv();
    resetLlmFailoverState();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => restoreEnv(envSnap));

  test('returns empty when nothing configured', () => {
    expect(parseLlmEndpoints()).toEqual([]);
  });

  test('parses legacy single-endpoint vars', () => {
    process.env.LLM_API_KEY = 'sk-test';
    process.env.LLM_API_BASE = 'https://example.com/v1/';
    process.env.LLM_MODEL = 'my-model';
    const eps = parseLlmEndpoints();
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({
      name: 'primary',
      base: 'https://example.com/v1',
      apiKey: 'sk-test',
      model: 'my-model',
    });
  });

  test('parses LLM_API_ENDPOINTS JSON array (takes precedence)', () => {
    process.env.LLM_API_KEY = 'legacy-key';
    process.env.LLM_API_ENDPOINTS = JSON.stringify([
      { name: 'a', base: 'https://a.com/v1', key: 'key-a', model: 'model-a' },
      { name: 'b', apiBase: 'https://b.com/v1', apiKey: 'key-b' },
    ]);
    const eps = parseLlmEndpoints();
    expect(eps).toHaveLength(2);
    expect(eps[0].name).toBe('a');
    expect(eps[1].apiKey).toBe('key-b');
    expect(eps[1].model).toBe('qwen-plus'); // default
  });

  test('skips entries without keys', () => {
    process.env.LLM_API_ENDPOINTS = JSON.stringify([
      { name: 'empty', base: 'https://x.com', key: '' },
      { name: 'ok', base: 'https://y.com', key: 'k' },
    ]);
    expect(parseLlmEndpoints()).toHaveLength(1);
    expect(parseLlmEndpoints()[0].name).toBe('ok');
  });
});

describe('orderEndpointsForAttempt', () => {
  const endpoints: LlmEndpoint[] = [
    { name: 'e0', base: 'https://0', apiKey: 'k0', model: 'm0' },
    { name: 'e1', base: 'https://1', apiKey: 'k1', model: 'm1' },
    { name: 'e2', base: 'https://2', apiKey: 'k2', model: 'm2' },
  ];

  test('puts preferred index first', () => {
    const ordered = orderEndpointsForAttempt(endpoints, 1, new Map());
    expect(ordered.map((o) => o.index)).toEqual([1, 2, 0]);
  });

  test('skips cooled-down endpoints', () => {
    const cooldown = new Map([[1, Date.now() + 60_000]]);
    const ordered = orderEndpointsForAttempt(endpoints, 1, cooldown);
    expect(ordered.map((o) => o.index)).toEqual([2, 0]);
  });

  test('rank-first ordering tries the highest-ranked endpoint first', () => {
    // ranks: e0=10, e1=30, e2=20 -> order by rank desc: 1, 2, 0
    const ordered = orderEndpointsForAttempt(endpoints, 0, new Map(), Date.now(), [10, 30, 20]);
    expect(ordered.map((o) => o.index)).toEqual([1, 2, 0]);
  });

  test('rank-first uses preferred-rotation only as a tiebreak among equal ranks', () => {
    // all equal rank -> falls back to preferred-first rotation (preferred=2)
    const ordered = orderEndpointsForAttempt(endpoints, 2, new Map(), Date.now(), [5, 5, 5]);
    expect(ordered.map((o) => o.index)).toEqual([2, 0, 1]);
  });

  test('rank-first still drops cooled-down endpoints', () => {
    const cooldown = new Map([[1, Date.now() + 60_000]]);
    const ordered = orderEndpointsForAttempt(endpoints, 0, cooldown, Date.now(), [10, 30, 20]);
    expect(ordered.map((o) => o.index)).toEqual([2, 0]);
  });
});

describe('isSwitchableLlmError', () => {
  test('does not switch on NOT_CONFIGURED', () => {
    expect(isSwitchableLlmError(new LlmError('LLM_NOT_CONFIGURED', 'x'))).toBe(false);
  });

  test('does not switch on BAD_RESPONSE (retry same endpoint first)', () => {
    expect(isSwitchableLlmError(new LlmError('LLM_BAD_RESPONSE', 'x'))).toBe(false);
  });

  test('switches on HTTP and timeout errors', () => {
    expect(isSwitchableLlmError(new LlmError('LLM_HTTP_ERROR', 'x'))).toBe(true);
    expect(isSwitchableLlmError(new LlmError('LLM_TIMEOUT', 'x'))).toBe(true);
  });
});
