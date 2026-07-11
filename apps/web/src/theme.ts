/**
 * Theme handling. CSS only knows `[data-theme="dark"]`; this module decides
 * what to stamp on <html> — an explicit stored choice, or the system
 * preference (tracked live) when the user never chose.
 */

const KEY = "tandem.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export type ThemeChoice = "light" | "dark";

export function storedTheme(): ThemeChoice | null {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : null;
}

export function effectiveTheme(): ThemeChoice {
  return storedTheme() ?? (media.matches ? "dark" : "light");
}

function apply(): void {
  document.documentElement.dataset.theme = effectiveTheme();
}

export function setTheme(choice: ThemeChoice): void {
  localStorage.setItem(KEY, choice);
  apply();
}

/** Call once at boot: applies the theme and follows system changes while the
 * user hasn't made an explicit choice. */
export function initTheme(): void {
  apply();
  media.addEventListener("change", () => {
    if (!storedTheme()) apply();
  });
}
