// Reading mail as conversations: the messages of a thread one under another, the newest and any
// unread ones open and the rest folded to a line. Archive, delete, spam, move and unread act on the
// whole conversation as it stands in the folder it is seen from (through the same `run` as the list,
// so Undo covers them); reply, reply to all and forward answer the message in front of you. What the
// mail server says about a message (failed checks, why it is spam, an invitation) is in MailSafety.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, ChevronRight, FileInput, Forward, Paperclip, Reply, ReplyAll } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Label, Skeleton } from "@ferrum/kit/primitives";
import { can, LinkInput, useMetaIndex } from "@ferrum/records";
import { api, download, errorMessage, formatDateTime, t as tr, isolate } from "@ferrum/client";
import { cn, confirmDialog, ReaderSkeleton, toast } from "@ferrum/kit";
import { Failure } from "./States";
import { useMailActions } from "./MailActions";
import { ExternalMark, ImagesBar, InviteCard, MessageMenu, WarningBanner, WhySpam, useExtras } from "./MailSafety";
import { ActionBar } from "./MailToolbar";
import { offered, type Verb } from "./lib/actions";
import { readBlocked, writeBlocked } from "./lib/blocklist";
import { folderName, isVirtual, virtualFolder } from "./lib/folders";
import { fullDate, listDate, nameAndAddress, recipientsLine } from "./lib/list";
import {
  MAIL,
  addressLabel,
  addressList,
  busyWith,
  byRole,
  expandedIds,
  frameDocument,
  inFolder,
  inTurn,
  jmap,
  keyAction,
  messagesIn,
  sizeLabel,
  type Draft,
  type EmailSummary,
  type Mailbox,
  type Message,
} from "./lib/mail";
import { alwaysShowImagesFrom, isExternal, senderWarning, showsImagesFrom } from "./lib/safety";

const SUMMARY = ["id", "threadId", "mailboxIds", "keywords", "from", "to", "subject", "receivedAt", "preview", "hasAttachment"];

/** A message to read, sanitised by the server (a conversation's cards share this). */
function useMessage(account: string, id: string | undefined, images = false) {
  return useQuery({
    queryKey: ["mail", "message", account, id, images],
    queryFn: ({ signal }) => inTurn(() => api.get<Message>(`${MAIL}/message/${account}/${id}`, images ? { images: 1 } : undefined, signal)),
    enabled: !!id,
  });
}

