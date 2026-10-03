# mde

A small WYSIWYG markdown editor for the browser, built on [ProseMirror](https://prosemirror.net).
It is deliberately constrained: the document model only knows about the features you
allow-list, and the markdown it emits is canonical and predictable.

## Features

- Headings (levels configurable, default 1–3), paragraphs (with indent levels), **bold**, *italic*,
  links, ordered and unordered lists (nestable), centered block images and videos, each with an
  optional caption; two or more images on one line sit side by side. Optionally, raw HTML blocks
  that round-trip untouched. Nothing else.
- Three modes in one component: rich text, raw markdown source, and read-only preview.
- Markdown-style typing shortcuts (`# `, `- `, `1. `, `**bold**`, `*em*`), keyboard shortcuts
  (⌘B, ⌘I, ⌘K, ⇧⌘7/8 for lists, ⇧⌘0–3 for block type, Tab/⇧Tab to nest lists), and a toolbar.
  ⌘B/⌘I with the cursor inside a word apply to the whole word; an explicit selection wins.
- The same shortcuts work in markdown source mode, editing the text directly (`**word**`,
  `[word](|)`, `## ` prefixes, `- ` / `1. ` list toggles, Tab indents list lines).
- Unsupported markdown never breaks anything: block quotes, code, tables, rules and HTML degrade
  to plain text; images inside lists/headings become links; loose lists become tight; extra
  heading levels are clamped.
- Pasting plain text parses it as markdown; pasting HTML is filtered through the schema.
- The rich view is kept in the exact shape of the markdown output: empty paragraphs exist only
  while the cursor is in them, and two lists of the same kind that touch are one list. Backspace at
  the start of a list item un-indents, then leaves the list, then joins onto the previous item.
- Tab means one level deeper, Shift-Tab one level shallower. A paragraph that follows a list goes
  into the list's last item (markdown's continuation paragraph); any other paragraph gets an indent
  level, written as a `> ` prefix per level. Tab on a list item nests it. Backspace at the start of
  an indented paragraph removes one level. Tab and Shift-Tab never move focus, in either mode.

## Install

```sh
npm install mde prosemirror-model prosemirror-state prosemirror-view
```

(All `prosemirror-*` packages and `markdown-it` are regular dependencies and are left external in
the build so your bundler can deduplicate them.)

## Usage

```ts
import { createEditor } from "mde";
import "mde/style.css";

const editor = createEditor(document.getElementById("editor")!, {
  markdown: "# Hello\n\nStart writing.",
  placeholder: "Start writing…",
  headingLevels: [1, 2, 3],           // default
  images: true, videos: true,           // default; false removes the feature entirely
  modes: ["rich", "source", "preview"], // default; toolbar mode switcher
  onChange: (markdown) => save(markdown),
});

editor.getMarkdown();        // canonical markdown
editor.setMarkdown("...");   // replace content
editor.setMode("preview");   // "rich" | "source" | "preview"
editor.insertImage("https://…/pic.png", "alt text"); // e.g. after your own upload flow
editor.insertImage("https://…/pic.png", { alt: "alt text", caption: "Shown under it", link: "https://…/full.png" });
editor.insertImageRow([{ src: "https://…/a.png" }, { src: "https://…/b.png" }]); // side by side
editor.insertVideo("https://…/clip.mp4", { poster: "https://…/clip.webp", caption: "Shown under it" });
editor.focus();
editor.destroy();
```

`onChange` fires only when the *markdown output* changes, so cosmetic edits (like an empty
paragraph that will be dropped on output) don't trigger it.

### Turning images or videos off

`images: false` / `videos: false` remove the feature from the allow-list: no toolbar button, no
paste/drop upload, `insertImage`/`insertVideo` become no-ops, and the node is absent from the
schema. Markdown that uses the feature degrades on the way in: images become links to the file,
and a `<video>` line is plain text. `createSchema({ images: false })` and `normalizeMarkdown`
follow the same options on the server.

### Your own image/video picker and uploads

The built-in popover just asks for a URL. Hand the editor your own picker and it is used instead,
both from the toolbar and when an existing image/video is double-clicked:

```ts
createEditor(el, {
  pickImage: async (current) => {
    // current is null for a new image, or { src, alt, caption, link } when editing one
    const asset = await openMediaBrowser({ kind: "image", selected: current?.src });
    return asset ? { src: asset.url, alt: asset.alt, caption: asset.caption } : null; // null = cancelled
  },
  pickVideo: async (current) => { /* same shape with { src, poster, caption } */ },
  pickMedia: async () => {
    // one "Insert media" button instead of image + video; resolve with
    // { kind: "image", src, … } or { kind: "video", src, … }, or insert yourself and resolve null
    const asset = await openMediaBrowser();
    return asset ? { kind: asset.kind, src: asset.url } : null;
  },
  pickLink: async (current) => {
    // current is { href, text } for a link under the cursor or a selection, else null
    const page = await openPagePicker();
    return page ? { href: page.url, text: page.title } : null; // text is used when nothing is selected
  },
  uploadFile: async (file) => {
    // called for every image/video file pasted or dropped into the editor
    const { url } = await api.upload(file);
    return { kind: file.type.startsWith("video/") ? "video" : "image", src: url };
  },
});
```

