import type { Attrs, MarkType, Node, NodeType, Schema } from "prosemirror-model";
import { NodeSelection, Selection, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { setBlockType, toggleMark } from "prosemirror-commands";
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import { liftTarget } from "prosemirror-transform";

/** Whether `type` is applied at the cursor, or anywhere within the selection. */
export function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

const WORD_CHAR = /[\p{L}\p{N}_'’]/u;

/**
 * The word the cursor is strictly inside of (word characters on both sides),
 * as absolute document positions. Null at a word boundary or outside text.
 */
export function wordRangeAt(state: EditorState): { from: number; to: number } | null {
  const { $from } = state.selection;
  const parent = $from.parent;
  if (!parent.isTextblock) return null;
  const text = parent.textBetween(0, parent.content.size, "\u0000", "\u0000");
  const offset = $from.parentOffset;
  let start = offset;
  let end = offset;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
  while (end < text.length && WORD_CHAR.test(text[end])) end++;
  if (start === offset || end === offset) return null;
  const base = $from.start();
  return { from: base + start, to: base + end };
}

/**
 * Like `toggleMark`, but a collapsed cursor inside a word toggles the mark on
 * the whole word. An explicit selection or a cursor at a word boundary keeps
 * ProseMirror's usual behavior (selection or stored marks).
 */
export function toggleMarkOnWord(type: MarkType): Command {
  return (state, dispatch, view) => {
    const word = state.selection.empty ? wordRangeAt(state) : null;
    if (!word) return toggleMark(type)(state, dispatch, view);
    if (dispatch) {
      const tr = state.doc.rangeHasMark(word.from, word.to, type)
        ? state.tr.removeMark(word.from, word.to, type)
        : state.tr.addMark(word.from, word.to, type.create());
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export function blockActive(state: EditorState, type: NodeType, attrs?: Attrs): boolean {
  const { $from, to, node } = state.selection as NodeSelection;
  const matches = (n: Node) => (attrs ? n.hasMarkup(type, attrs) : n.type === type);
  if (node) return matches(node);
  return to <= $from.end() && matches($from.parent);
}

/** The innermost list wrapping the selection start, with its depth. */
export function enclosingList(state: EditorState): { node: Node; depth: number } | null {
  const { $from } = state.selection;
  const { bullet_list, ordered_list } = state.schema.nodes;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type === bullet_list || node.type === ordered_list) return { node, depth };
  }
  return null;
}

export function listActive(state: EditorState, type: NodeType): boolean {
  return enclosingList(state)?.node.type === type;
}

/**
 * Wrap in a list, convert the surrounding list to the other kind, or lift out
 * of the list when it already is of the requested kind.
 */
export function toggleList(type: NodeType): Command {
  return (state, dispatch) => {
    const list = enclosingList(state);
    if (!list) return wrapInList(type)(state, dispatch);
    if (list.node.type === type) return withContinuedNumbering(liftListItem(state.schema.nodes.list_item))(state, dispatch);
    if (dispatch) {
      const pos = state.selection.$from.before(list.depth);
      dispatch(state.tr.setNodeMarkup(pos, type).scrollIntoView());
    }
    return true;
  };
}

/**
 * Backspace with the cursor at the very start of a block, made predictable:
 *
 *  - at the start of an indented paragraph: one indent level less;
 *  - at the start of a nested list item: un-indent it one level;
 *  - at the start of a root-level list item: leave the list, the item becomes a paragraph;
 *  - at the start of a paragraph (or heading) that directly follows a list:
 *    join it onto the end of the list's last item (an empty one is just removed).
 *
 * Anything else returns false so the default behavior applies.
 */
export const backspaceAtBlockStart: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || !$from.parent.isTextblock) return false;
  const { list_item, bullet_list, ordered_list, paragraph } = state.schema.nodes;

  if ($from.parent.type === paragraph && $from.parent.attrs.indent > 0) return shiftIndent(-1)(state, dispatch);

  if ($from.depth >= 2 && $from.node(-1).type === list_item && $from.index(-1) === 0) {
    return withContinuedNumbering(liftListItem(list_item))(state, dispatch);
  }

  if ($from.depth === 1 && $from.index(0) > 0) {
    const prev = state.doc.child($from.index(0) - 1);
    if (prev.type !== bullet_list && prev.type !== ordered_list) return false;
    const blockStart = $from.before(1);
    const target = Selection.findFrom(state.doc.resolve(blockStart), -1, true);
    if (!target) return false;
    if (dispatch) {
      const block = $from.parent;
      const tr = state.tr.delete(blockStart, $from.after(1));
      if (block.content.size) tr.insert(target.head, block.content);
      tr.setSelection(TextSelection.create(tr.doc, target.head));
      dispatch(tr.scrollIntoView());
    }
    return true;
  }

  return false;
};

/**
 * Wrap a command that may lift an item out of the middle of an ordered list,
 * so the list behind it continues numbering instead of restarting at 1. That
 * is what the markdown output shows, so the editor must show it too.
 */
export function withContinuedNumbering(command: Command): Command {
  return (state, dispatch, view) => command(state, dispatch && ((tr) => dispatch(continueNumberingAfterSplit(tr))), view);
}

function continueNumberingAfterSplit(tr: Transaction): Transaction {
  const $p = tr.selection.$from;
  if ($p.depth < 1) return tr;
  const { ordered_list } = tr.doc.type.schema.nodes;
  const parent = $p.node(-1);
  const index = $p.index(-1);
  const before = index > 0 ? parent.child(index - 1) : null;
  const after = index + 1 < parent.childCount ? parent.child(index + 1) : null;
  if (!before || !after || before.type !== ordered_list || after.type !== ordered_list) return tr;
  if (after.attrs.order !== before.attrs.order) return tr;
  // The lifted block is no longer an item, so the second half continues right after the first.
  return tr.setNodeMarkup($p.after(), undefined, { order: before.attrs.order + before.childCount });
}

/**
 * Change the indent level of every paragraph the selection touches (never
 * below 0). A list item's own paragraph is skipped: indenting that means
 * nesting the item, which Tab handles separately.
 */
function shiftIndent(delta: 1 | -1): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const { paragraph, list_item } = state.schema.nodes;
    const tr = state.tr;
    let changed = false;
    state.doc.nodesBetween(from, to, (node, pos, parent, index) => {
      if (node.type !== paragraph) return !node.isTextblock;
      if (parent?.type === list_item && index === 0) return false;
      const indent = Math.max(0, (node.attrs.indent || 0) + delta);
      if (indent !== node.attrs.indent) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent });
        changed = true;
      }
      return false;
    });
    if (!changed) return false;
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

