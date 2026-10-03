import MarkdownIt, {
  type MarkdownIt as MarkdownItInstance,
  type StateBlock,
  type StateCore,
  type Token,
} from "markdown-it";
import { clampHeadingLevel, type HeadingLevel } from "../schema";

/** A standalone video line: `<video src="https://…"></video>` (`src` and `poster` are kept, other attributes ignored). */
export const VIDEO_LINE_RE = /^<video\b([^>]*?\bsrc="[^"\s]+"[^>]*)>(?:\s*<\/video>)?\s*$/i;
/** A video with a caption: `<figure>` holding a `<video>` line and an optional `<figcaption>`, closed by `</figure>`. */
const FIGURE_RE = /^<figure\b[^>]*>\s*<video\b([^>]*?\bsrc="[^"\s]+"[^>]*)>(?:\s*<\/video>)?\s*(?:<figcaption>([\s\S]*?)<\/figcaption>)?\s*<\/figure>\s*$/i;

/** Pull `src` and `poster` out of a video tag's attribute string. */
export function videoAttrs(attrs: string): { src: string; poster: string } {
  const get = (name: string) => new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attrs)?.[1] ?? "";
  return { src: get("src"), poster: get("poster") };
}

function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

export interface TokenizerOptions {
  headingLevels: readonly HeadingLevel[];
  /** Emit block images (otherwise images become links). */
  images: boolean;
  /** Recognize standalone `<video>` lines. */
  videos: boolean;
  /** Keep raw HTML blocks as opaque nodes. */
  html?: boolean;
}

/**
 * Build a markdown-it instance that only ever emits the token types the
 * constrained schema understands. Two layers do the work:
 *
 *  1. Every markdown-it rule for a feature we don't support is disabled, so
 *     that syntax simply reads as literal text (a `> quote` stays "> quote").
 *  2. A final core rule rewrites the token stream so that the structure is
 *     valid for the schema: images become their own blocks, headings are
 *     clamped, block quotes become paragraph indentation, and so on.
 */
export function createTokenizer(options: TokenizerOptions): MarkdownItInstance {
  const md = new MarkdownIt("commonmark", { html: !!options.html, linkify: false, typographer: false, breaks: false });

  md.disable(["code", "fence", "hr", "table", "backticks", "html_inline", "strikethrough"], true);
  if (!options.html) md.disable(["html_block"], true);

  if (options.videos) {
    // Before html_block, which would otherwise swallow `<video>` and `<figure>` lines when html is on.
    md.block.ruler.before("html_block", "video", videoRule, { alt: ["paragraph", "reference", "blockquote", "list"] });
  }
  md.core.ruler.push("mde_normalize", (state) => normalize(state, options));

  return md;
}

function videoRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const lineText = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
  const first = lineText(startLine);
  let attrs: string | undefined;
  let caption = "";
  let lines = 1;
  const single = VIDEO_LINE_RE.exec(first);
  if (single) {
    attrs = single[1];
  } else if (/^<figure\b/i.test(first)) {
    // A figure spans up to six lines; find its closing tag.
    for (let n = startLine; n < Math.min(endLine, startLine + 6); n++) {
      if (!/<\/figure>\s*$/i.test(lineText(n))) continue;
      const block = Array.from({ length: n - startLine + 1 }, (_, i) => lineText(startLine + i)).join("\n");
      const m = FIGURE_RE.exec(block);
      if (!m) return false;
      attrs = m[1];
      caption = unescapeHtml((m[2] ?? "").trim());
      lines = n - startLine + 1;
      break;
    }
  }
  if (attrs === undefined) return false;
  if (silent) return true;

  const { src, poster } = videoAttrs(attrs);
  const token = state.push("video", "video", 0);
  token.attrSet("src", src);
  token.attrSet("poster", poster);
  token.attrSet("caption", caption);
  token.map = [startLine, startLine + lines];
  state.line = startLine + lines;
  return true;
}

// --- Token tree helpers ------------------------------------------------------

/** A block token with its (possibly nested) children, so we can restructure by node instead of by index. */
interface TokenTree {
  open: Token;
  close: Token | null;
  children: TokenTree[];
}

