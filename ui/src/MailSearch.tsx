// The search box over the list (all mail by default; Enter searches), the form for people who do not
// type operators, the chips a search is made of, and naming a search to keep it as a folder.

import { SlidersHorizontal, Search, X } from "lucide-react";
import { useId, useState, type FormEvent, type RefObject } from "react";
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Popover, PopoverContent, PopoverTrigger } from "@ferrum/kit/primitives";
import { isolate, t as tr } from "@ferrum/client";
import { cn } from "@ferrum/kit";
import { folderName, moveTargets } from "./lib/folders";
import type { Mailbox } from "./lib/mail";
import { formQuery, queryForm, recentSearches, snippetParts, termLabel, tokenize, without, type SearchForm } from "./lib/search";

/** The box: what is typed is searched on Enter; recent searches are offered as the browser's own suggestions. */
export function SearchBox({ account, boxes, value, onSearch, inputRef, placeholder }: { account: string; boxes: Mailbox[]; value: string; onSearch: (q: string) => void; inputRef: RefObject<HTMLInputElement | null>; placeholder: string }) {
  const [typed, setTyped] = useState(value);
  const [shown, setShown] = useState(value);
  // The committed query changed from outside (a chip taken off, the form): the box follows.
  if (shown !== value) {
    setShown(value);
    setTyped(value);
  }
  const list = useId();
  const recent = recentSearches(account);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSearch(typed.trim());
  };
  return (
    <form role="search" onSubmit={submit} className="relative flex min-w-0 flex-1 items-center">
      <Search className="pointer-events-none absolute top-1/2 start-2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        ref={inputRef}
        className="ps-8 pe-10 [&::-webkit-calendar-picker-indicator]:!hidden"
        type="search"
        enterKeyHint="search"
        list={list}
        placeholder={placeholder}
        aria-label={tr("Search mail")}
        value={typed}
        onChange={(e) => {
          setTyped(e.target.value);
          // Clearing the box (its ×) ends the search.
          if (!e.target.value && value) onSearch("");
        }}
        onKeyDown={(e) => e.key === "Escape" && typed && (e.stopPropagation(), setTyped(""), onSearch(""))}
      />
      <datalist id={list}>
        {recent.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <span className="absolute end-1 top-1/2 -translate-y-1/2">
        <SearchOptions boxes={boxes} query={typed} onSearch={(q) => (setTyped(q), onSearch(q))} />
      </span>
    </form>
  );
}

const WITHIN: { value: string; label: () => string }[] = [
  { value: "", label: () => tr("Any time") },
  { value: "1d", label: () => tr("The last day") },
  { value: "1w", label: () => tr("The last week") },
  { value: "1m", label: () => tr("The last month") },
  { value: "6m", label: () => tr("The last 6 months") },
  { value: "1y", label: () => tr("The last year") },
];

/** The form behind the box's sliders button: the same search, field by field. */
function SearchOptions({ boxes, query, onSearch }: { boxes: Mailbox[]; query: string; onSearch: (q: string) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<SearchForm>(() => queryForm(query));
  const id = useId();
  const field = (k: "from" | "to" | "subject" | "words" | "without", label: string) => (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
      <Label htmlFor={`${id}-${k}`}>{label}</Label>
      <Input id={`${id}-${k}`} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </div>
  );
  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), o && setF(queryForm(query)))}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={tr("Search options")} title={tr("Search options")}>
          <SlidersHorizontal />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(26rem,calc(100vw-2rem))]">
        <form
          className="grid gap-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            setOpen(false);
            onSearch(formQuery(f));
          }}
        >
          {field("from", tr("From"))}
          {field("to", tr("To"))}
          {field("subject", tr("Subject"))}
          {field("words", tr("Has the words"))}
          {field("without", tr("Doesn't have"))}
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
            <Label htmlFor={`${id}-within`}>{tr("Date")}</Label>
            <select id={`${id}-within`} className="h-(--control-h) rounded-md border border-input bg-card px-2" value={f.within} onChange={(e) => setF({ ...f, within: e.target.value })}>
              {WITHIN.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label()}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
            <Label htmlFor={`${id}-in`}>{tr("Search in")}</Label>
            <select id={`${id}-in`} className="h-(--control-h) rounded-md border border-input bg-card px-2" value={f.folder} onChange={(e) => setF({ ...f, folder: e.target.value })}>
              <option value="">{tr("All mail")}</option>
              {moveTargets(boxes).map(({ box }) => (
                <option key={box.id} value={box.role === "junk" ? "spam" : box.role ?? box.name}>
                  {folderName(box)}
                </option>
              ))}
              <option value="anywhere">{tr("Mail, Spam and Trash")}</option>
            </select>
          </div>
          <label className="flex items-center gap-2">
            <Checkbox checked={f.attachment} onCheckedChange={(c) => setF({ ...f, attachment: c === true })} /> {tr("Has attachment")}
          </label>
          <p className="text-xs text-muted-foreground">{tr("In the box you can also type from:, to:, subject:, has:attachment, is:unread, is:starred, in:, before:, after:, older_than:, newer_than:, larger:, filename:, \"exact words\", -word and OR.")}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setF(queryForm(""))}>
              {tr("Clear")}
            </Button>
            <Button type="submit">{tr("Search")}</Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** What a search is made of, as chips: where it looks (a toggle), each term (×), and what can be done with it. */
