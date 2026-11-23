// Kept free of editor imports: the app shell (Home, properties) uses it, and
// pulling blame.ts in would drag TipTap into the first page load.

/** How an author reads in blame: "David" for humans, "David's AI" for their
 * agent, "David's AI (Claude)" when the stamp names the agent. The ownerless
 * local agent keeps its stored name. */
export function authorLabel(info: {
  name: string;
  ai: boolean;
  userId: string;
  agent?: string;
}): string {
  if (!info.ai) return info.name || "Unknown";
  const base = !info.name || info.userId === "system" ? info.name || "AI" : `${info.name}'s AI`;
  return info.agent ? `${base} (${info.agent})` : base;
}
