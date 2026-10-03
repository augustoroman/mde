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
  /**
   * Keep raw HTML blocks (an `<iframe>` embed, say) as opaque, uneditable
   * blocks that round-trip verbatim, default false. Inline HTML is always text.
   */
  html?: boolean;
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
 *   block        := paragraph | heading | bullet_list | ordered_list | image? | photo_row? | video? | html_block?
 *   photo_row    := image+   (one image is unwrapped to a plain image; a row has one shared caption)
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
  const html = options.html === true;

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
        // A default so that image is "generatable": photo_row's content requires it.
        src: { default: "", validate: "string" },
        alt: { default: "", validate: "string" },
        /** Shown under the image; markdown's image title. */
        caption: { default: "", validate: "string" },
        /** Where clicking the image goes (the full-size original, say); markdown's `[![…](…)](link)`. */
        link: { default: "", validate: "string" },
      },
      parseDOM: [
        {
          tag: "img[src]",
          getAttrs: (dom) => ({
            src: dom.getAttribute("src"),
            alt: dom.getAttribute("alt") ?? "",
            caption: dom.getAttribute("data-caption") ?? dom.getAttribute("title") ?? "",
            link: dom.getAttribute("data-link") ?? "",
          }),
        },
      ],
      toDOM: (node) => {
        const img: [string, Record<string, string>] = ["img", { src: node.attrs.src, alt: node.attrs.alt }];
        if (node.attrs.caption) img[1]["data-caption"] = node.attrs.caption;
        if (node.attrs.link) img[1]["data-link"] = node.attrs.link;
        return node.attrs.caption
          ? ["figure", { class: "mde-image" }, img, ["figcaption", node.attrs.caption]]
          : ["figure", { class: "mde-image" }, img];
      },
    };
    // Two or more images on one markdown line sit side by side. The content
    // rule allows one so that dragging an image out never makes ProseMirror
    // fill the row with an empty image; the canonical plugin then unwraps it.
    // A row has one shared caption (markdown: the title of its first image).
    nodes.photo_row = {
      group: "block",
      content: "image+",
      defining: true,
      attrs: { caption: { default: "", validate: "string" } },
      parseDOM: [{ tag: "figure.mde-row", getAttrs: (dom) => ({ caption: dom.getAttribute("data-caption") ?? "" }) }],
      toDOM: (node) =>
        node.attrs.caption
          ? ["figure", { class: "mde-row", "data-caption": node.attrs.caption }, ["div", { class: "mde-row-items" }, 0], ["figcaption", node.attrs.caption]]
          : ["figure", { class: "mde-row" }, ["div", { class: "mde-row-items" }, 0]],
    };
  }

  if (videos) {
    nodes.video = {
      group: "block",
      atom: true,
      draggable: true,
      attrs: {
        src: { validate: "string" },
        poster: { default: "", validate: "string" },
        caption: { default: "", validate: "string" },
      },
      parseDOM: [
        {
          tag: "video[src]",
          getAttrs: (dom) => ({
            src: dom.getAttribute("src"),
            poster: dom.getAttribute("poster") ?? "",
            caption: dom.getAttribute("data-caption") ?? "",
          }),
        },
      ],
      toDOM: (node) => {
        const video: [string, Record<string, string>] = ["video", { src: node.attrs.src, controls: "controls", preload: "metadata" }];
        if (node.attrs.poster) video[1].poster = node.attrs.poster;
        if (node.attrs.caption) video[1]["data-caption"] = node.attrs.caption;
        return node.attrs.caption
          ? ["figure", { class: "mde-video" }, video, ["figcaption", node.attrs.caption]]
          : ["figure", { class: "mde-video" }, video];
      },
    };
  }

  if (html) {
    nodes.html_block = {
      group: "block",
      atom: true,
      draggable: true,
      attrs: { html: { validate: "string" } },
      parseDOM: [{ tag: "div.mde-html[data-html]", getAttrs: (dom) => ({ html: dom.getAttribute("data-html") ?? "" }) }],
      toDOM: (node) => ["div", { class: "mde-html", "data-html": node.attrs.html }, ["pre", node.attrs.html]],
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

/** Read back the options a schema was created with. */
export function optionsOf(s: Schema): Required<SchemaOptions> {
  return { headingLevels: headingLevelsOf(s), images: !!s.nodes.image, videos: !!s.nodes.video, html: !!s.nodes.html_block };
}

/** Read back which heading levels a schema was created with. */
export function headingLevelsOf(s: Schema): HeadingLevel[] {
  const rules = s.nodes.heading.spec.parseDOM ?? [];
  return rules.map((r) => (r.attrs as { level: HeadingLevel }).level);
}
