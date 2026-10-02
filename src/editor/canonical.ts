import type { Node, NodeType } from "prosemirror-model";
import { Plugin, PluginKey, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { setBlockType } from "prosemirror-commands";
import { applyEdit, whitespaceEdits } from "../whitespace";

export const canonicalKey = new PluginKey("mde-canonical");

/**
 * Keeps the document in the same shape the markdown output has, so what you
 * see in the rich editor is exactly what the markdown says:
 *
 *  - Empty paragraphs don't exist in the output, so they are removed as soon
 *    as the cursor leaves them. (The one you are in stays: pressing Enter has
 *    to give you somewhere to type.)
 *  - Two lists of the same kind sitting next to each other are one list in
 *    markdown, so they are joined.
 *  - A list item's own paragraph is never indented: the bullet is its indent.
 *  - Runs of spaces collapse to one, and blocks carry no leading/trailing
 *    space, except for a trailing space in the block being typed in.
 */
export function canonicalDocPlugin(): Plugin {
  return new Plugin({
    key: canonicalKey,
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged || tr.selectionSet)) return null;
      const tr = newState.tr;
      removeStrayEmptyParagraphs(newState, tr);
      unwrapSingleRows(tr);
      joinAdjacentLists(tr);
      clearItemHeadIndent(tr);
      normalizeWhitespace(tr);
      return tr.steps.length ? tr : null;
    },
  });
}

/** A photo row with one image left in it is just that image. */
function unwrapSingleRows(tr: Transaction): void {
  const row = tr.doc.type.schema.nodes.photo_row;
  if (!row) return;
  const spots: Array<{ from: number; to: number; node: Node }> = [];
  tr.doc.forEach((node, pos) => {
    if (node.type === row && node.childCount === 1) spots.push({ from: pos, to: pos + node.nodeSize, node: node.firstChild! });
  });
  for (const { from, to, node } of spots.reverse()) tr.replaceWith(from, to, node);
}

/** Empty paragraphs that don't hold the cursor: at the top level, or as a continuation paragraph in a list item. */
function removeStrayEmptyParagraphs(state: EditorState, tr: Transaction): void {
  const { doc, selection, schema } = state;
  const { paragraph, list_item } = schema.nodes;
  const stray: Array<{ from: number; to: number }> = [];
  doc.descendants((node, pos, parent, index) => {
    if (node.type !== paragraph) return !node.isTextblock;
    if (node.content.size > 0) return false;
    const removable = parent === doc ? doc.childCount > 1 : parent?.type === list_item && index > 0;
    const holdsCursor = selection.from >= pos && selection.to <= pos + node.nodeSize;
    if (removable && !holdsCursor) stray.push({ from: pos, to: pos + node.nodeSize });
    return false;
  });
  for (const { from, to } of stray.reverse()) tr.delete(from, to);
}

/** Wrapping an indented paragraph into a list drops its indent: the bullet takes over. */
function clearItemHeadIndent(tr: Transaction): void {
  const { list_item, paragraph } = tr.doc.type.schema.nodes;
  const fixes: Array<{ pos: number; attrs: Record<string, unknown> }> = [];
  tr.doc.descendants((node, pos) => {
    if (node.type !== list_item) return !node.isTextblock;
    const head = node.firstChild;
    if (head && head.type === paragraph && head.attrs.indent > 0) fixes.push({ pos: pos + 1, attrs: { ...head.attrs, indent: 0 } });
    return true;
  });
  for (const { pos, attrs } of fixes) tr.setNodeMarkup(pos, undefined, attrs);
}

/** Two lists of the same kind that touch (at any level) are one list in markdown. */
function joinAdjacentLists(tr: Transaction): void {
  const { bullet_list, ordered_list } = tr.doc.type.schema.nodes;
  const isList = (type: NodeType) => type === bullet_list || type === ordered_list;
  const joins: number[] = [];
  const scan = (parent: Node, base: number) => {
    let pos = base;
    for (let i = 0; i < parent.childCount; i++) {
      const child = parent.child(i);
      const next = i + 1 < parent.childCount ? parent.child(i + 1) : null;
      if (next && isList(child.type) && next.type === child.type) joins.push(pos + child.nodeSize);
      if (child.type.name === "list_item" || isList(child.type)) scan(child, pos + 1);
      pos += child.nodeSize;
    }
  };
  scan(tr.doc, 0);
  for (const pos of joins.reverse()) tr.join(pos);
}

/**
 * Enter inside an empty top-level block: a paragraph stays as it is (no
 * stacking of blank lines), an empty heading turns back into a paragraph.
 */
export const enterInEmptyBlock: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth !== 1 || !$from.parent.isTextblock || $from.parent.content.size > 0) return false;
  if ($from.parent.type === state.schema.nodes.paragraph) return true;
  return setBlockType(state.schema.nodes.paragraph)(state, dispatch);
};

function normalizeWhitespace(tr: Transaction): void {
  const { $from } = tr.selection;
  const cursorBlock = $from.parent.isTextblock ? { from: $from.before(), to: $from.after() } : undefined;
  for (const edit of whitespaceEdits(tr.doc, cursorBlock).reverse()) applyEdit(tr, edit);
}
