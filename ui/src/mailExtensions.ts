// What Mail adds to the kit's rich-text editor (its `extensions` prop), loaded with it, never in Mail's first load: a remote
// picture of an answered or forwarded message, kept by its address and not loaded while the answer is written (the reader's
// rule: remote content waits until the person allows it); it goes out as it came (lib/compose.ts, `REMOTE_MARK`). And a link
// ends where its words end: a space or punctuation typed right after it is not part of it.

import { Extension, mergeAttributes, Node } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { t } from "@ferrum/client";
import { REMOTE_MARK } from "./lib/compose";

const RemotePicture = Node.create({
  name: "mailRemotePicture",
  group: "inline",
  inline: true,
  atom: true,
  draggable: true,
  addAttributes: () => ({ src: { default: null }, alt: { default: null }, width: { default: null, parseHTML: (el) => Number(el.getAttribute("width")) || null } }),
  // Before the kit's own picture (priority 50), which would load it.
  parseHTML: () => [{ tag: `img[src$="${REMOTE_MARK}"]`, priority: 60 }],
  renderHTML: ({ HTMLAttributes }) => ["img", mergeAttributes(HTMLAttributes)],
  addNodeView() {
    return ({ node }) => {
      const chip = document.createElement("span");
      chip.className = "mail-remote-picture";
      chip.contentEditable = "false";
      chip.textContent = node.attrs.alt ? t("Picture from the web: {name}", { name: node.attrs.alt as string }) : t("Picture from the web");
      chip.title = t("Not loaded while you write; it goes out as it came.");
      return { dom: chip, selectNode: () => chip.classList.add("is-selected"), deselectNode: () => chip.classList.remove("is-selected") };
    };
  },
});

/** What ends a link when typed straight after it: a space, or punctuation that closes a sentence or a bracket. */
const ENDS_LINK = /^[\s.,;:!?)\]}'"»”’…]/u;

/** The editor's link keeps going as you type after it (TipTap makes the mark inclusive when it links addresses by itself), so
 *  "see the plan." would link the full stop too. Typed at a link's end, a space or punctuation goes in without the link, and so
 *  does what follows. Inside a link's words, typing is left alone. */
export const LinkEnds = Extension.create({
  name: "mailLinkEnds",
  addProseMirrorPlugins: () => [
    new Plugin({
      props: {
        handleTextInput(view, from, to, text) {
          const link = view.state.schema.marks.link;
          if (!link || !ENDS_LINK.test(text)) return false;
          const $from = view.state.doc.resolve(from);
          const marks = view.state.storedMarks ?? $from.marks();
          const on = link.isInSet(marks);
          if (!on || (to === from && $from.nodeAfter && on.isInSet($from.nodeAfter.marks))) return false;
          const tr = view.state.tr.insertText(text, from, to).removeMark(from, from + text.length, link);
          view.dispatch(tr.setStoredMarks(link.removeFromSet(marks)));
          return true;
        },
      },
    }),
  ],
});

export const mailExtensions: unknown[] = [RemotePicture, LinkEnds];
