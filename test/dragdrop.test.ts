// @vitest-environment jsdom
/**
 * Dragging images around: a model-based matrix.
 *
 * A tiny model of a document (blocks of text or image lists) says what any
 * drop must produce. Every combination of document shape, dragged image,
 * target image, drop zone and selection state is run through the real editor
 * (so the canonical plugin runs too) and compared with the model. On top of
 * the exact outcome, invariants that have each failed once are checked on
 * every case: no image is lost or duplicated, no empty image appears, every
 * row holds at least two images, and the result is a stable, valid document.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { createEditor, dropImages, zoneAt, type DropZone, type MarkdownEditor } from "../src";
import { parseMarkdown, serializeMarkdown } from "../src/markdown";

type Block = { text: string } | { images: string[] };
const src = (letter: string) => `/${letter}.png`;

function markdown(blocks: Block[]): string {
  return blocks.map((b) => ("text" in b ? b.text : b.images.map((l) => `![](${src(l)})`).join(" "))).join("\n\n");
}

/**
 * Model: what a drop of `dragged` onto `target` in `zone` yields. Whether the
 * target sits in a row is judged before the dragged images leave, since a
 * move within a row keeps it a row.
 */
function expected(blocks: Block[], dragged: string[], target: string, zone: DropZone, moved: boolean): Block[] {
  const targetInRow = blocks.some((b) => "images" in b && b.images.includes(target) && b.images.length >= 2);
  let out: Block[] = blocks.map((b) => ("text" in b ? { ...b } : { images: [...b.images] }));
  if (moved) {
    out = out
      .map((b) => ("text" in b ? b : { images: b.images.filter((l) => !dragged.includes(l)) }))
      .filter((b) => "text" in b || b.images.length > 0);
  }
  const ti = out.findIndex((b) => "images" in b && b.images.includes(target));
  const tb = out[ti] as { images: string[] };
  const at = tb.images.indexOf(target);
  if (targetInRow) {
    const slot = zone === "before" || zone === "stack-left" ? at : at + 1;
    tb.images.splice(slot, 0, ...dragged);
  } else if (zone === "before") out.splice(ti, 0, { images: [...dragged] });
  else if (zone === "after") out.splice(ti + 1, 0, { images: [...dragged] });
  else if (zone === "stack-left") tb.images = [...dragged, target];
  else tb.images = [target, ...dragged];
  return out;
}

let container: HTMLElement;
let editor: MarkdownEditor;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  editor = createEditor(container, { markdown: "" });
});
afterEach(() => {
  editor.destroy();
  container.remove();
});

/** Positions of every image (by letter) in the live document; rows count too. */
function positions() {
  const pos = new Map<string, number>();
  const rows = new Map<string, number>(); // first letter -> row pos
  const { doc } = editor.view.state;
  doc.forEach((node, p) => {
    if (node.type.name === "image") pos.set(node.attrs.src.slice(1, -4), p);
    if (node.type.name === "photo_row") {
      rows.set(node.firstChild!.attrs.src.slice(1, -4), p);
      node.forEach((child, offset) => pos.set(child.attrs.src.slice(1, -4), p + 1 + offset));
    }
  });
  return { pos, rows };
}

function srcs(): string[] {
  const out: string[] = [];
  editor.view.state.doc.descendants((n) => {
    if (n.type.name === "image") out.push(n.attrs.src);
  });
  return out.sort();
}

function checkInvariants(before: string[], draggedCount: number, moved: boolean) {
  const { doc } = editor.view.state;
  expect(() => doc.check()).not.toThrow();
  const after = srcs();
  expect(after).not.toContain("");
  if (moved) expect(after).toEqual(before);
  else expect(after.length).toBe(before.length + draggedCount);
  doc.forEach((node) => {
    if (node.type.name === "photo_row") expect(node.childCount).toBeGreaterThanOrEqual(2);
  });
  const md = editor.getMarkdown();
  expect(serializeMarkdown(parseMarkdown(md))).toBe(md);
}

type Mode = "node" | "selection" | "other-selected" | "copy";
const MODES: Mode[] = ["node", "selection", "other-selected", "copy"];

/** Run one drop through the real editor and return the markdown. */
function drop(blocks: Block[], dragged: string, target: string, zone: DropZone, mode: Mode): string {
  editor.setMarkdown(markdown(blocks));
  const { view } = editor;
  const { pos } = positions();
  const from = pos.get(dragged)!;
  const node = view.state.doc.nodeAt(from)!;
  // selection state before the drop
  if (mode === "selection") view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, from)));
  else if (mode === "other-selected") {
    const other = [...pos.entries()].find(([l]) => l !== dragged && l !== target)?.[1];
    if (other != null) view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, other)));
    else view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
  } else view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
  const source = mode === "copy" ? false : mode === "selection" ? true : NodeSelection.create(view.state.doc, from);
  const ok = dropImages(pos.get(target)!, { images: [node], row: false }, zone, source)(view.state, view.dispatch);
  expect(ok).toBe(true);
  return editor.getMarkdown();
}

