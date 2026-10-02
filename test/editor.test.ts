// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { stackOntoImage } from "../src";
import { createEditor, insertImage, insertVideo, setLink, toggleList, type MarkdownEditor } from "../src";

// jsdom has no layout; ProseMirror's view tolerates that with a few stubs.
beforeEach(() => {
  Object.defineProperty(document, "elementFromPoint", { value: () => null, configurable: true });
  (Range.prototype as unknown as { getClientRects: () => DOMRectList }).getClientRects = () => [] as unknown as DOMRectList;
  (Range.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }) as DOMRect;
});

let container: HTMLElement;
let editor: MarkdownEditor;
let changes: string[];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  changes = [];
});
afterEach(() => {
  editor?.destroy();
  container.remove();
});

const mount = (markdown: string, extra = {}) =>
  (editor = createEditor(container, { markdown, onChange: (md) => changes.push(md), ...extra }));

/** Put the cursor at the end of the document. */
const cursorAtEnd = () => {
  const { view } = editor;
  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
};
const cursorAt = (pos: number) => {
  const { view } = editor;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
};

describe("createEditor", () => {
  it("renders toolbar, rich view, and reports initial markdown", () => {
    mount("# Hi\n\nText");
    expect(container.querySelector(".mde-toolbar")).not.toBeNull();
    expect(container.querySelectorAll(".mde-tool").length).toBeGreaterThan(8);
    expect(container.querySelector(".ProseMirror h1")?.textContent).toBe("Hi");
    expect(editor.getMarkdown()).toBe("# Hi\n\nText");
    expect(editor.getMode()).toBe("rich");
  });

  it("switches between rich, source and preview and keeps content in sync", () => {
    mount("# Hi\n\n- a\n- b");
    editor.setMode("source");
    const textarea = container.querySelector<HTMLTextAreaElement>(".mde-source")!;
    expect(textarea.hidden).toBe(false);
    expect(textarea.value).toBe("# Hi\n\n- a\n- b");

    textarea.value = "## Changed\n\n> quote\n\n1. one";
    textarea.dispatchEvent(new Event("input"));
    expect(changes.at(-1)).toBe("## Changed\n\n> quote\n\n1. one");

    editor.setMode("preview");
    const preview = container.querySelector<HTMLElement>(".mde-preview")!;
    expect(preview.hidden).toBe(false);
    expect(preview.querySelector("h2")?.textContent).toBe("Changed");
    expect(preview.querySelector("ol li")?.textContent).toBe("one");

    editor.setMode("rich");
    expect(container.querySelector(".ProseMirror h2")?.textContent).toBe("Changed");
    expect(editor.getMarkdown()).toBe("## Changed\n\n> quote\n\n1. one");
    expect(container.querySelector(".ProseMirror p[data-indent]")?.textContent).toBe("quote");
  });

  it("toolbar mode buttons switch modes and call onModeChange", () => {
    const onModeChange = vi.fn();
    mount("x", { onModeChange });
    const btn = container.querySelector<HTMLButtonElement>('.mde-mode[data-mode="preview"]')!;
    btn.click();
    expect(editor.getMode()).toBe("preview");
    expect(onModeChange).toHaveBeenCalledWith("preview");
    expect(btn.classList.contains("is-active")).toBe(true);
    // formatting tools are disabled outside rich mode
    expect(container.querySelector<HTMLButtonElement>('[data-tool="bold"]')!.disabled).toBe(true);
  });

  it("setMarkdown replaces the document and emits a change", () => {
    mount("a");
    editor.setMarkdown("# New\n\n![i](/i.png)");
    expect(editor.getMarkdown()).toBe("# New\n\n![i](/i.png)");
    expect(changes.at(-1)).toBe("# New\n\n![i](/i.png)");
    expect(container.querySelector(".ProseMirror figure.mde-image img")?.getAttribute("src")).toBe("/i.png");
  });

  it("does not emit onChange when the markdown output is unchanged", () => {
    mount("a");
    const { view } = editor;
    // Adding an empty paragraph changes the doc but not the markdown.
    cursorAtEnd();
    view.dispatch(view.state.tr.split(view.state.selection.from));
    expect(editor.getMarkdown()).toBe("a");
    expect(changes).toEqual([]);
  });

  it("only offers the configured modes and heading levels", () => {
    mount("# a", { modes: ["rich", "preview"], headingLevels: [2, 3] });
    expect(container.querySelectorAll(".mde-mode").length).toBe(2);
    expect(container.querySelector('[data-tool="h1"]')).toBeNull();
    expect(container.querySelector('[data-tool="h2"]')).not.toBeNull();
    expect(editor.getMarkdown()).toBe("## a");
  });

  it("shows a placeholder only for an empty document", () => {
    mount("", { placeholder: "Write…" });
    expect(container.querySelector(".mde-empty")?.getAttribute("data-placeholder")).toBe("Write…");
    editor.setMarkdown("x");
    expect(container.querySelector(".mde-empty")).toBeNull();
  });
});

