import { describe, test, expect } from 'vitest';
import {
  detectModelFamily,
  providerRank,
  extractModelVersion,
  scoreModel,
  pickBestModel,
} from '../../src/lib/services/modelRegistry';

describe('detectModelFamily', () => {
  test('detects common families from the model id', () => {
    expect(detectModelFamily('glm-4')).toBe('glm');
    expect(detectModelFamily('glm-4.6')).toBe('glm');
    expect(detectModelFamily('qwen-plus')).toBe('qwen');
    expect(detectModelFamily('qwen3-max')).toBe('qwen');
    expect(detectModelFamily('deepseek-chat')).toBe('deepseek');
    expect(detectModelFamily('gpt-4o')).toBe('gpt');
    expect(detectModelFamily('claude-3-7-sonnet')).toBe('claude');
    expect(detectModelFamily('gemini-2.5-pro')).toBe('gemini');
    expect(detectModelFamily('moonshot-v1-128k')).toBe('kimi');
  });

  test('falls back to the base URL when the model is generic', () => {
    expect(detectModelFamily('default', 'https://open.bigmodel.cn/api/paas/v4')).toBe('glm');
    expect(detectModelFamily('x', 'https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('qwen');
  });
});

describe('extractModelVersion', () => {
  test('parses major/minor and ignores dates + param sizes', () => {
    expect(extractModelVersion('glm-4')).toEqual({ major: 4, minor: 0 });
    expect(extractModelVersion('glm-4.6')).toEqual({ major: 4, minor: 6 });
    expect(extractModelVersion('glm-5.2')).toEqual({ major: 5, minor: 2 });
    expect(extractModelVersion('qwen2.5-72b-instruct')).toEqual({ major: 2, minor: 5 });
    expect(extractModelVersion('claude-3-7-sonnet')).toEqual({ major: 3, minor: 7 });
    expect(extractModelVersion('gpt-4o-2024-08-06')).toEqual({ major: 4, minor: 0 });
    expect(extractModelVersion('deepseek-chat')).toEqual({ major: 0, minor: 0 });
  });

  test('does not treat dated snapshot tags as a version number', () => {
    // 1201 / 2604 are MMDD snapshot tags, not version 1201/2604.
    expect(extractModelVersion('qwen-max-1201')).toEqual({ major: 0, minor: 0 });
    expect(extractModelVersion('mistral-medium-2604')).toEqual({ major: 0, minor: 0 });
    expect(extractModelVersion('claude-3-5-sonnet-20241022')).toEqual({ major: 3, minor: 5 });
    expect(extractModelVersion('glm-4-0520')).toEqual({ major: 4, minor: 0 });
  });

  test('does not treat parameter sizes / context windows as a version', () => {
    // 72b is a parameter count, 128k a context window -- neither is version 72/128.
    expect(extractModelVersion('qwen-72b-chat')).toEqual({ major: 0, minor: 0 });
    expect(extractModelVersion('qwen2.5-72b-instruct')).toEqual({ major: 2, minor: 5 });
    expect(extractModelVersion('moonshot-v1-128k')).toEqual({ major: 1, minor: 0 });
  });
});

describe('scoreModel: generation dominates, then tier, then minor', () => {
  test('newer generation outranks an older flagship tier', () => {
    expect(scoreModel('glm-5.2')).toBeGreaterThan(scoreModel('glm-4-plus'));
  });
  test('within a generation, flagship tier and higher minor win', () => {
    expect(scoreModel('glm-4-plus')).toBeGreaterThan(scoreModel('glm-4'));
    expect(scoreModel('glm-4.6')).toBeGreaterThan(scoreModel('glm-4'));
    expect(scoreModel('glm-4')).toBeGreaterThan(scoreModel('glm-4-flash'));
  });
});

describe('pickBestModel', () => {
  test('auto-upgrades glm-4 to glm-5.2 when available', () => {
    const ids = ['glm-4', 'glm-4-plus', 'glm-4-flash', 'glm-4.6', 'glm-5.2', 'embedding-3', 'cogview-3'];
    expect(pickBestModel(ids, 'glm', 'glm-4')).toBe('glm-5.2');
  });

  test('upgrades to newest minor when no newer generation exists', () => {
    const ids = ['glm-4', 'glm-4-plus', 'glm-4.6', 'glm-4-flash'];
    expect(pickBestModel(ids, 'glm', 'glm-4')).toBe('glm-4.6');
  });

  test('never downgrades below the configured model', () => {
    // Only a weaker model is offered by the provider listing.
    expect(pickBestModel(['glm-4-flash'], 'glm', 'glm-4-plus')).toBe('glm-4-plus');
  });

  test('ignores other families and specialized variants', () => {
    const ids = ['qwen-max', 'glm-4-flash', 'text-embedding-v3', 'qwen-vl-max', 'qwen-audio'];
    // Only qwen chat models considered; qwen-max beats qwen-flash-less set.
    expect(pickBestModel(ids, 'qwen', 'qwen-plus')).toBe('qwen-max');
  });

  test('picks newest qwen generation', () => {
    const ids = ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen3-max', 'qwen2.5-72b-instruct'];
    expect(pickBestModel(ids, 'qwen', 'qwen-plus')).toBe('qwen3-max');
  });

  test('newer generation beats a dated flagship snapshot', () => {
    // qwen-max-1201 must NOT be read as version 1201 and outrank qwen3-max.
    const ids = ['qwen-max-1201', 'qwen3-max', 'qwen-plus'];
    expect(pickBestModel(ids, 'qwen', 'qwen-turbo')).toBe('qwen3-max');
  });

  test('prefers the clean alias over an equivalent dated snapshot', () => {
    const ids = ['qwen-max', 'qwen-max-1201'];
    expect(pickBestModel(ids, 'qwen', 'qwen-turbo')).toBe('qwen-max');
  });

  test('an old large-parameter model does not beat the current flagship', () => {
    // qwen-72b-chat must not be read as version 72 and outrank qwen-max.
    const ids = ['qwen-72b-chat', 'qwen-max', 'qwen-plus'];
    expect(pickBestModel(ids, 'qwen', 'qwen-turbo')).toBe('qwen-max');
  });

  test('returns the configured model when the listing is empty', () => {
    expect(pickBestModel([], 'glm', 'glm-4')).toBe('glm-4');
  });
});

describe('providerRank', () => {
  test('uses curated defaults', () => {
    expect(providerRank('gpt')).toBeGreaterThan(providerRank('qwen'));
    expect(providerRank('glm')).toBeGreaterThan(providerRank('kimi'));
    expect(providerRank('unknown-thing')).toBe(50);
  });

  test('honors an env JSON override', () => {
    const override = JSON.stringify({ glm: 99, qwen: 10 });
    expect(providerRank('glm', override)).toBe(99);
    expect(providerRank('qwen', override)).toBe(10);
    // families not in the override fall back to the curated default
    expect(providerRank('gpt', override)).toBe(95);
  });
});
