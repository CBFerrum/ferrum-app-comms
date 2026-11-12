// Writing a message: in a window of its own beside the mail (several at once, minimised to a titled tab,
// full screen, or popped out to a browser window of its own; one full-screen composer on a phone), under the
// conversation it answers, or as the page another app opened. The body is the kit's rich-text editor
// (RichTextEditor, its code loaded when first needed; its frame is the window's body) or plain text by choice. What is written is saved to Drafts a moment after the last key and
// kept in this browser until the mail server has it, so closing, a crash or a refused save loses
// nothing. Sending holds the message on the mail server for the person's Undo time (FUTURERELEASE),
// so Undo works even if the tab is gone; Schedule send holds it until a chosen time.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { Archive, CalendarClock, ChevronDown, ChevronUp, ExternalLink, File as FileBlank, FileArchive, FileImage, FileSpreadsheet, FileText, HardDrive, ImagePlus, Maximize2, Minimize2, Minus, MoreHorizontal, MoreVertical, PanelBottomOpen, Paperclip, RotateCw, Send, Trash2, Type, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type ComponentProps, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Kbd,
  Progress,
  Skeleton,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@ferrum/kit/primitives";
import { Alert, cn, confirmDialog, plainToRichText, preloadRichTextEditor, RichText, RichTextEditor, richTextToPlain, toast, useCanIntent } from "@ferrum/kit";
import { errorMessage, fetchBlob, formatDateTime, formatMoment, fromZonedInput, isolate, newKey, shell, shownTimeZone, t, toZonedInput } from "@ferrum/client";
import { usePeople } from "@ferrum/records";
import { useOptionalUndo } from "./MailActions";
import { RecipientField, isAddress } from "./MailRecipients";
import {
  answerSubject,
  BLOB_PREFIX,
  cleanHtml,
  emailCreate,
  envelope,
  fileProblem,
  holdParams,
  htmlToText,
  mailBody,
  mentionsAttachment,
  quoteHtml,
  quoteForEditor,
  recentRecipients,
  richOf,
  schedulePresets,
  suggest,
  TEMPLATES,
  textToHtml,
  threadOf,
  writePrefs,
  type Outgoing,
  type RawEmail,
} from "./lib/compose";
import {
  MAIL,
  byRole,
  dropDraft,
  hasContent,
  jmap,
  keepDraft,
  parseAddresses,
  refusal,
  replyRecipients,
  sizeLabel,
  type Address,
  type Draft,
  type Mailbox,
  type Upload,
  type Written,
} from "./lib/mail";


export interface Identity {
  id: string;
  name: string;
  email: string;
  htmlSignature?: string | null;
  textSignature?: string | null;
}

/** How long after the last key a draft is saved to the mailbox. */
const SAVE_AFTER = 2500;
/** Waits before saving again after a failed save. */
const RETRY_AFTER = [4000, 10_000, 30_000];

type Saved = { state: "idle" } | { state: "saving" } | { state: "saved" } | { state: "failed"; message: string };
type Asking = "subject" | "attachment" | "discard" | "plain" | null;
type Phase = { state: "idle" } | { state: "sending" } | { state: "failed"; message: string };

/** The mail server's refusal, in words for the person (as opposed to not having reached it). */
class Refused extends Error {}

export const blobUrl = (account: string) => (blobId: string, name: string, type: string) => `${MAIL}/blob/${account}/${blobId}?${new URLSearchParams({ name, type })}`;

const RAW_PROPS = { properties: ["htmlBody", "attachments", "bodyValues", "subject", "to", "cc", "bcc", "inReplyTo", "references", "keywords"], bodyProperties: ["partId", "blobId", "type", "name", "size", "cid", "disposition"], fetchHTMLBodyValues: true, maxBodyValueBytes: 4_000_000 };

/** A message's body and parts as JMAP gives them, for answering or going on with it. */
async function rawEmail(account: string, id: string): Promise<RawEmail & { subject?: string; to?: Address[]; cc?: Address[]; bcc?: Address[]; inReplyTo?: string[] | null; references?: string[] | null }> {
  const r = await jmap([["Email/get", { accountId: account, ids: [id], ...RAW_PROPS }, "0"]]);
  const e = (r["0"].list as RawEmail[] | undefined)?.[0];
  if (!e) throw new Error(t("That message is not here any more."));
  return e;
}

/** A message in Drafts (or a scheduled one called back) as a message to go on writing. */
export async function loadDraft(account: string, id: string): Promise<Draft> {
  const e = await rawEmail(account, id);
  const quoted = new Set((e.attachments ?? []).filter((a) => a.cid && a.disposition !== "attachment").map((a) => a.blobId));
  return {
    kind: "new",
    saved: {
      id,
      written: {
        to: e.to ?? [],
        cc: e.cc ?? [],
        bcc: e.bcc ?? [],
        subject: e.subject ?? "",
        html: richOf(e, blobUrl(account)),
        text: "",
        plain: false,
        quote: null,
        files: (e.attachments ?? []).filter((a) => !quoted.has(a.blobId)).map((a) => ({ blobId: a.blobId!, name: a.name ?? "attachment", type: a.type ?? "application/octet-stream", size: a.size ?? 0 })),
        signature: false,
      },
      inReplyTo: e.inReplyTo,
      references: e.references,
    },
  };
}

/** The person's identities (From addresses) with their signatures. */
export function useIdentities(account: string) {
  return useQuery({
    queryKey: ["mail", "identities", account],
    queryFn: async () => (await jmap([["Identity/get", { accountId: account }, "0"]]))["0"].list as Identity[],
    staleTime: 10 * 60_000,
  });
}

/** An identity's signature as HTML (another program may have saved only text, or unsafe HTML). */
export const signatureOf = (i: Identity | undefined) => (i?.htmlSignature?.trim() ? cleanHtml(i.htmlSignature) : i?.textSignature?.trim() ? textToHtml(i.textSignature) : "");

/** People written to before, from the newest 200 messages in Sent. */
function useRecent(account: string, sent: string | undefined, mine: string[]) {
  return useQuery({
    queryKey: ["mail", "recent", account],
    enabled: !!sent,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const r = await jmap([
        ["Email/query", { accountId: account, filter: { inMailbox: sent }, sort: [{ property: "receivedAt", isAscending: false }], limit: 200 }, "q"],
        ["Email/get", { accountId: account, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["to", "cc", "bcc"] }, "g"],
      ]);
      return recentRecipients(r.g.list as { to: Address[]; cc: Address[]; bcc: Address[] }[], mine);
    },
  });
}

/** Uploads a file to the mailbox with progress; resolves to the blob, rejects with the reason. */
function upload(account: string, file: File, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<Upload> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", `${MAIL}/upload/${account}`);
    x.setRequestHeader("content-type", file.type || "application/octet-stream");
    x.setRequestHeader("accept", "application/json");
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => {
      let body: { blobId?: string; type?: string; size?: number; message?: string } = {};
      try {
        body = JSON.parse(x.responseText);
      } catch {
        // an answer that is not JSON: said below
      }
      if (x.status >= 200 && x.status < 300 && body.blobId) resolve({ blobId: body.blobId, name: file.name || "file", type: file.type || body.type || "application/octet-stream", size: body.size ?? file.size });
      else reject(new Error(body.message || t("The upload was refused ({n}).", { n: x.status })));
    };
    x.onerror = () => reject(new Error(t("The upload did not reach the mail server.")));
    signal.addEventListener("abort", () => x.abort());
    x.onabort = () => reject(new DOMException("cancelled", "AbortError"));
    x.send(file);
  });
}

interface Pending {
  key: string;
  file: File;
  inline: boolean;
  loaded: number;
  failed?: string;
  stop: AbortController;
}

const isImage = (f: File) => /^image\/(png|jpeg|gif|webp)$/.test(f.type);

export function useMedia(query: string) {
  const [on, setOn] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const f = () => setOn(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [query]);
  return on;
}

// ───────────────────────────── the stack of windows ─────────────────────────────

export interface Win {
  id: string;
  draft: Draft;
  state: "open" | "min" | "max";
}

/** A window's size, as the person last left it (dragged by its corner), for every window after. */
const SIZE_KEY = "ferrum.mail.composeSize";
const DEFAULT_SIZE = { w: 640, h: 600 };
function readSize(): { w: number; h: number } {
  try {
    const v = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null") as { w?: number; h?: number } | null;
    return v && v.w && v.h ? { w: v.w, h: v.h } : DEFAULT_SIZE;
  } catch {
    return DEFAULT_SIZE;
  }
}