describe("commands", () => {
  it("toolbar bold button toggles strong and reflects active state", () => {
    mount("hello");
    const { view } = editor;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
    const bold = container.querySelector<HTMLButtonElement>('[data-tool="bold"]')!;
    bold.click();
    expect(editor.getMarkdown()).toBe("**hello**");
    expect(bold.classList.contains("is-active")).toBe(true);
    bold.click();
    expect(editor.getMarkdown()).toBe("hello");
  });

  it("heading buttons set block type, paragraph resets it", () => {
    mount("hello");
    container.querySelector<HTMLButtonElement>('[data-tool="h2"]')!.click();
    expect(editor.getMarkdown()).toBe("## hello");
    container.querySelector<HTMLButtonElement>('[data-tool="paragraph"]')!.click();
    expect(editor.getMarkdown()).toBe("hello");
  });

  it("toggleList wraps, converts and lifts", () => {
    mount("hello");
    const { view, schema } = editor;
    toggleList(schema.nodes.bullet_list)(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe("- hello");
    toggleList(schema.nodes.ordered_list)(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe("1. hello");
    toggleList(schema.nodes.ordered_list)(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe("hello");
  });

  it("setLink wraps the selection, or inserts the url when nothing is selected", () => {
    mount("read this");
    const { view, schema } = editor;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6, 10)));
    setLink(schema, "https://x.test")(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe("read [this](https://x.test)");
    // re-linking from inside the existing link replaces its href
    cursorAt(8);
    setLink(schema, "https://y.test")(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe("read [this](https://y.test)");
    cursorAtEnd();
    view.dispatch(view.state.tr.insertText(" "));
    setLink(schema, "https://z.test")(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe("read [this](https://y.test) <https://z.test>");
  });

  it("insertImage replaces an empty paragraph, splits a paragraph, and lands after lists", () => {
    mount("");
    const { view, schema } = editor;
    insertImage(schema, "/a.png", "A")(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe("![A](/a.png)");
    // cursor is in the trailing paragraph; typing works
    view.dispatch(view.state.tr.insertText("after"));
    expect(editor.getMarkdown()).toBe("![A](/a.png)\n\nafter");

    // split in the middle of a paragraph
    cursorAt(view.state.doc.content.size - 4);
    insertVideo(schema, "/v.mp4")(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe('![A](/a.png)\n\naf\n\n<video src="/v.mp4" controls></video>\n\nter');

    // inside a list -> after the list
    editor.setMarkdown("- one\n- two");
    cursorAt(3);
    insertImage(schema, "/b.png")(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe("- one\n- two\n\n![](/b.png)");
  });

  it("api insertImage works from source mode by switching to rich", () => {
    mount("text", { mode: "source" });
    editor.insertImage("/c.png", "C");
    expect(editor.getMode()).toBe("rich");
    expect(editor.getMarkdown()).toBe("text\n\n![C](/c.png)");
  });
});

describe("popover", () => {
  it("link button opens a popover and submitting inserts a link", () => {
    mount("hello");
    const { view } = editor;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
    container.querySelector<HTMLButtonElement>('[data-tool="link"]')!.click();
    const popover = container.querySelector<HTMLElement>(".mde-popover")!;
    expect(popover.hidden).toBe(false);
    const input = popover.querySelector<HTMLInputElement>('input[name="href"]')!;
    input.value = "https://example.com";
    popover.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(popover.hidden).toBe(true);
    expect(editor.getMarkdown()).toBe("[hello](https://example.com)");
  });

  it("image popover inserts an image with alt text", () => {
    mount("");
    container.querySelector<HTMLButtonElement>('[data-tool="image"]')!.click();
    const popover = container.querySelector<HTMLElement>(".mde-popover")!;
    popover.querySelector<HTMLInputElement>('input[name="src"]')!.value = "/p.png";
    popover.querySelector<HTMLInputElement>('input[name="alt"]')!.value = "pic";
    popover.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(editor.getMarkdown()).toBe("![pic](/p.png)");
  });

  it("escape closes the popover", () => {
    mount("");
    container.querySelector<HTMLButtonElement>('[data-tool="video"]')!.click();
    const popover = container.querySelector<HTMLElement>(".mde-popover")!;
    popover.querySelector("form")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(popover.hidden).toBe(true);
  });
});

describe("paste", () => {
  it("parses pasted plain text as markdown", () => {
    mount("");
    const { view } = editor;
    // jsdom has no DataTransfer, so drive the clipboard text parser directly.
    const slice = view.someProp("clipboardTextParser", (f) => f("# Pasted\n\n- item", view.state.selection.$from, true, view))!;
    view.dispatch(view.state.tr.replaceSelection(slice));
    expect(editor.getMarkdown()).toBe("# Pasted\n\n- item");
  });
});

describe("empty paragraphs never drift from the markdown", () => {
  const pressEnter = () => {
    const { view } = editor;
    view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key: "Enter" })));
  };
  const blocks = () => editor.view.state.doc.childCount;

  it("Enter at the end of a paragraph creates one empty paragraph, never a second", () => {
    mount("hello");
    cursorAtEnd();
    pressEnter();
    expect(blocks()).toBe(2);
    pressEnter();
    pressEnter();
    expect(blocks()).toBe(2);
    expect(editor.getMarkdown()).toBe("hello");
    editor.view.dispatch(editor.view.state.tr.insertText("world"));
    expect(editor.getMarkdown()).toBe("hello\n\nworld");
  });

  it("an empty paragraph is removed once the cursor leaves it", () => {
    mount("hello");
    cursorAtEnd();
    pressEnter();
    expect(blocks()).toBe(2);
    cursorAt(1);
    expect(blocks()).toBe(1);
    expect(editor.view.state.doc.textContent).toBe("hello");
  });

  it("Enter in an empty heading turns it into a paragraph", () => {
    mount("# ");
    expect(editor.view.state.doc.firstChild!.type.name).toBe("heading");
    cursorAt(1);
    pressEnter();
    expect(editor.view.state.doc.firstChild!.type.name).toBe("paragraph");
    expect(blocks()).toBe(1);
  });

  it("keeps the only paragraph of an empty document", () => {
    mount("");
    cursorAt(1);
    pressEnter();
    expect(blocks()).toBe(1);
  });

  it("Enter in an empty list item still lifts out of the list", () => {
    mount("- a");
    cursorAtEnd();
    pressEnter();
    expect(editor.getMarkdown()).toBe("- a\n-");
    pressEnter();
    expect(editor.view.state.doc.lastChild!.type.name).toBe("paragraph");
    expect(editor.getMarkdown()).toBe("- a");
  });

  it("the paragraph after a freshly inserted image survives while typing there, and is dropped when left", () => {
    mount("text");
    cursorAtEnd();
    editor.insertImage("/i.png");
    expect(blocks()).toBe(3);
    cursorAt(1);
    expect(blocks()).toBe(2);
    expect(editor.getMarkdown()).toBe("text\n\n![](/i.png)");
  });
});

describe("adjacent lists are one list, like in markdown", () => {
  const pressEnter = () => {
    const { view } = editor;
    view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key: "Enter" })));
  };

  it("an empty paragraph between list items splits the list only while the cursor is in it", () => {
    mount("- a\n- b");
    cursorAt(4); // end of "a"
    pressEnter(); // new empty item
    pressEnter(); // empty item leaves the list -> paragraph between two lists
    const doc = () => editor.view.state.doc;
    expect(doc().childCount).toBe(3);
    expect(doc().child(1).type.name).toBe("paragraph");
    expect(editor.getMarkdown()).toBe("- a\n- b");
    cursorAt(1);
    expect(doc().childCount).toBe(1);
    expect(editor.getMarkdown()).toBe("- a\n- b");
  });

  it("typing in that paragraph keeps the lists apart", () => {
    mount("- a\n- b");
    cursorAt(4);
    pressEnter();
    pressEnter();
    editor.view.dispatch(editor.view.state.tr.insertText("between"));
    expect(editor.getMarkdown()).toBe("- a\n\nbetween\n\n- b");
    expect(editor.view.state.doc.childCount).toBe(3);
  });

  it("Enter that splits an ordered list keeps the second half numbered like the markdown", () => {
    mount("1. a\n2. b\n3. c");
    cursorAt(9); // end of "b"
    pressEnter();
    pressEnter();
    const doc = editor.view.state.doc;
    expect(doc.childCount).toBe(3);
    expect(doc.child(2).attrs.order).toBe(3);
    editor.view.dispatch(editor.view.state.tr.insertText("between"));
    expect(editor.getMarkdown()).toBe("1. a\n2. b\n\nbetween\n\n3. c");
  });

  it("ordered lists join too, keeping the first list's numbering", () => {
    mount("3. a\n4. b");
    cursorAt(4);
    pressEnter();
    pressEnter();
    cursorAt(1);
    expect(editor.getMarkdown()).toBe("3. a\n4. b");
  });

  it("a bullet list next to an ordered list stays separate", () => {
    mount("- a\n\n1. b");
    expect(editor.view.state.doc.childCount).toBe(2);
    expect(editor.getMarkdown()).toBe("- a\n\n1. b");
  });
});

