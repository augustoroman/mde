import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import type { MarkType, Schema } from "prosemirror-model";
import type { Plugin } from "prosemirror-state";
import { clampHeadingLevel, headingLevelsOf } from "../schema";

/** Turn `**text**`-style typing into a mark, removing the delimiters. */
function markInputRule(regexp: RegExp, markType: MarkType): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const [full, wrapped, text] = match;
    if (!text) return null;
    const from = start + full.indexOf(wrapped);
    const tr = state.tr.insertText(text, from, end);
    return tr.addMark(from, from + text.length, markType.create()).removeStoredMark(markType);
  });
}

/** Markdown-style shortcuts while typing: `# `, `- `, `1. `, `**bold**`, `*em*`. */
export function buildInputRules(schema: Schema): Plugin {
  const levels = headingLevelsOf(schema);
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, (match) => ({
        level: clampHeadingLevel(match[1].length, levels),
      })),
      wrappingInputRule(/^\s*([-*+])\s$/, schema.nodes.bullet_list),
      wrappingInputRule(
        /^(\d+)\.\s$/,
        schema.nodes.ordered_list,
        (match) => ({ order: Number(match[1]) }),
        (match, node) => node.childCount + node.attrs.order === Number(match[1]),
      ),
      markInputRule(/(?:^|[^*])(\*\*([^*\s](?:[^*]*[^*\s])?)\*\*)$/, schema.marks.strong),
      markInputRule(/(?:^|[^_\w])(__([^_\s](?:[^_]*[^_\s])?)__)$/, schema.marks.strong),
      markInputRule(/(?:^|[^*])(\*([^*\s](?:[^*]*[^*\s])?)\*)$/, schema.marks.em),
      markInputRule(/(?:^|[^_\w])(_([^_\s](?:[^_]*[^_\s])?)_)$/, schema.marks.em),
    ],
  });
}
