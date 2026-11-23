/** A card that wants to sit beside the line at `y`, `h` tall. */
export interface MarginItem {
  key: string;
  y: number;
  h: number;
}

/**
 * Stack margin cards beside their anchors without overlap. Cards keep
 * document order. The active card sits exactly at its anchor; cards after it
 * are pushed down, cards before it are pushed up. With no active card,
 * everything flows down from the first. Returns each card's top by key.
 */
export function layoutMargin(
  items: MarginItem[],
  activeKey: string | null,
  gap = 8,
): Map<string, number> {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  const tops = new Array<number>(sorted.length);
  const pivot = Math.max(0, sorted.findIndex((i) => i.key === activeKey));
  if (sorted.length > 0) tops[pivot] = sorted[pivot]!.y;
  for (let i = pivot + 1; i < sorted.length; i++) {
    tops[i] = Math.max(sorted[i]!.y, tops[i - 1]! + sorted[i - 1]!.h + gap);
  }
  for (let i = pivot - 1; i >= 0; i--) {
    tops[i] = Math.min(sorted[i]!.y, tops[i + 1]! - sorted[i]!.h - gap);
  }
  return new Map(sorted.map((item, i) => [item.key, tops[i]!]));
}