describe("word-aware bold/italic in rich mode", () => {
  const press = (key: string, mods: Partial<KeyboardEventInit> = {}) => {
    const { view } = editor;
    return view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key, ...mods })));
  };

  it("⌘B with the cursor inside a word bolds the whole word, and again unbolds it", () => {
    mount("hello world");
    cursorAt(3); // he|llo
    press("b", { ctrlKey: true });
    expect(editor.getMarkdown()).toBe("**hello** world");
    press("b", { ctrlKey: true });
    expect(editor.getMarkdown()).toBe("hello world");
  });

  it("⌘I from the toolbar button behaves the same", () => {
    mount("hello world");
    cursorAt(8); // wo|rld
    container.querySelector<HTMLButtonElement>('[data-tool="italic"]')!.click();
    expect(editor.getMarkdown()).toBe("hello *world*");
  });

  it("an explicit selection wins over the word", () => {
    mount("hello world");
    editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, 1, 3)));
    press("b", { ctrlKey: true });
    expect(editor.getMarkdown()).toBe("**he**llo world");
  });

  it("at a word boundary it only sets a stored mark for what is typed next", () => {
    mount("hello");
    cursorAtEnd();
    press("b", { ctrlKey: true });
    expect(editor.getMarkdown()).toBe("hello");
    editor.view.dispatch(editor.view.state.tr.insertText(" x"));
    expect(editor.getMarkdown()).toBe("hello **x**");
  });

  it("Tab nests a list item and Shift-Tab lifts it; Tab on the first item is swallowed", () => {
    mount("- a\n- b");
    cursorAt(8); // inside "b"
    expect(press("Tab")).toBe(true);
    expect(editor.getMarkdown()).toBe("- a\n  - b");
    expect(press("Tab", { shiftKey: true })).toBe(true);
    expect(editor.getMarkdown()).toBe("- a\n- b");
    cursorAt(2);
    expect(press("Tab")).toBe(true); // cannot nest, but focus must not leave
    expect(editor.getMarkdown()).toBe("- a\n- b");
  });
});