export function Conversation(p: { account: string; id: string; me: string; boxes: Mailbox[]; folder: string | undefined; domains: string[]; onBack: () => void; onDraft: (d: Draft) => void }) {
  const qc = useQueryClient();
  const actions = useMailActions(p.account, p.boxes);
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
  const [moveOpen, setMoveOpen] = useState(false);
  const role = (r: string) => byRole(p.boxes, r);
  const here = p.boxes.find((b) => b.id === p.folder) ?? virtualFolder(p.folder ?? "");
  const folderRole = here?.role;
  // Which messages open is decided when the conversation does: reading one must not fold it.
  useEffect(() => {
    if (first === null && messages.length) setFirst(expandedIds(messages));
  }, [first, messages]);

  // Folders, lists and messages (a message's view knows its folders: "Not spam" needs Spam).
  const refresh = () => qc.invalidateQueries({ queryKey: ["mail"], predicate: (q) => q.queryKey[1] !== "session" });
  const open = (m: EmailSummary) => (folded[m.id] === undefined ? m.id === newest?.id || (first ?? expandedIds(messages)).includes(m.id) : !folded[m.id]);
  // The messages an action reaches: those in the folder it is seen from (all of them from a search such as Starred).
  const ids = isVirtual(p.folder) ? messages.map((m) => m.id) : inFolder(messages, p.folder, p.id);
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

  /** An action on the conversation; leaving it for the list unless it only marks it. */
  const verb = async (v: Verb, to?: Mailbox) => {
    const ok = await actions.run({ verb: v, ids, count: 1, to, from: folderRole });
    if (ok && v !== "star" && v !== "unstar" && v !== "read") p.onBack();
    return ok;
  };
  const forever = async () => {
    const ok = await confirmDialog({
      title: tr("Delete this conversation for good?"),
      message: tr("{n} messages will be removed from {folder} and cannot be recovered.", { n: ids.length, folder: here ? folderName(here) : "" }),
      confirmLabel: tr("Delete forever"),
      danger: true,
    });
    if (ok && (await actions.destroy(ids))) p.onBack();
  };
  const remove = () => void (offered(folderRole).deleteForever ? forever() : verb("trash"));
  const reply = (kind: "reply" | "replyAll" | "forward") => latest.data && p.onDraft({ kind, original: latest.data });

  // The keys of the list work on the conversation too (not while typing, or in a dialog).
  const keys = useRef<(k: NonNullable<ReturnType<typeof keyAction>>) => void>(() => undefined);
  keys.current = (k) => {
    const o = offered(folderRole);
    if (k === "reply" || k === "replyAll" || k === "forward") reply(k);
    else if (k === "archive" && o.archive) void verb("archive");
    else if (k === "delete") remove();
    else if (k === "spam") void verb(o.notSpam ? "notSpam" : "spam");
    else if (k === "unread") void verb("unread");
    else if (k === "read") void verb("read");
    else if (k === "star") void verb(starred ? "unstar" : "star");
    else if (k === "move") o.move && setMoveOpen(true);
    else if (k === "back") p.onBack();
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const k = keyAction(e);
      if (!k || busyWith(e.target as HTMLElement | null, e.key)) return;
      if (["reply", "replyAll", "forward", "archive", "delete", "spam", "unread", "read", "star", "back", "move"].includes(k)) {
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
  const junkId = role("junk")?.id;
  return (
    <article className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)]" aria-label={subject ?? tr("Conversation")}>
      <header className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
        <Button variant="ghost" size="icon-sm" aria-label={tr("Back to the list")} title={tr("Back to the list (u)")} onClick={p.onBack}>
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
        <ActionBar
          role={folderRole}
          boxes={p.boxes}
          anyUnread={false}
          allStarred={starred}
          folderId={p.folder}
          onVerb={(v) => (v === "trash" ? remove() : void verb(v))}
          onMove={(to) => void verb("move", to)}
          onForever={() => void forever()}
          moveOpen={moveOpen}
          onMoveOpen={setMoveOpen}
        >
          {comms && can(comms.permissions, "create") && latest.data && (
            <Button variant="ghost" size="icon-sm" aria-label={tr("File to a record")} title={tr("File to a record")} onClick={() => setFiling(true)}>
              <FileInput />
            </Button>
          )}
        </ActionBar>
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
          <Card
            key={m.id}
            account={p.account}
            summary={m}
            open={open(m)}
            fill={single}
            onToggle={() => setFolded((f) => ({ ...f, [m.id]: open(m) }))}
            me={p.me}
            domains={p.domains}
            inSpam={!!junkId && !!m.mailboxIds[junkId]}
            junkName={role("junk")?.name ?? "Junk Mail"}
            onVerb={(v) => void verb(v)}
            onDraft={p.onDraft}
          />
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

/** A message's plain text, with web addresses as links (https and http only; never followed from here). */
function PlainText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"')]+)/g);
  return (
    <div className="text-sm leading-relaxed break-words whitespace-pre-wrap">
      {parts.map((s, i) =>
        i % 2 ? (
          <a key={i} href={s} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
            {s}
          </a>
        ) : (
          s
        ),
      )}
    </div>
  );
}

/** One message of the conversation: a line when folded, the whole message when open. */
function Card({ account, summary, open, fill, onToggle, me, domains, inSpam, junkName, onVerb, onDraft }: { account: string; summary: EmailSummary; open: boolean; fill: boolean; onToggle: () => void; me: string; domains: string[]; inSpam: boolean; junkName: string; onVerb: (v: Verb) => void; onDraft: (d: Draft) => void }) {
  const sender = summary.from?.[0];
  const [images, setImages] = useState(() => showsImagesFrom(account, sender?.email));
  const [details, setDetails] = useState(false);
  const msg = useMessage(account, open ? summary.id : undefined, images);
  const extras = useExtras(account, open ? summary.id : undefined).data;
  const m = msg.data;
  const unread = !summary.keywords?.$seen;
  const from = addressLabel(sender);
  const mine = !!summary.from?.some((a) => a.email.toLowerCase() === me.toLowerCase());
  const warning = extras && !mine ? senderWarning(sender, extras.auth, domains) : null;
  const external = !mine && isExternal(sender, domains);
  // The invitation's own part is shown as the card, not as a file.
  const shown = (m?.attachments ?? []).filter((a) => !(extras?.invite && a.type === "text/calendar"));
  const block = async () => {
    if (!sender) return;
    try {
      const st = await readBlocked(account);
      const now = await writeBlocked(account, [...st.blocked, sender.email], junkName);
      toast(
        now.otherActive
          ? tr("{sender} is on your blocked list, but it cannot work while the filter “{name}” is your active one.", { sender: sender.email, name: now.otherActive })
          : tr("Mail from {sender} now goes to Spam. You can unblock it in Mail settings.", { sender: sender.email }),
        now.otherActive ? "info" : "success",
      );
      onVerb("spam");
    } catch (e) {
      toast(tr("Could not block {sender}: {e}", { sender: sender.email, e: errorMessage(e) }), "error");
    }
  };
  return (
    <section className={cn(fill ? "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]" : "border-b")} aria-label={tr("{value} on {value2}", { value: mine ? tr("You") : from, value2: formatDateTime(summary.receivedAt) })}>
      <div>
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-2 px-4 py-2 text-start hover:bg-accent focus-visible:-outline-offset-2 pointer-coarse:min-h-11">
          {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          {unread && <span className="size-2 shrink-0 rounded-full bg-primary" role="img" aria-label={tr("Unread")} />}
          <span className={cn("shrink-0 text-sm", unread ? "font-semibold" : "font-medium")}>{mine ? tr("You") : from || tr("(unknown sender)")}</span>
          {open && !mine && sender?.name && <span className="min-w-0 truncate text-xs text-muted-foreground">&lt;{isolate(sender.email)}&gt;</span>}
          {open && external && <ExternalMark />}
          {!open && <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{isolate(summary.preview)}</span>}
          {open && <span className="flex-1" />}
          {summary.hasAttachment && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label={tr("Has attachments")} />}
          <time className="shrink-0 text-xs text-muted-foreground" dateTime={summary.receivedAt} title={fullDate(summary.receivedAt)}>
            {isolate(open ? formatDateTime(summary.receivedAt) : listDate(summary.receivedAt))}
          </time>
        </button>
        {open && (
          <div className="grid gap-2 px-4 pb-2 ps-10">
            {m ? (
              <>
                <div className="grid gap-1 text-xs text-muted-foreground">
                  <button type="button" className="flex w-fit items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-2" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
                    <span>{isolate(recipientsLine(m.to, m.cc, me))}</span>
                    <ChevronDown className={cn("size-3.5 transition-transform", details && "rotate-180")} aria-hidden="true" />
                    <span className="sr-only">{tr("Show who it went to and when")}</span>
                  </button>
                  {details && (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md border bg-muted px-3 py-2">
                      <dt>{tr("From")}</dt>
                      <dd className="break-words">{isolate(nameAndAddress(m.from?.[0]) || "—")}</dd>
                      <dt>{tr("To")}</dt>
                      <dd className="break-words">{isolate(addressList(m.to) || "—")}</dd>
                      {!!m.cc?.length && (
                        <>
                          <dt>{tr("Cc")}</dt>
                          <dd className="break-words">{isolate(addressList(m.cc))}</dd>
                        </>
                      )}
                      <dt>{tr("Date")}</dt>
                      <dd>{isolate(formatDateTime(m.sentAt ?? m.receivedAt))}</dd>
                    </dl>
                  )}
                </div>
                {warning && <WarningBanner warning={warning} />}
                {inSpam && extras && <WhySpam extras={extras} />}
                {extras?.invite && <InviteCard invite={extras.invite} cancelled={extras.invite.method === "CANCEL"} />}
                <div className="flex flex-wrap items-center gap-1">
                  <Button variant="outline" size="xs" onClick={() => onDraft({ kind: "reply", original: m })}>
                    <Reply aria-hidden="true" /> {tr("Reply")}
                  </Button>
                  <Button variant="outline" size="xs" onClick={() => onDraft({ kind: "replyAll", original: m })}>
                    <ReplyAll aria-hidden="true" /> {tr("Reply all")}
                  </Button>
                  <Button variant="outline" size="xs" onClick={() => onDraft({ kind: "forward", original: m })}>
                    <Forward aria-hidden="true" /> {tr("Forward")}
                  </Button>
                  {!mine && (
                    <MessageMenu
                      from={sender}
                      unsubscribe={extras?.unsubscribe ?? null}
                      onBlock={() => void block()}
                      onPhishing={() => onVerb("phishing")}
                      onUnsubscribeMail={() => extras?.unsubscribe?.mail && onDraft({ kind: "new", prefill: { to: extras.unsubscribe.mail.to, subject: extras.unsubscribe.mail.subject, body: "" } })}
                    />
                  )}
                </div>
                {m.remote_images > 0 && !images && (
                  <ImagesBar
                    count={m.remote_images}
                    sender={sender?.email ?? from}
                    onShow={() => setImages(true)}
                    onAlways={() => {
                      if (sender) alwaysShowImagesFrom(account, sender.email);
                      setImages(true);
                    }}
                  />
                )}
                {shown.length > 0 && (
                  <ul className="flex flex-wrap gap-2 pt-1" aria-label={tr("Attachments")}>
                    {shown.map((a) => (
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
          extras?.plain ? (
            // Plain text is drawn on the theme's own surface, as text: no sheet, no frame.
            <div className={cn("overflow-y-auto px-4 py-3 ps-10", fill && "h-full min-h-0")}>
              <PlainText text={m.text || m.html.replace(/<[^>]+>/g, "")} />
            </div>
          ) : (
            // Mail written as a page keeps a light sheet (its authors drew it for white), set in the theme with a margin and rounded corners so it reads as a document.
            <div className={cn("bg-muted p-3", fill && "h-full min-h-0")}>
              <iframe
                title={tr("Message from {from}", { from })}
                sandbox="allow-popups allow-popups-to-escape-sandbox"
                referrerPolicy="no-referrer"
                className={cn("w-full rounded-lg border bg-white", fill ? "h-full" : "h-[26rem] max-h-[70dvh]")}
                srcDoc={frameDocument(m.html || "<p>(This message has no text.)</p>", images)}
              />
            </div>
          )
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
