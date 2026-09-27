import { clampHeadingLevel, type HeadingLevel } from "../schema";

/**
 * Keyboard shortcuts for the raw markdown textarea, mirroring the rich
 * editor: ⌘B/⌘I wrap the selection or the word under the cursor, ⌘K makes a
 * link, ⇧⌘0–6 set the block type, ⇧⌘7/8 toggle lists, Tab/⇧Tab indent the
 * current lines. Edits go through `insertText` when available so native undo works.
 */
export interface SourceKeymapOptions {
  headingLevels: readonly HeadingLevel[];
}

const WORD_CHAR = /[\p{L}\p{N}_'’]/u;
const HEADING_PREFIX = /^#{1,6}\s+/;
const BULLET_PREFIX = /^(\s*)[-*+]\s+/;
const ORDERED_PREFIX = /^(\s*)\d+\.\s+/;

export function attachSourceKeymap(textarea: HTMLTextAreaElement, options: SourceKeymapOptions): () => void {
  const onKeydown = (event: KeyboardEvent) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod && event.key !== "Tab") return;
    if (event.altKey) return;
    const key = event.key.toLowerCase();
    let handled = false;

    if (event.key === "Tab" && !mod) {
      handled = indentLines(textarea, event.shiftKey ? -1 : 1);
    } else if (!event.shiftKey && key === "b") {
      handled = toggleWrap(textarea, "**");
    } else if (!event.shiftKey && key === "i") {
      handled = toggleWrap(textarea, "*");
    } else if (!event.shiftKey && key === "k") {
      handled = insertLink(textarea);
    } else if (event.shiftKey && /^[0-9]$/.test(key)) {
      const digit = Number(key);
      if (digit === 0) handled = setLinePrefix(textarea, () => "");
      else if (digit === 7) handled = toggleList(textarea, "ordered");
      else if (digit === 8) handled = toggleList(textarea, "bullet");
      else if (digit <= 6 && options.headingLevels.includes(digit as HeadingLevel)) {
        const level = clampHeadingLevel(digit, options.headingLevels);
        handled = setLinePrefix(textarea, () => "#".repeat(level) + " ");
      }
    }

    if (handled) {
      event.preventDefault();
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };
  textarea.addEventListener("keydown", onKeydown);
  return () => textarea.removeEventListener("keydown", onKeydown);
}

// --- Primitive -------------------------------------------------------------

/** Replace [start, end) with `text` and select [selStart, selEnd) afterwards. */
function replaceRange(ta: HTMLTextAreaElement, start: number, end: number, text: string, selStart: number, selEnd = selStart): void {
  ta.focus();
  ta.setSelectionRange(start, end);
  let done = false;
  try {
    done = typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
  } catch {
    done = false;
  }
  if (!done || ta.value.slice(start, start + text.length) !== text) {
    ta.setRangeText(text, start, end, "end");
  }
  ta.setSelectionRange(selStart, selEnd);
}

function wordAt(value: string, pos: number): { start: number; end: number } | null {
  let start = pos;
  let end = pos;
  while (start > 0 && WORD_CHAR.test(value[start - 1])) start--;
  while (end < value.length && WORD_CHAR.test(value[end])) end++;
  return start === pos || end === pos ? null : { start, end };
}

// --- Inline marks ------------------------------------------------------------

function toggleWrap(ta: HTMLTextAreaElement, marker: string): boolean {
  const { value, selectionStart, selectionEnd } = ta;
  const collapsed = selectionStart === selectionEnd;
  let start = selectionStart;
  let end = selectionEnd;
  const n = marker.length;

  if (collapsed) {
    const word = wordAt(value, start);
    if (!word) {
      // Cursor between a pair of markers we inserted earlier: remove them. Otherwise insert an empty pair.
      if (value.slice(start - n, start) === marker && value.slice(start, start + n) === marker) {
        replaceRange(ta, start - n, start + n, "", start - n);
      } else {
        replaceRange(ta, start, start, marker + marker, start + n);
      }
      return true;
    }
    ({ start, end } = word);
  }

  // A collapsed cursor stays on the same character; a selection keeps covering the text.
  const place = (from: number, to: number, shift: number) =>
    collapsed ? [selectionStart + shift, selectionStart + shift] : [from, to];

  const inner = value.slice(start, end);
  if (value.slice(start - n, start) === marker && value.slice(end, end + n) === marker) {
    replaceRange(ta, start - n, end + n, inner, ...(place(start - n, end - n, -n) as [number, number]));
  } else if (inner.startsWith(marker) && inner.endsWith(marker) && inner.length >= 2 * n) {
    const text = inner.slice(n, -n);
    replaceRange(ta, start, end, text, ...(place(start, start + text.length, -n) as [number, number]));
  } else {
    replaceRange(ta, start, end, marker + inner + marker, ...(place(start + n, end + n, n) as [number, number]));
  }
  return true;
}