export function SearchChips({ query, folder, here, canHere, onHere, onQuery, onSave, onFilter, saved }: { query: string; folder: string; here: boolean; canHere: boolean; onHere: (h: boolean) => void; onQuery: (q: string) => void; onSave?: () => void; onFilter: () => void; saved?: string }) {
  const terms = tokenize(query);
  const namesFolder = terms.some((t) => t.op === "in" || t.op === "label");
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5 text-xs" aria-label={tr("What is searched")}>
      {saved && <span className="font-medium">{isolate(saved)}</span>}
      {!namesFolder &&
        (canHere ? (
          <Button size="xs" variant={here ? "secondary" : "outline"} aria-pressed={here} onClick={() => onHere(!here)} title={here ? tr("Search all mail instead") : tr("Search only this folder")}>
            {here ? tr("In {folder}", { folder }) : tr("All mail")}
          </Button>
        ) : (
          <span className="rounded-full border px-2 py-0.5">{tr("All mail")}</span>
        ))}
      {terms.map((t, i) => (
        <span key={`${i}-${t.raw}`} className={cn("inline-flex items-center gap-0.5 rounded-full border bg-card ps-2")}>
          {t.or && <span className="me-1 font-semibold text-muted-foreground no-underline">{tr("or")}</span>}
          <span className="max-w-48 truncate">{isolate(termLabel(t))}</span>
          <Button variant="ghost" size="icon-xs" className="size-5 rounded-full" aria-label={tr("Remove “{value}” from the search", { value: termLabel(t) })} onClick={() => onQuery(without(terms, i))}>
            <X className="size-3" />
          </Button>
        </span>
      ))}
      <span className="flex-1" />
      {onSave && (
        <Button size="xs" variant="ghost" onClick={onSave}>
          {tr("Save search")}
        </Button>
      )}
      <Button size="xs" variant="ghost" onClick={onFilter}>
        {tr("Make a filter")}
      </Button>
    </div>
  );
}

/** Words of a line with what matched marked (a search snippet: text only, never HTML). */
export function Marked({ snippet, fallback }: { snippet: string | null | undefined; fallback: string }) {
  const parts = snippetParts(snippet);
  if (!parts.length) return <>{isolate(fallback)}</>;
  return (
    <>
      {parts.map((p, i) =>
        p.mark ? (
          <mark key={i} className="rounded-sm bg-warning-soft px-0.5 text-foreground">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** Naming a search to keep it in the folder list. */
export function SaveSearchDialog({ query, onSave, onClose }: { query: string; onSave: (name: string) => Promise<boolean>; onClose: () => void }) {
  const [name, setName] = useState(() => tokenize(query).map(termLabel).join(", ").slice(0, 60));
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            setBusy(true);
            if (await onSave(name.trim().slice(0, 80))) onClose();
            setBusy(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{tr("Save this search")}</DialogTitle>
            <DialogDescription>{tr("It appears under Searches in the folder list and shows what matches whenever you open it.")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="saved-name">{tr("Name")}</Label>
            <Input id="saved-name" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            <p className="font-mono text-xs break-all text-muted-foreground">{isolate(query)}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {tr("Cancel")}
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {tr("Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
