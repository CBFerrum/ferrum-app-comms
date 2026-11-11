// A list of recipients as chips: typed or pasted addresses become chips (one that is not an address
// shows so at once), colleagues and people written to before are offered while typing, Backspace in
// the empty field takes the last chip off, and a chip can be dragged to another field (To, Cc, Bcc).

import { X } from "lucide-react";
import { useId, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { cn } from "@ferrum/kit";
import { isolate, t } from "@ferrum/client";
import { parseAddresses, type Address } from "./lib/mail";
import type { Suggestion } from "./lib/compose";

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
export const isAddress = (a: Address) => EMAIL.test(a.email);
const DRAG = "application/x-ferrum-address";

/** Typed text as chips: addresses, and what is not one kept as written so it can be fixed. */
function chipsOf(text: string): Address[] {
  const { list, bad } = parseAddresses(text);
  return [...list, ...bad.map((b) => ({ email: b }))];
}

export function RecipientField({
  field,
  label,
  value,
  onChange,
  suggest,
  onTake,
  autoFocus,
}: {
  field: string;
  label: string;
  value: Address[];
  onChange: (v: Address[]) => void;
  /** People to offer for what is typed, leaving out those on the message already. */
  suggest: (query: string) => Suggestion[];
  /** A chip dragged here from another field. */
  onTake: (a: Address, from: string) => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [pick, setPick] = useState(0);
  const [closed, setClosed] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const choices = closed || !text.trim() ? [] : suggest(text);
  const active = Math.min(pick, Math.max(choices.length - 1, 0));
  const add = (list: Address[]) => {
    const have = new Set(value.map((a) => a.email.toLowerCase()));
    const fresh = list.filter((a) => !have.has(a.email.toLowerCase()) && have.add(a.email.toLowerCase()));
    if (fresh.length) onChange([...value, ...fresh]);
  };
  const commit = () => {
    if (text.trim()) add(chipsOf(text));
    setText("");
    setPick(0);
  };
  const choose = (s: Suggestion) => {
    add([s.name ? { name: s.name, email: s.email } : { email: s.email }]);
    setText("");
    setPick(0);
    input.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (choices.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setPick((active + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
    } else if (choices.length && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      choose(choices[active]!);
    } else if (e.key === "Enter" || ((e.key === "," || e.key === ";") && text.trim())) {
      if (text.trim()) {
        e.preventDefault();
        commit();
      }
    } else if (e.key === "Escape" && choices.length) {
      // Closes the list, not the message.
      e.preventDefault();
      e.stopPropagation();
      setClosed(true);
    } else if (e.key === "Backspace" && !text && value.length) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (!/[,;\n]/.test(pasted)) return;
    e.preventDefault();
    add(chipsOf(text + pasted));
    setText("");
  };
  const onDrop = (e: DragEvent) => {
    setOver(false);
    const raw = e.dataTransfer.getData(DRAG);
    if (!raw) return;
    e.preventDefault();
    const got = JSON.parse(raw) as { a: Address; from: string };
    if (got.from !== field) onTake(got.a, got.from);
  };
  const bad = value.filter((a) => !isAddress(a));
  return (
    <div className="relative">
      <div
        className={cn("flex min-h-10 flex-wrap items-center gap-1 border-b px-1 py-1", over && "bg-accent")}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG)) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={(e) => e.target === e.currentTarget && input.current?.focus()}
      >
        <label htmlFor={id} className="px-1 text-sm text-muted-foreground">
          {isolate(label)}
        </label>
        <ul className="contents" aria-label={t("{label}: {n} recipients", { label, n: value.length })}>
          {value.map((a, i) => {
            const ok = isAddress(a);
            const shown = a.name || a.email;
            return (
              <li
                key={`${a.email}-${i}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG, JSON.stringify({ a, from: field }));
                  e.dataTransfer.effectAllowed = "move";
                }}
                title={ok ? a.email : t("Not an email address")}
                className={cn(
                  "flex max-w-full items-center gap-0.5 rounded-full border py-0.5 ps-2 pe-0.5 text-sm",
                  ok ? "bg-muted" : "border-destructive bg-destructive-soft text-destructive",
                )}
              >
                <span className="truncate">{isolate(shown)}</span>
                {!ok && <span className="sr-only">{t("Not an email address")}</span>}
                <button
                  type="button"
                  className="grid size-5 place-items-center rounded-full hover:bg-accent pointer-coarse:size-7"
                  aria-label={t("Remove {name}", { name: shown })}
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
        <input
          ref={input}
          id={id}
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            setClosed(false);
            setPick(0);
            // A separator typed at the end finishes the address.
            if (/[,;]\s*$/.test(v) && v.replace(/[,;\s]/g, "")) {
              add(chipsOf(v));
              setText("");
            } else setText(v);
          }}
          onKeyDown={onKey}
          onPaste={onPaste}
          onBlur={commit}
          autoComplete="off"
          dir="auto"
          role="combobox"
          aria-expanded={choices.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={choices.length ? `${id}-o${active}` : undefined}
          aria-autocomplete="list"
          aria-invalid={bad.length > 0 || undefined}
          aria-describedby={bad.length ? `${id}-bad` : undefined}
          className="h-8 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none"
        />
      </div>
      {choices.length > 0 && (
        <ul id={`${id}-list`} role="listbox" aria-label={t("People for {label}", { label })} className="absolute top-full end-0 start-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
          {choices.map((s, i) => (
            <li
              key={s.email}
              id={`${id}-o${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(s)}
              className={cn("flex cursor-pointer items-baseline gap-2 rounded px-2 py-1.5 text-sm pointer-coarse:min-h-11", i === active ? "bg-accent" : "hover:bg-accent")}
            >
              <span className="font-medium">{isolate(s.name || s.email)}</span>
              <span className="truncate text-xs text-muted-foreground">{isolate(s.email)}</span>
              {s.source === "recent" && <span className="ms-auto shrink-0 text-xs text-muted-foreground">{t("Written to before")}</span>}
            </li>
          ))}
        </ul>
      )}
      {bad.length > 0 && (
        <p id={`${id}-bad`} className="px-2 pt-1 text-xs text-destructive">
          {bad.length === 1 ? t("This is not an email address") : t("These are not email addresses")}: {isolate(bad.map((b) => b.email).join(", "))}
        </p>
      )}
    </div>
  );
}