`editor.insertImage(src, alt)` and `editor.insertVideo(src)` remain available for inserting from
anywhere else in your UI.

### Server-side helpers

```ts
import { normalizeMarkdown, parseMarkdown, serializeMarkdown, markdownToHtml } from "mde";

normalizeMarkdown(untrustedInput); // canonical, schema-valid markdown (no DOM needed)
markdownToHtml(markdown);          // same HTML as the editor/preview (needs a DOM)
// both take the editor's schema options, e.g. { headingLevels: [2, 3], videos: false }
```

## Styling

`mde/style.css` covers the editor chrome (toolbar, popover, cursors) and the one structural
guarantee, centered auto-sized media. Document typography is yours: style `.mde-content`
(applied to both the rich editor and the preview) in your page. `index.html` in this repo shows a
starting point; give paragraphs a real margin so a new paragraph looks different from a wrapped line:

```css
.mde-content p { margin: 1.25em 0; }
.mde-content h1, .mde-content h2, .mde-content h3 { margin: 1.5em 0 0.6em; }
.mde-content ul, .mde-content ol { margin: 1em 0; padding-left: 1.6em; }
.mde-content li > p { margin: 0; } /* list items wrap a <p>; keep them tight */
.mde-content { --mde-indent: 1.6em; } /* one paragraph indent level = the list padding */
```

## Output format

The serializer always emits the same shape for the same structure:

```markdown
# Heading

A paragraph with **strong**, *emphasis* and a [link](https://example.com).

- bullet
- bullet
  1. nested ordered
  2. nested ordered

![alt text](https://example.com/image.png)

[![alt text](https://example.com/thumb.png "A caption")](https://example.com/full.png)

![left](https://example.com/a.png) ![right](https://example.com/b.png)

<video src="https://example.com/clip.mp4" poster="https://example.com/clip.webp" controls></video>

<figure>
<video src="https://example.com/clip.mp4" controls></video>
<figcaption>A caption</figcaption>
</figure>
```

- Blocks are separated by exactly one blank line; lists are always tight.
- Bullets use `-`, emphasis `*`, strong `**`. Links with text equal to their URL become `<url>`.
- Empty paragraphs are never emitted. There are no hard line breaks: text is either in one
  paragraph or the next.
- Words are separated by exactly one space. Runs of spaces, tabs and non-breaking spaces collapse
  to one, and blocks have no leading or trailing space. Markdown renders all of those identically,
  so the editor never shows a difference the output can't keep.
- An image's caption is its markdown title (`"…"` after the URL); a link wrapping the image is the
  image's click-through (`link`), typically the full-size original. Both are optional attributes of
  the image node.
- Two or more images on one line, and nothing else, are a `photo_row`: the editor shows them side
  by side under one shared caption, written as the title of the row's first image (titles on the
  others are dropped). Editing any image in the row edits that caption. Text between images splits
  them into separate blocks. Dragging an image onto another
  puts it above or below (top or bottom third), beside it in a row (middle third, left or right
  of centre), or into a row at that slot (left or right half of an image in a row). The document
  logic is `dropImages`, exported, and `test/dragdrop.test.ts` runs every combination of document
  shape, dragged image, target, zone and selection state against a small model of the result.
- A video is a standalone `<video src="…" controls></video>` line, which renders as-is with any
  HTML-enabled markdown renderer. `src` and `poster` are preserved; a caption wraps it in
  `<figure>` with a `<figcaption>`, which also renders as-is.
- Images are always their own block (an image inside a paragraph splits the paragraph).
- With `html: true`, HTML blocks (an `<iframe>` embed, say) are kept as opaque blocks and written
  back verbatim; the editor shows their source. Inline HTML is always plain text.
- A paragraph indented on its own is written as a block quote, one `> ` per level. That is the only
  markdown construct that indents a block anywhere, and every renderer shows it indented. In the
  editor's HTML it is `<p data-indent="2">`, pushed in by `--mde-indent` per level:

  ```markdown
  > indented paragraph

  > > indented twice
  ```

- A paragraph indented under a list item is that item's continuation paragraph:

  ```markdown
  - task

    indented note under the task
  ```

### Document model

```
doc        := block+
block      := paragraph | heading | bullet_list | ordered_list | image | photo_row | video | html_block?
photo_row  := image image+
list_item  := paragraph (paragraph | bullet_list | ordered_list)*
marks      := strong | em | link
```

## Development

```sh
npm run dev    # demo page at http://localhost:5173
npm test       # round-trip and editor tests (vitest, jsdom)
npm run build  # dist/mde.js, dist/mde.css, dist/*.d.ts
```

## Layout

- `src/schema.ts` — the ProseMirror schema.
- `src/markdown/tokenizer.ts` — markdown-it configuration: disabled rules, the `<video>` block rule,
  and the normalization pass that makes any token stream fit the schema.
- `src/markdown/parser.ts`, `serializer.ts` — markdown ⇄ document.
- `src/editor/` — commands, keymap, input rules, toolbar, popover, and `createEditor`.
