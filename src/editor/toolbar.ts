import type { Command, EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

export interface ToolbarButton {
  kind: "button";
  id: string;
  /** Inner HTML (icon svg or text). */
  html: string;
  title: string;
  run: (view: EditorView) => void;
  isActive?: (state: EditorState) => boolean;
  isEnabled?: (state: EditorState) => boolean;
}

export interface ToolbarSeparator {
  kind: "separator";
}

export type ToolbarItem = ToolbarButton | ToolbarSeparator;

export type EditorMode = "rich" | "source" | "preview";

export const MODE_LABELS: Record<EditorMode, string> = { rich: "Edit", source: "Markdown", preview: "Preview" };

/** Convenience to build a toolbar button from a ProseMirror command. */
export function commandButton(
  id: string,
  html: string,
  title: string,
  command: Command,
  extra: Partial<Pick<ToolbarButton, "isActive" | "isEnabled">> = {},
): ToolbarButton {
  return {
    kind: "button",
    id,
    html,
    title,
    run: (view) => {
      command(view.state, view.dispatch, view);
      view.focus();
    },
    isEnabled: extra.isEnabled ?? ((state) => command(state)),
    isActive: extra.isActive,
  };
}

export class Toolbar {
  readonly dom: HTMLElement;
  private buttons = new Map<string, { item: ToolbarButton; el: HTMLButtonElement }>();
  private modeButtons = new Map<EditorMode, HTMLButtonElement>();

  constructor(
    parent: HTMLElement,
    items: ToolbarItem[],
    modes: EditorMode[],
    private onMode: (mode: EditorMode) => void,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "mde-toolbar";
    this.dom.setAttribute("role", "toolbar");

    const group = document.createElement("div");
    group.className = "mde-toolbar-group";
    for (const item of items) {
      if (item.kind === "separator") {
        const sep = document.createElement("span");
        sep.className = "mde-toolbar-sep";
        group.appendChild(sep);
        continue;
      }
      const el = document.createElement("button");
      el.type = "button";
      el.className = "mde-tool";
      el.dataset.tool = item.id;
      el.title = item.title;
      el.setAttribute("aria-label", item.title);
      el.innerHTML = item.html;
      // mousedown, not click, so the editor selection isn't lost before the command runs.
      el.addEventListener("mousedown", (event) => event.preventDefault());
      el.addEventListener("click", () => this.onButton?.(item));
      group.appendChild(el);
      this.buttons.set(item.id, { item, el });
    }
    this.dom.appendChild(group);

    if (modes.length > 1) {
      const modeGroup = document.createElement("div");
      modeGroup.className = "mde-modes";
      modeGroup.setAttribute("role", "tablist");
      for (const mode of modes) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "mde-mode";
        el.dataset.mode = mode;
        el.setAttribute("role", "tab");
        el.textContent = MODE_LABELS[mode];
        el.addEventListener("click", () => this.onMode(mode));
        modeGroup.appendChild(el);
        this.modeButtons.set(mode, el);
      }
      this.dom.appendChild(modeGroup);
    }

    parent.appendChild(this.dom);
  }

  onButton: ((item: ToolbarButton) => void) | null = null;

  /** Reflect editor state in active/disabled classes. Pass `null` when not in rich mode. */
  update(state: EditorState | null): void {
    for (const { item, el } of this.buttons.values()) {
      const enabled = !!state && (item.isEnabled ? item.isEnabled(state) : true);
      const active = !!state && !!item.isActive?.(state);
      el.disabled = !enabled;
      el.classList.toggle("is-active", active);
      el.setAttribute("aria-pressed", String(active));
    }
  }

  setMode(mode: EditorMode): void {
    for (const [m, el] of this.modeButtons) {
      const selected = m === mode;
      el.classList.toggle("is-active", selected);
      el.setAttribute("aria-selected", String(selected));
    }
  }

  destroy(): void {
    this.dom.remove();
  }
}
