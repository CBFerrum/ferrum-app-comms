// The body of a message as rich text (loaded only when someone writes, so Mail's first load does not
// carry the editor). What it makes is limited to what mail carries well: bold, italic, underline,
// strikethrough, colour and highlight from a small palette, four sizes, lists with indent, quote,
// alignment, links and images (shown from the mailbox while written, sent as parts by `cid:`).
// The toolbar is one tab stop with arrow keys between its controls, each named with its shortcut.

import type { Editor } from "@tiptap/core";
import { mergeAttributes, Node } from "@tiptap/core";
import { TextAlign } from "@tiptap/extension-text-align";
import { BackgroundColor, Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  ChevronDown,
  Highlighter,
  Image as ImageIcon,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Type,
  Underline,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger, Input, Kbd, Popover, PopoverContent, PopoverTrigger, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@ferrum/kit/primitives";
import { cn } from "@ferrum/kit";
import { t } from "@ferrum/client";

// ───────────────────────────── images ─────────────────────────────

/** An image in the body: shown from `src` while written; `cid` and `blobId` name the part it goes out as. */
const MailImage = Node.create({
  name: "image",
  group: "inline",
  inline: true,
  draggable: true,
  atom: true,
  addAttributes() {
    const data = (name: string) => ({ default: null, parseHTML: (el: HTMLElement) => el.getAttribute(`data-${name}`), renderHTML: (a: Record<string, unknown>) => (a[camel(name)] ? { [`data-${name}`]: a[camel(name)] } : {}) });
    return {
      src: { default: null },
      alt: { default: null },
      width: { default: null, parseHTML: (el) => Number(el.getAttribute("width")) || null },
      cid: data("cid"),
      blobId: data("blob-id"),
      type: data("type"),
      name: data("name"),
      remote: data("remote"),
      /** An upload in progress (its key): the image is replaced or removed when it ends. */
      upload: { default: null, rendered: false },
    };
  },
  parseHTML: () => [{ tag: "img" }],
  renderHTML: ({ HTMLAttributes }) => ["img", mergeAttributes(HTMLAttributes)],
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const wrap = document.createElement("span");
      wrap.className = "mail-img";
      wrap.contentEditable = "false";
      const img = document.createElement("img");
      const handle = document.createElement("span");
      handle.className = "mail-img-handle";
      handle.setAttribute("aria-hidden", "true");
      const draw = (n: typeof node) => {
        img.src = n.attrs.src ?? "";
        img.alt = n.attrs.alt ?? n.attrs.name ?? "";
        if (n.attrs.width) img.style.width = `${n.attrs.width}px`;
        else img.style.removeProperty("width");
        wrap.classList.toggle("is-uploading", !!n.attrs.upload);
        wrap.classList.toggle("is-remote", !n.attrs.src && !!n.attrs.remote);
        wrap.title = n.attrs.remote && !n.attrs.src ? t("Remote image (not loaded while you write)") : "";
      };
      draw(node);
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startW = img.getBoundingClientRect().width;
        const rtl = getComputedStyle(wrap).direction === "rtl" ? -1 : 1;
        const max = (editor.view.dom as HTMLElement).clientWidth - 8;
        const move = (ev: PointerEvent) => (img.style.width = `${Math.round(Math.min(max, Math.max(40, startW + (ev.clientX - startX) * rtl)))}px`);
        const up = () => {
          handle.removeEventListener("pointermove", move);
          const pos = getPos();
          if (typeof pos === "number") editor.chain().command(({ tr }) => (tr.setNodeAttribute(pos, "width", Math.round(img.getBoundingClientRect().width)), true)).run();
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up, { once: true });
      });
      wrap.append(img, handle);
      return {
        dom: wrap,
        update: (n) => (n.type.name === "image" ? (draw(n), true) : false),
        selectNode: () => wrap.classList.add("is-selected"),
        deselectNode: () => wrap.classList.remove("is-selected"),
      };
    };
  },
});

const camel = (s: string) => s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

// ───────────────────────────── the palette ─────────────────────────────

// ui-lint-allow raw-color: colours written into the message itself (other mail programs draw them), not the theme's
const COLORS = ["#000000", "#5f6368", "#c5221f", "#e8710a", "#f9ab00", "#188038", "#1967d2", "#9334e6", "#d01884", "#ffffff"];
// ui-lint-allow raw-color: highlight colours written into the message itself
const MARKS = ["#fff475", "#ccff90", "#a7ffeb", "#cbf0f8", "#fdcfe8", "#e6c9a8"];
const COLOR_NAMES = () => [t("Black"), t("Grey"), t("Red"), t("Orange"), t("Yellow"), t("Green"), t("Blue"), t("Purple"), t("Pink"), t("White")];
const MARK_NAMES = () => [t("Yellow"), t("Green"), t("Teal"), t("Blue"), t("Pink"), t("Brown")];

