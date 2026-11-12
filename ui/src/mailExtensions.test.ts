// @vitest-environment jsdom
// A link ends where its words end: a full stop or a space typed straight after it is not linked; typing inside it still is.

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { LinkEnds } from "./mailExtensions";

let editor: Editor | null = null;
afterEach(() => editor?.destroy());

const make = () => (editor = new Editor({ extensions: [StarterKit.configure({ link: { autolink: true } }), LinkEnds], content: `<p>see the <a href="https://x.test/plan">plan</a></p>` }));
/** Types as a person does: through the editor's text input handlers, falling back to a plain insert. */
const type = (e: Editor, text: string) => {
  for (const ch of text) {
    const { from, to } = e.state.selection;
    if (!e.view.someProp("handleTextInput", (f) => f(e.view, from, to, ch, () => e.state.tr.insertText(ch, from, to)))) e.view.dispatch(e.state.tr.insertText(ch, from, to));
  }
};

describe("a link's end", () => {
  it("a full stop and the words after a link are not linked", () => {
    const e = make();
    e.commands.setTextSelection(e.state.doc.content.size - 1);
    expect(e.isActive("link")).toBe(true);
    type(e, ". Thanks");
    expect(e.getHTML()).toBe(`<p>see the <a target="_blank" rel="noopener noreferrer nofollow" href="https://x.test/plan">plan</a>. Thanks</p>`);
  });
  it("typing inside a link's words keeps them one link", () => {
    const e = make();
    e.commands.setTextSelection(e.state.doc.content.size - 3);
    type(e, "X");
    expect(e.getHTML()).toContain(`>plXan</a>`);
  });
});
