import { MarkdownSerializer, type MarkdownSerializerState } from "prosemirror-markdown";
import type { Node } from "prosemirror-model";
import { VIDEO_LINE_RE } from "./tokenizer";
import { collapseWhitespace } from "../whitespace";

/** Undocumented but stable internals of MarkdownSerializerState that the default serializer also relies on. */
type State = MarkdownSerializerState & { inAutolink?: boolean; atBlank(): boolean };

function escapeUrl(url: string): string {
  return url.replace(/[()\s"]/g, (c) => (c === " " ? "%20" : "\\" + c));
}

/**
 * Serializer for the constrained schema. Output is canonical: `-` bullets,
 * `*` emphasis, `**` strong, tight lists, one blank line between blocks,
 * `> ` per indent level, single spaces between words, and no empty paragraphs.
 */
export const markdownSerializer = new MarkdownSerializer(
  {
    paragraph(state, node) {
      if (node.content.size === 0) return;
      const indent: number = node.attrs.indent || 0;
      if (indent > 0) {
        state.wrapBlock("> ".repeat(indent), null, node, () => state.renderInline(node));
      } else {
        state.renderInline(node);
        state.closeBlock(node);
      }
    },
    heading(state, node) {
      state.write(state.repeat("#", node.attrs.level) + " ");
      state.renderInline(node, false);
      state.closeBlock(node);
    },
    bullet_list(state, node) {
      state.renderList(node, "  ", () => "- ");
    },
    ordered_list(state, node) {
      const start: number = node.attrs.order ?? 1;
      const maxWidth = String(start + node.childCount - 1).length;
      const space = state.repeat(" ", maxWidth + 2);
      state.renderList(node, space, (i) => {
        const n = String(start + i);
        return state.repeat(" ", maxWidth - n.length) + n + ". ";
      });
    },
    list_item(state, node) {
      state.renderContent(node);
    },
    image(state, node) {
      state.write(imageMarkdown(state, node));
      state.closeBlock(node);
    },
    photo_row(state, node) {
      const parts: string[] = [];
      node.forEach((image) => parts.push(imageMarkdown(state, image)));
      state.write(parts.join(" "));
      state.closeBlock(node);
    },
    video(state, node) {
      const attr = (v: string) => String(v).replace(/"/g, "%22");
      const poster = node.attrs.poster ? ` poster="${attr(node.attrs.poster)}"` : "";
      const tag = `<video src="${attr(node.attrs.src)}"${poster} controls></video>`;
      if (node.attrs.caption) {
        state.write(`<figure>\n${tag}\n<figcaption>${escapeHtml(node.attrs.caption)}</figcaption>\n</figure>`);
      } else {
        state.write(tag);
      }
      state.closeBlock(node);
    },
    html_block(state, node) {
      state.write(String(node.attrs.html).trim());
      state.closeBlock(node);
    },
    text(state, node) {
      writeText(state as State, node.text ?? "", !!node.type.schema.nodes.video);
    },
  },
  {
    em: { open: "*", close: "*", mixable: true, expelEnclosingWhitespace: true },
    strong: { open: "**", close: "**", mixable: true, expelEnclosingWhitespace: true },
    link: {
      open(s, mark, parent, index) {
        const state = s as State;
        state.inAutolink = isPlainUrl(mark.attrs.href, parent, index);
        return state.inAutolink ? "<" : "[";
      },
      close(s, mark) {
        const state = s as State;
        const { inAutolink } = state;
        state.inAutolink = undefined;
        return inAutolink ? ">" : `](${escapeUrl(mark.attrs.href)})`;
      },
      mixable: true,
    },
  },
  { strict: true },
);

/** `[![alt](src "caption")](link)`, with the link and caption only when set. */
function imageMarkdown(state: MarkdownSerializerState, node: Node): string {
  const title = node.attrs.caption ? ` "${String(node.attrs.caption).replace(/"/g, '\\"')}"` : "";
  const image = `![${state.esc(node.attrs.alt || "")}](${escapeUrl(node.attrs.src)}${title})`;
  return node.attrs.link ? `[${image}](${escapeUrl(node.attrs.link)})` : image;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function writeText(state: State, text: string, videosEnabled: boolean): void {
  // A paragraph that happens to start with a literal `<video …>` line must not
  // round-trip into a video node, so escape its opening bracket.
  if (videosEnabled && state.atBlank() && VIDEO_LINE_RE.test(text.split("\n")[0])) {
    state.write("\\");
  }
  state.text(text, !state.inAutolink);
}

function isPlainUrl(href: string, parent: Node, index: number): boolean {
  if (!/^\w+:/.test(href)) return false;
  const content = parent.child(index);
  if (!content.isText || content.text !== href || content.marks[content.marks.length - 1]?.type.name !== "link") return false;
  return index === parent.childCount - 1 || !parent.child(index + 1).marks.some((m) => m.type.name === "link");
}

/**
 * Two adjacent lists of the same kind are indistinguishable from one list in
 * markdown, so they are rendered as one (the parser merges them the same way).
 */
function mergeAdjacentLists(doc: Node): Node {
  const { bullet_list, ordered_list, paragraph } = doc.type.schema.nodes;
  const blocks: Node[] = [];
  doc.forEach((node) => {
    // Empty paragraphs are not rendered, so they don't keep lists apart either.
    if (node.type === paragraph && node.content.size === 0) return;
    const prev = blocks[blocks.length - 1];
    if (prev && (node.type === bullet_list || node.type === ordered_list) && prev.type === node.type) {
      blocks[blocks.length - 1] = prev.type.create(prev.attrs, prev.content.append(node.content));
    } else {
      blocks.push(node);
    }
  });
  return blocks.length ? doc.type.create(doc.attrs, blocks) : doc;
}

/** Serialize a document to canonical markdown. */
export function serializeMarkdown(doc: Node): string {
  return markdownSerializer.serialize(collapseWhitespace(mergeAdjacentLists(doc)), { tightLists: true }).trimEnd();
}