describe("keyboard shortcuts in markdown mode", () => {
  let ta: HTMLTextAreaElement;
  // Sets the textarea text verbatim (mounting would canonicalize it first).
  const open = (text: string) => {
    editor?.destroy();
    mount("", { mode: "source" });
    ta = container.querySelector<HTMLTextAreaElement>(".mde-source")!;
    ta.value = text;
  };
  const sel = (start: number, end = start) => ta.setSelectionRange(start, end);
  const press = (key: string, mods: Partial<KeyboardEventInit> = {}) =>
    ta.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...mods }));

  it("⌘B wraps the word under the cursor and toggles it off again", () => {
    open("hello world");
    sel(2);
    press("b", { ctrlKey: true });
    expect(ta.value).toBe("**hello** world");
    expect(ta.selectionStart).toBe(4);
    press("b", { ctrlKey: true });
    expect(ta.value).toBe("hello world");
    expect(changes.at(-1)).toBe("hello world");
  });

  it("⌘I wraps an explicit selection", () => {
    open("hello world");
    sel(6, 11);
    press("i", { metaKey: true });
    expect(ta.value).toBe("hello *world*");
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([7, 12]);
    press("i", { metaKey: true });
    expect(ta.value).toBe("hello world");
  });

  it("⌘B at a boundary inserts an empty pair with the cursor inside, and removes it again", () => {
    open("hello ");
    sel(6);
    press("b", { ctrlKey: true });
    expect(ta.value).toBe("hello ****");
    expect(ta.selectionStart).toBe(8);
    press("b", { ctrlKey: true });
    expect(ta.value).toBe("hello ");
  });

  it("⌘K turns the word into a link with the cursor in the url slot", () => {
    open("see docs now");
    sel(5);
    press("k", { metaKey: true });
    expect(ta.value).toBe("see [docs]() now");
    expect(ta.selectionStart).toBe(11);
  });

  it("⇧⌘2 makes the line a heading, ⇧⌘0 resets it", () => {
    open("title\nbody");
    sel(2);
    press("2", { metaKey: true, shiftKey: true });
    expect(ta.value).toBe("## title\nbody");
    expect(ta.selectionStart).toBe(5);
    press("0", { metaKey: true, shiftKey: true });
    expect(ta.value).toBe("title\nbody");
  });

  it("⇧⌘8 / ⇧⌘7 toggle lists over the selected lines", () => {
    open("a\nb\nc");
    sel(0, 5);
    press("8", { metaKey: true, shiftKey: true });
    expect(ta.value).toBe("- a\n- b\n- c");
    press("7", { metaKey: true, shiftKey: true });
    expect(ta.value).toBe("1. a\n2. b\n3. c");
    press("7", { metaKey: true, shiftKey: true });
    expect(ta.value).toBe("a\nb\nc");
  });

  it("Tab / Shift-Tab indent the current lines and never move focus", () => {
    open("- a\n- b");
    sel(6);
    press("Tab");
    expect(ta.value).toBe("- a\n  - b");
    press("Tab", { shiftKey: true });
    expect(ta.value).toBe("- a\n- b");
    open("- a\n\nplain");
    sel(7);
    const event = new KeyboardEvent("keydown", { key: "Tab", cancelable: true, bubbles: true });
    ta.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(ta.value).toBe("- a\n\n> plain");
    expect(ta.selectionStart).toBe(9);
    press("Tab");
    expect(ta.value).toBe("- a\n\n> > plain");
    press("Tab", { shiftKey: true });
    press("Tab", { shiftKey: true });
    press("Tab", { shiftKey: true }); // nothing left to remove, still swallowed
    expect(ta.value).toBe("- a\n\nplain");
  });
});

