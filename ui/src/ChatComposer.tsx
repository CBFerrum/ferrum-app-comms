// Writing in Chat: the box under a conversation or a thread. What is typed is kept in this
// browser until it is sent, so changing conversation or closing the tab loses nothing; typing @
// offers the people to mention; a message that cannot be sent says so, and stays.

import { useQueryClient } from "@tanstack/react-query";
import { AtSign, Paperclip, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button, Input, Textarea } from "@ferrum/kit/primitives";
import { cn, toast } from "@ferrum/kit";
import { errorMessage, newKey, uploadFile, type StoredFile, api } from "@ferrum/client";
import { useMe } from "@ferrum/records";
import { CHAT, MAX_FILES, bodyTooLong, completeMention, draftKey, fileSize, matchPeople, mentionAt, mentionsIn, readDraft, writeDraft, type Person } from "./lib/chat";

/** A file picked for the next message: uploading, uploaded (`stored`) or refused (`error`). */
interface Pending {
  key: string;
  name: string;
  size: number;
  stored?: StoredFile;
  error?: string;
}

export function Composer({
  channel,
  parent,
  people,
  placeholder,
  autoFocus,
  onSent,
}: {
  channel: string;
  parent?: string;
  people: Person[];
  placeholder: string;
  autoFocus?: boolean;
  onSent?: () => void;
}) {
  const qc = useQueryClient();
  const me = useMe().data?.user.email;
  const key = draftKey(channel, parent);
  const [body, setBody] = useState(() => readDraft(key));
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [files, setFiles] = useState<Pending[]>([]);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const list = useId();
  const tooLong = bodyTooLong(body);
  const uploading = files.some((f) => !f.stored && !f.error);
  const ready = files.filter((f) => f.stored);

  // The draft is kept a moment after the last key, and again when leaving.
  useEffect(() => {
    const t = setTimeout(() => writeDraft(key, body), 250);
    return () => clearTimeout(t);
  }, [key, body]);
  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus]);

  const at = mentionAt(body, caret);
  const choices = at ? matchPeople(people, at.query, me) : [];
  const open = choices.length > 0 && !closed;
  const active = Math.min(pick, Math.max(choices.length - 1, 0));

  const addFiles = (picked: FileList | File[] | null) => {
    const wanted = Array.from(picked ?? []);
    const room = Math.max(0, MAX_FILES - files.length);
    if (wanted.length > room) toast(`A message carries at most ${MAX_FILES} files.`, "error");
    for (const file of wanted.slice(0, room)) {
      const k = newKey();
      setFiles((fs) => [...fs, { key: k, name: file.name, size: file.size }]);
      uploadFile(file).then(
        (stored) => setFiles((fs) => fs.map((f) => (f.key === k ? { ...f, stored } : f))),
        (e: unknown) => setFiles((fs) => fs.map((f) => (f.key === k ? { ...f, error: errorMessage(e) } : f))),
      );
    }
  };

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = body.trim();
    if ((!text && !ready.length) || tooLong || busy || uploading) return;
    setBusy(true);
    setFailed(null);
    try {
      await api.post(`${CHAT}/channels/${channel}/messages`, { body: text, parent, mentions: mentionsIn(text), attachments: ready.map((f) => ({ id: f.stored!.id })) });
      setBody("");
      setFiles([]);
      writeDraft(key, "");
      void qc.invalidateQueries({ queryKey: ["chat"] });
      onSent?.();
    } catch (err) {
      // The words stay where they are; the person is told why they did not go.
      setFailed(errorMessage(err));
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  };

  const choose = (p: Person) => {
    const done = completeMention(body, caret, p);
    setBody(done.text);
    setCaret(done.caret);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(done.caret, done.caret);
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPick((active + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(choices[active]!);
        return;
      }
      if (e.key === "Escape") {
        // Closes the list only; typing on opens it again.
        e.preventDefault();
        setClosed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const startMention = () => {
    const el = box.current;
    const pos = el?.selectionStart ?? body.length;
    const lead = pos > 0 && !/\s/.test(body[pos - 1]!) ? " " : "";
    const next = `${body.slice(0, pos)}${lead}@${body.slice(pos)}`;
    setBody(next);
    const to = pos + lead.length + 1;
    setCaret(to);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(to, to);
    });
  };

  return (
    <form
      onSubmit={send}
      className="relative grid gap-1.5"
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Files to send">
          {files.map((f) => (
            <li key={f.key} className={cn("flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs", f.error && "border-destructive text-destructive")}>
              <Paperclip className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{f.name}</span>
              <span className="shrink-0 text-muted-foreground">{f.error ? f.error : f.stored ? fileSize(f.size) : "Uploading…"}</span>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${f.name}`} onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}>
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <ul id={list} role="listbox" aria-label="People to mention" className="absolute right-0 bottom-full left-0 z-20 mb-1 max-h-56 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
          {choices.map((p, i) => (
            <li key={p.id} id={`${list}-${i}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                tabIndex={-1}
                // Pressing must not take focus off the box, or the caret is lost before the click lands.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(p)}
                className={cn("flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm pointer-coarse:min-h-11", i === active ? "bg-accent" : "hover:bg-accent")}
              >
                <span className="font-medium">{p.full_name || p.email}</span>
                <span className="truncate text-xs text-muted-foreground">{p.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          ref={box}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setCaret(e.target.selectionStart);
            setPick(0);
            setClosed(false);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKey}
          onPaste={(e) => {
            if (!e.clipboardData.files.length) return;
            e.preventDefault();
            addFiles(e.clipboardData.files);
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-invalid={tooLong || !!failed || undefined}
          aria-autocomplete="list"
          aria-controls={open ? list : undefined}
          aria-activedescendant={open ? `${list}-${active}` : undefined}
          rows={1}
          className="max-h-40 min-h-10 flex-1 resize-none"
        />
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <Button type="button" variant="outline" size="icon" aria-label="Attach files" onClick={() => picker.current?.click()}>
          <Paperclip />
        </Button>
        <Button type="button" variant="outline" size="icon" aria-label="Mention someone" onClick={startMention}>
          <AtSign />
        </Button>
        <Button type="submit" disabled={busy || uploading || (!body.trim() && !ready.length) || tooLong}>
          {busy ? "Sending…" : "Send"}
        </Button>
      </div>
      {tooLong && <p className="text-xs text-destructive">Messages are at most 4 KB.</p>}
      {failed && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive-soft px-2 py-1.5 text-xs text-destructive">
          Not sent: {failed}. Your message is still here; press Send to try again.
        </p>
      )}
      <p className="hidden text-xs text-muted-foreground sm:block">Enter sends, Shift+Enter starts a new line. Type @ to mention someone. **bold**, *italic*, `code` and links work.</p>
    </form>
  );
}

/** A box to find a person and pick them (a new direct message). */
export function PeoplePicker({ people, onPick, onClose }: { people: Person[]; onPick: (p: Person) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const shown = matchPeople(people, q, undefined, 8);
  return (
    <div className="rounded-md border bg-popover p-2 shadow-md">
      <div className="flex items-center gap-2">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person" aria-label="Find a person" onKeyDown={(e) => e.key === "Escape" && onClose()} />
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      <ul className="mt-1 grid">
        {shown.map((p) => (
          <li key={p.id}>
            <button type="button" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent pointer-coarse:min-h-11" onClick={() => onPick(p)}>
              {p.full_name || p.email} <span className="text-muted-foreground">{p.email}</span>
            </button>
          </li>
        ))}
        {!shown.length && <li className="px-2 py-1.5 text-sm text-muted-foreground">Nobody matches.</li>}
      </ul>
    </div>
  );
}