/** Whether the selection sits in a single paragraph that directly follows a list. */
function paragraphAfterList(state: EditorState): boolean {
  const { $from, empty, $to } = state.selection;
  const { paragraph, list_item, bullet_list, ordered_list } = state.schema.nodes;
  if (!(empty || $from.sameParent($to)) || $from.parent.type !== paragraph || $from.depth < 1) return false;
  const container = $from.node(-1);
  const index = $from.index(-1);
  if (index === 0 || (container.type !== state.schema.nodes.doc && container.type !== list_item)) return false;
  const prev = container.child(index - 1);
  return prev.type === bullet_list || prev.type === ordered_list;
}

/**
 * Tab: one level deeper. A paragraph that directly follows a list moves into
 * that list's last item (markdown's indented continuation paragraph); any
 * other paragraph gets one more indent level (a `> ` prefix in markdown).
 * With a selection spanning several paragraphs, all of them are indented.
 */
export const indentParagraph: Command = (state, dispatch) => {
  if (!paragraphAfterList(state)) return shiftIndent(1)(state, dispatch);
  const { $from } = state.selection;
  if (dispatch) {
    const para = $from.parent;
    const paraStart = $from.before();
    // The list ends where the paragraph starts; its last item's content ends two tokens earlier.
    const insertAt = paraStart - 2;
    const tr = state.tr.delete(paraStart, paraStart + para.nodeSize).insert(insertAt, para);
    tr.setSelection(TextSelection.create(tr.doc, insertAt + 1 + $from.parentOffset)).scrollIntoView();
    dispatch(tr);
  }
  return true;
};

/**
 * Shift-Tab: one level shallower. An indented paragraph loses one level;
 * otherwise a continuation paragraph (any paragraph of a list item but the
 * first, and the item's last block, so content never gets reordered) moves
 * out of the item, splitting the list around it when needed.
 */
export const outdentParagraph: Command = (state, dispatch) => {
  if (shiftIndent(-1)(state, dispatch)) return true;
  const { $from, empty } = state.selection;
  const { paragraph, list_item } = state.schema.nodes;
  if (!empty || $from.parent.type !== paragraph || $from.depth < 2 || $from.node(-1).type !== list_item) return false;
  const index = $from.index(-1);
  if (index === 0 || index !== $from.node(-1).childCount - 1) return false;
  const range = $from.blockRange();
  const target = range && liftTarget(range);
  if (!range || target == null) return false;
  if (dispatch) dispatch(continueNumberingAfterSplit(state.tr.lift(range, target)).scrollIntoView());
  return true;
};

export function setParagraph(schema: Schema): Command {
  return setBlockType(schema.nodes.paragraph);
}

export function setHeading(schema: Schema, level: number): Command {
  return setBlockType(schema.nodes.heading, { level });
}

