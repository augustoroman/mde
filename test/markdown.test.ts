import { describe, expect, it } from "vitest";
import { parseMarkdown, serializeMarkdown, createMarkdownParser } from "../src/markdown";
import { createSchema } from "../src/schema";
import { normalizeMarkdown } from "../src";

/** markdown -> doc -> markdown */
const roundTrip = (md: string) => serializeMarkdown(parseMarkdown(md));
/** Compact structural view of a document: `paragraph(text)` etc. */
const shape = (md: string) => parseMarkdown(md).toString();

describe("canonical documents round-trip unchanged", () => {
  const canonical = [
    "# Title",
    "## Subtitle with *emphasis* and **strong**",
    "A paragraph with a [link](https://example.com/a) and <https://example.com>.",
    "- one\n- two\n  - nested\n  - nested two\n- three",
    "1. first\n2. second\n   1. inner\n3. third",
    "3. starts at three\n4. four",
    "![Alt text](https://example.com/pic.png)",
    '<video src="https://example.com/clip.mp4" controls></video>',
    "# Heading\n\nParagraph one.\n\nParagraph two.\n\n- list\n\n![](https://x.test/i.jpg)\n\nAfter.",
  ];
  for (const md of canonical) {
    it(JSON.stringify(md), () => {
      expect(roundTrip(md)).toBe(md);
      // and idempotent
      expect(roundTrip(roundTrip(md))).toBe(md);
    });
  }
});

