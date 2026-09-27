import type { Node } from "prosemirror-model";
import { Transform } from "prosemirror-transform";

const isSpace = (ch: string) => ch === " " || ch === "\t" || ch === " ";

export interface TextEdit {
  from: number;
  to: number;
  /** Replacement text: " " to normalize one character, "" to delete the range. */
  text: string;
  node: Node;
}

/**
 * Edits that bring a document's whitespace into canonical form: runs of
 * spaces (including tabs and non-breaking spaces) become one space, and text
 * blocks carry no leading or trailing space. Markdown renders all of these
 * the same way, so the document shouldn't distinguish them either.
 *
 * Edits are minimal (only the surplus characters are touched) so that a cursor
 * near a run stays where it is. `keepTrailing` names one block (by position
 * range) whose trailing space is left alone, so that a space just typed at
 * the end of the cursor's block survives until the cursor moves on.
 */
export function whitespaceEdits(doc: Node, keepTrailing?: { from: number; to: number }): TextEdit[] {
  const edits: TextEdit[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    const keepEnd = !!keepTrailing && blockPos >= keepTrailing.from && blockPos + block.nodeSize <= keepTrailing.to;

    // Flatten the block's text into characters with absolute positions.
    const chars: Array<{ pos: number; ch: string; node: Node }> = [];
    block.forEach((child, offset) => {
      if (!child.isText) return;
      const base = blockPos + 1 + offset;
      for (let i = 0; i < child.text!.length; i++) chars.push({ pos: base + i, ch: child.text![i], node: child });
    });

    let i = 0;
    while (i < chars.length) {
      if (!isSpace(chars[i].ch)) {
        i++;
        continue;
      }
      let j = i;
      while (j < chars.length && isSpace(chars[j].ch)) j++;
      const atStart = i === 0;
      const atEnd = j === chars.length;
      if (atStart || (atEnd && !keepEnd)) {
        edits.push({ from: chars[i].pos, to: chars[j - 1].pos + 1, text: "", node: chars[i].node });
      } else {
        if (chars[i].ch !== " ") edits.push({ from: chars[i].pos, to: chars[i].pos + 1, text: " ", node: chars[i].node });
        if (j - i > 1) edits.push({ from: chars[i + 1].pos, to: chars[j - 1].pos + 1, text: "", node: chars[i + 1].node });
      }
      i = j;
    }
    return false;
  });
  return edits;
}

/** A copy of `doc` with canonical whitespace (see `whitespaceEdits`). */
export function collapseWhitespace(doc: Node): Node {
  const edits = whitespaceEdits(doc);
  if (!edits.length) return doc;
  const tr = new Transform(doc);
  for (const edit of edits.reverse()) applyEdit(tr, edit);
  return tr.doc;
}

export function applyEdit(tr: Transform, { from, to, text, node }: TextEdit): void {
  if (text) tr.replaceWith(from, to, node.type.schema.text(text, node.marks));
  else tr.delete(from, to);
}
