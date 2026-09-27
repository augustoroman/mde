import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import { DOMSerializer, Slice, type Node, type Schema } from "prosemirror-model";
import { EditorState, Plugin, PluginKey, TextSelection, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { createMarkdownParser, serializeMarkdown } from "../markdown";
import { createSchema, headingLevelsOf, type HeadingLevel } from "../schema";
import {
  blockActive,
  currentLinkHref,
  insertImage,
  insertVideo,
  listActive,
  markActive,
  removeLink,
  setHeading,
  setLink,
  setParagraph,
  toggleList,
  toggleMarkOnWord,
} from "./commands";
import { canonicalDocPlugin } from "./canonical";
import { icons } from "./icons";
import { buildInputRules } from "./inputrules";
import { buildKeymap } from "./keymap";
import { Popover } from "./popover";
import { attachSourceKeymap } from "./sourceKeymap";
import { commandButton, Toolbar, type EditorMode, type ToolbarItem } from "./toolbar";

export type { EditorMode };

/** What a picker hands back; `null`/`undefined` means the user cancelled. */
export interface ImageChoice {
  src: string;
  alt?: string;
}
export interface VideoChoice {
  src: string;
}
export interface UploadResult {
  kind: "image" | "video";
  src: string;
  alt?: string;
}

export interface EditorOptions {
  /** Initial content. */
  markdown?: string;
  /**
   * Your own image picker (browse, upload, …). Called from the toolbar with
   * `null`, and from a double-click on an existing image with its attributes.
   * Replaces the built-in URL popover for images.
   */
  pickImage?: (current: { src: string; alt: string } | null) => Promise<ImageChoice | null | undefined>;
  /** Same for videos. */
  pickVideo?: (current: { src: string } | null) => Promise<VideoChoice | null | undefined>;
  /**
   * Called for each image/video file pasted or dropped into the editor. Resolve
   * with where it ended up and it is inserted at the paste/drop position;
   * resolve with `null` to skip the file. Without this, files are ignored.
   */
  uploadFile?: (file: File) => Promise<UploadResult | null | undefined>;
  /** Initial mode, default `"rich"`. */
  mode?: EditorMode;
  /** Modes offered in the toolbar, default all three. */
  modes?: EditorMode[];
  /** Heading levels the editor allows, default `[1, 2, 3]`. */
  headingLevels?: HeadingLevel[];
  /** Allow images (toolbar button, paste/drop upload, `insertImage`, markdown images), default true. */
  images?: boolean;
  /** Allow videos, default true. */
  videos?: boolean;
  /** Placeholder shown when the document is empty. */
  placeholder?: string;
  /** Hide the toolbar (keyboard shortcuts keep working). */
  toolbar?: boolean;
  /** Called whenever the markdown output changes. */
  onChange?: (markdown: string) => void;
  onModeChange?: (mode: EditorMode) => void;
}

export interface MarkdownEditor {
  readonly dom: HTMLElement;
  readonly view: EditorView;
  readonly schema: Schema;
  getMarkdown(): string;
  setMarkdown(markdown: string): void;
  getMode(): EditorMode;
  setMode(mode: EditorMode): void;
  insertImage(src: string, alt?: string): void;
  insertVideo(src: string): void;
  focus(): void;
  destroy(): void;
}

const placeholderKey = new PluginKey("mde-placeholder");

function placeholderPlugin(text: string): Plugin {
  return new Plugin({
    key: placeholderKey,
    props: {
      decorations(state) {
        const { doc } = state;
        const only = doc.childCount === 1 ? doc.firstChild! : null;
        if (!only || !only.isTextblock || only.content.size > 0) return null;
        return DecorationSet.create(doc, [
          Decoration.node(0, only.nodeSize, { class: "mde-empty", "data-placeholder": text }),
        ]);
      },
    },
  });
}

/** Mount a markdown editor into `container`. */
export function createEditor(container: HTMLElement, options: EditorOptions = {}): MarkdownEditor {
  const schema = createSchema({ headingLevels: options.headingLevels, images: options.images, videos: options.videos });
  const images = !!schema.nodes.image;
  const videos = !!schema.nodes.video;
  const parser = createMarkdownParser(schema);
  const modes = options.modes?.length ? options.modes : (["rich", "source", "preview"] as EditorMode[]);
  const domSerializer = DOMSerializer.fromSchema(schema);

  // --- DOM skeleton ---------------------------------------------------------
  const dom = document.createElement("div");
  dom.className = "mde";
  const richHost = document.createElement("div");
  richHost.className = "mde-rich";
  const source = document.createElement("textarea");
  source.className = "mde-source";
  source.spellcheck = false;
  source.setAttribute("aria-label", "Markdown source");
  if (options.placeholder) source.placeholder = options.placeholder;
  const preview = document.createElement("div");
  preview.className = "mde-preview mde-content";
  preview.setAttribute("aria-label", "Preview");

  let mode: EditorMode = options.mode && modes.includes(options.mode) ? options.mode : modes[0];
  let lastMarkdown: string | null = null;
  let destroyed = false;

  // --- ProseMirror view -----------------------------------------------------
  const popover = new Popover(dom);

  const openLinkPopover = (view: EditorView): boolean => {
    const href = currentLinkHref(view.state);
    popover.open({
      title: href ? "Edit link" : "Insert link",
      fields: [{ name: "href", label: "URL", value: href ?? "", placeholder: "https://", type: "url", required: true }],
      submitLabel: href ? "Update" : "Insert",
      secondary: href ? { label: "Remove link", onClick: () => (removeLink(schema)(view.state, view.dispatch), view.focus()) } : undefined,
      onSubmit: ({ href: value }) => {
        if (value) setLink(schema, value)(view.state, view.dispatch);
        view.focus();
      },
    });
    return true;
  };

  const applyImage = (view: EditorView, choice: ImageChoice, edit?: { pos: number }) => {
    const alt = choice.alt ?? "";
    if (edit && view.state.doc.nodeAt(edit.pos)?.type === schema.nodes.image) {
      view.dispatch(view.state.tr.setNodeMarkup(edit.pos, undefined, { src: choice.src, alt }));
    } else {
      insertImage(schema, choice.src, alt)(view.state, view.dispatch);
    }
    view.focus();
  };

  const applyVideo = (view: EditorView, choice: VideoChoice, edit?: { pos: number }) => {
    if (edit && view.state.doc.nodeAt(edit.pos)?.type === schema.nodes.video) {
      view.dispatch(view.state.tr.setNodeMarkup(edit.pos, undefined, { src: choice.src }));
    } else {
      insertVideo(schema, choice.src)(view.state, view.dispatch);
    }
    view.focus();
  };

  const openImagePopover = (view: EditorView, edit?: { pos: number; src: string; alt: string }) => {
    if (options.pickImage) {
      void options.pickImage(edit ? { src: edit.src, alt: edit.alt } : null).then((choice) => {
        if (!destroyed && choice?.src) applyImage(view, choice, edit);
      });
      return;
    }
    popover.open({
      title: edit ? "Edit image" : "Insert image",
      fields: [
        { name: "src", label: "Image URL", value: edit?.src ?? "", placeholder: "https://", type: "url", required: true },
        { name: "alt", label: "Alt text", value: edit?.alt ?? "", placeholder: "Describe the image" },
      ],
      submitLabel: edit ? "Update" : "Insert",
      onSubmit: ({ src, alt }) => {
        if (src) applyImage(view, { src, alt }, edit);
      },
    });
  };

  const openVideoPopover = (view: EditorView, edit?: { pos: number; src: string }) => {
    if (options.pickVideo) {
      void options.pickVideo(edit ? { src: edit.src } : null).then((choice) => {
        if (!destroyed && choice?.src) applyVideo(view, choice, edit);
      });
      return;
    }
    popover.open({
      title: edit ? "Edit video" : "Insert video",
      fields: [{ name: "src", label: "Video URL", value: edit?.src ?? "", placeholder: "https://…/clip.mp4", type: "url", required: true }],
      submitLabel: edit ? "Update" : "Insert",
      onSubmit: ({ src }) => {
        if (src) applyVideo(view, { src }, edit);
      },
    });
  };

  /** Upload pasted/dropped media files through `options.uploadFile`, inserting each result in order. */
  const uploadFiles = (view: EditorView, files: File[], at?: number): boolean => {
    const upload = options.uploadFile;
    if (!upload) return false;
    const media = files.filter((f) => (images && f.type.startsWith("image/")) || (videos && f.type.startsWith("video/")));
    if (!media.length) return false;
    if (at != null) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at))));
    let chain = Promise.resolve();
    for (const file of media) {
      chain = chain
        .then(() => upload(file))
        .then((result) => {
          if (destroyed || !result?.src) return;
          if (result.kind === "video") insertVideo(schema, result.src)(view.state, view.dispatch);
          else if (result.kind === "image") insertImage(schema, result.src, result.alt ?? "")(view.state, view.dispatch);
        })
        .catch(() => undefined);
    }
    return true;
  };

  const plugins: Plugin[] = [
    buildInputRules(schema),
    ...buildKeymap(schema, { link: (_state, _dispatch, view) => (view ? openLinkPopover(view) : false) }),
    history(),
    canonicalDocPlugin(),
    dropCursor({ class: "mde-dropcursor" }),
    gapCursor(),
  ];
  if (options.placeholder) plugins.push(placeholderPlugin(options.placeholder));

  const initialDoc = parser.parse(options.markdown ?? "");
  const view = new EditorView(richHost, {
    state: EditorState.create({ doc: initialDoc, plugins }),
    attributes: { class: "mde-content", spellcheck: "true" },
    // Plain-text pastes are parsed as markdown so pasting a `# heading` does the right thing.
    clipboardTextParser: (text) => Slice.maxOpen(parser.parse(text).content),
    handlePaste: (v, event) => uploadFiles(v, Array.from(event.clipboardData?.files ?? [])),
    handleDrop: (v, event) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return false;
      const at = v.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
      return uploadFiles(v, files, at);
    },
    handleDoubleClickOn: (v, pos, node) => {
      if (images && node.type === schema.nodes.image) {
        openImagePopover(v, { pos, src: node.attrs.src, alt: node.attrs.alt });
        return true;
      }
      if (videos && node.type === schema.nodes.video) {
        openVideoPopover(v, { pos, src: node.attrs.src });
        return true;
      }
      return false;
    },
    dispatchTransaction(tr: Transaction) {
      const newState = view.state.apply(tr);
      view.updateState(newState);
      toolbar?.update(newState);
      if (tr.docChanged) emitChange();
    },
  });

  // --- Toolbar --------------------------------------------------------------
  const { strong, em } = schema.marks;
  const { paragraph, heading, bullet_list, ordered_list } = schema.nodes;
  const items: ToolbarItem[] = [
    commandButton("undo", icons.undo, "Undo (⌘Z)", undo),
    commandButton("redo", icons.redo, "Redo (⇧⌘Z)", redo),
    { kind: "separator" },
    commandButton("paragraph", "¶", "Paragraph (⇧⌘0)", setParagraph(schema), {
      isActive: (s) => blockActive(s, paragraph),
    }),
    ...headingLevelsOf(schema).map((level) =>
      commandButton(`h${level}`, `H${level}`, `Heading ${level} (⇧⌘${level})`, setHeading(schema, level), {
        isActive: (s) => blockActive(s, heading, { level }),
      }),
    ),
    { kind: "separator" },
    commandButton("bold", icons.bold, "Bold (⌘B)", toggleMarkOnWord(strong), { isActive: (s) => markActive(s, strong) }),
    commandButton("italic", icons.italic, "Italic (⌘I)", toggleMarkOnWord(em), { isActive: (s) => markActive(s, em) }),
    {
      kind: "button",
      id: "link",
      html: icons.link,
      title: "Link (⌘K)",
      run: openLinkPopover,
      isActive: (s) => currentLinkHref(s) !== null,
      isEnabled: (s) => s.selection.$from.parent.isTextblock,
    },
    { kind: "separator" },
    commandButton("bullet_list", icons.bulletList, "Bullet list (⇧⌘8)", toggleList(bullet_list), {
      isActive: (s) => listActive(s, bullet_list),
    }),
    commandButton("ordered_list", icons.orderedList, "Numbered list (⇧⌘7)", toggleList(ordered_list), {
      isActive: (s) => listActive(s, ordered_list),
    }),
  ];
  if (images || videos) items.push({ kind: "separator" });
  if (images) items.push({ kind: "button", id: "image", html: icons.image, title: "Insert image", run: (v) => openImagePopover(v) });
  if (videos) items.push({ kind: "button", id: "video", html: icons.video, title: "Insert video", run: (v) => openVideoPopover(v) });

  const toolbar = options.toolbar === false ? null : new Toolbar(dom, items, modes, (m) => setMode(m));
  if (toolbar) toolbar.onButton = (item) => item.run(view);

  dom.append(richHost, source, preview);
  container.appendChild(dom);

  source.addEventListener("input", () => emitChange());
  const detachSourceKeymap = attachSourceKeymap(source, { headingLevels: headingLevelsOf(schema) });

  // --- Mode handling --------------------------------------------------------
  function docFromSource(): Node {
    return parser.parse(source.value);
  }

  function replaceDoc(doc: Node): void {
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
    view.dispatch(tr.setMeta("addToHistory", true));
  }

  function renderPreview(doc: Node): void {
    preview.replaceChildren(domSerializer.serializeFragment(doc.content));
  }

  function applyMode(next: EditorMode, initial = false): void {
    if (!initial && next === mode) return;
    // Leaving source mode makes the document authoritative again.
    if (!initial && mode === "source") replaceDoc(docFromSource());
    mode = next;
    dom.dataset.mode = next;
    richHost.hidden = next !== "rich";
    source.hidden = next !== "source";
    preview.hidden = next !== "preview";
    popover.close();
    if (next === "source") source.value = serializeMarkdown(view.state.doc);
    if (next === "preview") renderPreview(view.state.doc);
    toolbar?.setMode(next);
    toolbar?.update(next === "rich" ? view.state : null);
    if (!initial) options.onModeChange?.(next);
  }

  function setMode(next: EditorMode): void {
    if (destroyed || !modes.includes(next)) return;
    applyMode(next);
    focus();
  }

  function getMarkdown(): string {
    return mode === "source" ? serializeMarkdown(docFromSource()) : serializeMarkdown(view.state.doc);
  }

  function emitChange(): void {
    if (!options.onChange) return;
    const markdown = getMarkdown();
    if (markdown === lastMarkdown) return;
    lastMarkdown = markdown;
    options.onChange(markdown);
  }

  function focus(): void {
    if (mode === "rich") view.focus();
    else if (mode === "source") source.focus();
  }

  applyMode(mode, true);
  lastMarkdown = getMarkdown();

  return {
    dom,
    view,
    schema,
    getMarkdown,
    setMarkdown(markdown) {
      replaceDoc(parser.parse(markdown));
      if (mode === "source") source.value = serializeMarkdown(view.state.doc);
      if (mode === "preview") renderPreview(view.state.doc);
      emitChange();
    },
    getMode: () => mode,
    setMode,
    insertImage(src, alt = "") {
      if (!images) return;
      if (mode !== "rich") setMode("rich");
      insertImage(schema, src, alt)(view.state, view.dispatch);
    },
    insertVideo(src) {
      if (!videos) return;
      if (mode !== "rich") setMode("rich");
      insertVideo(schema, src)(view.state, view.dispatch);
    },
    focus,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      detachSourceKeymap();
      popover.destroy();
      toolbar?.destroy();
      view.destroy();
      dom.remove();
    },
  };
}
