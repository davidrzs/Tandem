/** Platform key names for labels and tooltips. */
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = IS_MAC ? "⌘" : "Ctrl";
