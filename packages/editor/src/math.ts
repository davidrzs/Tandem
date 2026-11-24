/**
 * Math is plain text between dollar signs: `$…$` inline, `$$…$$` display.
 * This module is its one definition, shared by the markdown parser (which
 * reads a span as literal text), the serializer (which writes it raw and
 * escapes everything else) and the editor's rendering. The inline rules are
 * pandoc's, so prose dollars stay prose: the opening `$` is followed by a
 * non-space, the closing `$` follows a non-space and is not followed by a
 * digit. "$5 and $10" is not math; `$x_1$` is.
 */

export interface MathSpan {
  from: number;
  to: number;
  tex: string;
  display: boolean;
}

const SPACE = /\s/;
const DIGIT = /\d/;

/** The math span opening at `pos` and ending by `end`, or null. A backslash
 * inside inline math escapes the next character, so `$\$5$` is one span.
 * Math never holds a backtick: code spans bind tighter, as CommonMark has
 * them bind tighter than every other inline construct. */
export function mathSpanAt(text: string, pos: number, end = text.length): MathSpan | null {
  if (text[pos] !== "$" || pos + 1 >= end) return null;
  if (text[pos + 1] === "$") {
    const close = text.indexOf("$$", pos + 2);
    if (close < 0 || close + 2 > end) return null;
    const tex = text.slice(pos + 2, close);
    return tex.trim() && !tex.includes("`") ? { from: pos, to: close + 2, tex, display: true } : null;
  }
  if (SPACE.test(text[pos + 1]!)) return null;
  for (let i = pos + 1; i < end; i++) {
    const c = text[i]!;
    if (c === "\n" || c === "`") return null;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c !== "$") continue;
    if (text[i + 1] === "$") return null;
    if (SPACE.test(text[i - 1]!) || DIGIT.test(text[i + 1] ?? "")) continue;
    return { from: pos, to: i + 1, tex: text.slice(pos + 1, i), display: false };
  }
  return null;
}

/** Every math span in `text`, left to right, as the parser finds them. */
export function mathSpans(text: string): MathSpan[] {
  const spans: MathSpan[] = [];
  for (let i = text.indexOf("$"); i >= 0 && i < text.length; i = text.indexOf("$", i)) {
    const span = mathSpanAt(text, i);
    if (span) {
      spans.push(span);
      i = span.to;
    } else {
      i++;
    }
  }
  return spans;
}