describe("normalization of allowed features", () => {
  it("uses canonical markers for bullets, emphasis and strong", () => {
    expect(roundTrip("* a\n+ b\n\n_em_ __strong__")).toBe("- a\n- b\n\n*em* **strong**");
  });

  it("merges adjacent lists of the same kind", () => {
    expect(roundTrip("- a\n\n\n- b")).toBe("- a\n- b");
    expect(roundTrip("1. a\n\n\n1. b\n\n- c")).toBe("1. a\n2. b\n\n- c");
  });

  it("clamps heading levels to the allowed set", () => {
    expect(roundTrip("#### too deep\n\n###### deeper")).toBe("### too deep\n\n### deeper");
  });

  it("supports a custom heading level set", () => {
    const parser = createMarkdownParser(createSchema({ headingLevels: [2, 3] }));
    expect(serializeMarkdown(parser.parse("# one\n\n#### four"))).toBe("## one\n\n### four");
  });

  it("collapses loose lists to tight lists", () => {
    expect(roundTrip("- a\n\n- b\n\n- c")).toBe("- a\n- b\n- c");
  });

  it("turns setext headings into ATX headings", () => {
    expect(roundTrip("Title\n=====\n\nSub\n---")).toBe("# Title\n\n## Sub");
  });

  it("merges soft and hard line breaks into a single paragraph", () => {
    expect(roundTrip("line one\nline two  \nline three\\\nline four")).toBe("line one line two line three line four");
  });

  it("never emits empty paragraphs", () => {
    expect(roundTrip("")).toBe("");
    expect(roundTrip("\n\n   \n\n")).toBe("");
    expect(roundTrip("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("keeps the ordered list start number", () => {
    expect(shape("5. five\n6. six")).toBe('doc(ordered_list(list_item(paragraph("five")), list_item(paragraph("six"))))');
    expect(parseMarkdown("5. five").firstChild!.attrs.order).toBe(5);
  });

  it("keeps continuation paragraphs and nested lists inside their item, merging touching same-kind lists", () => {
    const md = "- a\n  - x\n\n  - y\n\n  paragraph two\n  1. ordered";
    expect(roundTrip(md)).toBe("- a\n  - x\n  - y\n\n  paragraph two\n  1. ordered");
    expect(shape("- a\n\n  note")).toBe('doc(bullet_list(list_item(paragraph("a"), paragraph("note"))))');
  });

  it("indents continuation paragraphs to the ordered list's content column", () => {
    expect(roundTrip("1. a\n\n   note\n2. b")).toBe("1. a\n\n   note\n2. b");
    expect(roundTrip("9. a\n10. b\n\n    note")).toBe(" 9. a\n10. b\n\n    note");
  });
});

describe("whitespace", () => {
  it("collapses runs of spaces, tabs and nbsp to one space and trims block edges", () => {
    expect(roundTrip("a   b\tc\u00a0\u00a0d")).toBe("a b c d");
    expect(roundTrip("- c    d\n\n# h    i")).toBe("- c d\n\n# h i");
    expect(roundTrip("a **b**   c *d*    e")).toBe("a **b** c *d* e");
  });

  it("normalizes a document built with stray spaces", () => {
    const schema = parseMarkdown("").type.schema;
    const { doc, paragraph } = schema.nodes;
    const strong = schema.marks.strong.create();
    const d = doc.create(null, paragraph.create(null, [schema.text("  a  "), schema.text("  b  ", [strong]), schema.text("  c  ")]));
    expect(serializeMarkdown(d)).toBe("a **b** c");
  });
});

describe("serializer canonical form", () => {
  it("renders adjacent same-kind lists as one list", () => {
    const schema = parseMarkdown("").type.schema;
    const { doc, bullet_list, ordered_list, list_item, paragraph } = schema.nodes;
    const item = (t: string) => list_item.create(null, paragraph.create(null, schema.text(t)));
    const d = doc.create(null, [
      bullet_list.create(null, [item("a")]),
      bullet_list.create(null, [item("b")]),
      ordered_list.create({ order: 3 }, [item("c")]),
      ordered_list.create(null, [item("d")]),
    ]);
    expect(serializeMarkdown(d)).toBe("- a\n- b\n\n3. c\n4. d");
  });
});

describe("images and videos", () => {
  it("lifts images out of paragraphs into their own blocks", () => {
    expect(roundTrip("before ![a](https://x.test/1.png) after")).toBe("before\n\n![a](https://x.test/1.png)\n\nafter");
  });

  it("splits several images in one paragraph", () => {
    expect(roundTrip("![a](/1.png)![b](/2.png)")).toBe("![a](/1.png)\n\n![b](/2.png)");
  });

  it("degrades images inside list items to links", () => {
    expect(roundTrip("- see ![the cat](https://x.test/cat.png)")).toBe("- see [the cat](https://x.test/cat.png)");
  });

  it("degrades images inside headings to links", () => {
    expect(roundTrip("# ![logo](/logo.png)")).toBe("# [logo](/logo.png)");
  });

  it("parses a standalone <video> line and ignores extra attributes", () => {
    expect(shape('<video controls src="https://x.test/v.mp4" width="100"></video>')).toBe("doc(video)");
    expect(roundTrip('<video src="https://x.test/v.mp4">')).toBe('<video src="https://x.test/v.mp4" controls></video>');
  });

  it("degrades a video inside a list item to a link", () => {
    expect(roundTrip('- item\n\n  <video src="https://x.test/v.mp4"></video>')).toBe(
      "- item\n\n  <https://x.test/v.mp4>",
    );
    // An unindented video line ends the list instead.
    expect(roundTrip('- item\n<video src="https://x.test/v.mp4"></video>')).toBe(
      '- item\n\n<video src="https://x.test/v.mp4" controls></video>',
    );
  });

  it("escapes a paragraph that merely looks like a video", () => {
    const doc = parseMarkdown("plain");
    const text = doc.type.schema.text('<video src="https://x.test/v.mp4"></video>');
    const p = doc.type.schema.nodes.paragraph.create(null, text);
    const md = serializeMarkdown(doc.type.schema.nodes.doc.create(null, p));
    expect(md.startsWith("\\<video")).toBe(true);
    expect(shape(md)).toMatch(/^doc\(paragraph\(/);
  });

  it("escapes parentheses and spaces in urls", () => {
    expect(roundTrip("![x](<https://x.test/a b(1).png>)")).toBe("![x](https://x.test/a%20b\\(1\\).png)");
  });
});

describe("disallowed markdown degrades to text or is dropped", () => {
  it("block quotes are paragraph indentation; other quoted blocks are unwrapped", () => {
    expect(parseMarkdown("> quoted").firstChild!.attrs.indent).toBe(1);
    expect(parseMarkdown("> > deeper").firstChild!.attrs.indent).toBe(2);
    expect(roundTrip("> quoted")).toBe("> quoted");
    expect(roundTrip(">quoted\n> lazy\ncontinued")).toBe("> quoted lazy continued");
    expect(roundTrip("> a\n\n> b")).toBe("> a\n\n> b");
    expect(roundTrip("> - item\n\n> # heading\n\n> ![i](/i.png)")).toBe("- item\n\n# heading\n\n![i](/i.png)");
    expect(roundTrip("> before ![i](/i.png) after")).toBe("> before\n\n![i](/i.png)\n\n> after");
    expect(roundTrip("- x\n\n  > note")).toBe("- x\n\n  > note");
    expect(parseMarkdown("- x\n\n  > note").firstChild!.firstChild!.child(1).attrs.indent).toBe(1);
    // a quote as the item's own paragraph is just the item
    expect(roundTrip("- > quoted item\n- plain")).toBe("- quoted item\n- plain");
  });

  it("code fences and inline code become plain text", () => {
    expect(shape("```js\nlet x = 1\n```")).toBe('doc(paragraph("```js let x = 1 ```"))');
    expect(shape("a `code` b")).toBe('doc(paragraph("a `code` b"))');
    expect(roundTrip("a `code` b")).toBe("a \\`code\\` b");
  });

  it("indented code is a paragraph", () => {
    expect(shape("    indented")).toBe('doc(paragraph("indented"))');
  });

  it("horizontal rules become text", () => {
    expect(shape("---")).toBe('doc(paragraph("---"))');
    expect(shape("a\n\n***\n\nb")).toBe('doc(paragraph("a"), paragraph("***"), paragraph("b"))');
  });

  it("tables become paragraphs", () => {
    expect(shape("| a | b |\n|---|---|\n| 1 | 2 |")).toBe('doc(paragraph("| a | b | |---|---| | 1 | 2 |"))');
  });

  it("html is inert text", () => {
    expect(shape("<div>hi</div>\n\n<b>x</b>")).toBe('doc(paragraph("<div>hi</div>"), paragraph("<b>x</b>"))');
  });

  it("headings inside list items become paragraphs", () => {
    expect(roundTrip("- # not a heading")).toBe("- not a heading");
  });

  it("strips link titles", () => {
    expect(roundTrip('[a](https://x.test "title")')).toBe("[a](https://x.test)");
  });
});

describe("images and videos can be switched off", () => {
  const noImages = createMarkdownParser(createSchema({ images: false }));
  const noVideos = createMarkdownParser(createSchema({ videos: false }));
  const rt = (parser: typeof noImages, md: string) => serializeMarkdown(parser.parse(md));

  it("without images, markdown images become links and videos still work", () => {
    expect(rt(noImages, "see ![cat](/cat.png) here")).toBe("see [cat](/cat.png) here");
    expect(rt(noImages, '<video src="/v.mp4"></video>')).toBe('<video src="/v.mp4" controls></video>');
    expect(createSchema({ images: false }).nodes.image).toBeUndefined();
  });

  it("normalizeMarkdown takes the same options", () => {
    expect(normalizeMarkdown("#### h\n\n![a](/a.png)", { headingLevels: [1, 2], images: false })).toBe("## h\n\n[a](/a.png)");
    expect(normalizeMarkdown("#### h", [1, 2])).toBe("## h");
  });

  it("without videos, a <video> line is plain text and needs no escaping", () => {
    expect(noVideos.parse('<video src="/v.mp4"></video>').firstChild!.type.name).toBe("paragraph");
    expect(rt(noVideos, '<video src="/v.mp4"></video>')).toBe('<video src="/v.mp4"></video>');
    expect(rt(noVideos, "![a](/a.png)")).toBe("![a](/a.png)");
  });
});

describe("resilience", () => {
  it("accepts arbitrary junk without throwing", () => {
    const junk = ["<!-- c -->", "[x]: /ref", "- ", "1.", "#", "**", "![](", "<video>", "- - - -", "\t\t", "a\n>\n>b", "1. a\n\n   b\n\n   c"];
    for (const j of junk) expect(() => roundTrip(j)).not.toThrow();
  });

  it("resolves reference links", () => {
    expect(roundTrip("[a][ref]\n\n[ref]: https://x.test")).toBe("[a](https://x.test)");
  });
});