/** The windows being written in, at the bottom end of the screen; on a phone the newest open one fills it. */
export function ComposeStack({ wins, setWins, account, me, boxes, open }: { wins: Win[]; setWins: (f: (w: Win[]) => Win[]) => void; account: string; me: string; boxes: Mailbox[]; open: (d: Draft) => void }) {
  const phone = useMedia("(max-width: 767px)");
  const [size, setSize] = useState(readSize);
  const front = [...wins].reverse().find((w) => w.state !== "min")?.id;
  const set = (id: string, state: Win["state"]) => setWins((all) => all.map((w) => (w.id === id ? { ...w, state } : w.state === "max" && state === "max" ? { ...w, state: "open" } : w)));
  const close = (id: string) => setWins((all) => all.filter((w) => w.id !== id));
  const resized = (next: { w: number; h: number }) => {
    setSize(next);
    try {
      localStorage.setItem(SIZE_KEY, JSON.stringify(next));
    } catch {
      // kept for this page only
    }
  };
  if (!wins.length) return null;
  return (
    // While windows are open at the bottom end, the kit's notices go to the bottom start, never over a Send button.
    <div data-compose-stack data-toast-placement="bottom-start" className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-row-reverse items-end gap-3 px-4 max-md:px-0" aria-label={t("Messages being written")} role="region">
      {wins.some((w) => w.state === "max") && !phone && <div className="pointer-events-auto fixed inset-0 bg-black/45" aria-hidden="true" onClick={() => setWins((all) => all.map((w) => (w.state === "max" ? { ...w, state: "open" } : w)))} />}
      {wins.map((w) => {
        const shown = phone ? (w.id === front ? "phone" : "min") : w.state;
        return (
          <Composer
            key={w.id}
            mode="window"
            frame={shown}
            size={size}
            onResize={resized}
            account={account}
            me={me}
            boxes={boxes}
            draft={w.draft}
            onFrame={(s) => set(w.id, s)}
            onClose={() => close(w.id)}
            open={open}
          />
        );
      })}
    </div>
  );
}

// ───────────────────────────── one message being written ─────────────────────────────

function startOf(draft: Draft, own: string[], signatureInReplies: boolean): Written {
  const empty: Written = { to: [], cc: [], bcc: [], subject: "", html: "", text: "", plain: false, quote: null, files: [], signature: true };
  if (draft.saved?.written) return { ...empty, signature: false, ...draft.saved.written };
  const o = draft.original;
  if (!o) {
    const p = draft.prefill;
    return { ...empty, to: parseAddresses(p?.to ?? "").list, cc: parseAddresses(p?.cc ?? "").list, subject: p?.subject ?? "", html: p?.body ? plainToRichText(p.body) : "" };
  }
  if (draft.kind === "forward")
    return { ...empty, subject: answerSubject(o.subject, "forward"), files: o.attachments.map((a) => ({ blobId: a.blobId, name: a.name ?? "attachment", type: a.type, size: a.size })), signature: signatureInReplies };
  const r = replyRecipients(o, own, draft.kind === "replyAll");
  return { ...empty, to: r.to, cc: r.cc, subject: answerSubject(o.subject, "reply"), signature: signatureInReplies };
}

/** An icon button named for readers, its name and key in a tooltip. */
function Tool({ label, keys, children, ...rest }: { label: string; keys?: string; children: ReactNode } & Omit<ComponentProps<typeof Button>, "children">) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} aria-keyshortcuts={keys} {...rest}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}
        {keys && <Kbd className="ms-2">{keys}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** Send's shortcut as this keyboard writes it, and as `aria-keyshortcuts` names it. */
export const SEND_KEYS = { shown: mac ? "⌘↵" : "Ctrl+Enter", aria: "Control+Enter Meta+Enter" };

/** Send: named with what it does and its key (for readers and voice control, not only in the tooltip), the key exposed as `aria-keyshortcuts`. */
export function SendButton({ busy, disabled, split, onSend, iconOnly }: { busy: boolean; disabled: boolean; split: boolean; onSend: () => void; iconOnly?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" className={cn("ps-4 pe-3.5", split && "rounded-e-none")} aria-label={busy ? t("Sending…") : t("Send ({keys})", { keys: SEND_KEYS.shown })} aria-keyshortcuts={SEND_KEYS.aria} onClick={onSend} disabled={disabled}>
          <Send aria-hidden="true" /> <span className={cn(iconOnly && "sr-only")}>{busy ? t("Sending…") : t("Send")}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {t("Send")} <Kbd className="ms-2">{SEND_KEYS.shown}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/** The icon of a file by what it is. */
function FileIcon({ type, name }: { type: string; name: string }) {
  const I = /^image\//.test(type) ? FileImage : /pdf$/.test(type) || /\.pdf$/i.test(name) ? FileText : /sheet|excel|csv/.test(type) || /\.(xlsx?|csv|ods)$/i.test(name) ? FileSpreadsheet : /zip|compressed/.test(type) ? FileArchive : FileBlank;
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-2 text-muted-foreground">
      <I className="size-4" aria-hidden="true" />
    </span>
  );
}

/** The phone's visible height and top while the on-screen keyboard is up, so the composer's toolbar sits just above it. */
function useVisualViewport(on: boolean) {
  const [vv, setVv] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const v = typeof window !== "undefined" ? window.visualViewport : null;
    if (!on || !v) return;
    const f = () => setVv({ top: v.offsetTop, height: v.height });
    f();
    v.addEventListener("resize", f);
    v.addEventListener("scroll", f);
    return () => {
      v.removeEventListener("resize", f);
      v.removeEventListener("scroll", f);
    };
  }, [on]);
  return vv;
}

/** A width at which the writing area has room for the editor's whole toolbar (undo, indent, table, rule). */
const FULL_TOOLBAR_AT = 860;

