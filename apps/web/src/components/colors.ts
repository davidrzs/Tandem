/** Deterministic, calm per-author colors shared by blame spans, presence
 * carets, and avatars — one identity, one hue everywhere. AI authorship is
 * the exception: it is always the accent teal, so "teal in the body means an
 * agent wrote it" holds across every human's hue. */

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Stable identity key for an author (the AI half of a user is its own identity). */
export function authorKey(userId: string, ai: boolean): string {
  return `${userId}:${ai ? "ai" : "human"}`;
}

function isAi(key: string): boolean {
  return key.endsWith(":ai");
}

export function authorHue(key: string): number {
  return hash(key) % 360;
}

/** Saturated variant — carets, avatar rims, legend dots. */
export function authorColor(key: string): string {
  return isAi(key) ? "var(--ai)" : `hsl(${authorHue(key)} 45% 42%)`;
}

/** Subtle background tint — blame spans must whisper, not shout. */
export function authorTint(key: string): string {
  return isAi(key) ? "var(--ai-wash)" : `hsla(${authorHue(key)} 55% 42% / 0.1)`;
}
