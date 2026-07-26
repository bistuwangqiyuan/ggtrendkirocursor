/**
 * Decides which hotwords are worth a business plan.
 *
 * WHY
 * Google Trends is dominated by sports fixtures and celebrity news. Those
 * hotwords produce near-identical business plans ("a fan engagement platform
 * for <team>", "a celebrity news aggregator for <name>"), so analysing them
 * repeatedly spends LLM budget to restate the same idea. The goal is online
 * services someone could actually build and sell, so sport and entertainment
 * are classified out before generation rather than filtered afterwards.
 *
 * HOW
 * A bare keyword is often ambiguous — "brickyard 400" and "wicked" say nothing
 * on their own. The Google Trends RSS attaches the news stories driving each
 * spike, and those are decisive: three headlines from NASCAR.com and Yahoo
 * Sports settle "brickyard 400" without needing to know what it is. So the
 * classifier reads the keyword, the headlines, and the publishers together.
 *
 * Evidence is scored rather than matched all-or-nothing. A publisher is the
 * strongest signal (ESPN does not cover tax software), the keyword itself is
 * nearly as strong (a keyword containing "nfl" is about the NFL), and a
 * headline term is suggestive but needs corroboration — "star" and "coach"
 * appear in plenty of unrelated news.
 *
 * Deliberately deterministic: no LLM call, no network, no name list to
 * maintain. Every verdict is reproducible from the inputs and unit-tested.
 */

/** What a hotword is about, as far as this site's purpose is concerned. */
export type TopicClass = 'sports' | 'entertainment' | 'general';

export interface TriageInput {
  keyword: string;
  /** Headlines of the news stories driving the spike, from the RSS feed. */
  newsTitles?: string[];
  /** Publisher names and article URLs for those stories. */
  newsSources?: string[];
}

export interface TriageResult {
  topic: TopicClass;
  /** Points behind the verdict, per class. Exposed so a call can be explained. */
  scores: Record<Exclude<TopicClass, 'general'>, number>;
  /** The signals that fired, for auditing a surprising verdict. */
  matched: string[];
}

/**
 * Points needed to classify. Reachable by one publisher match, one keyword
 * match, two headline terms, or a headline term plus a weak corroborating one —
 * i.e. never on a single incidental word.
 */
const CLASSIFY_THRESHOLD = 3;

const WEIGHT = { source: 3, keyword: 3, title: 2, weakTitle: 1 } as const;
/** One dominant publisher shouldn't outweigh everything else on its own. */
const SOURCE_CAP = 6;

/**
 * Publishers that only cover this beat. Matched against the RSS publisher name
 * and the article URL, so both "Yahoo Sports" and "sports.yahoo.com" hit.
 */
export const SPORTS_SOURCES = [
  'espn', 'sports.yahoo', 'yahoo sports', 'bleacherreport', 'bleacher report',
  'cbssports', 'cbs sports', 'foxsports', 'fox sports', 'nbcsports', 'nbc sports',
  'si.com', 'sports illustrated', 'skysports', 'sky sports', 'talksport',
  'theathletic', 'the athletic', 'goal.com', '90min', 'givemegsport', 'givemesport',
  'sportingnews', 'sporting news', 'sportskeeda', 'sportsnet', 'tsn.ca',
  'nfl.com', 'nba.com', 'mlb.com', 'nhl.com', 'ncaa.com', 'mlssoccer', 'wnba.com',
  'nascar', 'formula1.com', 'motorsport', 'autosport', 'indycar',
  'pgatour', 'lpga.com', 'atptour', 'wtatennis', 'olympics.com',
  'espncricinfo', 'cricbuzz', 'uefa.com', 'fifa.com', 'ufc.com', 'boxingscene',
  'marca.com', 'as.com', 'gazzetta', 'lequipe', 'bbc.co.uk/sport', 'bbc.com/sport',
  'hendrickmotorsports', 'racer.com', 'motorsportweek',
];