function insertLink(ta: HTMLTextAreaElement): boolean {
  const { value, selectionStart, selectionEnd } = ta;
  let start = selectionStart;
  let end = selectionEnd;
  if (start === end) {
    const word = wordAt(value, start);
    if (word) ({ start, end } = word);
  }
  const text = value.slice(start, end);
  if (text) {
    // [text](|)
    const replacement = `[${text}]()`;
    replaceRange(ta, start, end, replacement, start + replacement.length - 1);
  } else {
    // [|]()
    replaceRange(ta, start, end, "[]()", start + 1);
  }
  return true;
}

// --- Line-based ----------------------------------------------------------------

interface Lines {
  start: number;
  end: number;
  lines: string[];
}

/** The full lines touched by the selection. */
function selectedLines(ta: HTMLTextAreaElement): Lines {
  const { value, selectionStart, selectionEnd } = ta;
  const start = value.lastIndexOf("\n", selectionStart - 1) + 1;
  let end = value.indexOf("\n", selectionEnd);
  if (end === -1) end = value.length;
  if (selectionEnd > selectionStart && value[selectionEnd - 1] === "\n" && end === selectionEnd) end = selectionEnd - 1;
  return { start, end, lines: value.slice(start, end).split("\n") };
}

/**
 * Write back transformed lines. A selection ends up covering the whole
 * region; a collapsed cursor stays on its line, shifted by that line's change.
 */
function replaceLines(ta: HTMLTextAreaElement, region: Lines, lines: string[]): void {
  const { selectionStart, selectionEnd } = ta;
  const text = lines.join("\n");
  if (selectionEnd > selectionStart) {
    replaceRange(ta, region.start, region.end, text, region.start, region.start + text.length);
    return;
  }
  const lineIndex = region.lines.length - 1 - (ta.value.slice(selectionStart, region.end).match(/\n/g)?.length ?? 0);
  let lineStart = region.start;
  for (let i = 0; i < lineIndex; i++) lineStart += lines[i].length + 1;
  const offsetInLine = selectionStart - (region.start + region.lines.slice(0, lineIndex).reduce((n, l) => n + l.length + 1, 0));
  const delta = lines[lineIndex].length - region.lines[lineIndex].length;
  const cursor = lineStart + Math.max(0, Math.min(lines[lineIndex].length, offsetInLine + delta));
  replaceRange(ta, region.start, region.end, text, cursor);
}

function stripBlockPrefix(line: string): string {
  return line.replace(HEADING_PREFIX, "").replace(BULLET_PREFIX, "$1").replace(ORDERED_PREFIX, "$1");
}

/** Replace the block prefix of each selected line (heading marker or nothing). Blank lines are left alone. */
function setLinePrefix(ta: HTMLTextAreaElement, prefix: () => string): boolean {
  const region = selectedLines(ta);
  const lines = region.lines.map((line) => (line.trim() ? prefix() + stripBlockPrefix(line).trimStart() : line));
  replaceLines(ta, region, lines);
  return true;
}

function toggleList(ta: HTMLTextAreaElement, kind: "bullet" | "ordered"): boolean {
  const region = selectedLines(ta);
  const content = region.lines.filter((l) => l.trim());
  const isKind = (line: string) => (kind === "bullet" ? BULLET_PREFIX : ORDERED_PREFIX).test(line);
  const allAlready = content.length > 0 && content.every(isKind);
  let n = 0;
  const lines = region.lines.map((line) => {
    if (!line.trim()) return line;
    const indent = line.match(/^\s*/)![0];
    const body = stripBlockPrefix(line).trimStart();
    if (allAlready) return indent + body;
    n++;
    return indent + (kind === "bullet" ? "- " : `${n}. `) + body;
  });
  replaceLines(ta, region, lines);
  return true;
}

/**
 * Tab / Shift-Tab, mirroring the rich editor: list lines nest with two spaces,
 * any other line gets (or loses) a `> ` indent prefix. Blank lines are left
 * alone, and the key never moves focus.
 */
function indentLines(ta: HTMLTextAreaElement, direction: 1 | -1): boolean {
  const region = selectedLines(ta);
  const lines = region.lines.map((line) => {
    if (!line.trim()) return line;
    const isList = BULLET_PREFIX.test(line) || ORDERED_PREFIX.test(line);
    if (direction === 1) return isList ? "  " + line : line.replace(/^(\s*)/, "$1> ");
    if (isList) return line.replace(/^ {1,2}/, "");
    return line.replace(/^(\s*)> ?/, "$1");
  });
  if (lines.join("\n") !== region.lines.join("\n")) replaceLines(ta, region, lines);
  return true;
}
