export interface PopoverField {
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
  type?: "url" | "text";
  required?: boolean;
}

export interface PopoverRequest {
  title: string;
  fields: PopoverField[];
  submitLabel?: string;
  /** Extra action rendered as a secondary button (e.g. "Remove link"). */
  secondary?: { label: string; onClick: () => void };
  onSubmit: (values: Record<string, string>) => void;
  onClose?: () => void;
}

/**
 * A tiny inline form (no window.prompt) used for link, image and video URLs.
 * Only one popover is open at a time; opening a new one closes the previous.
 */
export class Popover {
  readonly dom: HTMLElement;
  private cleanup: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.dom = document.createElement("div");
    this.dom.className = "mde-popover";
    this.dom.hidden = true;
    parent.appendChild(this.dom);
  }

  get isOpen(): boolean {
    return !this.dom.hidden;
  }

  open(request: PopoverRequest): void {
    this.close();
    const form = document.createElement("form");
    form.className = "mde-popover-form";
    form.setAttribute("aria-label", request.title);

    const heading = document.createElement("div");
    heading.className = "mde-popover-title";
    heading.textContent = request.title;
    form.appendChild(heading);

    const inputs: HTMLInputElement[] = [];
    for (const field of request.fields) {
      const label = document.createElement("label");
      label.className = "mde-popover-field";
      const span = document.createElement("span");
      span.textContent = field.label;
      const input = document.createElement("input");
      input.name = field.name;
      input.type = field.type === "url" ? "url" : "text";
      input.value = field.value ?? "";
      input.placeholder = field.placeholder ?? "";
      input.required = !!field.required;
      input.autocomplete = "off";
      input.spellcheck = false;
      label.append(span, input);
      form.appendChild(label);
      inputs.push(input);
    }

    const actions = document.createElement("div");
    actions.className = "mde-popover-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "mde-btn mde-btn-primary";
    submit.textContent = request.submitLabel ?? "Insert";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "mde-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.close());
    actions.append(submit, cancel);
    if (request.secondary) {
      const secondary = document.createElement("button");
      secondary.type = "button";
      secondary.className = "mde-btn mde-btn-danger";
      secondary.textContent = request.secondary.label;
      secondary.addEventListener("click", () => {
        this.close();
        request.secondary!.onClick();
      });
      actions.appendChild(secondary);
    }
    form.appendChild(actions);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values: Record<string, string> = {};
      for (const input of inputs) values[input.name] = input.value.trim();
      this.close();
      request.onSubmit(values);
    });

    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!this.dom.contains(event.target as Node)) this.close();
    };
    form.addEventListener("keydown", onKeydown);
    // Deferred so the click that opened the popover doesn't immediately close it.
    const timer = setTimeout(() => document.addEventListener("pointerdown", onPointerDown), 0);

    this.cleanup = () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown);
      request.onClose?.();
    };

    this.dom.replaceChildren(form);
    this.dom.hidden = false;
    inputs[0]?.focus();
    inputs[0]?.select();
  }

  close(): void {
    if (this.dom.hidden) return;
    this.dom.hidden = true;
    this.dom.replaceChildren();
    const cleanup = this.cleanup;
    this.cleanup = null;
    cleanup?.();
  }

  destroy(): void {
    this.close();
    this.dom.remove();
  }
}
