/** Deterministic, calm per-author colors shared by blame spans, presence
 * carets, and avatars — one identity, one hue everywhere. */

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Stable identity key for an author (the AI half of a user is its own hue). */
export function authorKey(userId: string, ai: boolean): string {
  return `${userId}:${ai ? "ai" : "human"}`;
}

export function authorHue(key: string): number {
  return hash(key) % 360;
}

/** Saturated variant — carets, avatar rims, legend dots. */
export function authorColor(key: string): string {
  return `hsl(${authorHue(key)} 60% 45%)`;
}

/** Subtle background tint — blame spans must whisper, not shout. */
export function authorTint(key: string): string {
  return `hsla(${authorHue(key)} 70% 42% / 0.11)`;
}
