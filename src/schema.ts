import { Schema, type NodeSpec, type MarkSpec } from "prosemirror-model";

/** Heading levels the editor will accept. Anything outside is clamped on input. */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface SchemaOptions {
  /** Allowed heading levels, default `[1, 2, 3]`. */
  headingLevels?: HeadingLevel[];
  /** Allow block images, default true. When false, markdown images degrade to links. */
  images?: boolean;
  /** Allow block videos, default true. When false, `<video>` lines are plain text. */
  videos?: boolean;
}

export const DEFAULT_HEADING_LEVELS: HeadingLevel[] = [1, 2, 3];

/**
 * Snap a heading level to the closest allowed level. Levels above the
 * largest allowed collapse to the largest; levels below the smallest
 * collapse to the smallest.
 */
export function clampHeadingLevel(level: number, allowed: readonly HeadingLevel[]): HeadingLevel {
  const sorted = [...allowed].sort((a, b) => a - b);
  for (const l of sorted) if (l >= level) return l;
  return sorted[sorted.length - 1];
}

/**
 * The document model, deliberately small:
 *
 *   doc          := block+
 *   block        := paragraph | heading | bullet_list | ordered_list | image? | video?
 *   list_item    := paragraph (paragraph | bullet_list | ordered_list)*
 *   inline marks := strong | em | link
 *
 * Paragraphs carry an `indent` level (0 by default), serialized as `> `
 * prefixes: that is the one markdown construct that indents a block anywhere.
 * A list item is its paragraph, followed by any mix of nested lists and
 * continuation paragraphs (what markdown writes as an indented paragraph
 * under the item). There are no hard breaks, code, quotes, rules or tables;
 * images and videos are block-level leaves so that they are always their own
 * centered block.
 */
export function createSchema(options: SchemaOptions = {}): Schema {
  const levels = options.headingLevels?.length ? options.headingLevels : DEFAULT_HEADING_LEVELS;
  const images = options.images !== false;
  const videos = options.videos !== false;

  const nodes: Record<string, NodeSpec> = {
    doc: { content: "block+" },

    paragraph: {
      group: "block",
      content: "inline*",
      // Indent level, written in markdown as `> ` prefixes. `--mde-indent` sets the width per level.
      attrs: { indent: { default: 0, validate: "number" } },
      parseDOM: [{ tag: "p", getAttrs: (dom) => ({ indent: Math.max(0, Number(dom.getAttribute("data-indent")) || 0) }) }],
      toDOM: (node) =>
        node.attrs.indent > 0
          ? ["p", { "data-indent": node.attrs.indent, style: `--mde-level: ${node.attrs.indent}` }, 0]
          : ["p", 0],
    },

    heading: {
      group: "block",
      content: "inline*",
      defining: true,
      attrs: { level: { default: levels[0], validate: "number" } },
      parseDOM: levels.map((level) => ({ tag: `h${level}`, attrs: { level } })),
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },

    bullet_list: {
      group: "block",
      content: "list_item+",
      parseDOM: [{ tag: "ul" }],
      toDOM: () => ["ul", 0],
    },

    ordered_list: {
      group: "block",
      content: "list_item+",
      attrs: { order: { default: 1, validate: "number" } },
      parseDOM: [
        {
          tag: "ol",
          getAttrs: (dom) => ({ order: dom.hasAttribute("start") ? Number(dom.getAttribute("start")) || 1 : 1 }),
        },
      ],
      toDOM: (node) => (node.attrs.order === 1 ? ["ol", 0] : ["ol", { start: node.attrs.order }, 0]),
    },

    list_item: {
      content: "paragraph (paragraph | bullet_list | ordered_list)*",
      defining: true,
      parseDOM: [{ tag: "li" }],
      toDOM: () => ["li", 0],
    },

    text: { group: "inline" },
  };

  if (images) {
    nodes.image = {
      group: "block",
      atom: true,
      draggable: true,
      attrs: {
        src: { validate: "string" },
        alt: { default: "", validate: "string" },
      },
      parseDOM: [
        {
          tag: "img[src]",
          getAttrs: (dom) => ({ src: dom.getAttribute("src"), alt: dom.getAttribute("alt") ?? "" }),
        },
      ],
      toDOM: (node) => ["figure", { class: "mde-image" }, ["img", { src: node.attrs.src, alt: node.attrs.alt }]],
    };
  }

  if (videos) {
    nodes.video = {
      group: "block",
      atom: true,
      draggable: true,
      attrs: { src: { validate: "string" } },
      parseDOM: [
        {
          tag: "video[src]",
          getAttrs: (dom) => ({ src: dom.getAttribute("src") }),
        },
      ],
      toDOM: (node) => [
        "figure",
        { class: "mde-video" },
        ["video", { src: node.attrs.src, controls: "controls", preload: "metadata" }],
      ],
    };
  }

  const marks: Record<string, MarkSpec> = {
    link: {
      attrs: { href: { validate: "string" } },
      inclusive: false,
      parseDOM: [{ tag: "a[href]", getAttrs: (dom) => ({ href: dom.getAttribute("href") }) }],
      toDOM: (mark) => ["a", { href: mark.attrs.href }, 0],
    },
    em: {
      parseDOM: [
        { tag: "i" },
        { tag: "em" },
        { style: "font-style=italic" },
        { style: "font-style=normal", clearMark: (m) => m.type.name === "em" },
      ],
      toDOM: () => ["em", 0],
    },
    strong: {
      parseDOM: [
        { tag: "strong" },
        // Google Docs and friends emit <b style="font-weight:normal">.
        { tag: "b", getAttrs: (dom) => dom.style.fontWeight !== "normal" && null },
        { style: "font-weight=400", clearMark: (m) => m.type.name === "strong" },
        { style: "font-weight", getAttrs: (value) => /^(bold(er)?|[5-9]\d{2,})$/.test(value) && null },
      ],
      toDOM: () => ["strong", 0],
    },
  };

  return new Schema({ nodes, marks });
}

/** Default schema with heading levels 1–3. */
export const schema = createSchema();

/** Read back which heading levels a schema was created with. */
export function headingLevelsOf(s: Schema): HeadingLevel[] {
  const rules = s.nodes.heading.spec.parseDOM ?? [];
  return rules.map((r) => (r.attrs as { level: HeadingLevel }).level);
}
