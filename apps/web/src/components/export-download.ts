// Matches EXPORT_WARNINGS_HEADER in the server's transfer routes.
const WARNINGS_HEADER = "x-tandem-export-warnings";

/** Download an export zip (`query` is `workspace=<id>` or `collection=<id>`)
 * and say what the export left out. Fetched rather than navigated to, so the
 * warnings that come back in a header can be shown. */
export async function downloadExport(query: string): Promise<{ filename: string; warnings: string[] }> {
  const res = await fetch(`/api/export?${query}`, { credentials: "include" });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? "The export couldn't be completed.");
  }
  const filename = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "export.zip";
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  const header = res.headers.get(WARNINGS_HEADER);
  return { filename, warnings: header ? (JSON.parse(decodeURIComponent(header)) as string[]) : [] };
}
