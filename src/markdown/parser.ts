import { MarkdownParser } from "prosemirror-markdown";
import type { Node, Schema } from "prosemirror-model";
import { createTokenizer } from "./tokenizer";
import { headingLevelsOf, schema as defaultSchema } from "../schema";

/**
 * Create a parser that turns markdown into a document for `schema`.
 * Unsupported constructs are degraded rather than rejected, so any input
 * produces a valid document.
 */
export function createMarkdownParser(schema: Schema = defaultSchema): MarkdownParser {
  const images = !!schema.nodes.image;
  const videos = !!schema.nodes.video;
  const html = !!schema.nodes.html_block;
  const tokenizer = createTokenizer({ headingLevels: headingLevelsOf(schema), images, videos, html });

  return new MarkdownParser(schema, tokenizer, {
    paragraph: { block: "paragraph", getAttrs: (tok) => ({ indent: Number(tok.attrGet("indent")) || 0 }) },
    heading: { block: "heading", getAttrs: (tok) => ({ level: Number(tok.tag.slice(1)) }) },
    bullet_list: { block: "bullet_list" },
    ordered_list: { block: "ordered_list", getAttrs: (tok) => ({ order: Number(tok.attrGet("start")) || 1 }) },
    list_item: { block: "list_item" },
    ...(images
      ? {
          image_block: {
            node: "image",
            getAttrs: (tok) => ({
              src: String(tok.attrGet("src") ?? ""),
              alt: String(tok.attrGet("alt") ?? ""),
              caption: String(tok.attrGet("caption") ?? ""),
              link: String(tok.attrGet("link") ?? ""),
            }),
          },
          photo_row: { block: "photo_row" },
        }
      : {}),
    ...(videos
      ? {
          video: {
            node: "video",
            getAttrs: (tok) => ({
              src: String(tok.attrGet("src") ?? ""),
              poster: String(tok.attrGet("poster") ?? ""),
              caption: String(tok.attrGet("caption") ?? ""),
            }),
          },
        }
      : {}),
    ...(html ? { html_block: { node: "html_block", getAttrs: (tok) => ({ html: tok.content }) } } : {}),
    em: { mark: "em" },
    strong: { mark: "strong" },
    link: { mark: "link", getAttrs: (tok) => ({ href: String(tok.attrGet("href") ?? "") }) },
  });
}

const defaultParser = createMarkdownParser(defaultSchema);

/** Parse markdown into a document using the default schema. */
export function parseMarkdown(markdown: string, parser: MarkdownParser = defaultParser): Node {
  return parser.parse(markdown);
}
