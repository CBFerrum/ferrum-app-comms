// Writing a message. What is written is saved as a draft in the mailbox a moment after the last
// key, and kept in this browser until the mail server has it, so closing the window, a crash or a
// refused save loses nothing; closing keeps the draft, Discard deletes it. A message that cannot be
// sent says why, stays here, and is in Drafts, never half-sent.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Paperclip, Send, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Textarea } from "@ferrum/kit/primitives";
import { Alert, cn, toast, useCanIntent } from "@ferrum/kit";
import { errorMessage, fetchBlob, newKey, request, shell } from "@ferrum/client";
import { formatDateTime, t, isolate } from "@ferrum/client";
import { usePeople } from "@ferrum/records";
import {
  MAIL,
  addressChoices,
  byRole,
  completeAddress,
  draftEmail,
  dropDraft,
  formatAddresses,
  hasContent,
  jmap,
  keepDraft,
  parseAddresses,
  quote,
  refusal,
  replyRecipients,
  replySubject,
  sizeLabel,
  threadingFor,
  type Draft,
  type Fields,
  type Mailbox,
  type Threading,
  type Upload,
} from "./lib/mail";
import type { Person } from "./lib/chat";

interface Identity {
  id: string;
  name: string;
  email: string;
}

/** How long after the last key a draft is saved to the mailbox. */
const SAVE_AFTER = 2500;

type Saved = { state: "idle" } | { state: "saving" } | { state: "saved"; at: Date } | { state: "failed"; message: string };

/** The mail server's refusal, in words for the person (as opposed to not having reached it). */
class Refused extends Error {}

