// Writing mail, what Mail needs before anyone writes: the stack of windows (each a `Composer`, whose code, MailComposer.tsx,
// and the editor's arrive when the first one opens), a draft loaded to go on with, the person's identities and signatures,
// templates, holding a sent message back, and which windows were open in this tab before a reload.

import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { Skeleton } from "@ferrum/kit/primitives";
import { cn, preloadRichTextEditor } from "@ferrum/kit";
import { t } from "@ferrum/client";
import { cleanHtml, richOf, TEMPLATES, textToHtml, type RawEmail } from "./lib/compose";
import { MAIL, jmap, refusal, type Address, type Draft, type Mailbox } from "./lib/mail";

export interface Identity {
  id: string;
  name: string;
  email: string;
  htmlSignature?: string | null;
  textSignature?: string | null;
}

export const blobUrl = (account: string) => (blobId: string, name: string, type: string) => `${MAIL}/blob/${account}/${blobId}?${new URLSearchParams({ name, type })}`;

const RAW_PROPS = { properties: ["htmlBody", "attachments", "bodyValues", "subject", "to", "cc", "bcc", "inReplyTo", "references", "keywords"], bodyProperties: ["partId", "blobId", "type", "name", "size", "cid", "disposition"], fetchHTMLBodyValues: true, maxBodyValueBytes: 4_000_000 };

/** A message's body and parts as JMAP gives them, for answering or going on with it. */
export async function rawEmail(account: string, id: string): Promise<RawEmail & { subject?: string; to?: Address[]; cc?: Address[]; bcc?: Address[]; inReplyTo?: string[] | null; references?: string[] | null }> {
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

// ───────────────────────────── the composer, loaded when someone writes ─────────────────────────────

export interface ComposerProps {
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
}


const load = () => import("./MailComposer");
const Lazy = lazy(() => load().then((m) => ({ default: m.Composer })));
/** Fetches the composer's code ahead of need (a pointer over Write or Reply). */
export const preloadComposer = () => void Promise.all([load(), preloadRichTextEditor()]);

/** A message being written (MailComposer.tsx): its code, and the editor's, arrive when the first one opens; a frame of its shape meanwhile. */
export function Composer(p: ComposerProps) {
  const window_ = p.mode === "window";
  return (
    <Suspense
      fallback={
        <div className={cn("pointer-events-auto grid content-start gap-3 bg-popover p-4", window_ ? "h-[min(37.5rem,calc(100dvh-6rem))] w-[min(40rem,calc(100vw-2rem))] rounded-t-xl border border-b-0 shadow-(--shadow)" : "rounded-lg border bg-card")} aria-busy="true" aria-label={t("Opening the message")}>
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-24" />
        </div>
      }
    >
      <Lazy {...p} />
    </Suspense>
  );
}

// ───────────────────────────── the stack of windows ─────────────────────────────

export interface Win {
  id: string;
  draft: Draft;
  state: "open" | "min" | "max";
}

/** A window's size, as the person last left it (dragged by its corner), for every window after. */
const SIZE_KEY = "ferrum.mail.composeSize";
export const DEFAULT_SIZE = { w: 640, h: 600 };
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
export async function templatesBox(account: string, boxes: Mailbox[]): Promise<string> {
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
export function rememberOpen(account: string, key: string, id: () => string | null) {
  getters.set(key, { account, id });
  writeOpen(account);
}
export function forgetOpen(account: string, key: string) {
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