export function Composer({
  mode,
  frame = "open",
  size = DEFAULT_SIZE,
  onResize,
  account,
  me,
  boxes,
  draft,
  onFrame,
  onClose,
  onSent,
  onPopOut,
  onArchive,
  open,
}: {
  mode: "window" | "inline" | "page";
  frame?: Win["state"] | "phone";
  /** A window's size when open (not full screen, not on a phone), and how it is changed by its corner. */
  size?: { w: number; h: number };
  onResize?: (s: { w: number; h: number }) => void;
  account: string;
  me: string;
  boxes: Mailbox[];
  draft: Draft;
  onFrame?: (s: Win["state"]) => void;
  onClose: () => void;
  onSent?: () => void;
  /** Inline only: go on in a window of its own. */
  onPopOut?: (d: Draft) => void;
  /** An answer under its conversation: "Send and archive" archives the conversation once the message is sent. */
  onArchive?: () => void;
  /** Opens a message to write (after Undo, or a discarded draft brought back). */
  open?: (d: Draft) => void;
}) {
  const qc = useQueryClient();
  const undo = useOptionalUndo();
  const prefs = useMemo(() => writePrefs(account), [account]);
  const identities = useIdentities(account);
  const own = useMemo(() => [me, ...(identities.data ?? []).map((i) => i.email)], [me, identities.data]);
  const [w, setW] = useState<Written>(() => startOf(draft, [me], prefs.signatureInReplies));
  const original = draft.original;
  const resumed = !!draft.saved;
  const [ccShown, setCcShown] = useState(w.cc.length > 0);
  const [bccShown, setBccShown] = useState(w.bcc.length > 0);
  const [pending, setPending] = useState<Pending[]>([]);
  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  const [status, setStatus] = useState<Saved>({ state: "idle" });
  const [asking, setAsking] = useState<Asking>(null);
  const [scheduling, setScheduling] = useState(false);
  const [over, setOver] = useState(false);
  const editor = useRef<Editor | null>(null);
  const box = useRef<HTMLElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const imagePicker = useRef<HTMLInputElement>(null);
  const people = usePeople().data?.users ?? [];
  const drafts = byRole(boxes, "drafts");
  const sent = byRole(boxes, "sent");
  const recent = useRecent(account, sent?.id, own).data ?? [];
  const identity = identities.data?.find((i) => i.id === w.identityId) ?? identities.data?.find((i) => i.email.toLowerCase() === me.toLowerCase()) ?? identities.data?.[0];
  const signature = w.signature ? signatureOf(identity) : "";
  const threading = resumed ? { ...(draft.saved?.inReplyTo?.length ? { inReplyTo: draft.saved.inReplyTo } : {}), ...(draft.saved?.references?.length ? { references: draft.saved.references } : {}) } : draft.kind === "new" ? {} : threadOf(original);
  const maxTotal = 50_000_000;
  const phone = frame === "phone";
  const vv = useVisualViewport(phone);

  // Mail's own editor extensions load with the editor, never with Mail's first page.
  const [extensions, setExtensions] = useState<unknown[] | null>(null);
  useEffect(() => {
    preloadRichTextEditor();
    void import("./mailExtensions").then((m) => setExtensions(m.mailExtensions));
  }, []);

  // The whole toolbar where the writing area is wide (full screen, a page), the compact one in a window or under a conversation.
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= FULL_TOOLBAR_AT));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The original under an answer, kept as HTML with its images as references to its own parts.
  const quoted = useQuery({
    queryKey: ["mail", "raw", account, original?.id],
    enabled: !!original && !resumed,
    staleTime: Infinity,
    queryFn: () => rawEmail(account, original!.id),
  });
  useEffect(() => {
    if (!quoted.data || !original || resumed || w.quote !== null) return;
    const when = formatDateTime(original.sentAt ?? original.receivedAt);
    setW((x) => ({ ...x, quote: quoteHtml(draft.kind === "forward" ? "forward" : "reply", original, when, richOf(quoted.data, blobUrl(account))) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the original is in
  }, [quoted.data]);

  // ── saving ──
  const latest = useRef({ w, identity, signature, threading });
  latest.current = { w, identity, signature, threading };
  const key = useRef(draft.saved?.key ?? newKey()).current;
  const draftId = useRef<string | null>(draft.saved?.id ?? null);
  const edits = useRef(0);
  const kept = useRef(0);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const failures = useRef(0);
  /** Pictures that were not on the mail server (a signature's own), by their address: uploaded once, then sent by reference. */
  const uploaded = useRef(new Map<string, string>());
  const changed = () => edits.current !== kept.current;
  const refresh = () => qc.invalidateQueries({ queryKey: ["mail"], predicate: (q) => q.queryKey[1] === "list" || q.queryKey[1] === "mailboxes" || q.queryKey[1] === "scheduled" });

  /** What is written now, with the words of the body as plain text. */
  const now = (): Written => {
    const x = latest.current.w;
    return x.plain ? x : { ...x, text: richTextToPlain(x.html) };
  };

  /** The message as it goes out; pictures not on the mail server yet are uploaded first. */
  const outgoing = async (x: Written): Promise<Outgoing> => {
    const who = latest.current.identity!;
    const base = { from: { name: who.name, email: who.email }, to: x.to.filter(isAddress), cc: x.cc.filter(isAddress), bcc: x.bcc.filter(isAddress), subject: x.subject, files: x.files, ...latest.current.threading };
    const sig = latest.current.signature;
    if (x.plain) {
      const text = [x.text.replace(/\s+$/, ""), sig ? `-- \n${htmlToText(sig)}` : "", x.quote ? htmlToText(x.quote) : ""].filter(Boolean).join("\n\n");
      return { ...base, text, html: null };
    }
    const parts = { body: x.html, signature: sig || null, quote: x.quote };
    let body = mailBody(parts, Object.fromEntries(uploaded.current));
    if (body.missing.length) {
      for (const src of body.missing) {
        const blob = await fetchBlobFrom(src);
        if (!blob) continue;
        const up = await upload(account, new File([blob], "image", { type: blob.type || "image/png" }), () => undefined, new AbortController().signal);
        uploaded.current.set(src, blobUrl(account)(up.blobId, "image", up.type));
      }
      body = mailBody(parts, Object.fromEntries(uploaded.current));
    }
    return { ...base, text: body.text, html: body.html, inline: body.inline };
  };

  const saveNow = async (): Promise<boolean> => {
    const x = now();
    const at = edits.current;
    if (!hasContent(x) || at === kept.current) return true;
    if (!latest.current.identity) {
      if (identities.isLoading) {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void save(), 1500);
        return true;
      }
      setStatus({ state: "failed", message: t("The mailbox has no address to write as.") });
      return false;
    }
    if (!drafts) {
      setStatus({ state: "failed", message: t("The mailbox has no Drafts folder.") });
      return false;
    }
    setStatus({ state: "saving" });
    try {
      const r = await jmap([["Email/set", { accountId: account, create: { d: emailCreate(await outgoing(x), drafts.id) } }, "0"]]);
      const made = (r["0"].created as Record<string, { id: string }> | undefined)?.d;
      if (!made) throw new Refused(refusal((r["0"].notCreated as Record<string, { type?: string; description?: string }> | undefined)?.d, t("The mail server did not take the draft.")));
      const old = draftId.current;
      draftId.current = made.id;
      kept.current = at;
      failures.current = 0;
      // The copy before it goes; if that fails an old copy stays in Drafts, which loses nothing.
      if (old) await jmap([["Email/set", { accountId: account, destroy: [old] }, "0"]]).catch(() => undefined);
      if (edits.current === at) dropDraft(account, key);
      setStatus({ state: "saved" });
      void refresh();
      return true;
    } catch (e) {
      setStatus({ state: "failed", message: errorMessage(e) });
      // It is tried again by itself, a little later each time.
      const wait = RETRY_AFTER[Math.min(failures.current++, RETRY_AFTER.length - 1)]!;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), wait);
      return false;
    }
  };
  const save = () => {
    queue.current = queue.current.then(saveNow);
    return queue.current;
  };

  // Every change is kept in this browser and saved to the mailbox when typing pauses.
  const keepTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touched = () => {
    edits.current += 1;
    clearTimeout(keepTimer.current);
    keepTimer.current = setTimeout(() => {
      const x = now();
      if (hasContent(x)) keepDraft({ key, account, savedAt: new Date().toISOString(), written: x, draftId: draftId.current ?? undefined, inReplyTo: threading.inReplyTo, references: threading.references });
      else dropDraft(account, key);
    }, 300);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_AFTER);
  };
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    touched();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a change of what is written is what this reacts to
  }, [w]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(keepTimer.current);
    },
    [],
  );
  // Closing the tab with unsaved words: the browser's copy is made at once, and the browser asks.
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (!changed() || !hasContent(now())) return;
      keepDraft({ key, account, savedAt: new Date().toISOString(), written: now(), draftId: draftId.current ?? undefined, inReplyTo: latest.current.threading.inReplyTo, references: latest.current.threading.references });
      e.preventDefault();
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The window is remembered for this tab, so a reload opens it again.
  useEffect(() => {
    if (mode !== "window") return;
    rememberOpen(account, key, () => draftId.current);
    return () => forgetOpen(account, key);
  }, [account, key, mode]);

  // ── files ──
  const totalNow = () => w.files.reduce((n, f) => n + f.size, 0) + pending.reduce((n, p) => n + p.file.size, 0);
  /** Uploads a file to the mailbox, its progress on its tile; resolves to the part, rejects with the reason. */
  const run = (p: Pending) =>
    upload(account, p.file, (loaded) => setPending((all) => all.map((x) => (x.key === p.key ? { ...x, loaded } : x))), p.stop.signal).then((up) => {
      setPending((all) => all.filter((x) => x.key !== p.key));
      return up;
    });
  const startUpload = (p: Pending) =>
    void run(p).then(
      (up) => setW((x) => ({ ...x, files: [...x.files, up] })),
      (e: unknown) => {
        if ((e as Error).name === "AbortError") return;
        setPending((all) => all.map((x) => (x.key === p.key ? { ...x, failed: errorMessage(e) } : x)));
      },
    );
  /** A picture in the text: uploaded to the mailbox (its progress on a tile), shown from there while written, sent as a `cid:` part. */
  const uploadPicture = (file: File): Promise<{ src: string; alt: string } | null> => {
    const problem = fileProblem(file.size, totalNow(), maxTotal);
    if (problem) {
      toast(`${file.name}: ${problem}`, "error");
      return Promise.resolve(null);
    }
    const p: Pending = { key: newKey(), file, inline: true, loaded: 0, stop: new AbortController() };
    setPending((all) => [...all, p]);
    return run(p).then(
      (up) => ({ src: blobUrl(account)(up.blobId, up.name, up.type), alt: (file.name || t("image")).replace(/\.[^.]+$/, "") }),
      (e: unknown) => {
        setPending((all) => all.filter((x) => x.key !== p.key));
        if ((e as Error).name === "AbortError") return null;
        throw e;
      },
    );
  };
  const insertPictures = (list: File[]) => {
    for (const f of list.filter(isImage))
      void uploadPicture(f).then(
        (got) => got && editor.current?.chain().focus().insertContent({ type: "image", attrs: got }).run(),
        (e: unknown) => toast(errorMessage(e), "error"),
      );
  };
  const attach = (list: File[]) => {
    let total = totalNow();
    const add: Pending[] = [];
    for (const file of list) {
      const problem = fileProblem(file.size, total, maxTotal);
      if (problem) {
        toast(`${file.name}: ${problem}`, "error");
        continue;
      }
      total += file.size;
      add.push({ key: newKey(), file, inline: false, loaded: 0, stop: new AbortController() });
    }
    if (!add.length) return;
    setPending((all) => [...all, ...add]);
    add.forEach(startUpload);
  };
  const cancel = (p: Pending) => {
    p.stop.abort();
    setPending((all) => all.filter((x) => x.key !== p.key));
  };
  const retry = (p: Pending) => {
    const again = { ...p, failed: undefined, loaded: 0, stop: new AbortController() };
    setPending((all) => all.map((x) => (x.key === p.key ? again : x)));
    startUpload(again);
  };
  const fromDrive = useCanIntent("pick", "file");
  const pickFromDrive = async () => {
    const out = await shell()
      .intent<{ files: { url: string; name: string }[] }>({ action: "pick", type: "file", data: { multiple: true, title: t("Attach files from Drive") } })
      .catch((e: unknown) => (toast(errorMessage(e), "error"), null));
    if (out?.status === "done" && out.result?.files?.length) await attachFrom(out.result.files);
  };
  // Files from this site (Drive's, a printed record) attach as copies, fetched with the person's own rights.
  const attachFrom = async (list: { url: string; name: string }[]) => {
    const ownFiles = list.filter((f) => f.url.startsWith("/api/") && !f.url.startsWith("//"));
    try {
      attach(await Promise.all(ownFiles.map(async (f) => new File([await fetchBlob(f.url)], f.name))));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const attached = useRef(false);
  useEffect(() => {
    if (attached.current || !draft.attach?.length) return;
    attached.current = true;
    void attachFrom(draft.attach);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the files the draft came with
  }, []);
  // Files dropped or pasted: pictures dropped on the text go into it (the editor takes them); everything else is attached.
  const onDrop = (e: DragEvent) => {
    setOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    const tookPictures = e.defaultPrevented;
    e.preventDefault();
    attach(tookPictures ? files.filter((f) => !isImage(f)) : files);
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (!files.length) return;
    const inText = !w.plain && !!(e.target as HTMLElement).closest?.(".rte-content");
    const rest = inText ? files.filter((f) => !isImage(f)) : files;
    if (!rest.length) return;
    e.preventDefault();
    attach(rest);
  };

  // ── closing, discarding ──
  const close = async () => {
    if (phase.state === "sending") return;
    clearTimeout(timer.current);
    if (pending.some((p) => !p.failed) && !(await confirmLeave())) return;
    pending.forEach((p) => p.stop.abort());
    if (!hasContent(now()) || !changed()) return onClose();
    if (await save()) {
      toast(t("Draft saved"));
      onClose();
    }
  };
  const confirmLeave = () => confirmDialog({ title: t("Files are still uploading"), message: t("Close and leave them out?"), confirmLabel: t("Close"), danger: true });
  const discard = async (sure = false) => {
    const x = now();
    if (!sure && hasContent(x)) return setAsking("discard");
    setAsking(null);
    clearTimeout(timer.current);
    pending.forEach((p) => p.stop.abort());
    await queue.current;
    const id = draftId.current;
    if (id) {
      try {
        await jmap([["Email/set", { accountId: account, destroy: [id] }, "0"]]);
        void refresh();
      } catch (e) {
        toast(t("The draft in Drafts could not be deleted: {e}", { e: errorMessage(e) }), "error");
      }
    }
    dropDraft(account, key);
    onClose();
    // Undo brings the words back in a new window (they are saved again from there).
    if (undo && open && hasContent(x)) undo.push(t("Draft discarded"), async () => open({ ...draft, saved: { written: x, inReplyTo: threading.inReplyTo, references: threading.references } }));
  };
  /** Goes on in a browser window of its own: saved to Drafts first, then opened there full size. */
  const popOut = async () => {
    if (!(await save()) || !draftId.current) return toast(t("Write something first: an empty message is not kept."), "info");
    const at = `/mail/compose?${new URLSearchParams({ draft: draftId.current, ...(account ? { account } : {}) })}`;
    const win = window.open(at, `mail-${key}`, "popup,width=960,height=800");
    if (!win) return toast(t("The browser blocked the new window. Allow pop-ups for this site and try again."), "error");
    dropDraft(account, key);
    onClose();
  };

  // ── sending ──
  const send = async (when?: Date, sure: Asking[] = [], archive = false) => {
    setPhase({ state: "idle" });
    setAsking(null);
    const x = now();
    const bad = [...x.to, ...x.cc, ...x.bcc].filter((a) => !isAddress(a)).map((a) => a.email);
    const problem = bad.length ? t("Not an email address: {bad}. Fix it, or take it out, and send again.", { bad: bad.join(", ") }) : !x.to.length && !x.cc.length && !x.bcc.length ? t("Add at least one recipient.") : null;
    if (problem) return setPhase({ state: "failed", message: problem });
    if (!drafts || !sent || !identity) return setPhase({ state: "failed", message: t("The mailbox has no Drafts or Sent folder, or no address to send as. Nothing was sent.") });
    if (pending.length) return setPhase({ state: "failed", message: pending.some((p) => p.failed) ? t("A file could not be uploaded: try it again or remove it.") : t("Wait for the files to finish uploading.") });
    if (!x.subject.trim() && !sure.includes("subject")) return setAsking("subject"), void pendingSend.current.set(when, sure, archive);
    if (!x.files.length && mentionsAttachment(x.text) && !sure.includes("attachment")) return setAsking("attachment"), void pendingSend.current.set(when, sure, archive);
    clearTimeout(timer.current);
    await queue.current;
    setPhase({ state: "sending" });
    const seconds = mode === "page" ? 0 : prefs.undoSeconds;
    const hold = when ? { until: when } : { seconds };
    try {
      const out = await outgoing(x);
      const r = await jmap([
        ["Email/set", { accountId: account, create: { m: emailCreate(out, drafts.id) } }, "0"],
        [
          "EmailSubmission/set",
          {
            accountId: account,
            create: { s: { emailId: "#m", identityId: identity.id, envelope: envelope(identity.email, out, holdParams(hold)) } },
            onSuccessUpdateEmail: { "#s": { [`mailboxIds/${drafts.id}`]: null, [`mailboxIds/${sent.id}`]: true, "keywords/$draft": null } },
          },
          "1",
        ],
        ...(original && !resumed ? [["Email/set", { accountId: account, update: { [original.id]: { [draft.kind === "forward" ? "keywords/$forwarded" : "keywords/$answered"]: true } } }, "2"] as [string, Record<string, unknown>, string]] : []),
      ]);
      const made = (r["0"].created as Record<string, { id: string }> | undefined)?.m;
      const submission = (r["1"].created as Record<string, { id: string; sendAt?: string }> | undefined)?.s;
      const refused = (r["0"].notCreated as Record<string, { type?: string; description?: string }> | undefined)?.m ?? (r["1"].notCreated as Record<string, { type?: string; description?: string }> | undefined)?.s;
      if (refused || !made || !submission) {
        // Taken into Drafts but not sent: it is the draft now, and the window says so.
        if (made) {
          const old = draftId.current;
          draftId.current = made.id;
          kept.current = edits.current;
          if (old) await jmap([["Email/set", { accountId: account, destroy: [old] }, "0"]]).catch(() => undefined);
          setStatus({ state: "saved" });
          void refresh();
        }
        throw new Refused(`${refusal(refused, t("The mail server refused to send it."))}${made ? ` ${t("The message is saved in Drafts.")}` : ""}`);
      }
      // The autosaved copy goes; tried twice, and said when it stays.
      const old = draftId.current;
      if (old) {
        const gone = await removeDraft(account, old);
        if (!gone) toast(t("Sent, but an older copy is still in Drafts. Delete it there."), "info");
      }
      dropDraft(account, key);
      void refresh();
      onSent?.();
      if (archive) onArchive?.();
      onClose();
      afterSend({ account, emailId: made.id, submissionId: submission.id, drafts: drafts.id, sent: sent.id, when, seconds, undo, open });
    } catch (err) {
      const why = errorMessage(err);
      setPhase({
        state: "failed",
        message:
          err instanceof Refused || why.startsWith("The mail server refused it")
            ? t("Not sent. {why} Your message is still here.", { why })
            : t("Not sent: {why}. The mail server may not have been reached; look in Sent before sending it again. Your message is still here, and kept in this browser.", { why }),
      });
    }
  };
  const pendingSend = useRef({ when: undefined as Date | undefined, sure: [] as Asking[], archive: false, set(when: Date | undefined, sure: Asking[], archive: boolean) { this.when = when; this.sure = sure; this.archive = archive; } });
  const goOn = (a: Asking) => void send(pendingSend.current.when, [...pendingSend.current.sure, a], pendingSend.current.archive);

  // ── plain text, templates, quote ──
  const setPlain = (on: boolean, sure = false) => {
    if (on === w.plain) return;
    if (on) {
      if (!sure) return setAsking("plain");
      setAsking(null);
      setW((x) => ({ ...x, plain: true, text: richTextToPlain(x.html), html: "" }));
    } else setW((x) => ({ ...x, plain: false, html: plainToRichText(x.text), text: "" }));
  };
  const templates = useTemplates(account, boxes);
  const insertTemplate = async (id: string, subject: string | null) => {
    try {
      const d = await loadDraft(account, id);
      const html = d.saved?.written?.html ?? "";
      if (w.plain) setW((x) => ({ ...x, text: `${x.text}${x.text ? "\n" : ""}${htmlToText(html)}` }));
      else editor.current?.chain().focus().insertContent(html).run();
      setW((x) => ({ ...x, subject: x.subject.trim() ? x.subject : (subject ?? ""), files: [...x.files, ...(d.saved?.written?.files ?? []).filter((f) => !x.files.some((y) => y.blobId === f.blobId))] }));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const saveTemplate = async () => {
    const x = now();
    if (!identity) return;
    const name = x.subject.trim() || t("Untitled template");
    try {
      const box = await templatesBox(account, boxes);
      const out = await outgoing({ ...x, quote: null, signature: false } as Written);
      const same = templates.data?.filter((m) => (m.subject ?? "").trim() === name).map((m) => m.id) ?? [];
      const r = await jmap([["Email/set", { accountId: account, create: { t: emailCreate({ ...out, subject: name, to: [], cc: [], bcc: [], inReplyTo: undefined, references: undefined }, box, { $seen: true }) }, destroy: same }, "0"]]);
      if (!(r["0"].created as Record<string, unknown> | undefined)?.t) throw new Error(refusal((r["0"].notCreated as Record<string, { type?: string }> | undefined)?.t));
      toast(same.length ? t("Template “{name}” replaced", { name }) : t("Saved as the template “{name}”", { name }));
      void qc.invalidateQueries({ queryKey: ["mail", "templates", account] });
      void qc.invalidateQueries({ queryKey: ["mail", "mailboxes", account] });
    } catch (e) {
      toast(t("The template could not be saved: {e}", { e: errorMessage(e) }), "error");
    }
  };
  /** The folded original opened into the text, to be edited there. */
  const unfold = () => {
    if (w.plain) setW((x) => ({ ...x, text: `${x.text}\n\n${htmlToText(x.quote ?? "")}`, quote: null }));
    else {
      const e = editor.current;
      if (!e) return;
      // The caret stays where the person was writing; the original follows the words, to be edited there.
      const { from, to } = e.state.selection;
      e.chain().insertContentAt(e.state.doc.content.size, quoteForEditor(w.quote ?? "")).setTextSelection({ from, to }).run();
      setW((x) => ({ ...x, quote: null }));
    }
  };

  // ── the window ──
  const busy = phase.state === "sending";
  const titleId = `compose-${key}`;
  const title = w.subject.trim() || { new: t("New message"), reply: t("Reply"), replyAll: t("Reply to all"), forward: t("Forward") }[draft.kind];
  const total = w.files.reduce((n, f) => n + f.size, 0);
  const statusText = status.state === "saving" ? t("Saving…") : status.state === "saved" ? t("Saved to Drafts") : status.state === "failed" ? t("Could not save, retrying") : "";
  const presets = schedulePresets(new Date(), (iso) => toZonedInput(iso), (local) => fromZonedInput(local));
  const minimised = frame === "min";
  const window_ = mode === "window";
  const suggestFor = (q: string) => suggest(q, people, recent, [...w.to, ...w.cc, ...w.bcc].map((a) => a.email));
  // An open window is the size it was last left, within the screen; dragged by its top start corner (it sits at the bottom end).
  const sized = window_ && frame === "open" ? ({ inlineSize: `min(${size.w}px, calc(100vw - 2rem))`, blockSize: `min(${size.h}px, calc(100dvh - var(--ferrum-bar-height, 48px) - 1rem))` } as CSSProperties) : undefined;
  const frameClass =
    mode === "inline"
      ? "rounded-lg border bg-card shadow-(--shadow-sm)"
      : mode === "page"
        ? "mx-auto flex min-h-[calc(100dvh-var(--ferrum-bar-height,48px))] max-w-4xl flex-col border-x bg-card"
        : frame === "phone"
          ? "pointer-events-auto fixed inset-x-0 z-40 flex flex-col bg-popover [transform:translateZ(0)]"
          : frame === "max"
            ? "pointer-events-auto fixed inset-x-0 top-[calc(var(--ferrum-bar-height,48px)+1.5rem)] bottom-6 z-50 mx-auto flex w-[min(68rem,calc(100vw-4rem))] flex-col rounded-xl border bg-popover shadow-(--shadow)"
            : frame === "min"
              ? "pointer-events-auto w-72 min-w-0 shrink rounded-t-xl border border-b-0 bg-popover shadow-(--shadow)"
              : "pointer-events-auto relative flex min-w-[22rem] shrink flex-col rounded-t-xl border border-b-0 bg-popover shadow-(--shadow)";
  const startResize = (e: ReactPointerEvent) => {
    if (!onResize) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const rtl = getComputedStyle(el).direction === "rtl" ? -1 : 1;
    const from = { x: e.clientX, y: e.clientY, w: box.current?.offsetWidth ?? size.w, h: box.current?.offsetHeight ?? size.h };
    const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)));
    const at = (ev: PointerEvent) => ({ w: clamp(from.w - (ev.clientX - from.x) * rtl, 440, window.innerWidth - 32), h: clamp(from.h - (ev.clientY - from.y), 340, window.innerHeight - 64) });
    const move = (ev: PointerEvent) => {
      const s = at(ev);
      if (box.current) Object.assign(box.current.style, { inlineSize: `${s.w}px`, blockSize: `${s.h}px` });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", (ev) => (el.removeEventListener("pointermove", move), onResize(at(ev))), { once: true });
  };
  const sizeKeys = (e: ReactKeyboardEvent) => {
    const step = { ArrowLeft: [16, 0], ArrowRight: [-16, 0], ArrowUp: [0, 16], ArrowDown: [0, -16] }[e.key];
    if (!step || !onResize) return;
    e.preventDefault();
    onResize({ w: Math.max(440, Math.min(window.innerWidth - 32, size.w + step[0]!)), h: Math.max(340, Math.min(window.innerHeight - 64, size.h + step[1]!)) });
  };

  const extras = (
    <div className="grid gap-3 px-4 pb-4 empty:hidden">
      {signature && (
        <div className="group relative text-sm text-muted-foreground" aria-label={t("Signature")} role="group">
          <div aria-hidden="true">-- </div>
          {/* As it goes out (the identity's own HTML, cleaned); it is not part of the text, so it is never written twice. */}
          <RichText html={signature} options={SIGNATURE_VIEW} className="mail-signature" />
          <Button type="button" variant="ghost" size="xs" className="absolute end-0 top-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => setW((x) => ({ ...x, signature: false }))}>
            {t("Leave out the signature")}
          </Button>
        </div>
      )}
      {w.quote !== null && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="mail-quote-fold" aria-label={t("Show the quoted message")} aria-expanded="false" onClick={unfold}>
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{t("Show the quoted message")}</TooltipContent>
        </Tooltip>
      )}
      {original && !resumed && quoted.isLoading && <Skeleton className="h-6 w-12 rounded-full" />}
      {(w.files.length > 0 || pending.length > 0) && (
        <div className="grid gap-1.5">
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2" aria-label={t("Attachments")}>
            {w.files.map((f) => (
              <li key={f.blobId} className="mail-file">
                <FileIcon type={f.type} name={f.name} />
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-sm font-medium">{isolate(f.name)}</span>
                  <span className="text-xs text-muted-foreground">{isolate(sizeLabel(f.size))}</span>
                </span>
                <Tool label={t("Remove {name}", { name: f.name })} size="icon-xs" onClick={() => setW((x) => ({ ...x, files: x.files.filter((y) => y.blobId !== f.blobId) }))}>
                  <X />
                </Tool>
              </li>
            ))}
            {pending.map((p) => (
              <li key={p.key} className="mail-file">
                <FileIcon type={p.file.type} name={p.file.name} />
                <span className="grid min-w-0 flex-1 gap-1">
                  <span className="truncate text-sm font-medium">{isolate(p.file.name || t("image"))}</span>
                  {p.failed ? (
                    <span className="truncate text-xs text-destructive" title={p.failed}>
                      {t("Not uploaded")}: {isolate(p.failed)}
                    </span>
                  ) : (
                    <Progress value={(p.loaded / Math.max(1, p.file.size)) * 100} aria-label={p.inline ? t("Adding the picture {name}", { name: p.file.name }) : t("Uploading {name}", { name: p.file.name })} className="h-1" />
                  )}
                </span>
                {p.failed && (
                  <Tool label={t("Try {name} again", { name: p.file.name })} size="icon-xs" onClick={() => retry(p)}>
                    <RotateCw />
                  </Tool>
                )}
                <Tool label={t("Cancel {name}", { name: p.file.name })} size="icon-xs" onClick={() => cancel(p)}>
                  <X />
                </Tool>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t("{size} of {max} MB; up to {file} MB a file", { size: sizeLabel(total), max: Math.floor(maxTotal / 1e6), file: 32 })}</p>
        </div>
      )}
    </div>
  );
  const head = (
    <header className={cn("flex shrink-0 items-center gap-0.5 ps-4 pe-1.5", phone ? "h-12 border-b" : "h-11", window_ && !phone && "cursor-default rounded-t-xl bg-surface-2", minimised && "rounded-t-xl")}>
      <h2 id={titleId} className={cn("min-w-0 flex-1 truncate text-sm font-semibold", phone && "grid text-base")}>
        {window_ && minimised ? (
          <button type="button" className="w-full truncate py-2 text-start" onClick={() => onFrame?.("open")}>
            {isolate(title)}
          </button>
        ) : (
          isolate(title)
        )}
        {phone && statusText && <span className={cn("truncate text-xs font-normal", status.state === "failed" ? "text-destructive" : "text-muted-foreground")}>{statusText}</span>}
      </h2>
      {window_ && !phone && (
        <>
          <Tool label={minimised ? t("Open") : t("Minimise")} onClick={() => onFrame?.(minimised ? "open" : "min")}>
            {minimised ? <ChevronUp /> : <Minus />}
          </Tool>
          <Tool label={frame === "max" ? t("Exit full screen") : t("Full screen")} onClick={() => onFrame?.(frame === "max" ? "open" : "max")}>
            {frame === "max" ? <Minimize2 /> : <Maximize2 />}
          </Tool>
          {!minimised && (
            <Tool label={t("Open in a new browser window")} onClick={() => void popOut()} disabled={busy}>
              <ExternalLink />
            </Tool>
          )}
        </>
      )}
      <Tool label={t("Save and close")} keys={mode === "window" ? "Escape" : undefined} onClick={() => void close()} disabled={busy}>
        <X />
      </Tool>
    </header>
  );
  const rows = (
    <div className="shrink-0">
      {(identities.data?.length ?? 0) > 1 && (
        <div className="mail-row">
          <label htmlFor={`${titleId}-from`} className="mail-row-label">
            {t("From")}
          </label>
          <select id={`${titleId}-from`} className="h-9 min-w-0 flex-1 rounded-md bg-transparent text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" value={identity?.id ?? ""} onChange={(e) => setW((x) => ({ ...x, identityId: e.target.value }))}>
            {identities.data?.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name ? `${i.name} <${i.email}>` : i.email}
              </option>
            ))}
          </select>
        </div>
      )}
      <RecipientField
        field="to"
        label={t("To")}
        value={w.to}
        onChange={(to) => setW((x) => ({ ...x, to }))}
        suggest={suggestFor}
        onTake={(a, from) => setW((x) => moveAddress(x, a, from, "to"))}
        autoFocus={mode !== "inline" && !w.to.length}
        end={
          (!ccShown || !bccShown) && (
            <span className="flex shrink-0 gap-0.5">
              {!ccShown && (
                <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" aria-label={t("Add Cc recipients")} onClick={() => setCcShown(true)}>
                  {t("Cc")}
                </Button>
              )}
              {!bccShown && (
                <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" aria-label={t("Add Bcc recipients")} onClick={() => setBccShown(true)}>
                  {t("Bcc")}
                </Button>
              )}
            </span>
          )
        }
      />
      {ccShown && <RecipientField field="cc" label={t("Cc")} value={w.cc} onChange={(cc) => setW((x) => ({ ...x, cc }))} suggest={suggestFor} onTake={(a, from) => setW((x) => moveAddress(x, a, from, "cc"))} autoFocus={!w.cc.length && mode !== "inline"} />}
      {bccShown && <RecipientField field="bcc" label={t("Bcc")} value={w.bcc} onChange={(bcc) => setW((x) => ({ ...x, bcc }))} suggest={suggestFor} onTake={(a, from) => setW((x) => moveAddress(x, a, from, "bcc"))} autoFocus={!w.bcc.length && mode !== "inline"} />}
      {mode !== "inline" && (
        <input
          id={`${titleId}-subject`}
          aria-label={t("Subject")}
          placeholder={t("Subject")}
          dir="auto"
          className="mail-subject"
          value={w.subject}
          maxLength={900}
          onChange={(e) => setW((x) => ({ ...x, subject: e.target.value }))}
        />
      )}
      <Notices
        phase={phase}
        asking={asking}
        status={status}
        onAsk={setAsking}
        onGoOn={goOn}
        onDiscard={() => void discard(true)}
        onPlain={() => setPlain(true, true)}
        onAttach={() => picker.current?.click()}
        onRetrySave={() => void save()}
        onCloseAnyway={onClose}
        subjectFocus={() => document.getElementById(`${titleId}-subject`)?.focus()}
      />
    </div>
  );
  const body = w.plain ? (
    <Textarea
      aria-label={t("Message")}
      className="min-h-48 resize-none rounded-none border-0 bg-transparent px-4 py-3 text-base leading-normal shadow-none focus-visible:ring-0"
      value={w.text}
      autoFocus={!!w.to.length}
      onChange={(e) => setW((x) => ({ ...x, text: e.target.value }))}
      dir="auto"
    />
  ) : extensions ? (
    <RichTextEditor
      className="mail-rte"
      toolbar={wide ? "full" : "compact"}
      label={t("Message")}
      placeholder={t("Write your message")}
      value={w.html}
      onChange={(html) => setW((x) => ({ ...x, html }))}
      onUploadImage={uploadPicture}
      imageSources={IMAGE_SOURCES}
      extensions={extensions}
      onEditor={(e) => (editor.current = e)}
      onSubmit={() => void send()}
      autoFocus={!!w.to.length || mode === "inline"}
      minHeight={mode === "inline" ? "7rem" : "10rem"}
      maxHeight="none"
    />
  ) : (
    <div className="grid gap-2 px-4 py-3" aria-busy="true">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
  const iconTools = (
    <>
      <Tool label={t("Attach files")} onClick={() => picker.current?.click()}>
        <Paperclip />
      </Tool>
      <input ref={picker} type="file" multiple hidden onChange={(e) => (attach(Array.from(e.target.files ?? [])), (e.target.value = ""))} />
      {fromDrive && (
        <Tool label={t("Attach from Drive")} onClick={() => void pickFromDrive()}>
          <HardDrive />
        </Tool>
      )}
      {!w.plain && (
        <>
          <Tool label={t("Insert a picture")} onClick={() => imagePicker.current?.click()}>
            <ImagePlus />
          </Tool>
          <input ref={imagePicker} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden data-mail-picture onChange={(e) => (insertPictures(Array.from(e.target.files ?? [])), (e.target.value = ""))} />
        </>
      )}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("Templates")}>
                <FileText />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{t("Templates")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" side="top" className="max-h-80 w-64">
          <DropdownMenuLabel>{t("Insert a template")}</DropdownMenuLabel>
          {templates.data?.length ? (
            templates.data.map((m) => (
              <DropdownMenuItem key={m.id} onSelect={() => void insertTemplate(m.id, m.subject)}>
                <span className="grid min-w-0">
                  <span className="truncate">{isolate(m.subject || t("(no subject)"))}</span>
                  {m.preview && <span className="truncate text-xs text-muted-foreground">{isolate(m.preview)}</span>}
                </span>
              </DropdownMenuItem>
            ))
          ) : (
            <DropdownMenuItem disabled>{templates.isLoading ? t("Loading…") : t("No templates yet")}</DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void saveTemplate()}>{t("Save this message as a template")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tool label={w.plain ? t("Plain text: on") : t("Plain text")} aria-pressed={w.plain} className="aria-pressed:bg-primary-soft aria-pressed:text-primary" onClick={() => setPlain(!w.plain)}>
        <Type />
      </Tool>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("More options")}>
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{t("More options")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" side="top">
          <DropdownMenuCheckboxItem checked={w.signature} disabled={!signatureOf(identity)} onCheckedChange={(c) => setW((x) => ({ ...x, signature: c === true }))}>
            {t("Signature")}
          </DropdownMenuCheckboxItem>
          {phone && (
            <DropdownMenuItem variant="destructive" onSelect={() => void discard()}>
              <Trash2 aria-hidden="true" /> {t("Discard the draft")}
            </DropdownMenuItem>
          )}
          {onPopOut && (
            <DropdownMenuItem onSelect={() => onPopOut({ ...draft, saved: { id: draftId.current ?? undefined, key, written: now(), inReplyTo: threading.inReplyTo, references: threading.references } })}>
              <PanelBottomOpen aria-hidden="true" /> {t("Open in a window of its own")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
  const footer = (
    <footer className="mail-compose-bar">
      <span className="flex shrink-0">
        <SendButton busy={busy} disabled={busy || identities.isLoading} split={mode !== "page"} iconOnly={phone} onSend={() => void send()} />
        {mode !== "page" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" className="rounded-s-none border-s border-primary-foreground/30 px-2" aria-label={t("Send options")} disabled={busy}>
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-72">
              {onArchive && (
                <>
                  <DropdownMenuItem onSelect={() => void send(undefined, [], true)}>
                    <Archive aria-hidden="true" /> {t("Send and archive")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuLabel>{t("Schedule send")}</DropdownMenuLabel>
              {presets.map((s) => (
                <DropdownMenuItem key={s.label} onSelect={() => void send(s.at)}>
                  <span className="flex-1">{s.label}</span>
                  <span className="text-xs text-muted-foreground">{isolate(formatMoment(s.at, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onSelect={() => setScheduling(true)}>
                <CalendarClock aria-hidden="true" /> {t("Pick a date and time…")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </span>
      <span className="flex min-w-0 items-center">{iconTools}</span>
      <span role="status" className={cn("ms-auto min-w-0 truncate text-xs", status.state === "failed" ? "text-destructive" : "text-muted-foreground", phone && "sr-only")}>
        {statusText}
      </span>
      {!phone && (
        <Tool label={t("Discard the draft")} onClick={() => void discard()} disabled={busy}>
          <Trash2 />
        </Tool>
      )}
    </footer>
  );
  const inlineName = draft.kind === "forward" ? t("Forward") : draft.kind === "replyAll" ? t("Reply to all") : t("Reply");
  return (
    <TooltipProvider delayDuration={400}>
      <section
        ref={box}
        role={mode === "page" ? "region" : mode === "inline" ? "region" : "dialog"}
        aria-modal={window_ ? "false" : undefined}
        aria-labelledby={mode === "inline" ? undefined : titleId}
        aria-label={mode === "inline" ? inlineName : undefined}
        data-frame={mode === "window" ? frame : mode}
        className={cn("mail-compose", frameClass, over && "ring-2 ring-primary")}
        // Under the platform's bar, down to the on-screen keyboard's top edge (the visual viewport) when it is up.
        style={phone ? { top: `calc(var(--ferrum-bar-height, 48px) + ${vv?.top ?? 0}px)`, height: vv ? `calc(${vv.height}px - var(--ferrum-bar-height, 48px))` : "calc(100dvh - var(--ferrum-bar-height, 48px))" } : sized}
        onKeyDown={(e) => {
          if (e.key === "Escape" && window_ && !e.defaultPrevented) {
            e.preventDefault();
            void close();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) {
            // Ctrl/Cmd+Enter sends from any field of the message (the editor's own key does it there).
            e.preventDefault();
            void send();
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as globalThis.Node | null) && setOver(false)}
        onDrop={onDrop}
        onPaste={onPaste}
      >
        {window_ && frame === "open" && onResize && (
          <span
            role="separator"
            aria-orientation="horizontal"
            aria-label={t("Resize the window (arrow keys)")}
            tabIndex={0}
            className="mail-compose-grip"
            onPointerDown={startResize}
            onKeyDown={sizeKeys}
          />
        )}
        {mode !== "inline" && head}
        <div hidden={minimised} className="flex min-h-0 flex-1 flex-col">
          <fieldset disabled={busy} className="contents">
            <div className="mail-compose-column flex min-h-0 flex-1 flex-col">
              {rows}
              <div className="mail-compose-scroll min-h-0 flex-1 overflow-y-auto">
                {body}
                {extras}
              </div>
              {footer}
              {scheduling && <ScheduleRow onCancel={() => setScheduling(false)} onPick={(at) => (setScheduling(false), void send(at))} />}
            </div>
          </fieldset>
        </div>
      </section>
    </TooltipProvider>
  );
}

const IMAGE_SOURCES = [BLOB_PREFIX];
const SIGNATURE_VIEW = { inlineImages: true, imageSources: IMAGE_SOURCES };

const moveAddress = (x: Written, a: Address, from: string, to: "to" | "cc" | "bcc"): Written => {
  const k = from as "to" | "cc" | "bcc";
  if (!["to", "cc", "bcc"].includes(k) || k === to) return x;
  return { ...x, [k]: x[k].filter((y) => y.email !== a.email), [to]: x[to].some((y) => y.email === a.email) ? x[to] : [...x[to], a] };
};

/** An image's bytes from where the editor shows it (pasted, or a copy of a draft); null when gone. */
async function fetchBlobFrom(src: string): Promise<Blob | null> {
  try {
    const r = await fetch(src);
    return r.ok ? await r.blob() : null;
  } catch {
    return null;
  }
}

/** Deletes an old copy of a draft, trying twice; false when it stays. */
async function removeDraft(account: string, id: string): Promise<boolean> {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await jmap([["Email/set", { accountId: account, destroy: [id] }, "0"]]);
      const not = (r["0"].notDestroyed as Record<string, { type?: string }> | undefined)?.[id];
      if (!not || not.type === "notFound") return true;
    } catch {
      // asked again once
    }
  }
  return false;
}

/** Calls a held message back: the submission is cancelled and the message goes back to Drafts. */
export async function callBack(account: string, drafts: string, submission: string, emailId: string): Promise<void> {
  const r = await jmap([["EmailSubmission/set", { accountId: account, update: { [submission]: { undoStatus: "canceled" } } }, "0"]]);
  if ((r["0"].notUpdated as Record<string, unknown> | undefined)?.[submission]) throw new Error(t("Too late: the message has already gone."));
  await jmap([["Email/set", { accountId: account, update: { [emailId]: { mailboxIds: { [drafts]: true }, "keywords/$draft": true } } }, "0"]]);
}

/**
 * After the mail server took a message: with a hold, Undo calls it back (cancels the submission, puts
 * the message back in Drafts and opens it) until the hold ends, and then "Sent" is said when the server
 * has let it go. Runs outside the closed window; the server sends whether or not this page is still open.
 */
function afterSend(o: { account: string; emailId: string; submissionId: string; drafts: string; sent: string; when?: Date; seconds: number; undo: ReturnType<typeof useOptionalUndo>; open?: (d: Draft) => void }) {
  const back = async () => {
    await callBack(o.account, o.drafts, o.submissionId, o.emailId);
    if (o.open) o.open(await loadDraft(o.account, o.emailId));
  };
  if (o.when) {
    const at = formatMoment(o.when, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    if (o.undo) o.undo.push(t("Scheduled for {when}", { when: at }), back);
    else toast(t("Scheduled for {when}", { when: at }));
    return;
  }
  if (!o.seconds || !o.undo) return toast(t("Sent"));
  o.undo.push(t("Sending in {n} seconds", { n: o.seconds }), back, o.seconds * 1000);
  // Said once the hold is over and the server has let it go (or what it says instead).
  setTimeout(() => {
    void jmap([["EmailSubmission/get", { accountId: o.account, ids: [o.submissionId], properties: ["undoStatus"] }, "0"]]).then(
      (r) => {
        const s = (r["0"].list as { undoStatus: string }[] | undefined)?.[0]?.undoStatus;
        if (s === "final") toast(t("Sent"));
        else if (s === "pending") toast(t("Sending…"), "info");
      },
      () => undefined,
    );
  }, (o.seconds + 2) * 1000);
}

function Notices(p: {
  phase: Phase;
  asking: Asking;
  status: Saved;
  onAsk: (a: Asking) => void;
  onGoOn: (a: Asking) => void;
  onDiscard: () => void;
  onPlain: () => void;
  onAttach: () => void;
  onRetrySave: () => void;
  onCloseAnyway: () => void;
  subjectFocus: () => void;
}) {
  const ask = (text: string, actions: ReactNode, tone: "warning" | "error" = "warning") => (
    <div className="px-2 pt-2">
      <Alert tone={tone} action={<span className="flex shrink-0 flex-wrap gap-1">{actions}</span>}>
        <span>{text}</span>
      </Alert>
    </div>
  );
  return (
    <>
      {p.phase.state === "failed" && (
        <div className="px-2 pt-2" role="alert">
          <Alert tone="error">
            <span>{isolate(p.phase.message)}</span>
          </Alert>
        </div>
      )}
      {p.asking === "subject" &&
        ask(
          t("This message has no subject."),
          <>
            <Button type="button" size="xs" onClick={() => p.onGoOn("subject")}>
              {t("Send anyway")}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => (p.onAsk(null), p.subjectFocus())}>
              {t("Add a subject")}
            </Button>
          </>,
        )}
      {p.asking === "attachment" &&
        ask(
          t("Your message mentions an attachment, and there is none."),
          <>
            <Button type="button" size="xs" onClick={() => (p.onAsk(null), p.onAttach())}>
              {t("Attach a file")}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => p.onGoOn("attachment")}>
              {t("Send anyway")}
            </Button>
          </>,
        )}
      {p.asking === "plain" &&
        ask(
          t("Plain text drops the formatting, pictures and links' looks of this message."),
          <>
            <Button type="button" size="xs" onClick={p.onPlain}>
              {t("Use plain text")}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => p.onAsk(null)}>
              {t("Keep formatting")}
            </Button>
          </>,
        )}
      {p.asking === "discard" &&
        ask(
          t("Discard this draft? Undo brings it back for a few seconds."),
          <>
            <Button type="button" size="xs" variant="destructive" onClick={p.onDiscard}>
              {t("Discard")}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => p.onAsk(null)}>
              {t("Keep writing")}
            </Button>
          </>,
        )}
      {p.status.state === "failed" &&
        ask(
          t("The draft could not be saved: {message} It is kept in this browser and tried again by itself.", { message: p.status.message }),
          <>
            <Button type="button" size="xs" variant="outline" onClick={p.onRetrySave}>
              {t("Try again now")}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={p.onCloseAnyway}>
              {t("Close anyway")}
            </Button>
          </>,
        )}
    </>
  );
}

/** A date and time for Schedule send, on the person's clock. */
function ScheduleRow({ onPick, onCancel }: { onPick: (at: Date) => void; onCancel: () => void }) {
  const [value, setValue] = useState(() => toZonedInput(new Date(Date.now() + 3_600_000).toISOString()));
  const iso = fromZonedInput(value);
  const at = iso ? new Date(iso) : null;
  const late = !!at && at.getTime() - Date.now() > 30 * 86_400_000;
  const past = !at || at.getTime() <= Date.now() + 60_000;
  return (
    <form
      className="flex flex-wrap items-center gap-2 border-t px-2 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (at && !past && !late) onPick(at);
      }}
    >
      <label htmlFor="mail-schedule" className="text-sm">
        {t("Send at")}
      </label>
      <Input id="mail-schedule" type="datetime-local" className="h-8 w-auto" value={value} onChange={(e) => setValue(e.target.value)} autoFocus aria-describedby="mail-schedule-zone" />
      <span id="mail-schedule-zone" className="text-xs text-muted-foreground">
        {isolate(shownTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone)}
      </span>
      <Button type="submit" size="sm" disabled={past || late}>
        {t("Schedule send")}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        {t("Cancel")}
      </Button>
      {(past || late) && <p className="basis-full text-xs text-destructive">{late ? t("The mail server holds a message for at most 30 days.") : t("Pick a time in the future.")}</p>}
    </form>
  );
}

// ───────────────────────────── templates ─────────────────────────────

/** The person's templates: the messages in their Templates folder, by subject. */
export function useTemplates(account: string, boxes: Mailbox[]) {
  const box = boxes.find((b) => !b.role && b.name === TEMPLATES && !b.parentId);
  return useQuery({
    queryKey: ["mail", "templates", account, box?.id],
    enabled: !!box,
    queryFn: async () => {
      const r = await jmap([
        ["Email/query", { accountId: account, filter: { inMailbox: box!.id }, sort: [{ property: "subject", isAscending: true }], limit: 100 }, "q"],
        ["Email/get", { accountId: account, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["subject", "preview"] }, "g"],
      ]);
      return r.g.list as { id: string; subject: string | null; preview: string }[];
    },
  });
}

/** The Templates folder, made when it is first needed. */
async function templatesBox(account: string, boxes: Mailbox[]): Promise<string> {
  const have = boxes.find((b) => !b.role && b.name === TEMPLATES && !b.parentId);
  if (have) return have.id;
  const r = await jmap([["Mailbox/set", { accountId: account, create: { t: { name: TEMPLATES, parentId: null } } }, "0"]]);
  const made = (r["0"].created as Record<string, { id: string }> | undefined)?.t;
  if (!made) throw new Error(refusal((r["0"].notCreated as Record<string, { type?: string }> | undefined)?.t, t("The Templates folder could not be made.")));
  return made.id;
}

// ───────────────────────────── windows open in this tab ─────────────────────────────

const OPEN = "ferrum.mail.open.";
const openList = (account: string): { key: string; id: string | null }[] => {
  try {
    return JSON.parse(sessionStorage.getItem(OPEN + account) ?? "[]");
  } catch {
    return [];
  }
};
const getters = new Map<string, { account: string; id: () => string | null }>();
function rememberOpen(account: string, key: string, id: () => string | null) {
  getters.set(key, { account, id });
  writeOpen(account);
}
function forgetOpen(account: string, key: string) {
  getters.delete(key);
  writeOpen(account);
}
function writeOpen(account: string) {
  try {
    const list = [...getters].filter(([, g]) => g.account === account).map(([key, g]) => ({ key, id: g.id() }));
    sessionStorage.setItem(OPEN + account, JSON.stringify(list));
  } catch {
    // not remembered: the draft is still in Drafts
  }
}
// The draft ids change as it is saved: the list is written again as the page goes.
if (typeof window !== "undefined") window.addEventListener("pagehide", () => new Set([...getters.values()].map((g) => g.account)).forEach(writeOpen));

/** The windows that were open in this tab before it was reloaded. */
export const openBefore = (account: string) => openList(account);