const DOCS: Record<string, Block[]> = {
  "three loose images": [{ images: ["A"] }, { images: ["B"] }, { images: ["C"] }],
  "a row and a loose image": [{ images: ["A", "B"] }, { images: ["C"] }],
  "a row of three": [{ images: ["A", "B", "C"] }],
  "images around text": [{ images: ["A"] }, { text: "between" }, { images: ["B"] }],
  "two rows": [{ images: ["A", "B"] }, { images: ["C", "D"] }],
  "a loose image before a row": [{ images: ["A"] }, { images: ["B", "C"] }],
};
const ZONES: DropZone[] = ["before", "after", "stack-left", "stack-right"];

describe("dropping one image onto another", () => {
  for (const [name, blocks] of Object.entries(DOCS)) {
    const letters = blocks.flatMap((b) => ("images" in b ? b.images : []));
    for (const dragged of letters) {
      for (const target of letters) {
        if (target === dragged) continue;
        for (const zone of ZONES) {
          for (const mode of MODES) {
            it(`${name}: ${dragged} onto ${target}, ${zone}, ${mode}`, () => {
              const before = markdown(blocks).match(/\/[A-Z]\.png/g)!.sort();
              const md = drop(blocks, dragged, target, zone, mode);
              expect(md).toBe(markdown(expected(blocks, [dragged], target, zone, mode !== "copy")));
              checkInvariants(before, 1, mode !== "copy");
            });
          }
        }
      }
    }
  }
});

describe("dropping an image onto itself does nothing", () => {
  for (const zone of ZONES) {
    for (const mode of ["node", "selection"] as Mode[]) {
      it(`${zone}, ${mode}`, () => {
        const blocks = DOCS["a row and a loose image"];
        editor.setMarkdown(markdown(blocks));
        const { view } = editor;
        const { pos } = positions();
        const from = pos.get("A")!;
        const node = view.state.doc.nodeAt(from)!;
        if (mode === "selection") view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, from)));
        const source = mode === "selection" ? true : NodeSelection.create(view.state.doc, from);
        expect(dropImages(from, { images: [node], row: false }, zone, source)(view.state, view.dispatch)).toBe(false);
        expect(editor.getMarkdown()).toBe(markdown(blocks));
      });
    }
  }
});

describe("dropping a whole row", () => {
  const cases: Array<[string, Block[], string, DropZone]> = [
    ["row above a loose image", [{ images: ["A", "B"] }, { images: ["C"] }], "C", "before"],
    ["row below a loose image", [{ images: ["A", "B"] }, { images: ["C"] }], "C", "after"],
    ["row stacked onto a loose image", [{ images: ["A", "B"] }, { images: ["C"] }], "C", "stack-right"],
    ["row stacked left of a loose image", [{ images: ["A", "B"] }, { images: ["C"] }], "C", "stack-left"],
    ["row into another row", [{ images: ["A", "B"] }, { images: ["C", "D"] }], "D", "after"],
    ["row into another row, in front", [{ images: ["A", "B"] }, { images: ["C", "D"] }], "C", "before"],
  ];
  for (const [name, blocks, target, zone] of cases) {
    it(name, () => {
      editor.setMarkdown(markdown(blocks));
      const { view } = editor;
      const { pos, rows } = positions();
      const rowPos = rows.get("A")!;
      const row = view.state.doc.nodeAt(rowPos)!;
      const images = [row.child(0), row.child(1)];
      const source = NodeSelection.create(view.state.doc, rowPos);
      view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
      const before = srcs();
      expect(dropImages(pos.get(target)!, { images, row: true }, zone, source)(view.state, view.dispatch)).toBe(true);
      expect(editor.getMarkdown()).toBe(markdown(expected(blocks, ["A", "B"], target, zone, true)));
      checkInvariants(before, 2, true);
    });
  }
});

describe("zones from pointer position", () => {
  const rect = { left: 100, top: 200, width: 300, height: 90 };
  it("a loose image splits into thirds, the middle one left/right", () => {
    expect(zoneAt(rect, 250, 210, false)).toBe("before");
    expect(zoneAt(rect, 250, 280, false)).toBe("after");
    expect(zoneAt(rect, 200, 245, false)).toBe("stack-left");
    expect(zoneAt(rect, 300, 245, false)).toBe("stack-right");
  });
  it("an image in a row splits left/right only", () => {
    expect(zoneAt(rect, 200, 210, true)).toBe("before");
    expect(zoneAt(rect, 300, 280, true)).toBe("after");
  });
});