/**
 * Insert a block leaf (image or video) at a predictable place: replacing an
 * empty top-level paragraph, before/after the current top-level block when the
 * cursor sits at its edge, splitting the block when it's in the middle, and
 * after the whole list when the cursor is inside one. The cursor ends up in a
 * paragraph right after the inserted node.
 */
export function insertBlockLeaf(node: Node): Command {
  return (state, dispatch) => {
    const { selection } = state;
    const $from = selection.$from;
    const tr = state.tr;
    let insertPos: number;

    if (selection instanceof NodeSelection && $from.depth === 0) {
      tr.replaceWith(selection.from, selection.to, node);
      insertPos = selection.from;
    } else if ($from.depth === 1 && $from.parent.isTextblock && $from.parent.content.size === 0) {
      tr.replaceWith($from.before(1), $from.after(1), node);
      insertPos = $from.before(1);
    } else if ($from.depth === 1 && $from.parent.isTextblock && selection.empty) {
      if ($from.parentOffset === 0) {
        insertPos = $from.before(1);
      } else if ($from.parentOffset === $from.parent.content.size) {
        insertPos = $from.after(1);
      } else {
        tr.split($from.pos);
        insertPos = $from.pos + 1;
      }
      tr.insert(insertPos, node);
    } else {
      insertPos = $from.depth === 0 ? $from.pos : $from.after(1);
      tr.insert(insertPos, node);
    }

    // Leave the cursor in a paragraph after the new block so typing can continue.
    const after = insertPos + node.nodeSize;
    const next = tr.doc.nodeAt(after);
    if (!next || !next.isTextblock) tr.insert(after, state.schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView();

    dispatch?.(tr);
    return true;
  };
}

/** Insert an image; a no-op command when the schema was created without images. */
export function insertImage(schema: Schema, src: string, alt = ""): Command {
  const type = schema.nodes.image;
  return type ? insertBlockLeaf(type.create({ src, alt })) : () => false;
}

/** Insert a video; a no-op command when the schema was created without videos. */
export function insertVideo(schema: Schema, src: string): Command {
  const type = schema.nodes.video;
  return type ? insertBlockLeaf(type.create({ src })) : () => false;
}

/** Boundaries of the link mark instance the cursor is inside, if any. */
function linkRange(state: EditorState): { from: number; to: number } | null {
  const { $from } = state.selection;
  const link = state.schema.marks.link;
  const parent = $from.parent;
  const index = $from.index();
  const nodeAt = (i: number) => (i >= 0 && i < parent.childCount ? parent.child(i) : null);
  const isLinked = (n: Node | null) => !!n && !!link.isInSet(n.marks);

  let startIndex = index;
  let endIndex = index;
  if (!isLinked(nodeAt(index))) {
    if ($from.textOffset === 0 && isLinked(nodeAt(index - 1))) startIndex = endIndex = index - 1;
    else return null;
  }
  const mark = link.isInSet(nodeAt(startIndex)!.marks)!;
  while (startIndex > 0 && mark.isInSet(nodeAt(startIndex - 1)!.marks)) startIndex--;
  while (endIndex < parent.childCount - 1 && mark.isInSet(nodeAt(endIndex + 1)!.marks)) endIndex++;

  let from = $from.start();
  for (let i = 0; i < startIndex; i++) from += parent.child(i).nodeSize;
  let to = from;
  for (let i = startIndex; i <= endIndex; i++) to += parent.child(i).nodeSize;
  return { from, to };
}

/** Apply a link to the selection, or insert the URL as linked text when the selection is empty. */
export function setLink(schema: Schema, href: string): Command {
  return (state, dispatch) => {
    const link = schema.marks.link;
    const { empty, from, to } = state.selection;
    const range = empty ? linkRange(state) : { from, to };
    const tr = state.tr;
    if (range) {
      tr.removeMark(range.from, range.to, link).addMark(range.from, range.to, link.create({ href }));
    } else {
      tr.replaceSelectionWith(schema.text(href, [link.create({ href })]), false);
    }
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

export function removeLink(schema: Schema): Command {
  return (state, dispatch) => {
    const { empty, from, to } = state.selection;
    const range = empty ? linkRange(state) : { from, to };
    if (!range) return false;
    dispatch?.(state.tr.removeMark(range.from, range.to, schema.marks.link));
    return true;
  };
}

/** The href of the link at the cursor / in the selection, if any. */
export function currentLinkHref(state: EditorState): string | null {
  const link = state.schema.marks.link;
  const { $from, from, to, empty } = state.selection;
  if (empty) {
    const range = linkRange(state);
    if (!range) return null;
    return (link.isInSet(state.doc.resolve(range.from + 1).marks()) ?? link.isInSet($from.marks()))?.attrs.href ?? null;
  }
  let href: string | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    const mark = link.isInSet(node.marks);
    if (mark) href = mark.attrs.href;
    return href === null;
  });
  return href;
}
