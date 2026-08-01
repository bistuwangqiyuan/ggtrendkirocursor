/**
 * Text layout primitives for the report PDF.
 *
 * WHY THIS IS ITS OWN FILE
 * Wrapping mixed Chinese and English text is the only genuinely tricky part of
 * generating the document, and it is pure arithmetic: given a width measurement
 * function it needs no PDF library at all. Keeping it separate is what makes it
 * testable — a wrapping bug shows up as an overflowing line in a paid artifact,
 * which is not something to discover from a customer.
 */

/**
 * Characters that may start or end a line on their own.
 *
 * Latin script needs whole words kept together; Chinese has no spaces and breaks
 * between any two characters. Treating everything as breakable would hyphenate
 * English mid-word; treating nothing as breakable would push a whole Chinese
 * paragraph onto one line.
 */
const BREAKABLE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\u3000-\u303F]/;

/** Punctuation that must not be orphaned at the start of a line. */
const NO_LINE_START = new Set('，。、；：？！）】》」』%¢’”,.;:?!)]}>');
/** Punctuation that must not be left dangling at the end of a line. */
const NO_LINE_END = new Set('（【《「『([{<“‘');

export type Measure = (text: string) => number;

/**
 * Split text into the smallest units that must stay together: single CJK
 * characters, and runs of Latin/digits.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let latin = '';
  for (const char of text) {
    if (BREAKABLE.test(char)) {
      if (latin) {
        tokens.push(latin);
        latin = '';
      }
      tokens.push(char);
    } else if (char === ' ') {
      if (latin) {
        tokens.push(latin);
        latin = '';
      }
      tokens.push(' ');
    } else {
      latin += char;
    }
  }
  if (latin) tokens.push(latin);
  return tokens;
}

/**
 * Greedy line breaking. Honours explicit newlines, drops trailing spaces, and
 * hard-splits a single token that cannot fit on a line by itself (a 200-character
 * URL would otherwise run off the page).
 */
export function wrapText(text: string, maxWidth: number, measure: Measure): string[] {
  const lines: string[] = [];

  for (const paragraph of String(text ?? '').split(/\r?\n/)) {
    if (paragraph.trim() === '') {
      lines.push('');
      continue;
    }

    let line = '';
    const flush = () => {
      const trimmed = line.replace(/\s+$/, '');
      if (trimmed) lines.push(trimmed);
      line = '';
    };

    for (const token of tokenize(paragraph)) {
      // A space at the start of a wrapped line is invisible padding.
      if (token === ' ' && line === '') continue;

      const candidate = line + token;
      if (measure(candidate) <= maxWidth) {
        // Chinese typography: never leave an opening bracket at the line end or
        // a closing one at the start. Both look like a rendering error.
        line = candidate;
        continue;
      }

      if (line === '') {
        // The token alone is wider than the line: split it character by character.
        let chunk = '';
        for (const char of token) {
          if (measure(chunk + char) > maxWidth && chunk) {
            lines.push(chunk);
            chunk = char;
          } else {
            chunk += char;
          }
        }
        line = chunk;
        continue;
      }

      // Pull a trailing opening bracket down to the next line with its content.
      if (NO_LINE_END.has(line.slice(-1))) {
        const held = line.slice(-1);
        line = line.slice(0, -1);
        flush();
        line = held + token;
        continue;
      }

      // Keep closing punctuation attached to the line it belongs to, even if that
      // makes the line marginally too long — the alternative looks broken.
      if (NO_LINE_START.has(token)) {
        lines.push(line + token);
        line = '';
        continue;
      }

      flush();
      line = token;
    }
    flush();
  }

  // A single trailing blank line adds nothing but a gap before the next block.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Fit a single line into a width by truncating with an ellipsis. Used for table
 * cells, where wrapping would break the row grid.
 */
export function truncateToWidth(text: string, maxWidth: number, measure: Measure): string {
  const value = String(text ?? '');
  if (measure(value) <= maxWidth) return value;
  const ellipsis = '…';
  let out = '';
  for (const char of value) {
    if (measure(out + char + ellipsis) > maxWidth) break;
    out += char;
  }
  return out ? out + ellipsis : ellipsis;
}
