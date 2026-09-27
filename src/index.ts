import "./style.css";
import { DOMSerializer } from "prosemirror-model";
import { createMarkdownParser, parseMarkdown, serializeMarkdown } from "./markdown";
import { createSchema, schema, type HeadingLevel, type SchemaOptions } from "./schema";

export { createEditor } from "./editor/editor";
export type { EditorMode, EditorOptions, MarkdownEditor, ImageChoice, VideoChoice, UploadResult } from "./editor/editor";
export { createSchema, schema, clampHeadingLevel, headingLevelsOf, DEFAULT_HEADING_LEVELS } from "./schema";
export type { HeadingLevel, SchemaOptions } from "./schema";
export { createMarkdownParser, parseMarkdown, markdownSerializer, serializeMarkdown, VIDEO_LINE_RE } from "./markdown";
export {
  insertImage,
  insertVideo,
  setLink,
  removeLink,
  toggleList,
  setHeading,
  setParagraph,
} from "./editor/commands";

/**
 * Normalize arbitrary markdown into the canonical form this editor produces.
 * Useful on the server to validate/clean submissions.
 */
export function normalizeMarkdown(markdown: string, options?: SchemaOptions | HeadingLevel[]): string {
  return serializeMarkdown(createMarkdownParser(schemaFor(options)).parse(markdown));
}

/** Render markdown to an HTML string using the same DOM output as the editor. Requires a DOM. */
export function markdownToHtml(markdown: string, options?: SchemaOptions | HeadingLevel[]): string {
  const s = schemaFor(options);
  const doc = options ? createMarkdownParser(s).parse(markdown) : parseMarkdown(markdown);
  const container = document.createElement("div");
  container.appendChild(DOMSerializer.fromSchema(s).serializeFragment(doc.content));
  return container.innerHTML;
}

/** Same options as `createEditor`'s schema options; a bare array is a heading level list. */
function schemaFor(options?: SchemaOptions | HeadingLevel[]) {
  if (!options) return schema;
  return createSchema(Array.isArray(options) ? { headingLevels: options } : options);
}