export const ENTERTAINMENT_SOURCES = [
  'tmz', 'variety.com', 'hollywoodreporter', 'hollywood reporter', 'deadline.com',
  'people.com', 'eonline', 'e! online', 'entertainmentweekly', 'entertainment weekly',
  'billboard.com', 'rollingstone', 'rolling stone', 'pitchfork', 'screenrant',
  'screen rant', 'collider', 'gamespot', 'polygon.com', 'comicbook.com',
  'justjared', 'pagesix', 'page six', 'usmagazine', 'us weekly', 'etonline',
  'popsugar', 'vulture.com', 'indiewire', 'cinemablend', 'thewrap', 'avclub',
  'digitalspy', 'radiotimes', 'koimoi', 'bollywoodhungama', 'pinkvilla',
  'soompi', 'allkpop', 'hindustantimes.com/entertainment',
];

/**
 * Terms distinctive enough to classify on their own when they appear in the
 * keyword. Competitions, formats, and results vocabulary — not team names,
 * which go stale and are covered by the publisher signal anyway.
 */
export const SPORTS_STRONG_TERMS = [
  // leagues and governing bodies
  'nfl', 'nba', 'mlb', 'nhl', 'ncaa', 'wnba', 'mls', 'epl', 'premier league',
  'la liga', 'serie a', 'bundesliga', 'ligue 1', 'eredivisie', 'uefa', 'fifa',
  'champions league', 'europa league', 'conference league', 'euroleague',
  'nrl', 'afl', 'cfl', 'ipl', 'bbl', 'psl', 'six nations',
  // tournaments and events
  'world cup', 'copa america', 'copa del rey', 'fa cup', 'carabao cup',
  'super bowl', 'world series', 'stanley cup', 'march madness', 'final four',
  'olympics', 'olympic', 'paralympic', 'commonwealth games', 'asian games',
  'wimbledon', 'roland garros', 'us open', 'australian open', 'french open',
  'the masters', 'ryder cup', 'solheim cup', 'pga championship', 'pga tour',
  'grand prix', 'formula 1', 'formula one', 'motogp', 'nascar', 'indycar',
  'indy 500', 'daytona 500', 'brickyard', 'le mans', 'tour de france',
  'giro d', 'vuelta a espana', 'ashes', 'test match', 'rugby world cup',
  'ufc ', 'wwe', 'aew ', 'summerslam', 'wrestlemania', 'royal rumble',
  // formats and results
  ' vs ', ' vs. ', ' v ', 'live score', 'final score', 'box score',
  'starting xi', 'starting lineup', 'penalty shootout', 'transfer news',
  'trade deadline', 'free agency', 'draft pick', 'injury report',
  'playoff', 'playoffs', 'standings', 'matchday', 'kickoff', 'kick-off',
  'qualifying', 'pole position', 'grand slam', 'medal table',
  // India and Singapore are collected regions, and cricket fixtures there
  // trend in local scripts where none of the terms above can match — the
  // publishers are local outlets too, so the keyword is the only signal left.
  // Observed in production as "ভারত বনাম জিম্বাবুয়ে" and
  // "భారత్ వర్సెస్ జింబాబ్వే" reaching generation as `general`.
  'बनाम', 'বনাম', 'వర్సెస్', 'ವಿರುದ್ಧ', 'എതിരെ', 'எதிராக',      // "versus"
  'क्रिकेट', 'ক্রিকেট', 'క్రికెట్', 'கிரிக்கெட்', 'ಕ್ರಿಕೆಟ್', 'ക്രിക്കറ്റ്',   // "cricket"
  'फुटबॉल', 'ফুটবল', 'ఫుట్‌బాల్', 'கால்பந்து', 'ಫುಟ್‌ಬಾಲ್',            // "football"
];

