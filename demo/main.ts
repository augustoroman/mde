import { createEditor } from "../src";

const sample = `# Welcome to mde

This editor produces a **small, predictable** subset of markdown: headings, paragraphs, *emphasis*, links, lists, images and videos. Nothing else.

This is a second paragraph. It is long enough to wrap onto more than one line at the demo's width, so you can see that lines inside a paragraph sit close together while separate paragraphs are clearly spaced apart. There are no hard line breaks in this format: text is either part of one paragraph or the next.

## Try it

- Type \`# \` at the start of a line for a heading
- Type \`- \` or \`1. \` for lists, Tab / Shift-Tab to nest
- Wrap text in \`**\` or \`*\` while typing
- ⌘B, ⌘I, ⌘K for bold, italic, link
- Tab / Shift-Tab indent and outdent paragraphs

> An indented paragraph. In markdown it is written with a \`>\` prefix, one per level.

1. Switch to **Markdown** to edit the source directly
2. Switch to **Preview** to see the rendered result
3. Double-click an image or video to change its URL

![A sample image](https://picsum.photos/seed/mde/800/400)

<video src="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" controls></video>

Made with [ProseMirror](https://prosemirror.net).`;

const output = document.getElementById("output")!;
const editor = createEditor(document.getElementById("editor")!, {
  markdown: sample,
  placeholder: "Start writing…",
  onChange: (markdown) => {
    output.textContent = markdown;
  },
  onModeChange: (mode) => console.log("[mde] mode:", mode),
});
output.textContent = editor.getMarkdown();

// Expose for poking around in the console.
(window as unknown as { editor: typeof editor }).editor = editor;