describe("Backspace at the start of a block", () => {
  const backspace = () => {
    const { view } = editor;
    return view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key: "Backspace" })));
  };
  const cursorAtStartOfText = (text: string) => {
    const { doc } = editor.view.state;
    let pos = -1;
    doc.descendants((node, p) => {
      if (pos === -1 && node.isText && node.text!.startsWith(text)) pos = p;
    });
    if (pos === -1) throw new Error(`no text ${text}`);
    cursorAt(pos);
  };

  it("un-indents step by step, then exits the list, then joins onto the previous item", () => {
    mount("- a\n  - b\n    - c");
    cursorAtStartOfText("c");
    backspace();
    expect(editor.getMarkdown()).toBe("- a\n  - b\n  - c");
    backspace();
    expect(editor.getMarkdown()).toBe("- a\n  - b\n- c");
    backspace();
    expect(editor.getMarkdown()).toBe("- a\n  - b\n\nc");
    expect(editor.view.state.doc.lastChild!.type.name).toBe("paragraph");
    backspace();
    expect(editor.getMarkdown()).toBe("- a\n  - bc");
    expect(editor.view.state.selection.$from.parent.textContent).toBe("bc");
    expect(editor.view.state.selection.$from.parentOffset).toBe(1);
  });

  it("an empty paragraph after a list is removed and the cursor lands at the end of the last item", () => {
    mount("- a\n- b\n\nx");
    cursorAtStartOfText("x");
    backspace();
    expect(editor.getMarkdown()).toBe("- a\n- bx");
    // now make an empty paragraph after the list and backspace it away
    editor.setMarkdown("- a\n- b");
    cursorAtEnd();
    editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", { key: "Enter" })));
    editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", { key: "Enter" })));
    expect(editor.view.state.doc.lastChild!.type.name).toBe("paragraph");
    backspace();
    expect(editor.view.state.doc.childCount).toBe(1);
    expect(editor.getMarkdown()).toBe("- a\n- b");
    expect(editor.view.state.selection.$from.parent.textContent).toBe("b");
  });

  it("the first item of a root list exits the list too, keeping the rest of the list intact", () => {
    mount("- a\n- b");
    cursorAtStartOfText("a");
    backspace();
    expect(editor.getMarkdown()).toBe("a\n\n- b");
  });

  it("a middle item exits the list, splitting it", () => {
    mount("- a\n- b\n- c");
    cursorAtStartOfText("b");
    backspace();
    expect(editor.getMarkdown()).toBe("- a\n\nb\n\n- c");
  });

  it("splitting an ordered list keeps the numbering going", () => {
    mount("1. a\n2. b\n3. c\n4. d");
    cursorAtStartOfText("c");
    backspace();
    expect(editor.getMarkdown()).toBe("1. a\n2. b\n\nc\n\n3. d");
  });

  it("never touches a non-empty selection or a cursor mid-text", () => {
    mount("- ab");
    cursorAt(4); // a|b
    expect(backspace()).toBeFalsy();
    expect(editor.getMarkdown()).toBe("- ab");
  });

  it("a heading after a list joins onto the list as text", () => {
    mount("- a\n\n# Title");
    cursorAtStartOfText("Title");
    backspace();
    expect(editor.getMarkdown()).toBe("- aTitle");
  });
});


