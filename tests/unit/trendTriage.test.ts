import { describe, it, expect } from 'vitest';
import {
  classifyTrendTopic,
  commercialIntentScore,
  isAnalyzableTopic,
  parseTopicClass,
} from '../../src/lib/services/trendTriage';

const topicOf = (input: Parameters<typeof classifyTrendTopic>[0]) =>
  classifyTrendTopic(input).topic;

describe('classifying from news publishers', () => {
  it('calls an opaque keyword sport when its coverage is all sports desks', () => {
    // "brickyard 400" is meaningless in isolation. This is the case the whole
    // news-context design exists for.
    expect(
      topicOf({
        keyword: 'brickyard 400',
        newsTitles: ['What to Watch: Brickyard 400 demands perfection in path to victory'],
        newsSources: ['NASCAR.com', 'https://sports.yahoo.com/articles/x', 'Hendrick Motorsports'],
      })
    ).toBe('sports');
  });

  it('calls a bare celebrity name entertainment from its coverage', () => {
    // No term in "sydney sweeney" is classifiable; only the publishers are.
    expect(
      topicOf({
        keyword: 'sydney sweeney',
        newsTitles: ['Sydney Sweeney spotted at premiere'],
        newsSources: ['TMZ', 'https://variety.com/2026/film/news/x'],
      })
    ).toBe('entertainment');
  });

  it('matches a publisher by URL host as well as by name', () => {
    expect(
      topicOf({ keyword: 'some name', newsSources: ['https://www.espn.com/nfl/story/_/id/1'] })
    ).toBe('sports');
  });
});

describe('classifying from the keyword alone', () => {
  it('recognises a fixture', () => {
    expect(topicOf({ keyword: 'chiefs vs bills' })).toBe('sports');
  });

  it('recognises a competition', () => {
    expect(topicOf({ keyword: 'champions league draw' })).toBe('sports');
    expect(topicOf({ keyword: 'wimbledon final' })).toBe('sports');
  });

  it('recognises an entertainment release or award', () => {
    expect(topicOf({ keyword: 'oscars 2026' })).toBe('entertainment');
    expect(topicOf({ keyword: 'stranger things season 3' })).toBe('entertainment');
  });

  // India and Singapore are collected regions. These reached generation as
  // `general` in production because both the fixture vocabulary and the
  // publishers were local.
  it.each([
    ['ভারত বনাম জিম্বাবুয়ে', 'Bengali "India versus Zimbabwe"'],
    ['భారత్ వర్సెస్ జింబాబ్వే', 'Telugu "India versus Zimbabwe"'],
    ['भारत बनाम ऑस्ट्रेलिया', 'Hindi "India versus Australia"'],
    ['ಕ್ರಿಕೆಟ್', 'Kannada "cricket"'],
    ['क्रिकेट स्कोर', 'Hindi "cricket score"'],
  ])('recognises a fixture written in a local script: %s (%s)', (keyword) => {
    expect(topicOf({ keyword })).toBe('sports');
  });

  it('leaves an ambiguous bare name alone rather than guessing', () => {
    // Under-blocking wastes one report; over-blocking loses an opportunity and
    // says nothing about it. The first failure is the cheaper one.
    expect(topicOf({ keyword: 'jordan bell' })).toBe('general');
  });
});

describe('keeping real opportunities analysable', () => {
  it.each([
    'irs tax refund status',
    'chatgpt down',
    'best travel insurance',
    'student loan forgiveness',
    'hurricane evacuation routes',
  ])('leaves %s analysable', (keyword) => {
    expect(topicOf({ keyword })).toBe('general');
  });

  it('does not classify on a single incidental headline word', () => {
    // "star" and "match" are everywhere; one of them must not be enough.
    expect(
      topicOf({ keyword: 'solar flare', newsTitles: ['A star is observed by researchers'] })
    ).toBe('general');
  });

  it('does classify once two weak signals corroborate', () => {
    expect(
      topicOf({
        keyword: 'some person',
        newsTitles: ['Actress and singer opens up about the new album'],
      })
    ).toBe('entertainment');
  });
});

describe('scores and helpers', () => {
  it('reports the evidence behind a verdict', () => {
    const result = classifyTrendTopic({ keyword: 'lakers vs celtics', newsSources: ['ESPN'] });
    expect(result.scores.sports).toBeGreaterThanOrEqual(3);
    expect(result.matched.some((m) => m.startsWith('sports:'))).toBe(true);
  });

  it('treats only sport and entertainment as unanalysable', () => {
    expect(isAnalyzableTopic('general')).toBe(true);
    expect(isAnalyzableTopic(null)).toBe(true);
    expect(isAnalyzableTopic('sports')).toBe(false);
    expect(isAnalyzableTopic('entertainment')).toBe(false);
  });

  it('parses stored values and rejects junk', () => {
    expect(parseTopicClass('sports')).toBe('sports');
    expect(parseTopicClass(null)).toBeNull();
    expect(parseTopicClass('nonsense')).toBeNull();
  });

  it('scores commercial intent higher for a keyword naming a service', () => {
    expect(commercialIntentScore('best tax software')).toBeGreaterThan(
      commercialIntentScore('solar flare')
    );
    expect(commercialIntentScore('solar flare')).toBe(0);
  });

  it('caps the commercial score at 100', () => {
    expect(commercialIntentScore('best free app software tool online course')).toBeLessThanOrEqual(100);
  });

  it('survives empty and malformed input', () => {
    expect(topicOf({ keyword: '' })).toBe('general');
    expect(topicOf({ keyword: 'x', newsTitles: [], newsSources: [] })).toBe('general');
  });
});