export function Compose({
  account,
  me,
  boxes,
  draft,
  onClose,
  onSent,
}: {
  account: string;
  me: string;
  boxes: Mailbox[];
  draft: Draft;
  onClose: () => void;
  onSent?: () => void;
}) {
  const qc = useQueryClient();
  const original = draft.original;
  const saved = draft.saved;
  const start = useMemo(() => {
    if (!original) return { to: draft.prefill?.to ?? "", cc: draft.prefill?.cc ?? "", subject: draft.prefill?.subject ?? "", body: draft.prefill?.body ?? "" };
    const when = formatDateTime(original.receivedAt);
    if (draft.kind === "forward") return { to: "", cc: "", subject: replySubject(original.subject, "forward"), body: quote(original, "forward", when) };
    const r = replyRecipients(original, me, draft.kind === "replyAll");
    return { to: formatAddresses(r.to), cc: formatAddresses(r.cc), subject: replySubject(original.subject, "reply"), body: quote(original, "reply", when) };
  }, [original, draft.kind, draft.prefill, me]);
  const [to, setTo] = useState(start.to);
  const [cc, setCc] = useState(start.cc);
  const [bcc, setBcc] = useState("");
  const [more, setMore] = useState(!!start.cc);
  const [subject, setSubject] = useState(start.subject);
  const [body, setBody] = useState(start.body);
  const [files, setFiles] = useState<Upload[]>(
    saved?.files ?? (draft.kind === "forward" && original ? original.attachments.map((a) => ({ blobId: a.blobId, name: a.name ?? "attachment", type: a.type, size: a.size })) : []),
  );
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<Saved>({ state: "idle" });
  // A question to the person, asked in the window itself (a second dialog over this one would fight it for focus).
  const [asking, setAsking] = useState<"subject" | "discard" | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const people = usePeople().data?.users ?? [];
  const identities = useQuery({
    queryKey: ["mail", "identities", account],
    queryFn: async () => (await jmap([["Identity/get", { accountId: account }, "0"]]))["0"].list as Identity[],
    staleTime: 10 * 60_000,
  });
  const [fromId, setFromId] = useState<string | null>(null);
  const identity = identities.data?.find((i) => i.id === fromId) ?? identities.data?.find((i) => i.email.toLowerCase() === me.toLowerCase()) ?? identities.data?.[0];
  const drafts = byRole(boxes, "drafts");
  const sent = byRole(boxes, "sent");

  const parsed = { to: parseAddresses(to), cc: parseAddresses(cc), bcc: parseAddresses(bcc) };
  const bad = [...parsed.to.bad, ...parsed.cc.bad, ...parsed.bcc.bad];
  const fields: Fields = { to: parsed.to.list, cc: parsed.cc.list, bcc: parsed.bcc.list, subject, body, files };
  const threading: Threading = saved
    ? { ...(saved.inReplyTo?.length ? { inReplyTo: saved.inReplyTo } : {}), ...(saved.references?.length ? { references: saved.references } : {}) }
    : threadingFor(original, draft.kind);

  // What the saving and closing code below needs, as it is now rather than when it was set up.
  const latest = useRef({ fields, raw: { to, cc, bcc }, identity, threading, bad: bad.length });
  latest.current = { fields, raw: { to, cc, bcc }, identity, threading, bad: bad.length };
  const key = useRef(saved?.key ?? newKey()).current;
  const draftId = useRef<string | null>(saved?.id ?? null);
  const edits = useRef(0);
  const kept = useRef(0);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // What was written when the window opened, to tell a change from a window opening again.
  const same = useRef([to, cc, bcc, subject, body, files.map((f) => f.blobId).join()].join("\u0000"));

  const changed = () => edits.current !== kept.current;
  const refresh = () => qc.invalidateQueries({ queryKey: ["mail"], predicate: (q) => q.queryKey[1] === "list" || q.queryKey[1] === "mailboxes" });

  // Saves what is written as the draft in the mailbox, replacing the one before it.
  const saveNow = async (): Promise<boolean> => {
    const { fields: f, identity: who, threading: thread } = latest.current;
    const at = edits.current;
    if (!hasContent(f) || at === kept.current) return true;
    if (!who && identities.isLoading) {
      // The mailbox has not said who the person writes as yet: try again in a moment, no alarm.
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), 1500);
      return true;
    }
    if (!who || !drafts) {
      setStatus({ state: "failed", message: drafts ? "The mailbox has no address to write as." : "The mailbox has no Drafts folder." });
      return false;
    }
    setStatus({ state: "saving" });
    try {
      const r = await jmap([["Email/set", { accountId: account, create: { d: draftEmail(f, who, drafts.id, thread) } }, "0"]]);
      const made = (r["0"].created as Record<string, { id: string }> | undefined)?.d;
      if (!made) throw new Refused(refusal((r["0"].notCreated as Record<string, { type?: string; description?: string }> | undefined)?.d, "The mail server did not take the draft."));
      const old = draftId.current;
      draftId.current = made.id;
      kept.current = at;
      // The copy before it goes; if that fails an old copy stays in Drafts, which loses nothing.
      if (old) await jmap([["Email/set", { accountId: account, destroy: [old] }, "0"]]).catch(() => undefined);
      // A draft cannot hold an address that is not one: the browser's copy keeps what was typed.
      if (!latest.current.bad && edits.current === at) dropDraft(account, key);
      setStatus({ state: "saved", at: new Date() });
      void refresh();
      return true;
    } catch (e) {
      setStatus({ state: "failed", message: errorMessage(e) });
      return false;
    }
  };
  const save = () => {
    queue.current = queue.current.then(saveNow);
    return queue.current;
  };

  // Every change is kept in this browser at once, and saved to the mailbox when typing pauses.
  useEffect(() => {
    const now = [to, cc, bcc, subject, body, files.map((f) => f.blobId).join()].join("\u0000");
    if (now === same.current) return;
    same.current = now;
    edits.current += 1;
    if (hasContent(latest.current.fields)) {
      keepDraft({ key, account, savedAt: new Date().toISOString(), ...latest.current.raw, subject, body, files, draftId: draftId.current ?? undefined, inReplyTo: threading.inReplyTo, references: threading.references });
    } else {
      // Everything was taken out again: there is nothing to come back to.
      dropDraft(account, key);
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_AFTER);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the changes themselves are what this reacts to
  }, [to, cc, bcc, subject, body, files]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const attach = async (list: FileList | File[] | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(list)) {
        const up = await request<{ blobId: string; type: string; size: number }>(`${MAIL}/upload/${account}`, { method: "POST", body: f });
        setFiles((x) => [...x, { blobId: up.blobId, name: f.name, type: f.type || up.type || "application/octet-stream", size: up.size ?? f.size }]);
      }
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setUploading(false);
      if (picker.current) picker.current.value = "";
    }
  };
  // Files from this site (Drive's, a printed record) attach as copies, fetched with the person's own rights.
  const attachFrom = async (list: { url: string; name: string }[]) => {
    const own = list.filter((f) => f.url.startsWith("/api/") && !f.url.startsWith("//"));
    try {
      const got = await Promise.all(own.map(async (f) => new File([await fetchBlob(f.url)], f.name)));
      await attach(got);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const fromDrive = useCanIntent("pick", "file");
  const pickFromDrive = async () => {
    const out = await shell()
      .intent<{ files: { url: string; name: string }[] }>({ action: "pick", type: "file", data: { multiple: true, title: t("Attach files from Drive") } })
      .catch((e: unknown) => (toast(errorMessage(e), "error"), null));
    if (out?.status === "done" && out.result?.files?.length) await attachFrom(out.result.files);
  };
  const attached = useRef(false);
  useEffect(() => {
    if (attached.current || !draft.attach?.length) return;
    attached.current = true;
    void attachFrom(draft.attach);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the files the draft came with
  }, []);

  // Closing keeps the draft; if it cannot be kept, the window stays and says so.
  const close = async () => {
    if (busy) return;
    clearTimeout(timer.current);
    if (!hasContent(latest.current.fields) || !changed()) return onClose();
    if (await save()) {
      toast(t("Draft saved"));
      onClose();
    }
  };
  const discard = async (sure = false) => {
    const something = hasContent(fields) || !!draftId.current;
    if (something && !sure) return setAsking("discard");
    setAsking(null);
    clearTimeout(timer.current);
    await queue.current;
    if (draftId.current) {
      try {
        await jmap([["Email/set", { accountId: account, destroy: [draftId.current] }, "0"]]);
        void refresh();
      } catch (e) {
        toast(t("The draft in Drafts could not be deleted: {e}", { e: errorMessage(e) }), "error");
      }
    }
    dropDraft(account, key);
    onClose();
  };

  const send = async (e?: FormEvent, anyway = false) => {
    e?.preventDefault();
    setProblem(null);
    setAsking(null);
    if (bad.length) return setProblem(`Not an email address: ${bad.join(", ")}. Fix it, or take it out, and send again.`);
    if (!fields.to.length && !fields.cc.length && !fields.bcc.length) return setProblem("Add at least one recipient.");
    if (!drafts || !sent || !identity) return setProblem("The mailbox has no Drafts or Sent folder, or no address to send as. Nothing was sent.");
    if (!subject.trim() && !anyway) return setAsking("subject");
    clearTimeout(timer.current);
    await queue.current;
    setBusy(true);
    try {
      const r = await jmap([
        ["Email/set", { accountId: account, create: { m: draftEmail(fields, identity, drafts.id, threading) } }, "0"],
        [
          "EmailSubmission/set",
          {
            accountId: account,
            create: { s: { emailId: "#m", identityId: identity.id } },
            onSuccessUpdateEmail: { "#s": { [`mailboxIds/${drafts.id}`]: null, [`mailboxIds/${sent.id}`]: true, "keywords/$draft": null } },
          },
          "1",
        ],
        ...(original && !saved
          ? [["Email/set", { accountId: account, update: { [original.id]: { [draft.kind === "forward" ? "keywords/$forwarded" : "keywords/$answered"]: true } } }, "2"] as [string, Record<string, unknown>, string]]
          : []),
      ]);
      const made = (r["0"].created as Record<string, { id: string }> | undefined)?.m;
      const refused = (r["0"].notCreated as Record<string, { type?: string; description?: string }> | undefined)?.m ?? (r["1"].notCreated as Record<string, { type?: string; description?: string }> | undefined)?.s;
      if (refused || !made) {
        // The message was taken into Drafts but not sent: it is the draft now, and the window says so.
        if (made) {
          const old = draftId.current;
          draftId.current = made.id;
          kept.current = edits.current;
          if (old) await jmap([["Email/set", { accountId: account, destroy: [old] }, "0"]]).catch(() => undefined);
          void refresh();
        }
        if (made) setStatus({ state: "saved", at: new Date() });
        throw new Refused(`${refusal(refused, "The mail server refused to send it.")}${made ? " The message is saved in Drafts." : ""}`);
      }
      if (draftId.current) await jmap([["Email/set", { accountId: account, destroy: [draftId.current] }, "0"]]).catch(() => undefined);
      dropDraft(account, key);
      toast(t("Sent"));
      void refresh();
      onSent?.();
      onClose();
    } catch (err) {
      // Whatever went wrong, the words are still here, and the reason stays until it is dealt with.
      const why = errorMessage(err);
      setProblem(
        err instanceof Refused || why.startsWith("The mail server refused it")
          ? `Not sent. ${why} Your message is still here.`
          : `Not sent: ${why}. The mail server may not have been reached; look in Sent before sending it again. Your message is still here, and kept in this browser.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const title = { new: t("New message"), reply: t("Reply"), replyAll: t("Reply to all"), forward: t("Forward") }[draft.kind];
  const status_ =
    status.state === "saving"
      ? t("Saving the draft…")
      : status.state === "saved"
        ? t("Draft saved {value}", { value: status.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
        : status.state === "failed"
          ? null
          : "";
  return (
    <Dialog open onOpenChange={(o) => !o && void close()}>
      <DialogContent
        className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl"
        onEscapeKeyDown={(e) => {
          // Escape keeps the draft and closes; with a list of people open, it only closes the list.
          e.preventDefault();
          if (document.activeElement?.getAttribute("aria-expanded") !== "true") void close();
        }}
      >
        <form onSubmit={send} className="grid gap-3">
          <DialogHeader>
            <DialogTitle>{isolate(title)}</DialogTitle>
            <DialogDescription>
              {(identities.data?.length ?? 0) > 1 ? t("Choose who it is from.") : t("From {value}", { value: identity ? (identity.name ? `${identity.name} <${identity.email}>` : identity.email) : me })}
            </DialogDescription>
          </DialogHeader>
          {problem && (
            <Alert tone="error">
              <span>{isolate(problem)}</span>
            </Alert>
          )}
          <fieldset disabled={busy} className="contents">
          {asking === "subject" && (
            <Alert
              tone="warning"
              action={
                <span className="flex shrink-0 gap-1">
                  <Button type="button" size="xs" onClick={() => void send(undefined, true)}>
                    {t("Send anyway")}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setAsking(null);
                      document.getElementById("mail-subject")?.focus();
                    }}
                  >
                    {t("Add a subject")}
                  </Button>
                </span>
              }
            >
              <span>{t("This message has no subject.")}</span>
            </Alert>
          )}
          {asking === "discard" && (
            <Alert
              tone="warning"
              action={
                <span className="flex shrink-0 gap-1">
                  <Button type="button" size="xs" variant="destructive" onClick={() => void discard(true)}>
                    {t("Delete the draft")}
                  </Button>
                  <Button type="button" size="xs" variant="ghost" onClick={() => setAsking(null)}>
                    {t("Keep writing")}
                  </Button>
                </span>
              }
            >
              <span>{t("Delete this draft? What you wrote cannot be brought back.")}</span>
            </Alert>
          )}
          {status.state === "failed" && (
            <Alert
              tone="warning"
              action={
                <span className="flex shrink-0 gap-1">
                  <Button type="button" size="xs" variant="outline" onClick={() => void save()}>
                    {t("Try again")}
                  </Button>
                  <Button type="button" size="xs" variant="ghost" onClick={onClose}>
                    {t("Close anyway")}
                  </Button>
                </span>
              }
            >
              <span>
                {t("The draft could not be saved: {message} It is kept in this browser, so you will be offered it next time you open Mail.", { message: status.message })}
              </span>
            </Alert>
          )}
          {(identities.data?.length ?? 0) > 1 && (
            <div className="grid gap-1.5">
              <Label htmlFor="mail-from">{t("From")}</Label>
              <select id="mail-from" className="h-9 rounded-md border bg-background px-2 text-sm" value={identity?.id ?? ""} onChange={(e) => setFromId(e.target.value)}>
                {identities.data?.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name ? `${i.name} <${i.email}>` : i.email}
                  </option>
                ))}
              </select>
            </div>
          )}
          <RecipientField id="mail-to" label={t("To")} value={to} onChange={setTo} people={people} autoFocus={!to} bad={parsed.to.bad} />
          {more ? (
            <>
              <RecipientField id="mail-cc" label={t("Cc")} value={cc} onChange={setCc} people={people} bad={parsed.cc.bad} />
              <RecipientField id="mail-bcc" label={t("Bcc")} value={bcc} onChange={setBcc} people={people} bad={parsed.bcc.bad} />
            </>
          ) : (
            <Button type="button" variant="link" size="xs" className="justify-self-start p-0" onClick={() => setMore(true)}>
              {t("Cc and Bcc")}
            </Button>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="mail-subject">{t("Subject")}</Label>
            <Input id="mail-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={900} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mail-body">{t("Message")}</Label>
            <Textarea id="mail-body" autoFocus={!!to} rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => picker.current?.click()}>
              <Paperclip aria-hidden="true" /> {uploading ? t("Uploading…") : t("Attach")}
            </Button>
            <input ref={picker} type="file" multiple hidden onChange={(e) => void attach(e.target.files)} />
            {fromDrive && (
              <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => void pickFromDrive()}>
                <FolderOpen aria-hidden="true" /> {t("From Drive")}
              </Button>
            )}
            {files.map((f) => (
              <Badge key={f.blobId} variant="secondary" className="gap-1">
                {isolate(f.name)} <span className="text-muted-foreground">{isolate(sizeLabel(f.size))}</span>
                <button type="button" aria-label={t("Remove {name}", { name: f.name })} onClick={() => setFiles((x) => x.filter((y) => y.blobId !== f.blobId))}>
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
          </fieldset>
          <DialogFooter className="items-center sm:justify-between">
            <span className="text-xs text-muted-foreground sm:me-auto" role="status" aria-live="polite">
              {isolate(status_ ?? "")}
            </span>
            <Button type="button" variant="outline" onClick={() => void discard()} disabled={busy}>
              {t("Discard")}
            </Button>
            <Button type="button" variant="outline" onClick={() => void close()} disabled={busy}>
              {t("Save and close")}
            </Button>
            <Button type="submit" disabled={busy || uploading}>
              <Send aria-hidden="true" /> {busy ? t("Sending…") : t("Send")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** An address list with the workspace's people offered as the beginning of a name or address is typed. */
function RecipientField({
  id,
  label,
  value,
  onChange,
  people,
  bad,
  autoFocus,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  people: Person[];
  bad: string[];
  autoFocus?: boolean;
}) {
  const [caret, setCaret] = useState(value.length);
  const [pick, setPick] = useState(0);
  const [closed, setClosed] = useState(false);
  const [left, setLeft] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const choices = closed ? [] : addressChoices(people, value, caret);
  const active = Math.min(pick, Math.max(choices.length - 1, 0));
  const choose = (p: Person) => {
    const done = completeAddress(value, caret, p);
    onChange(done.text);
    setCaret(done.caret);
    setClosed(false);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(done.caret, done.caret);
    });
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!choices.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setPick((active + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      choose(choices[active]!);
    } else if (e.key === "Escape") {
      // Closes the list, not the window.
      e.preventDefault();
      e.stopPropagation();
      setClosed(true);
    }
  };
  return (
    <div className="relative grid gap-1.5">
      <Label htmlFor={id}>{isolate(label)}</Label>
      <Input
        ref={input}
        id={id}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setPick(0);
          setClosed(false);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKey}
        onBlur={() => setLeft(true)}
        placeholder="name@example.com, …"
        autoComplete="off"
        role="combobox"
        aria-expanded={choices.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-invalid={(left && bad.length > 0) || undefined}
        aria-describedby={left && bad.length ? `${id}-bad` : undefined}
      />
      {choices.length > 0 && (
        <ul id={`${id}-list`} role="listbox" aria-label={t("People for {label}", { label })} className="absolute top-full end-0 start-0 z-20 mt-1 max-h-48 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
          {choices.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(p)}
                className={cn("flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-start text-sm pointer-coarse:min-h-11", i === active ? "bg-accent" : "hover:bg-accent")}
              >
                <span className="font-medium">{p.full_name || p.email}</span>
                <span className="truncate text-xs text-muted-foreground">{isolate(p.email)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {left && bad.length > 0 && (
        <p id={`${id}-bad`} className="text-xs text-destructive">
          {bad.length === 1 ? t("This is not an email address") : t("These are not email addresses")}: {isolate(bad.join(", "))}
        </p>
      )}
    </div>
  );
}