/** Suggestive in a headline but too common to classify alone. */
export const SPORTS_WEAK_TERMS = [
  'score', 'scores', 'highlights', 'lineup', 'lineups', 'fixture', 'fixtures',
  'halftime', 'full time', 'touchdown', 'home run', 'innings', 'wicket',
  'goalless', 'tipoff', 'roster', 'coach', 'head coach', 'quarterback',
  'striker', 'midfielder', 'season opener', 'game recap', 'world record',
  'championship', 'tournament', 'league', 'match', 'race', 'racing',
  'cricket', 'tennis', 'golf', 'soccer', 'football', 'basketball', 'baseball',
  'hockey', 'boxing', 'mma', 'athlete', 'sprinter', 'swimmer',
];

export const ENTERTAINMENT_STRONG_TERMS = [
  // awards and industry events
  'oscars', 'academy awards', 'grammy', 'grammys', 'emmy', 'emmys',
  'golden globe', 'bafta', 'met gala', 'tony awards', 'vmas', 'eurovision',
  'red carpet', 'box office', 'comic con', 'sundance', 'cannes film',
  // releases and platforms
  'trailer', 'teaser', 'season finale', 'series finale', 'season 2', 'season 3',
  'new episode', 'spoilers', 'netflix', 'hulu', 'disney+', 'disney plus',
  'prime video', 'hbo max', 'peacock', 'paramount+', 'apple tv+',
  'sequel', 'prequel', 'spin-off', 'reboot', 'soundtrack', 'new album',
  'world tour', 'tour dates', 'setlist', 'k-pop', 'kpop', 'bollywood',
  // formats
  'american idol', 'the voice', 'big brother', 'love island', 'the bachelor',
  'dancing with the stars', 'saturday night live', 'reality show',
  // person-centred curiosity that never implies a service
  'net worth', 'dating rumors', 'red carpet look', 'who is dating',
];

export const ENTERTAINMENT_WEAK_TERMS = [
  'actor', 'actress', 'singer', 'rapper', 'celebrity', 'comedian', 'director',
  'movie', 'film', 'series', 'sitcom', 'drama', 'anime', 'streaming',
  'album', 'single', 'song', 'chart', 'concert', 'festival', 'premiere',
  'cast', 'casting', 'star', 'stars', 'fans', 'fandom',
  'divorce', 'engaged', 'wedding', 'pregnant', 'baby', 'split', 'feud',
  'dies at', 'dead at', 'obituary', 'tribute', 'memoir',
  'slams', 'opens up', 'reveals', 'backlash', 'clapped back',
];

/**
 * Terms suggesting a buildable online product or service. Used only to rank
 * eligible candidates, never to reject one: hotwords rarely spell out their
 * commercial angle, so requiring a match would starve the pipeline. Ranking on
 * it puts the clearest opportunities first when the batch size is the binding
 * constraint.
 */
export const COMMERCIAL_INTENT_TERMS = [
  'app', 'apps', 'software', 'saas', 'platform', 'tool', 'website', 'online',
  'ai ', ' ai', 'chatbot', 'automation', 'api', 'plugin', 'extension',
  'subscription', 'pricing', 'price', 'cost', 'cheap', 'deal', 'discount',
  'coupon', 'free trial', 'alternative', 'alternatives', 'review', 'reviews',
  'best ', 'top 10', 'how to', 'tutorial', 'guide', 'template', 'generator',
  'calculator', 'converter', 'tracker', 'planner', 'checklist',
  'course', 'class', 'training', 'certification', 'bootcamp', 'exam',
  'insurance', 'loan', 'mortgage', 'refinance', 'tax', 'refund', 'invoice',
  'banking', 'payment', 'payout', 'crypto', 'invest', 'investing', 'stock',
  'booking', 'reservation', 'delivery', 'shipping', 'rental', 'repair',
  'near me', 'hiring', 'jobs', 'resume', 'salary', 'remote work',
  'visa', 'permit', 'license', 'registration', 'application form',
  'outage', 'down', 'not working', 'error', 'fix', 'troubleshoot', 'support',
  'login', 'sign up', 'cancel subscription', 'customer service',
];