describe("Tab indents paragraphs under lists", () => {
  const press = (key: string, mods: Partial<KeyboardEventInit> = {}) => {
    const { view } = editor;
    return view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key, ...mods })));
  };
  const cursorAtStartOfText = (text: string) => {
    let pos = -1;
    editor.view.state.doc.descendants((node, p) => {
      if (pos === -1 && node.isText && node.text!.startsWith(text)) pos = p;
    });
    cursorAt(pos);
  };

  it("moves a paragraph after a list into the last item, following nesting on repeated Tabs", () => {
    mount("- a\n  - b\n\nnote");
    cursorAtStartOfText("note");
    expect(press("Tab")).toBe(true);
    expect(editor.getMarkdown()).toBe("- a\n  - b\n\n  note");
    expect(press("Tab")).toBe(true);
    expect(editor.getMarkdown()).toBe("- a\n  - b\n\n    note");
    expect(press("Tab")).toBe(true); // nothing deeper to go into: indent inside the item instead
    expect(editor.getMarkdown()).toBe("- a\n  - b\n\n    > note");
    expect(press("Tab", { shiftKey: true })).toBe(true);
    expect(editor.getMarkdown()).toBe("- a\n  - b\n\n    note");
    expect(press("Tab", { shiftKey: true })).toBe(true);
    expect(editor.getMarkdown()).toBe("- a\n  - b\n\n  note");
    expect(press("Tab", { shiftKey: true })).toBe(true);
    expect(editor.getMarkdown()).toBe("- a\n  - b\n\nnote");
    expect(editor.view.state.selection.$from.parent.textContent).toBe("note");
  });

  it("keeps the cursor offset inside the paragraph", () => {
    mount("- a\n\nnote here");
    cursorAtStartOfText("note");
    cursorAt(editor.view.state.selection.from + 4);
    press("Tab");
    expect(editor.view.state.selection.$from.parentOffset).toBe(4);
    expect(editor.getMarkdown()).toBe("- a\n\n  note here");
  });

  it("a paragraph with no list before it cannot be indented, but Tab is still swallowed", () => {
    mount("first\n\n- a");
    cursorAtStartOfText("first");
    expect(press("Tab")).toBe(true);
    expect(press("Tab", { shiftKey: true })).toBe(true);
    expect(editor.getMarkdown()).toBe("first\n\n- a");
  });

  it("outdenting from a middle item splits the list and continues numbering", () => {
    mount("1. a\n\n   note\n2. b");
    cursorAtStartOfText("note");
    press("Tab", { shiftKey: true });
    expect(editor.getMarkdown()).toBe("1. a\n\nnote\n\n2. b");
  });

  it("Tab in a continuation paragraph that cannot go deeper indents it inside the item (the item stays put)", () => {
    mount("- a\n- b\n\n  note");
    cursorAtStartOfText("note");
    expect(press("Tab")).toBe(true);
    expect(editor.getMarkdown()).toBe("- a\n- b\n\n  > note");
  });

  it("indents standalone paragraphs level by level, and Shift-Tab / Backspace go back", () => {
    mount("first\n\nsecond");
    cursorAtStartOfText("second");
    press("Tab");
    expect(editor.getMarkdown()).toBe("first\n\n> second");
    press("Tab");
    expect(editor.getMarkdown()).toBe("first\n\n> > second");
    expect(container.querySelector('.ProseMirror p[data-indent="2"]')?.textContent).toBe("second");
    press("Tab", { shiftKey: true });
    expect(editor.getMarkdown()).toBe("first\n\n> second");
    press("Backspace");
    expect(editor.getMarkdown()).toBe("first\n\nsecond");
    press("Backspace"); // now a plain join with the previous paragraph
    expect(editor.getMarkdown()).toBe("firstsecond");
  });

  it("turning an indented paragraph into a list item drops the indent (the bullet is the indent)", () => {
    mount("> a\n\n> > b");
    cursorAtStartOfText("a");
    container.querySelector<HTMLButtonElement>('[data-tool="bullet_list"]')!.click();
    expect(editor.getMarkdown()).toBe("- a\n\n> > b");
    expect(container.querySelector(".ProseMirror li p[data-indent]")).toBeNull();
    cursorAtStartOfText("b");
    toggleList(editor.schema.nodes.ordered_list)(editor.view.state, editor.view.dispatch);
    expect(editor.getMarkdown()).toBe("- a\n\n1. b");
    // leaving the list again gives a plain paragraph, not an indented one
    press("Tab", { shiftKey: true });
    expect(editor.getMarkdown()).toBe("- a\n\nb");
  });

  it("Enter keeps the indent level; a selection over several paragraphs indents all of them", () => {
    mount("> a");
    cursorAtEnd();
    press("Enter");
    editor.view.dispatch(editor.view.state.tr.insertText("b"));
    expect(editor.getMarkdown()).toBe("> a\n\n> b");
    editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, 1, editor.view.state.doc.content.size - 1)));
    press("Tab");
    expect(editor.getMarkdown()).toBe("> > a\n\n> > b");
    press("Tab", { shiftKey: true });
    press("Tab", { shiftKey: true });
    press("Tab", { shiftKey: true }); // already at 0: swallowed, no change
    expect(editor.getMarkdown()).toBe("a\n\nb");
  });

  it("Shift-Tab in a continuation paragraph that is not the item's last block does nothing", () => {
    mount("- a\n\n  note\n  - nested");
    cursorAtStartOfText("note");
    expect(press("Tab", { shiftKey: true })).toBe(true);
    expect(editor.getMarkdown()).toBe("- a\n\n  note\n  - nested");
  });

  it("Tab on a list item's own paragraph still nests the item", () => {
    mount("- a\n- b");
    cursorAtStartOfText("b");
    press("Tab");
    expect(editor.getMarkdown()).toBe("- a\n  - b");
  });

  it("an empty continuation paragraph disappears once the cursor leaves it", () => {
    mount("- a\n\n  note");
    cursorAtStartOfText("note");
    cursorAt(editor.view.state.selection.from + 4);
    press("Enter");
    expect(editor.view.state.doc.firstChild!.childCount).toBe(2); // Enter at the end of a continuation paragraph starts a new item
    editor.setMarkdown("- a\n\n  note");
    cursorAtStartOfText("note");
    editor.view.dispatch(editor.view.state.tr.delete(editor.view.state.selection.from, editor.view.state.selection.from + 4));
    expect(editor.view.state.doc.firstChild!.firstChild!.childCount).toBe(2);
    cursorAt(2);
    expect(editor.view.state.doc.firstChild!.firstChild!.childCount).toBe(1);
    expect(editor.getMarkdown()).toBe("- a");
  });
});


