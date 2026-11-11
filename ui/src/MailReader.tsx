// Reading mail as conversations: the messages of a thread one under another, the newest and any
// unread ones open and the rest folded to a line. Archive, delete, spam and unread act on the
// whole conversation as it stands in the folder it is seen from; reply, reply to all and forward
// answer the message in front of you. j, k, r, a, f, e, # and the other keys work here too.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowLeft, ChevronDown, ChevronRight, Forward, FolderInput, MailOpen, Paperclip, Reply, ReplyAll, ShieldAlert, ShieldCheck, Star, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Label, Skeleton } from "@ferrum/kit/primitives";
import { can, LinkInput, useMetaIndex } from "@ferrum/records";
import { api, download, errorMessage, formatDateTime, relativeTime, t as tr, isolate } from "@ferrum/client";
import { cn, confirmDialog, ReaderSkeleton, toast } from "@ferrum/kit";
import { Failure } from "./States";
import {
  MAIL,
  addressLabel,
  addressList,
  busyWith,
  byRole,
  expandedIds,
  frameDocument,
  inFolder,
  jmap,
  keyAction,
  messagesIn,
  refusal,
  sizeLabel,
  type Draft,
  type EmailSummary,
  type Mailbox,
  type Message,
} from "./lib/mail";

const SUMMARY = ["id", "threadId", "mailboxIds", "keywords", "from", "to", "subject", "receivedAt", "preview", "hasAttachment"];

/** A message to read, sanitised by the server (a conversation's cards share this). */
function useMessage(account: string, id: string | undefined, images = false) {
  return useQuery({
    queryKey: ["mail", "message", account, id, images],
    queryFn: ({ signal }) => api.get<Message>(`${MAIL}/message/${account}/${id}`, images ? { images: 1 } : undefined, signal),
    enabled: !!id,
  });
}

