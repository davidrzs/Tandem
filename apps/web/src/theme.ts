/**
 * Theme handling. CSS only knows `[data-theme="dark"]`; this module decides
 * what to stamp on <html> — an explicit stored choice, or the system
 * preference (tracked live) when the user never chose.
 */

import { storageGet, storageSet } from "./storage.js";

const KEY = "tandem.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export type ThemeChoice = "light" | "dark";

export function storedTheme(): ThemeChoice | null {
  const v = storageGet(KEY);
  return v === "light" || v === "dark" ? v : null;
}

export function effectiveTheme(): ThemeChoice {
  return storedTheme() ?? (media.matches ? "dark" : "light");
}

function apply(): void {
  const root = document.documentElement;
  root.dataset.theme = effectiveTheme();
  // The browser chrome (and the iOS status bar of the installed app) follows
  // <meta name="theme-color">, which knows nothing of an explicit in-app
  // choice: point it at the page's own surface so that choice wins there too.
  const surface = getComputedStyle(root).getPropertyValue("--surface").trim();
  if (surface) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", surface);
}

export function setTheme(choice: ThemeChoice): void {
  storageSet(KEY, choice);
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