function toTree(tokens: Token[]): TokenTree[] {
  const root: TokenTree = { open: null as unknown as Token, close: null, children: [] };
  const stack: TokenTree[] = [root];
  for (const token of tokens) {
    const top = stack[stack.length - 1];
    if (token.nesting === 1) {
      const node: TokenTree = { open: token, close: null, children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (token.nesting === -1) {
      const node = stack.pop()!;
      node.close = token;
    } else {
      top.children.push({ open: token, close: null, children: [] });
    }
  }
  return root.children;
}

function flatten(nodes: TokenTree[], out: Token[] = []): Token[] {
  for (const node of nodes) {
    out.push(node.open);
    flatten(node.children, out);
    if (node.close) out.push(node.close);
  }
  return out;
}

function baseType(token: Token): string {
  return token.type.replace(/_(open|close)$/, "");
}

function makeToken(state: StateCore, type: string, tag: string, nesting: 1 | 0 | -1): Token {
  const token = new state.Token(type, tag, nesting);
  token.block = true;
  return token;
}

function paragraphOf(state: StateCore, children: Token[], indent = 0): TokenTree {
  const inline = makeToken(state, "inline", "", 0);
  inline.children = children;
  const open = makeToken(state, "paragraph_open", "p", 1);
  if (indent) open.attrSet("indent", String(indent));
  return {
    open,
    close: makeToken(state, "paragraph_close", "p", -1),
    children: [{ open: inline, close: null, children: [] }],
  };
}

function textToken(state: StateCore, content: string): Token {
  const token = new state.Token("text", "", 0);
  token.content = content;
  return token;
}

function linkTokens(state: StateCore, href: string, text: string): Token[] {
  const open = new state.Token("link_open", "a", 1);
  open.attrSet("href", href);
  return [open, textToken(state, text), new state.Token("link_close", "a", -1)];
}

// --- Normalization -----------------------------------------------------------

function normalize(state: StateCore, options: TokenizerOptions): void {
  const tree = toTree(state.tokens);
  state.tokens = flatten(normalizeBlocks(state, tree, false, options));
}

/**
 * Rewrite a sequence of block-level token nodes into one the schema accepts.
 * Inside a list item only paragraphs and lists survive; everything else is
 * degraded to a paragraph.
 */
function normalizeBlocks(state: StateCore, nodes: TokenTree[], inListItem: boolean, options: TokenizerOptions): TokenTree[] {
  const out: TokenTree[] = [];

  for (const node of nodes) {
    switch (baseType(node.open)) {
      case "paragraph":
        out.push(...splitParagraph(state, node, inListItem || !options.images));
        break;

      case "heading": {
        if (inListItem) {
          node.open.type = "paragraph_open";
          node.close!.type = "paragraph_close";
          node.open.tag = node.close!.tag = "p";
          out.push(...splitParagraph(state, node, true));
        } else {
          const level = clampHeadingLevel(Number(node.open.tag.slice(1)), options.headingLevels);
          node.open.tag = node.close!.tag = `h${level}`;
          // Headings hold inline content only; images inside a heading become links.
          const inline = node.children[0]?.open;
          if (inline?.children) inline.children = inlineWithoutImages(state, inline.children);
          out.push(node);
        }
        break;
      }

      case "video":
        if (inListItem) {
          const src = String(node.open.attrGet("src") ?? "");
          out.push(paragraphOf(state, linkTokens(state, src, src)));
        } else {
          out.push(node);
        }
        break;

      case "blockquote": {
        // A quote is our indentation: each paragraph inside goes one level
        // deeper. Anything else inside is simply unwrapped.
        for (const child of normalizeBlocks(state, node.children, inListItem, options)) {
          if (baseType(child.open) === "paragraph") {
            child.open.attrSet("indent", String((Number(child.open.attrGet("indent")) || 0) + 1));
          }
          out.push(child);
        }
        break;
      }

      case "bullet_list":
      case "ordered_list": {
        node.children = normalizeListItems(state, node.children, options);
        // Two adjacent lists of the same kind cannot be told apart in
        // markdown, so they are one list.
        const prev = out[out.length - 1];
        if (prev && baseType(prev.open) === baseType(node.open)) prev.children.push(...node.children);
        else out.push(node);
        break;
      }

      case "html_block":
        if (options.html && node.open.content.trim()) {
          node.open.content = node.open.content.trim();
          out.push(node);
        } else if (node.open.content.trim()) {
          out.push(paragraphOf(state, [textToken(state, node.open.content.trim())]));
        }
        break;

      default:
        // Anything else has no place in the schema. Containers are unwrapped,
        // leaves with text become paragraphs, empty leaves are dropped.
        if (node.open.nesting === 1) {
          out.push(...normalizeBlocks(state, node.children, inListItem, options));
        } else if (node.open.content) {
          out.push(paragraphOf(state, [textToken(state, node.open.content)]));
        }
    }
  }

  return out;
}

/**
 * Inside a list item only paragraphs and nested lists survive (see
 * `normalizeBlocks`); here touching lists of the same kind are merged, since
 * markdown cannot tell them apart.
 */
function normalizeListItems(state: StateCore, items: TokenTree[], options: TokenizerOptions): TokenTree[] {
  for (const item of items) {
    const blocks = normalizeBlocks(state, item.children, true, options);
    const merged: TokenTree[] = [];
    for (const block of blocks) {
      const prev = merged[merged.length - 1];
      const type = baseType(block.open);
      if (prev && (type === "bullet_list" || type === "ordered_list") && baseType(prev.open) === type) {
        prev.children.push(...block.children);
      } else {
        merged.push(block);
      }
    }
    // The item's own paragraph is never indented; the bullet is its indent.
    const head = merged[0];
    if (head && baseType(head.open) === "paragraph") head.open.attrSet("indent", "0");
    item.children = merged;
  }
  return items;
}

/**
 * A paragraph whose inline content contains images is split into a sequence
 * of paragraph / image-block nodes. With `imagesAsLinks` (inside list items,
 * or when block images are disabled) images become links instead.
 */
function splitParagraph(state: StateCore, paragraph: TokenTree, imagesAsLinks: boolean): TokenTree[] {
  const inline = paragraph.children[0]?.open;
  const children = inline?.children ?? [];

  for (const child of children) {
    if (child.type === "hardbreak") child.type = "softbreak";
    // Runs of spaces render as one space anyway; keep the document honest about it.
    if (child.type === "text") child.content = child.content.replace(/[ \t\u00a0]+/g, " ");
  }

  if (!children.some((t) => t.type === "image")) return isBlankInline(children) ? [] : [paragraph];

  if (imagesAsLinks) {
    inline!.children = inlineWithoutImages(state, children);
    return [paragraph];
  }

  const out: TokenTree[] = [];
  const indent = Number(paragraph.open.attrGet("indent")) || 0;
  let run: Token[] = [];
  const flushRun = () => {
    if (!isBlankInline(run)) out.push(paragraphOf(state, trimInline(run), indent));
    run = [];
  };

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    // `[![alt](src)](link)`: a link holding only an image is the image's click-through.
    if (child.type === "link_open" && children[i + 1]?.type === "image" && children[i + 2]?.type === "link_close") {
      flushRun();
      out.push(imageBlock(state, children[i + 1], String(child.attrGet("href") ?? "")));
      i += 2;
    } else if (child.type === "image") {
      flushRun();
      out.push(imageBlock(state, child, ""));
    } else {
      run.push(child);
    }
  }
  flushRun();

  // Only images, two or more: they sit side by side, with one shared caption
  // (the first title among them; markdown has no caption for a group).
  if (out.length >= 2 && out.every((n) => n.open.type === "image_block")) {
    const open = makeToken(state, "photo_row_open", "figure", 1);
    const close = makeToken(state, "photo_row_close", "figure", -1);
    const caption = out.map((n) => String(n.open.attrGet("caption") ?? "")).find((c) => c) ?? "";
    for (const n of out) n.open.attrSet("caption", "");
    open.attrSet("caption", caption);
    return [{ open, close, children: out }];
  }
  return out;
}

function imageBlock(state: StateCore, image: Token, link: string): TokenTree {
  const block = makeToken(state, "image_block", "img", 0);
  block.attrSet("src", String(image.attrGet("src") ?? ""));
  block.attrSet("alt", image.content ?? "");
  block.attrSet("caption", String(image.attrGet("title") ?? ""));
  block.attrSet("link", link);
  return { open: block, close: null, children: [] };
}

function inlineWithoutImages(state: StateCore, children: Token[]): Token[] {
  const out: Token[] = [];
  for (const child of children) {
    if (child.type !== "image") {
      out.push(child);
      continue;
    }
    const src = String(child.attrGet("src") ?? "");
    out.push(...linkTokens(state, src, child.content || src));
  }
  return out;
}

function isBlankInline(tokens: Token[]): boolean {
  return tokens.every((t) => (t.type === "text" && !t.content.trim()) || t.type === "softbreak");
}

/** Drop leading/trailing whitespace-only tokens left behind by a split. */
function trimInline(tokens: Token[]): Token[] {
  const isBlank = (t: Token) => (t.type === "text" && !t.content.trim()) || t.type === "softbreak";
  let start = 0;
  let end = tokens.length;
  while (start < end && isBlank(tokens[start])) start++;
  while (end > start && isBlank(tokens[end - 1])) end--;
  const result = tokens.slice(start, end);
  if (result.length && result[0].type === "text") result[0].content = result[0].content.replace(/^\s+/, "");
  const last = result[result.length - 1];
  if (last?.type === "text") last.content = last.content.replace(/\s+$/, "");
  return result;
}