export function Conversation(p: { account: string; id: string; me: string; boxes: Mailbox[]; folder: string | undefined; onBack: () => void; onDraft: (d: Draft) => void }) {
  const qc = useQueryClient();
  const thread = useQuery({
    queryKey: ["mail", "thread", p.account, p.id],
    queryFn: async () => {
      // The conversation of this message, then its messages (two asks, so neither depends on a
      // reference to a list of lists).
      const t = await jmap([
        ["Email/get", { accountId: p.account, ids: [p.id], properties: ["threadId"] }, "e"],
        ["Thread/get", { accountId: p.account, "#ids": { resultOf: "e", name: "Email/get", path: "/list/*/threadId" } }, "t"],
      ]);
      const wanted = ((t.t.list as { emailIds: string[] }[] | undefined)?.[0]?.emailIds ?? []).filter(Boolean);
      if (!wanted.length) return [] as EmailSummary[];
      const r = await jmap([["Email/get", { accountId: p.account, ids: wanted, properties: SUMMARY }, "s"]]);
      return (r.s.list as EmailSummary[]).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    },
  });
  const messages = useMemo(() => thread.data ?? [], [thread.data]);
  const newest = messages[messages.length - 1];
  const latest = useMessage(p.account, newest?.id);
  const comms = useMetaIndex().data?.entities.find((e) => e.name === "Communication");
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [first, setFirst] = useState<string[] | null>(null);
  const [filing, setFiling] = useState(false);
  const role = (r: string) => byRole(p.boxes, r);
  // Which messages open is decided when the conversation does: reading one must not fold it.
  useEffect(() => {
    if (first === null && messages.length) setFirst(expandedIds(messages));
  }, [first, messages]);

  // Folders, lists and messages (a message's view knows its folders: "Not spam" needs Junk).
  const refresh = () => qc.invalidateQueries({ queryKey: ["mail"], predicate: (q) => q.queryKey[1] !== "session" });
  const open = (m: EmailSummary) => (folded[m.id] === undefined ? m.id === newest?.id || (first ?? expandedIds(messages)).includes(m.id) : !folded[m.id]);
  const ids = inFolder(messages, p.folder, p.id);
  const inBox = (r: string) => !!role(r) && messages.some((m) => !!m.mailboxIds[role(r)!.id]);
  const starred = !!newest?.keywords?.$flagged;

  // Opening a message reads it.
  const unread = messages.filter((m) => open(m) && !m.keywords?.$seen).map((m) => m.id);
  const reading = useRef("");
  useEffect(() => {
    const key = unread.join();
    if (!unread.length || reading.current === key) return;
    reading.current = key;
    void jmap([["Email/set", { accountId: p.account, update: Object.fromEntries(unread.map((i) => [i, { "keywords/$seen": true }])) }, "0"]]).then(refresh, () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the set of unread open messages changes
  }, [unread.join(), p.account]);

  const update = async (patch: Record<string, unknown>, done?: string) => {
    try {
      const r = await jmap([["Email/set", { accountId: p.account, update: Object.fromEntries(ids.map((i) => [i, patch])) }, "0"]]);
      const failed = Object.values((r["0"].notUpdated as Record<string, { type?: string; description?: string }> | undefined) ?? {})[0];
      if (failed) throw new Error(refusal(failed, tr("The mail server refused the change.")));
      if (done) toast(done);
      await refresh();
      return true;
    } catch (e) {
      toast(errorMessage(e), "error");
      void refresh();
      return false;
    }
  };
  // The list is shown again at once; the change goes to the mail server meanwhile, and a refusal says so.
  const move = (to: Mailbox | undefined, label: string, keywords: Record<string, boolean | null> = {}) => {
    if (!to) return toast(tr("This mailbox has no such folder."), "error");
    const patch: Record<string, unknown> = { mailboxIds: { [to.id]: true } };
    for (const [k, v] of Object.entries(keywords)) patch[`keywords/${k}`] = v;
    p.onBack();
    void update(patch, label);
  };
  const remove = async () => {
    if (p.folder !== role("trash")?.id) return move(role("trash"), tr("Moved to Trash"));
    if (!(await confirmDialog({ title: tr("Delete this conversation for good?"), message: tr("It cannot be recovered."), confirmLabel: tr("Delete"), danger: true }))) return;
    try {
      await jmap([["Email/set", { accountId: p.account, destroy: ids }, "0"]]);
      toast(tr("Deleted"));
      p.onBack();
      await refresh();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const junk = p.folder === role("junk")?.id;
  const reply = (kind: "reply" | "replyAll" | "forward") => latest.data && p.onDraft({ kind, original: latest.data });
  const star = () => void update({ "keywords/$flagged": starred ? null : true }, starred ? tr("Star removed") : "Starred");
  const unreadAgain = () => void update({ "keywords/$seen": null }, tr("Marked as unread")).then((ok) => ok && p.onBack());
  const spam = () => (junk ? move(role("inbox"), tr("Moved to the inbox"), { $junk: null, $notjunk: true }) : move(role("junk"), tr("Moved to Junk"), { $junk: true, $notjunk: null }));

  // The keys of the list work on the conversation too (not while typing, or in a dialog).
  const keys = useRef<(k: NonNullable<ReturnType<typeof keyAction>>) => void>(() => undefined);
  keys.current = (k) => {
    if (k === "reply" || k === "replyAll" || k === "forward") reply(k);
    else if (k === "archive" && role("archive") && !inBox("archive")) move(role("archive"), "Archived");
    else if (k === "delete") void remove();
    else if (k === "spam") spam();
    else if (k === "unread") unreadAgain();
    else if (k === "star") star();
    else if (k === "back") p.onBack();
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const k = keyAction(e);
      if (!k || busyWith(e.target as HTMLElement | null, e.key)) return;
      if (["reply", "replyAll", "forward", "archive", "delete", "spam", "unread", "star", "back"].includes(k)) {
        e.preventDefault();
        keys.current(k);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  if (thread.error) return <Failure error={thread.error} onRetry={() => void thread.refetch()} />;
  if (!thread.data) return <ReaderSkeleton />;
  if (!newest) return <Failure title={tr("That message is not here any more")} error={new Error(tr("It may have been moved or deleted."))} onRetry={p.onBack} />;
  const subject = latest.data?.subject ?? newest.subject;
  const single = messages.length === 1;
  const draftOpen = !!role("drafts") && !!newest.mailboxIds[role("drafts")!.id];
  return (
    <article className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)]" aria-label={subject ?? tr("Conversation")}>
      <header className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
        <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label={tr("Back to messages")} onClick={p.onBack}>
          <ArrowLeft />
        </Button>
        <Button variant="ghost" size="sm" disabled={!latest.data} onClick={() => reply("reply")} title={tr("Reply (r)")}>
          <Reply aria-hidden="true" /> {tr("Reply")}
        </Button>
        <Button variant="ghost" size="sm" disabled={!latest.data} onClick={() => reply("replyAll")} title={tr("Reply to all (a)")}>
          <ReplyAll aria-hidden="true" /> {tr("Reply all")}
        </Button>
        <Button variant="ghost" size="sm" disabled={!latest.data} onClick={() => reply("forward")} title={tr("Forward (f)")}>
          <Forward aria-hidden="true" /> {tr("Forward")}
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" size="icon-sm" aria-label={starred ? tr("Remove the star") : tr("Star")} aria-pressed={starred} title={tr("Star (s)")} onClick={star}>
          <Star className={cn(starred && "fill-warning text-warning")} />
        </Button>
        {role("archive") && !inBox("archive") && (
          <Button variant="ghost" size="icon-sm" aria-label={tr("Archive")} title={tr("Archive (e)")} onClick={() => move(role("archive"), "Archived")}>
            <Archive />
          </Button>
        )}
        {junk ? (
          <Button variant="ghost" size="sm" title={tr("Not spam: back to the inbox, and the filter learns")} onClick={spam}>
            <ShieldCheck aria-hidden="true" /> {tr("Not spam")}
          </Button>
        ) : (
          <Button variant="ghost" size="icon-sm" aria-label={tr("Spam")} title={tr("Spam (!): to Junk, and the filter learns")} onClick={spam}>
            <ShieldAlert />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label={tr("Mark as unread")} title={tr("Mark as unread (Shift+U)")} onClick={unreadAgain}>
          <MailOpen />
        </Button>
        {comms && can(comms.permissions, "create") && latest.data && (
          <Button variant="ghost" size="icon-sm" aria-label={tr("File to a record")} title={tr("File to a record")} onClick={() => setFiling(true)}>
            <FolderInput />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label={p.folder === role("trash")?.id ? tr("Delete for good") : tr("Delete")} title={tr("Delete (#)")} onClick={() => void remove()}>
          <Trash2 />
        </Button>
      </header>
      <div className="border-b px-4 py-2">
        <h2 className="text-lg font-semibold break-words">{subject || tr("(no subject)")}</h2>
        {!single && <p className="text-xs text-muted-foreground">{isolate(messagesIn(messages.length))} {tr("in this conversation")}</p>}
        {draftOpen && latest.data && (
          <Button size="sm" variant="outline" className="mt-1" onClick={() => p.onDraft(asDraft(latest.data!, newest.id))}>
            {tr("Continue writing this draft")}
          </Button>
        )}
      </div>
      <div className={cn("min-h-0", single ? "grid grid-rows-[minmax(0,1fr)]" : "overflow-y-auto")}>
        {messages.map((m) => (
          <Card key={m.id} account={p.account} summary={m} open={open(m)} fill={single} onToggle={() => setFolded((f) => ({ ...f, [m.id]: open(m) }))} me={p.me} onDraft={p.onDraft} />
        ))}
      </div>
      {filing && latest.data && <FileDialog account={p.account} email={latest.data} onClose={() => setFiling(false)} />}
    </article>
  );
}

/** A message that sits in Drafts, as a message to go on writing. */
export function asDraft(m: Message, id: string): Draft {
  return {
    kind: "new",
    prefill: { to: addressText(m.to), cc: addressText(m.cc), subject: m.subject ?? "", body: m.text },
    saved: {
      id,
      files: m.attachments.map((a) => ({ blobId: a.blobId, name: a.name ?? "attachment", type: a.type, size: a.size })),
      inReplyTo: m.inReplyTo,
      references: m.references,
    },
  };
}

const addressText = (list: Message["to"]) => (list ?? []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");

/** One message of the conversation: a line when folded, the whole message when open. */
function Card({ account, summary, open, fill, onToggle, me, onDraft }: { account: string; summary: EmailSummary; open: boolean; fill: boolean; onToggle: () => void; me: string; onDraft: (d: Draft) => void }) {
  const [images, setImages] = useState(false);
  const msg = useMessage(account, open ? summary.id : undefined, images);
  const m = msg.data;
  const unread = !summary.keywords?.$seen;
  const from = addressLabel(summary.from?.[0]);
  const mine = !!summary.from?.some((a) => a.email.toLowerCase() === me.toLowerCase());
  return (
    <section className={cn(fill ? "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]" : "border-b")} aria-label={tr("{value} on {value2}", { value: mine ? tr("You") : from, value2: formatDateTime(summary.receivedAt) })}>
      <div>
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-2 px-4 py-2 text-start hover:bg-accent focus-visible:-outline-offset-2 pointer-coarse:min-h-11">
          {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          {unread && <span className="size-2 shrink-0 rounded-full bg-primary" role="img" aria-label={tr("Unread")} />}
          <span className={cn("shrink-0 text-sm", unread ? "font-semibold" : "font-medium")}>{mine ? tr("You") : from || tr("(unknown sender)")}</span>
          {!open && <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{isolate(summary.preview)}</span>}
          {open && <span className="flex-1" />}
          {summary.hasAttachment && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label={tr("Has attachments")} />}
          <time className="shrink-0 text-xs text-muted-foreground" dateTime={summary.receivedAt} title={formatDateTime(summary.receivedAt)}>
            {isolate(relativeTime(summary.receivedAt))}
          </time>
        </button>
        {open && (
          <div className="grid gap-1 px-4 pb-2 ps-10">
            {m ? (
              <>
                <p className="text-sm">
                  {m.from?.[0]?.name && <span className="text-muted-foreground">&lt;{isolate(m.from[0].email)}&gt; </span>}
                  <span className="text-xs text-muted-foreground">
                    {tr("To")} {addressList(m.to) || "—"}
                    {m.cc?.length ? tr(" · Cc {value}", { value: addressList(m.cc) }) : ""} · {isolate(formatDateTime(m.receivedAt))}
                  </span>
                </p>
                <div className="flex flex-wrap gap-1">
                  <Button variant="outline" size="xs" onClick={() => onDraft({ kind: "reply", original: m })}>
                    <Reply aria-hidden="true" /> {tr("Reply")}
                  </Button>
                  <Button variant="outline" size="xs" onClick={() => onDraft({ kind: "replyAll", original: m })}>
                    <ReplyAll aria-hidden="true" /> {tr("Reply all")}
                  </Button>
                  <Button variant="outline" size="xs" onClick={() => onDraft({ kind: "forward", original: m })}>
                    <Forward aria-hidden="true" /> {tr("Forward")}
                  </Button>
                </div>
                {m.remote_images > 0 && !images && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    {(m.remote_images === 1 ? tr("1 remote image is hidden to protect your privacy.") : tr("{remote_images} remote images are hidden to protect your privacy.", { remote_images: m.remote_images }))}
                    <Button variant="link" size="xs" className="h-auto p-0" onClick={() => setImages(true)}>
                      {tr("Show images")}
                    </Button>
                  </p>
                )}
                {m.attachments.length > 0 && (
                  <ul className="flex flex-wrap gap-2 pt-1" aria-label={tr("Attachments")}>
                    {m.attachments.map((a) => (
                      <li key={a.blobId}>
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() =>
                            void download(`${MAIL}/blob/${account}/${a.blobId}`, a.name ?? "attachment", { name: a.name ?? "attachment", type: a.type }).catch((e: unknown) =>
                              toast(errorMessage(e), "error"),
                            )
                          }
                        >
                          <Paperclip aria-hidden="true" /> {a.name ?? tr("attachment")} <span className="text-muted-foreground">{isolate(sizeLabel(a.size))}</span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : msg.error ? (
              <p role="alert" className="text-sm text-destructive">
                {tr("This message could not be loaded:")} {isolate(errorMessage(msg.error))}{isolate(" ")}
                <Button variant="link" size="xs" className="h-auto p-0" onClick={() => void msg.refetch()}>
                  {tr("Try again")}
                </Button>
              </p>
            ) : (
              <Skeleton className="h-8" />
            )}
          </div>
        )}
      </div>
      {open &&
        (m ? (
          <iframe
            title={tr("Message from {from}", { from })}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            className={cn("w-full border-0 bg-white", fill ? "h-full" : "h-[26rem] max-h-[70dvh]")}
            srcDoc={frameDocument(m.html || "<p>(This message has no text.)</p>", images)}
          />
        ) : (
          <div className={fill ? "h-full" : "h-24"} />
        ))}
    </section>
  );
}

export function FileDialog({ account, email, onClose }: { account: string; email: Message; onClose: () => void }) {
  const entities = useMetaIndex().data?.entities.filter((e) => can(e.permissions, "read") && e.kind !== "child" && e.name !== "Communication") ?? [];
  const [entity, setEntity] = useState("");
  const [record, setRecord] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!entity || !record) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.post(`${MAIL}/file`, { account, email: email.id, entity, record });
      toast(tr("Filed: the record's timeline shows it."));
      onClose();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{tr("File to a record")}</DialogTitle>
            <DialogDescription>
              "{email.subject || tr("(no subject)")}{tr("\" goes onto the record's timeline with its attachments, for everyone who can see the record.")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="file-entity">{tr("Kind of record")}</Label>
            <select
              id="file-entity"
              className="h-(--control-h) rounded-md border border-input bg-card px-2 text-sm"
              value={entity}
              onChange={(e) => {
                setEntity(e.target.value);
                setRecord(null);
              }}
            >
              <option value="">{tr("Choose…")}</option>
              {entities.map((e) => (
                <option key={e.name} value={e.name}>
                  {isolate(e.label)}
                </option>
              ))}
            </select>
          </div>
          {entity && (
            <div className="grid gap-1.5">
              <Label htmlFor="file-record">{tr("Record")}</Label>
              <LinkInput key={entity} id="file-record" to={entity} value={record} onChange={(id) => setRecord(id)} />
            </div>
          )}
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {tr("Not filed: {problem}", { problem })}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {tr("Cancel")}
            </Button>
            <Button type="submit" disabled={!entity || !record || busy}>
              {tr("File")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
