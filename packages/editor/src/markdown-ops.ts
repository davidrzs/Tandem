/**
 * Targeted edit operations over canonical markdown (the serializer's output).
 * These are the primitives behind the MCP edit tools: locate a precise target,
 * change only that, and let the structural Y.Doc diff keep everything else —
 * including its authorship — untouched. Full-document rewrites are deliberately
 * not offered: they would re-attribute the entire document to the editing
 * session and destroy human blame.
 */

/** A user-correctable edit failure (bad target); message is safe to surface. */
export class MarkdownEditError extends Error {}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (
    let i = haystack.indexOf(needle);
    i !== -1;
    i = haystack.indexOf(needle, i + needle.length)
  ) {
    count++;
  }
  return count;
}

/**
 * Replace an exact substring of the markdown. `oldString` must match exactly
 * once (or pass replaceAll) — same contract as a code editor's find/replace,
 * so an agent must quote the precise text it intends to change.
 */
export function replaceText(
  markdown: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  if (oldString.length === 0) {
    throw new MarkdownEditError("old_string must not be empty");
  }
  if (oldString === newString) {
    throw new MarkdownEditError("old_string and new_string are identical");
  }
  const count = countOccurrences(markdown, oldString);
  if (count === 0) {
    throw new MarkdownEditError(
      "old_string was not found in the document. It must match the document's markdown exactly, including whitespace — copy it verbatim from get_document.",
    );
  }
  if (count > 1 && !replaceAll) {
    throw new MarkdownEditError(
      `old_string appears ${count} times in the document. Provide a longer, unique snippet (include surrounding context) or set replace_all.`,
    );
  }
  return replaceAll
    ? markdown.split(oldString).join(newString)
    : markdown.replace(oldString, newString);
}

interface HeadingLine {
  line: number;
  level: number;
  text: string;
}

/** Visit every line that is not inside a code fence. */
function eachUnfencedLine(lines: string[], visit: (line: string, index: number) => void) {
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      // A closing fence must use the same character and at least the same length.
      if (fenceMatch && fenceMatch[1]!.startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    visit(line, i);
  }
}

/** ATX headings outside code fences (the canonical serializer emits no setext
 * headings and no headings inside fences). */
function scanHeadings(lines: string[]): HeadingLine[] {
  const headings: HeadingLine[] = [];
  eachUnfencedLine(lines, (line, i) => {
    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (heading) {
      headings.push({ line: i, level: heading[1]!.length, text: heading[2]! });
    }
  });
  return headings;
}

/** A task item (`- [ ] …`) found in a markdown document. */
export interface TaskScan {
  /** 0-based line index in the markdown source. */
  line: number;
  done: boolean;
  text: string;
  /** Users this task addresses: every `@handle` mention in its text. */
  mentions: string[];
}

/** All task items outside code fences. Mentions are `@email` or `@local-part`
 * tokens (how TODOs get assigned to users). */
export function scanTaskItems(markdown: string): TaskScan[] {
  const tasks: TaskScan[] = [];
  eachUnfencedLine(markdown.split("\n"), (line, i) => {
    const task = /^\s*[-*+] \[([ xX])\] (.*)$/.exec(line);
    if (!task) return;
    const text = task[2]!.trim();
    const mentions = [...text.matchAll(/@([\w.+-]+(?:@[\w.-]+)?)/g)].map((m) =>
      m[1]!.toLowerCase(),
    );
    tasks.push({ line: i, done: task[1] !== " ", text, mentions });
  });
  return tasks;
}

function findHeading(lines: string[], heading: string): HeadingLine {
  // Accept "## Title" or "Title"; compare the text after the # markers.
  const wanted = heading.replace(/^#{1,6}\s+/, "").trim();
  const headings = scanHeadings(lines);
  const matches = headings.filter((h) => h.text === wanted);
  if (matches.length === 0) {
    const available = headings.map((h) => `"${h.text}"`).join(", ");
    throw new MarkdownEditError(
      `heading "${wanted}" not found. Headings in this document: ${available || "(none)"}`,
    );
  }
  if (matches.length > 1) {
    throw new MarkdownEditError(
      `heading "${wanted}" appears ${matches.length} times; make the headings unique or use edit_document with surrounding context instead`,
    );
  }
  return matches[0]!;
}

/** Insert a markdown block right after the given heading line. */
export function insertAfterHeading(
  markdown: string,
  heading: string,
  insert: string,
): string {
  const lines = markdown.split("\n");
  const target = findHeading(lines, heading);
  lines.splice(target.line + 1, 0, "", insert.trim());
  return lines.join("\n");
}

/**
 * Replace the body of the section under `heading` (everything up to the next
 * heading of the same or higher level). The heading line itself is kept — use
 * edit_document to change heading text.
 */
export function replaceSection(
  markdown: string,
  heading: string,
  content: string,
): string {
  const lines = markdown.split("\n");
  const target = findHeading(lines, heading);
  const next = scanHeadings(lines).find(
    (h) => h.line > target.line && h.level <= target.level,
  );
  const end = next ? next.line : lines.length;
  const replacement = content.trim();
  lines.splice(
    target.line + 1,
    end - target.line - 1,
    ...(replacement ? ["", replacement, ""] : [""]),
  );
  return lines.join("\n");
}

/** Append a markdown block at the end of the document. */
export function appendMarkdown(markdown: string, block: string): string {
  const base = markdown.replace(/\s+$/, "");
  return base ? `${base}\n\n${block.trim()}` : block.trim();
}
