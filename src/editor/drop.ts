import { Fragment, type Node, type Schema, type Slice } from "prosemirror-model";
import { NodeSelection, type Command } from "prosemirror-state";

/**
 * Dropping images.
 *
 * Every drop of dragged images onto an image goes through `dropImages`, which
 * is pure document logic: delete what was dragged, then put the images where
 * the zone says. The editor only works out the target and zone from the
 * pointer (`zoneAt`). Keeping the two apart is what lets the behaviour be
 * tested exhaustively without a browser.
 */

/** Where on an image a drop lands. Images inside a row only split left/right. */
export type DropZone = "before" | "after" | "stack-left" | "stack-right";

/** The zone for a pointer at (x, y) over an image's box. */
export function zoneAt(rect: { left: number; top: number; width: number; height: number }, x: number, y: number, inRow: boolean): DropZone {
  const leftHalf = x < rect.left + rect.width / 2;
  if (inRow) return leftHalf ? "before" : "after";
  if (y < rect.top + rect.height / 3) return "before";
  if (y > rect.top + (rect.height * 2) / 3) return "after";
  return leftHalf ? "stack-left" : "stack-right";
}

/** What a drag carries, when it is nothing but images (loose or in rows). */
export interface DraggedImages {
  images: Node[];
  /** The drag was a whole row (or several): keep it a row when dropped between blocks. */
  row: boolean;
}

export function draggedImages(slice: Slice, schema: Schema): DraggedImages | null {
  const { image, photo_row } = schema.nodes;
  if (!image || !photo_row) return null;
  const images: Node[] = [];
  let row = false;
  let ok = true;
  slice.content.forEach((node) => {
    if (node.type === image) images.push(node);
    else if (node.type === photo_row) {
      row = true;
      node.forEach((child) => images.push(child));
    } else ok = false;
  });
  return ok && images.length ? { images, row } : null;
}

/**
 * The position of the image node a document position points at: the image
 * itself (pos before it, or inside it) whether loose or inside a row.
 */
export function imageAt(doc: Node, pos: number): number | null {
  const { image } = doc.type.schema.nodes;
  if (!image) return null;
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if ($pos.nodeAfter?.type === image) return $pos.pos;
  if ($pos.nodeBefore?.type === image) return $pos.pos - $pos.nodeBefore.nodeSize;
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type === image) return $pos.before(d);
  return null;
}

/**
 * Drop dragged images at the image at `target`. `source` is what to delete
 * first: a node selection for the dragged node (which need not be the editor's
 * selection), `true` for the current selection, or `false` for a copy.
 * Dropping an image onto itself does nothing.
 */
export function dropImages(target: number, dragged: DraggedImages, zone: DropZone, source: boolean | NodeSelection): Command {
  return (state, dispatch) => {
    const { image, photo_row } = state.schema.nodes;
    if (!photo_row || !state.doc.nodeAt(target) || state.doc.nodeAt(target)!.type !== image) return false;
    const sel = source instanceof NodeSelection ? source : source ? state.selection : null;
    if (sel && !sel.empty && sel.from <= target && target < sel.to) return false; // onto itself
    const tr = state.tr;
    if (sel && !sel.empty) tr.deleteRange(sel.from, sel.to);
    const pos = tr.mapping.map(target);
    const still = tr.doc.nodeAt(pos);
    if (!still || still.type !== image) return false;
    const $pos = tr.doc.resolve(pos);
    const inRow = $pos.depth === 1 && $pos.parent.type === photo_row;
    // Images in a row carry no caption of their own; the row has one.
    const images = dragged.images.map((n) => image.create({ ...n.attrs, caption: "" }));
    let selectAt: number;
    if (inRow) {
      // Inside a row every zone is a slot: before or after this image.
      const at = zone === "before" || zone === "stack-left" ? pos : pos + still.nodeSize;
      tr.insert(at, Fragment.from(images));
      selectAt = at;
    } else if (zone === "before" || zone === "after") {
      const block = dragged.row || images.length > 1 ? photo_row.create(null, images) : images[0];
      const at = zone === "before" ? pos : pos + still.nodeSize;
      tr.insert(at, block);
      selectAt = at;
    } else {
      const bare = image.create({ ...still.attrs, caption: "" });
      const children = zone === "stack-left" ? [...images, bare] : [bare, ...images];
      tr.replaceWith(pos, pos + still.nodeSize, photo_row.create({ caption: still.attrs.caption }, children));
      selectAt = pos;
    }
    tr.setSelection(NodeSelection.create(tr.doc, selectAt));
    dispatch?.(tr);
    return true;
  };
}
