// Finding a message: inside one conversation (a panel beside it) or across all of them (a
// dialog). A result opens its conversation at that message.

import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Skeleton } from "@ferrum/kit/primitives";
import { ErrorState, useDebounced } from "@ferrum/kit";
import { api, relativeTime, t } from "@ferrum/client";
import { usePeople } from "@ferrum/records";
import { CHAT, showMentions, snippet, type Message } from "./lib/chat";

/** At least this many characters are searched for (the server asks for two). */
const LEAST = 2;

function Hit({ m, term, people }: { m: Message; term: string; people: Parameters<typeof showMentions>[1] }) {
  const s = snippet(showMentions(m.body, people), term);
  return (
    <>
      <span className="font-medium">{m.sender_name || m.sender}</span> <span className="text-xs text-muted-foreground">{relativeTime(m.posted_at)}</span>
      {m.parent && <span className="ms-1 text-xs text-muted-foreground">{t("in a thread")}</span>}
      <span className="mt-0.5 line-clamp-2 block text-muted-foreground">
        {s.before}
        {s.hit && <mark className="rounded-sm bg-warning-soft px-0.5 text-foreground">{s.hit}</mark>}
        {s.after}
      </span>
    </>
  );
}

/** Search inside one conversation, beside it. */
export function ChannelSearch({ channel, onPick, onClose }: { channel: string; onPick: (m: Message) => void; onClose: () => void }) {
  const people = usePeople().data?.users ?? [];
  const [typed, setTyped] = useState("");
  const term = useDebounced(typed.trim(), 300);
  const ready = term.length >= LEAST;
  const results = useQuery({
    queryKey: ["chat", "search", channel, term],
    queryFn: ({ signal }) => api.get<{ messages: Message[] }>(`${CHAT}/search`, { q: term, channel, limit: 50 }, signal),
    enabled: ready,
  });
  return (
    <aside
      className="fixed inset-y-0 end-0 z-40 grid w-full grid-rows-[auto_auto_minmax(0,1fr)] border-s bg-background shadow-xl sm:w-[420px] xl:static xl:z-auto xl:row-span-2 xl:row-start-2 xl:w-[360px] xl:shadow-none"
      aria-label={t("Search this conversation")}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h3 className="flex-1 font-semibold">{t("Search this conversation")}</h3>
        <Button variant="ghost" size="icon-sm" aria-label={t("Close search")} onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="relative border-b p-2">
        <Search className="pointer-events-none absolute top-4.5 start-4 size-4 text-muted-foreground" aria-hidden="true" />
        <Input autoFocus className="ps-8" type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t("Words in a message")} aria-label={t("Search this conversation")} />
      </div>
      <ul className="min-h-0 overflow-y-auto p-2" aria-live="polite" aria-busy={results.isFetching}>
        {!ready && <li className="px-1 py-4 text-sm text-muted-foreground">{t("Type at least {LEAST} letters. Messages in this conversation that contain them are listed here, newest first.", { LEAST })}</li>}
        {ready && results.isFetching && !results.data && <Skeleton className="h-16" />}
        {results.error && (
          <li>
            <ErrorState error={results.error} onRetry={() => void results.refetch()} />
          </li>
        )}
        {results.data?.messages.map((m) => (
          <li key={m.id} className="mb-2">
            <button type="button" onClick={() => onPick(m)} className="block w-full rounded-md border p-2 text-start text-sm hover:bg-accent pointer-coarse:min-h-11">
              <Hit m={m} term={term} people={people} />
            </button>
          </li>
        ))}
        {results.data && !results.data.messages.length && <li className="px-1 py-4 text-sm text-muted-foreground">{t("No message here contains “{term}”.", { term })}</li>}
      </ul>
    </aside>
  );
}

/** Search across the conversations the person may read. */
export function SearchDialog({ base, onClose }: { base: string; onClose: () => void }) {
  const people = usePeople().data?.users ?? [];
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const results = useQuery({
    queryKey: ["chat", "search", "all", term],
    queryFn: ({ signal }) => api.get<{ messages: Message[] }>(`${CHAT}/search`, { q: term, limit: 50 }, signal),
    enabled: term.length >= LEAST,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTerm(q.trim());
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Search messages")}</DialogTitle>
          <DialogDescription>{t("In your conversations and in public channels.")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex gap-2">
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`At least ${LEAST} letters`} aria-label={t("Search text")} />
          <Button type="submit" disabled={q.trim().length < LEAST}>
            {t("Search")}
          </Button>
        </form>
        <ul className="grid max-h-80 gap-2 overflow-y-auto" aria-live="polite">
          {results.isFetching && <Skeleton className="h-16" />}
          {results.error && (
            <li>
              <ErrorState error={results.error} onRetry={() => void results.refetch()} />
            </li>
          )}
          {results.data?.messages.map((m) => (
            <li key={m.id}>
              <Link to={`${base}/${m.channel}?m=${m.id}`} onClick={onClose} className="block rounded-md border p-2 text-sm hover:bg-accent pointer-coarse:min-h-11">
                <Hit m={m} term={term} people={people} />
              </Link>
            </li>
          ))}
          {results.data && !results.data.messages.length && <li className="text-sm text-muted-foreground">{t("Nothing found.")}</li>}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
