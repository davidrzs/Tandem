/**
 * localStorage that never throws. Blocked site data (Safari/Firefox settings,
 * some webviews) makes every access throw SecurityError, and a full quota
 * makes setItem throw; everything stored here is a best-effort cache.
 */

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Best effort.
  }
}