const SIZES = [
  { id: "12px", label: () => t("Small") },
  { id: "", label: () => t("Normal") },
  { id: "18px", label: () => t("Large") },
  { id: "26px", label: () => t("Huge") },
];

// ───────────────────────────── the editor ─────────────────────────────

export interface EditorHandle {
  focus: () => void;
  html: () => string;
  /** Puts HTML at the end of the body (an opened quote, a template). */
  append: (html: string) => void;
  /** Replaces the whole body. */
  replace: (html: string) => void;
  insertImage: (attrs: { src: string; name: string; upload: string }) => void;
  /** Finishes an upload: the image becomes the part it now is, or goes when the upload failed or was cancelled. */
  settleImage: (upload: string, attrs: { blobId: string; cid: string; type: string } | null) => void;
  /** Replaces images whose `src` is in `from` by the uploaded parts. */
  swapImages: (from: Record<string, { blobId: string; cid: string; type: string; src: string }>) => void;
  /** The words of the body as plain text (for the attachment reminder and the plain-text switch). */
  text: () => string;
}

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** "Mod-Shift-k" as this keyboard names it. */
const keysOf = (k: string) => k.split("-").map((p) => (p === "Mod" ? (mac ? "⌘" : "Ctrl") : p === "Shift" ? (mac ? "⇧" : "Shift") : p.toUpperCase())).join(mac ? "" : "+");

export const MailEditor = forwardRef<
  EditorHandle,
  { initial: string; label: string; placeholder?: string; autoFocus?: boolean; onChange: () => void; onFiles: (files: File[], inline: boolean) => void; onSend: () => void; dir?: "ltr" | "rtl"; children?: ReactNode }
>(function MailEditor(p, ref) {
  const [linking, setLinking] = useState(false);
  const latest = useRef(p);
  latest.current = p;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, code: false, codeBlock: false, horizontalRule: false, link: { openOnClick: false, autolink: true, defaultProtocol: "https", protocols: ["mailto", "tel"] } }),
      TextStyle,
      Color,
      BackgroundColor,
      FontSize,
      TextAlign.configure({ types: ["paragraph"], alignments: ["left", "center", "right"] }),
      Placeholder.configure({ placeholder: p.placeholder ?? "" }),
      MailImage,
    ],
    content: p.initial,
    autofocus: p.autoFocus ? "start" : false,
    immediatelyRender: true,
    editorProps: {
      attributes: {
        class: "mail-editor min-h-40 px-3 py-2 text-sm leading-relaxed outline-none",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": p.label,
        // The platform bar leaves Ctrl/Cmd+K to a region that asks for it: here it adds a link.
        "data-ferrum-keys": "mod+k",
        dir: "auto",
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.length) return false;
        latest.current.onFiles(files, true);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
        if (!files.length) return false;
        event.preventDefault();
        latest.current.onFiles(files, true);
        return true;
      },
      handleKeyDown: (_view, e) => {
        const mod = mac ? e.metaKey : e.ctrlKey;
        if (mod && e.key.toLowerCase() === "k") {
          e.preventDefault();
          setLinking(true);
          return true;
        }
        if (mod && e.key === "Enter") {
          e.preventDefault();
          latest.current.onSend();
          return true;
        }
        if (mod && e.key === "\\") {
          e.preventDefault();
          editor?.chain().focus().unsetAllMarks().unsetTextAlign().run();
          return true;
        }
        return false;
      },
    },
    onUpdate: () => latest.current.onChange(),
  });

  useImperativeHandle(ref, () => ({
    focus: () => editor?.commands.focus(),
    html: () => editor?.getHTML() ?? "",
    text: () => editor?.getText({ blockSeparator: "\n" }) ?? "",
    append: (html) => editor?.chain().focus("end").insertContentAt(editor.state.doc.content.size, html).run(),
    replace: (html) => editor?.commands.setContent(html, { emitUpdate: true }),
    insertImage: (attrs) => editor?.chain().focus().insertContent({ type: "image", attrs }).run(),
    settleImage: (upload, attrs) => {
      if (!editor) return;
      editor
        .chain()
        .command(({ tr, state }) => {
          const found: { pos: number; size: number }[] = [];
          state.doc.descendants((n, pos) => void (n.type.name === "image" && n.attrs.upload === upload && found.push({ pos, size: n.nodeSize })));
          for (const f of found.reverse()) {
            if (!attrs) tr.delete(f.pos, f.pos + f.size);
            else for (const [k, v] of Object.entries({ ...attrs, upload: null })) tr.setNodeAttribute(f.pos, k, v);
          }
          return true;
        })
        .run();
    },
    swapImages: (from) => {
      if (!editor) return;
      editor
        .chain()
        .command(({ tr, state }) => {
          state.doc.descendants((n, pos) => {
            const to = n.type.name === "image" ? from[n.attrs.src as string] : undefined;
            if (to) for (const [k, v] of Object.entries(to)) tr.setNodeAttribute(pos, k, v);
          });
          return true;
        })
        .run();
    },
  }));

  if (!editor) return null;
  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto_auto]">
      <div className="min-h-0 overflow-y-auto">
        <EditorContent editor={editor} />
        {p.children}
      </div>
      {linking && <LinkRow editor={editor} onDone={() => setLinking(false)} />}
      <Toolbar editor={editor} onLink={() => setLinking(true)} />
    </div>
  );
});