/** Lowercase and pad so ' vs ' style terms can match at string boundaries. */
function haystack(s: string): string {
  return ` ${String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()} `;
}

function matches(text: string, terms: string[]): string[] {
  const hay = haystack(text);
  return terms.filter((term) => hay.includes(term));
}

function matchesAny(texts: string[], terms: string[]): string[] {
  const hits = new Set<string>();
  for (const text of texts) for (const t of matches(text, terms)) hits.add(t);
  return [...hits];
}

/**
 * Classify a hotword from its text and the news driving it.
 *
 * With no news context (rows collected before the feed carried it, or a manual
 * keyword) this still works, but only on terms present in the keyword itself —
 * a bare celebrity name will come back `general`. That is the intended
 * trade-off: under-blocking costs one wasted report, while over-blocking on a
 * guess would silently drop real opportunities.
 */
export function classifyTrendTopic(input: TriageInput): TriageResult {
  const keyword = input.keyword ?? '';
  const titles = (input.newsTitles ?? []).filter(Boolean);
  const sources = (input.newsSources ?? []).filter(Boolean);
  const matched: string[] = [];

  const score = (
    sourceTerms: string[],
    strongTerms: string[],
    weakTerms: string[],
    label: string
  ): number => {
    let total = 0;

    const sourceHits = matchesAny(sources, sourceTerms);
    if (sourceHits.length) {
      total += Math.min(SOURCE_CAP, sourceHits.length * WEIGHT.source);
      matched.push(...sourceHits.map((h) => `${label}:source:${h}`));
    }

    const keywordHits = matches(keyword, strongTerms);
    if (keywordHits.length) {
      total += WEIGHT.keyword;
      matched.push(...keywordHits.map((h) => `${label}:keyword:${h}`));
    }

    const titleHits = matchesAny(titles, strongTerms);
    if (titleHits.length) {
      total += WEIGHT.title;
      matched.push(...titleHits.map((h) => `${label}:title:${h}`));
    }

    const weakHits = matchesAny(titles, weakTerms);
    if (weakHits.length) {
      total += Math.min(WEIGHT.title, weakHits.length * WEIGHT.weakTitle);
      matched.push(...weakHits.map((h) => `${label}:weak:${h}`));
    }

    return total;
  };

  const sports = score(SPORTS_SOURCES, SPORTS_STRONG_TERMS, SPORTS_WEAK_TERMS, 'sports');
  const entertainment = score(
    ENTERTAINMENT_SOURCES, ENTERTAINMENT_STRONG_TERMS, ENTERTAINMENT_WEAK_TERMS, 'entertainment'
  );

  let topic: TopicClass = 'general';
  if (sports >= CLASSIFY_THRESHOLD || entertainment >= CLASSIFY_THRESHOLD) {
    topic = sports >= entertainment ? 'sports' : 'entertainment';
  }

  return { topic, scores: { sports, entertainment }, matched };
}

/** Whether a topic is worth spending a business plan on. */
export function isAnalyzableTopic(topic: TopicClass | null | undefined): boolean {
  // An unclassified row (collected before triage existed) stays eligible; the
  // picker re-classifies it from the keyword rather than discarding history.
  return topic !== 'sports' && topic !== 'entertainment';
}

/** Parse a stored value back to a TopicClass, tolerating nulls and junk. */
export function parseTopicClass(value: unknown): TopicClass | null {
  return value === 'sports' || value === 'entertainment' || value === 'general' ? value : null;
}

/**
 * 0-100 signal that a hotword implies a buildable online service. Saturates
 * quickly: three distinct commercial terms is already a clear signal, and more
 * of them does not make the opportunity better.
 */
export function commercialIntentScore(keyword: string): number {
  const hits = matches(keyword, COMMERCIAL_INTENT_TERMS);
  return Math.min(100, hits.length * 34);
}