describe("whitespace stays canonical while editing", () => {
  it("a second space collapses as it is typed; the trailing space survives until the cursor leaves", () => {
    mount("hello");
    cursorAtEnd();
    const { view } = editor;
    view.dispatch(view.state.tr.insertText(" "));
    view.dispatch(view.state.tr.insertText(" "));
    expect(view.state.doc.firstChild!.textContent).toBe("hello ");
    view.dispatch(view.state.tr.insertText("world"));
    expect(view.state.doc.firstChild!.textContent).toBe("hello world");
    view.dispatch(view.state.tr.insertText(" "));
    expect(view.state.doc.firstChild!.textContent).toBe("hello world ");
    expect(editor.getMarkdown()).toBe("hello world");
    editor.setMarkdown("hello world \n\nnext");
    cursorAtEnd();
    expect(editor.view.state.doc.firstChild!.textContent).toBe("hello world");
  });

  it("a leading space is dropped, and pasted non-breaking spaces become spaces", () => {
    mount("");
    const { view } = editor;
    view.dispatch(view.state.tr.insertText(" "));
    expect(view.state.doc.firstChild!.textContent).toBe("");
    view.dispatch(view.state.tr.insertText("a\u00a0\u00a0b"));
    expect(view.state.doc.firstChild!.textContent).toBe("a b");
    expect(view.state.selection.from).toBe(4);
  });

  it("a double space in the middle of a line leaves the cursor after the single space", () => {
    mount("hello world");
    cursorAt(6); // hello| world
    const { view } = editor;
    view.dispatch(view.state.tr.insertText(" "));
    expect(view.state.doc.textContent).toBe("hello world");
    expect(view.state.selection.from).toBe(7); // hello |world
    view.dispatch(view.state.tr.insertText(" "));
    expect(view.state.doc.textContent).toBe("hello world");
    expect(view.state.selection.from).toBe(7);
    view.dispatch(view.state.tr.insertText("big "));
    expect(view.state.doc.textContent).toBe("hello big world");
    expect(view.state.selection.from).toBe(11);
  });

  it("collapses across mark boundaries", () => {
    mount("a **b** c");
    const { view, schema } = editor;
    view.dispatch(view.state.tr.insertText("   ", 2, 2));
    expect(view.state.doc.firstChild!.textContent).toBe("a b c");
    cursorAt(4); // right after "b"
    view.dispatch(view.state.tr.insertText("  ", 4, 4));
    expect(view.state.doc.firstChild!.textContent).toBe("a b c");
    expect(editor.getMarkdown()).toBe("a **b** c");
    void schema;
  });
});

