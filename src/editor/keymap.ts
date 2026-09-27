import {
  baseKeymap,
  chainCommands,
  createParagraphNear,
  liftEmptyBlock,
  splitBlockAs,
} from "prosemirror-commands";
import { redo, undo } from "prosemirror-history";
import { undoInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { Schema } from "prosemirror-model";
import type { Command, Plugin } from "prosemirror-state";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { headingLevelsOf } from "../schema";
import {
  backspaceAtBlockStart,
  indentParagraph,
  outdentParagraph,
  setHeading,
  setParagraph,
  toggleList,
  toggleMarkOnWord,
  withContinuedNumbering,
} from "./commands";
import { enterInEmptyBlock } from "./canonical";

export interface KeymapHooks {
  /** Bound to Mod-k; typically opens the link dialog. */
  link?: Command;
}

/** Only run `command` when the cursor is in a list item's first paragraph, not in a continuation paragraph. */
function inItemHead(command: Command): Command {
  return (state, dispatch, view) => {
    const { $from } = state.selection;
    const inHead = $from.depth >= 2 && $from.node(-1).type === state.schema.nodes.list_item && $from.index(-1) === 0;
    return inHead && command(state, dispatch, view);
  };
}

export function buildKeymap(schema: Schema, hooks: KeymapHooks = {}): Plugin[] {
  const { strong, em } = schema.marks;
  const { list_item, bullet_list, ordered_list } = schema.nodes;

  // A new paragraph keeps the indent level of the one it was split from.
  const splitKeepingIndent = splitBlockAs((node) =>
    node.type === schema.nodes.paragraph && node.attrs.indent > 0 ? { type: node.type, attrs: node.attrs } : null,
  );
  const enter = withContinuedNumbering(
    chainCommands(enterInEmptyBlock, splitListItem(list_item), createParagraphNear, liftEmptyBlock, splitKeepingIndent),
  );

  const bindings: Record<string, Command> = {
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,
    Backspace: chainCommands(undoInputRule, backspaceAtBlockStart),
    "Mod-b": toggleMarkOnWord(strong),
    "Mod-B": toggleMarkOnWord(strong),
    "Mod-i": toggleMarkOnWord(em),
    "Mod-I": toggleMarkOnWord(em),
    Enter: enter,
    // There are no hard breaks in this schema, so a soft newline is just a new block.
    "Shift-Enter": enter,
    // Tab indents: a continuation paragraph goes one level deeper, a list item
    // (cursor in its own paragraph) nests. Shift-Tab is the reverse. Neither
    // ever moves focus out of the editor.
    Tab: chainCommands(indentParagraph, inItemHead(sinkListItem(list_item)), () => true),
    "Shift-Tab": chainCommands(outdentParagraph, inItemHead(withContinuedNumbering(liftListItem(list_item))), () => true),
    "Shift-Mod-8": toggleList(bullet_list),
    "Shift-Mod-7": toggleList(ordered_list),
    "Shift-Mod-0": setParagraph(schema),
  };
  for (const level of headingLevelsOf(schema)) bindings[`Shift-Mod-${level}`] = setHeading(schema, level);
  if (hooks.link) bindings["Mod-k"] = hooks.link;

  return [keymap(bindings), keymap(baseKeymap)];
}
