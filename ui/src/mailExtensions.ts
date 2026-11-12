// What Mail adds to the kit's rich-text editor (its `extensions` prop), loaded with it, never in Mail's first load: a remote
// picture of an answered or forwarded message, kept by its address and not loaded while the answer is written (the reader's
// rule: remote content waits until the person allows it); it goes out as it came (lib/compose.ts, `REMOTE_MARK`).

import { mergeAttributes, Node } from "@tiptap/core";
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

export const mailExtensions: unknown[] = [RemotePicture];