export default MailEditor;

// ───────────────────────────── toolbar ─────────────────────────────

function selection(e: Editor) {
  const style = e.getAttributes("textStyle");
  return {
    bold: e.isActive("bold"),
    italic: e.isActive("italic"),
    underline: e.isActive("underline"),
    strike: e.isActive("strike"),
    bullet: e.isActive("bulletList"),
    ordered: e.isActive("orderedList"),
    inList: e.isActive("listItem"),
    quote: e.isActive("blockquote"),
    link: e.isActive("link"),
    size: (style.fontSize as string | null) ?? "",
    color: (style.color as string | null) ?? null,
    mark: (style.backgroundColor as string | null) ?? null,
    align: e.isActive({ textAlign: "center" }) ? "center" : e.isActive({ textAlign: "right" }) ? "right" : "left",
    image: e.isActive("image"),
    canUndo: e.can().undo(),
    canRedo: e.can().redo(),
  };
}

function Tip({ label, keys, children }: { label: string; keys?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top">
        {label}
        {keys && <Kbd className="ms-2">{keysOf(keys)}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

const TOOL = "grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40 aria-pressed:bg-accent aria-pressed:text-foreground aria-pressed:shadow-[inset_0_-2px_0_var(--primary)] pointer-coarse:size-10";

function Tool({ label, icon: I, keys, pressed, disabled, onClick }: { label: string; icon: LucideIcon; keys?: string; pressed?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <Tip label={label} keys={keys}>
      <button type="button" className={TOOL} aria-label={label} aria-pressed={pressed} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
        <I className="size-4" aria-hidden="true" />
      </button>
    </Tip>
  );
}

const Sep = () => <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" />;

function Toolbar({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  const s = useEditorState({ editor, selector: ({ editor: e }) => selection(e) });
  const bar = useRef<HTMLDivElement>(null);
  const run = () => editor.chain().focus();
  // One tab stop for the row; arrows, Home and End move along it.
  const active = useRef<HTMLElement | null>(null);
  const items = () => Array.from(bar.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
  useLayoutEffect(() => {
    const all = items();
    if (!active.current || !all.includes(active.current)) active.current = all[0] ?? null;
    for (const el of all) el.tabIndex = el === active.current ? 0 : -1;
  });
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const all = items();
    const at = all.indexOf(e.target as HTMLElement);
    if (at < 0) return;
    const rtl = getComputedStyle(bar.current!).direction === "rtl";
    const next = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : Math.max(0, Math.min(all.length - 1, at + ((e.key === "ArrowRight") !== rtl ? 1 : -1)));
    e.preventDefault();
    all[next]?.focus();
  };
  return (
    <TooltipProvider delayDuration={400}>
      <div
        ref={bar}
        role="toolbar"
        aria-label={t("Formatting")}
        className="scroll-cue flex items-center gap-0.5 overflow-x-auto border-t px-1 py-1"
        onFocusCapture={(e) => {
          const el = (e.target as HTMLElement).closest<HTMLElement>("button");
          if (el && bar.current?.contains(el)) active.current = el;
        }}
        onKeyDown={onKeyDown}
      >
        <Tool label={t("Undo")} icon={Undo2} keys="Mod-z" disabled={!s.canUndo} onClick={() => run().undo().run()} />
        <Tool label={t("Redo")} icon={Redo2} keys="Mod-Shift-z" disabled={!s.canRedo} onClick={() => run().redo().run()} />
        <Sep />
        <DropdownMenu>
          <Tip label={t("Size")}>
            <DropdownMenuTrigger asChild>
              <button type="button" className={cn(TOOL, "inline-flex w-auto gap-0.5 px-1.5")} aria-label={t("Size: {value}", { value: SIZES.find((x) => x.id === s.size)?.label() ?? t("Normal") })} onMouseDown={(e) => e.preventDefault()}>
                <Type className="size-4" aria-hidden="true" />
                <ChevronDown className="size-3" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent onCloseAutoFocus={(e) => (e.preventDefault(), editor.commands.focus())}>
            <DropdownMenuRadioGroup value={s.size} onValueChange={(v) => (v ? run().setFontSize(v).run() : run().unsetFontSize().run())}>
              {SIZES.map((x) => (
                <DropdownMenuRadioItem key={x.id || "normal"} value={x.id}>
                  <span style={x.id ? { fontSize: x.id } : undefined}>{x.label()}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tool label={t("Bold")} icon={Bold} keys="Mod-b" pressed={s.bold} onClick={() => run().toggleBold().run()} />
        <Tool label={t("Italic")} icon={Italic} keys="Mod-i" pressed={s.italic} onClick={() => run().toggleItalic().run()} />
        <Tool label={t("Underline")} icon={Underline} keys="Mod-u" pressed={s.underline} onClick={() => run().toggleUnderline().run()} />
        <Tool label={t("Strikethrough")} icon={Strikethrough} keys="Mod-Shift-s" pressed={s.strike} onClick={() => run().toggleStrike().run()} />
        <Swatches label={t("Text colour")} icon={Baseline} colors={COLORS} names={COLOR_NAMES()} current={s.color} noneLabel={t("Automatic")} onPick={(c) => (c ? run().setColor(c).run() : run().unsetColor().run())} />
        <Swatches label={t("Highlight")} icon={Highlighter} colors={MARKS} names={MARK_NAMES()} current={s.mark} noneLabel={t("No highlight")} onPick={(c) => (c ? run().setBackgroundColor(c).run() : run().unsetBackgroundColor().run())} />
        <Sep />
        <DropdownMenu>
          <Tip label={t("Align")}>
            <DropdownMenuTrigger asChild>
              <button type="button" className={cn(TOOL, "inline-flex w-auto gap-0.5 px-1.5")} aria-label={t("Align")} onMouseDown={(e) => e.preventDefault()}>
                {s.align === "center" ? <AlignCenter className="size-4" aria-hidden="true" /> : s.align === "right" ? <AlignRight className="size-4" aria-hidden="true" /> : <AlignLeft className="size-4" aria-hidden="true" />}
                <ChevronDown className="size-3" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent onCloseAutoFocus={(e) => (e.preventDefault(), editor.commands.focus())}>
            <DropdownMenuRadioGroup value={s.align} onValueChange={(v) => run().setTextAlign(v).run()}>
              <DropdownMenuRadioItem value="left">{t("Left")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="center">{t("Centre")}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="right">{t("Right")}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tool label={t("Numbered list")} icon={ListOrdered} keys="Mod-Shift-7" pressed={s.ordered} onClick={() => run().toggleOrderedList().run()} />
        <Tool label={t("Bulleted list")} icon={List} keys="Mod-Shift-8" pressed={s.bullet} onClick={() => run().toggleBulletList().run()} />
        <Tool label={t("Indent less")} icon={IndentDecrease} keys="Shift-Tab" disabled={!s.inList} onClick={() => run().liftListItem("listItem").run()} />
        <Tool label={t("Indent more")} icon={IndentIncrease} keys="Tab" disabled={!s.inList} onClick={() => run().sinkListItem("listItem").run()} />
        <Tool label={t("Quote")} icon={Quote} keys="Mod-Shift-b" pressed={s.quote} onClick={() => run().toggleBlockquote().run()} />
        <Sep />
        <Tool label={t("Link")} icon={Link2} keys="Mod-k" pressed={s.link} onClick={onLink} />
        {s.image && (
          <DropdownMenu>
            <Tip label={t("Image size")}>
              <DropdownMenuTrigger asChild>
                <button type="button" className={cn(TOOL, "inline-flex w-auto gap-0.5 px-1.5")} aria-label={t("Image size")} onMouseDown={(e) => e.preventDefault()}>
                  <ImageIcon className="size-4" aria-hidden="true" />
                  <ChevronDown className="size-3" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent onCloseAutoFocus={(e) => (e.preventDefault(), editor.commands.focus())}>
              <DropdownMenuRadioGroup value="" onValueChange={(v) => run().updateAttributes("image", { width: v === "full" ? null : Number(v) }).run()}>
                <DropdownMenuRadioItem value="160">{t("Small")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="320">{t("Medium")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="560">{t("Large")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="full">{t("Original size")}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Tool label={t("Remove formatting")} icon={RemoveFormatting} keys="Mod-\" onClick={() => run().unsetAllMarks().unsetTextAlign().run()} />
      </div>
    </TooltipProvider>
  );
}

/** A colour from the palette, or none: one tab stop, arrow keys between the swatches. */
function Swatches({ label, icon: I, colors, names, current, noneLabel, onPick }: { label: string; icon: LucideIcon; colors: string[]; names: string[]; current: string | null; noneLabel: string; onPick: (c: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const pick = (c: string | null) => {
    onPick(c);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label={label}>
        <PopoverTrigger asChild>
          <button type="button" className={cn(TOOL, "relative")} aria-label={label} onMouseDown={(e) => e.preventDefault()}>
            <I className="size-4" aria-hidden="true" />
            {/* ui-lint-allow raw-color: shows the colour chosen for the message, which is content */}
            <span className="absolute inset-x-1.5 bottom-1 h-0.5 rounded-full" style={{ background: current ?? "currentColor" }} aria-hidden="true" />
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent className="w-auto p-2" onCloseAutoFocus={(e) => e.preventDefault()}>
        <div
          role="group"
          aria-label={label}
          className="grid grid-cols-5 gap-1"
          onKeyDown={(e) => {
            const cells = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button"));
            const at = cells.indexOf(document.activeElement as HTMLElement);
            const rtl = getComputedStyle(e.currentTarget).direction === "rtl" ? -1 : 1;
            const by = { ArrowRight: rtl, ArrowLeft: -rtl, ArrowDown: 5, ArrowUp: -5 }[e.key];
            if (at < 0 || by === undefined) return;
            e.preventDefault();
            cells[Math.max(0, Math.min(cells.length - 1, at + by))]?.focus();
          }}
        >
          {colors.map((c, i) => (
            <button
              key={c}
              type="button"
              tabIndex={c === current || (!current && i === 0) ? 0 : -1}
              aria-label={names[i]}
              aria-pressed={c === current}
              title={names[i]}
              onClick={() => pick(c)}
              className="size-7 rounded-md border border-border focus-visible:outline-2 focus-visible:outline-ring aria-pressed:ring-2 aria-pressed:ring-primary pointer-coarse:size-9"
              // ui-lint-allow raw-color: a swatch of a colour for the message's content
              style={{ background: c }}
            />
          ))}
        </div>
        <Button variant="ghost" size="sm" className="mt-1 w-full justify-start" onClick={() => pick(null)}>
          {noneLabel}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** The address of a link at the selection: added, changed or taken off. */
function LinkRow({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const [href, setHref] = useState<string>((editor.getAttributes("link").href as string | undefined) ?? "");
  const [bad, setBad] = useState(false);
  const done = () => {
    onDone();
    // Back to the words, after the link, once the row is gone.
    requestAnimationFrame(() => editor.chain().focus().unsetMark("link").run());
  };
  const apply = () => {
    const raw = href.trim();
    if (!raw) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return done();
    }
    const url = /^(https?:|mailto:|tel:)/i.test(raw) ? raw : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? `mailto:${raw}` : `https://${raw}`;
    try {
      new URL(url);
    } catch {
      return setBad(true);
    }
    if (editor.state.selection.empty && !editor.isActive("link")) editor.chain().focus().insertContent({ type: "text", text: raw, marks: [{ type: "link", attrs: { href: url } }] }).run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    done();
  };
  return (
    <form
      className="flex flex-wrap items-center gap-2 border-t px-2 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done();
        }
      }}
    >
      <label htmlFor="mail-link" className="text-xs text-muted-foreground">
        {t("Link to")}
      </label>
      <Input id="mail-link" autoFocus className="h-8 min-w-0 flex-1" value={href} placeholder="https://" aria-invalid={bad || undefined} onChange={(e) => (setHref(e.target.value), setBad(false))} />
      <Button type="submit" size="sm">
        {t("Apply")}
      </Button>
      {editor.isActive("link") && (
        <Button type="button" size="sm" variant="ghost" onClick={() => (editor.chain().focus().extendMarkRange("link").unsetLink().run(), done())}>
          {t("Remove link")}
        </Button>
      )}
      <Button type="button" size="sm" variant="ghost" onClick={done}>
        {t("Cancel")}
      </Button>
      {bad && <p className="basis-full text-xs text-destructive">{t("That is not a web or email address.")}</p>}
    </form>
  );
}