describe("media hooks", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("pickImage replaces the popover for the toolbar button and receives null", async () => {
    const pickImage = vi.fn(async () => ({ src: "/picked.png", alt: "picked" }));
    mount("text", { pickImage });
    cursorAtEnd();
    container.querySelector<HTMLButtonElement>('[data-tool="image"]')!.click();
    expect(container.querySelector<HTMLElement>(".mde-popover")!.hidden).toBe(true);
    expect(pickImage).toHaveBeenCalledWith(null);
    await flush();
    expect(editor.getMarkdown()).toBe("text\n\n![picked](/picked.png)");
  });

  it("pickLink replaces the link popover; its text is used when nothing is selected", async () => {
    const pickLink = vi.fn(async () => ({ href: "/2026/10/post/", text: "that post" }));
    mount("see", { pickLink });
    cursorAtEnd();
    container.querySelector<HTMLButtonElement>('[data-tool="link"]')!.click();
    expect(pickLink).toHaveBeenCalledWith(null);
    await flush();
    expect(editor.getMarkdown()).toBe("see[that post](/2026/10/post/)");
  });

  it("the link popover accepts a relative URL", () => {
    mount("word");
    editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, 1, 5)));
    container.querySelector<HTMLButtonElement>('[data-tool="link"]')!.click();
    const popover = container.querySelector<HTMLElement>(".mde-popover")!;
    const input = popover.querySelector<HTMLInputElement>('input[name="href"]')!;
    expect(input.type).toBe("text");
    input.value = "/a/b.html";
    popover.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(editor.getMarkdown()).toBe("[word](/a/b.html)");
  });

  it("pickMedia replaces the image and video buttons with one that inserts either", async () => {
    const pickMedia = vi.fn(async () => ({ kind: "video" as const, src: "/clip.webm", poster: "/clip.webp" }));
    mount("text", { pickMedia });
    expect(container.querySelector('[data-tool="image"]')).toBeNull();
    expect(container.querySelector('[data-tool="video"]')).toBeNull();
    cursorAtEnd();
    container.querySelector<HTMLButtonElement>('[data-tool="media"]')!.click();
    await flush();
    expect(editor.getMarkdown()).toBe('text\n\n<video src="/clip.webm" poster="/clip.webp" controls></video>');
  });

  it("a cancelled picker inserts nothing", async () => {
    const pickVideo = vi.fn(async () => null);
    mount("text", { pickVideo });
    container.querySelector<HTMLButtonElement>('[data-tool="video"]')!.click();
    await flush();
    expect(pickVideo).toHaveBeenCalledWith(null);
    expect(editor.getMarkdown()).toBe("text");
  });

  it("double-clicking existing media passes its attributes and updates it in place", async () => {
    const pickImage = vi.fn(async () => ({ src: "/new.png", alt: "new" }));
    mount("![old](/old.png)", { pickImage });
    const { view } = editor;
    view.someProp("handleDoubleClickOn", (f) => f(view, 0, view.state.doc.firstChild!, 0, new MouseEvent("dblclick"), true));
    expect(pickImage).toHaveBeenCalledWith({ src: "/old.png", alt: "old", caption: "", link: "" });
    await flush();
    expect(editor.getMarkdown()).toBe("![new](/new.png)");
  });

  it("double-clicking updates the clicked node even when the click position is its end", async () => {
    const pickImage = vi.fn(async () => ({ src: "/new.png" }));
    mount("![a](/a.png)\n\n![b](/b.png)", { pickImage });
    const { view } = editor;
    const first = view.state.doc.firstChild!;
    // pos = 1 is the end of the first image, i.e. the start of the second block.
    view.someProp("handleDoubleClickOn", (f) => f(view, 1, first, 0, new MouseEvent("dblclick"), true));
    await flush();
    expect(editor.getMarkdown()).toBe("![a](/new.png)\n\n![b](/b.png)");
  });

  it("a row with one image left is just that image, never padded with an empty one", () => {
    mount("![a](/a.png) ![b](/b.png)\n\nafter");
    const { view } = editor;
    // delete the second image of the row (positions: row at 0, images at 1 and 2)
    view.dispatch(view.state.tr.delete(2, 3));
    expect(editor.getMarkdown()).toBe("![a](/a.png)\n\nafter");
    expect(editor.getMarkdown()).not.toContain("![](");
  });

  it("stackOntoImage puts dropped images beside a lone image, on either side", () => {
    mount("![a](/a.png)\n\n![b](/b.png)");
    const { view, schema } = editor;
    const b = view.state.doc.child(1);
    // select b as if it were being dragged, then drop it onto the right half of a
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 1)));
    stackOntoImage(0, [b], false, true)(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe("![a](/a.png) ![b](/b.png)");
    editor.setMarkdown("![a](/a.png)\n\n![b](/b.png)");
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 1)));
    stackOntoImage(0, [view.state.doc.child(1)], true, true)(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe("![b](/b.png) ![a](/a.png)");
    expect(schema.nodes.photo_row).toBeDefined();
  });

  it("stackOntoImage deletes the dragged node even when something else is selected", () => {
    mount("![a](/a.png)\n\n![b](/b.png)\n\ntext");
    const { view } = editor;
    // the cursor sits in the text; b is dragged without being selected
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    const b = NodeSelection.create(view.state.doc, 1);
    stackOntoImage(0, [b.node], false, b)(view.state, view.dispatch);
    expect(editor.getMarkdown()).toBe("![a](/a.png) ![b](/b.png)\n\ntext");
  });

  it("uploadFile handles pasted files in order and skips non-media and nulls", async () => {
    const uploadFile = vi.fn(async (file: File) =>
      file.name === "skip.png" ? null : { kind: file.type.startsWith("video") ? "video" : "image", src: "/up/" + file.name } as const,
    );
    mount("text", { uploadFile });
    cursorAtEnd();
    const files = [
      new File([""], "a.png", { type: "image/png" }),
      new File([""], "notes.txt", { type: "text/plain" }),
      new File([""], "skip.png", { type: "image/png" }),
      new File([""], "clip.mp4", { type: "video/mp4" }),
    ];
    const { view } = editor;
    const handled = view.someProp("handlePaste", (f) => f(view, { clipboardData: { files } } as unknown as ClipboardEvent, null as never));
    expect(handled).toBe(true);
    await flush();
    await flush();
    await flush();
    expect(uploadFile).toHaveBeenCalledTimes(3);
    expect(editor.getMarkdown()).toBe('text\n\n![](/up/a.png)\n\n<video src="/up/clip.mp4" controls></video>');
  });

  it("without uploadFile, pasted files are left to the default handling", () => {
    mount("text");
    const { view } = editor;
    const files = [new File([""], "a.png", { type: "image/png" })];
    const handled = view.someProp("handlePaste", (f) => f(view, { clipboardData: { files } } as unknown as ClipboardEvent, null as never));
    expect(handled).toBeFalsy();
  });
});


describe("images / videos switched off", () => {
  it("removes the toolbar buttons, the API and upload handling, and degrades markdown", async () => {
    const uploadFile = vi.fn(async () => ({ kind: "image" as const, src: "/x.png" }));
    mount("![a](/a.png)\n\n<video src=\"/v.mp4\"></video>", { images: false, uploadFile });
    expect(container.querySelector('[data-tool="image"]')).toBeNull();
    expect(container.querySelector('[data-tool="video"]')).not.toBeNull();
    expect(editor.getMarkdown()).toBe('[a](/a.png)\n\n<video src="/v.mp4" controls></video>');
    editor.insertImage("/b.png");
    expect(editor.getMarkdown()).toBe('[a](/a.png)\n\n<video src="/v.mp4" controls></video>');
    const { view } = editor;
    const files = [new File([""], "a.png", { type: "image/png" })];
    expect(view.someProp("handlePaste", (f) => f(view, { clipboardData: { files } } as unknown as ClipboardEvent, null as never))).toBeFalsy();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("both off leaves a text-only toolbar", () => {
    mount("x", { images: false, videos: false });
    expect(container.querySelector('[data-tool="image"]')).toBeNull();
    expect(container.querySelector('[data-tool="video"]')).toBeNull();
    editor.insertVideo("/v.mp4");
    expect(editor.getMarkdown()).toBe("x");
  });
});
