// Answering an invitation without an account: the page the link in the invitation email opens
// (/calendar/rsvp/{workspace}/{token}). It shows what the event is, takes Yes, Maybe or No with a
// note for the organizer, and says plainly when the link no longer works.

import { useQuery } from "@tanstack/react-query";
import { CalendarDays, MapPin } from "lucide-react";
import { useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { Button, Skeleton, Textarea } from "@ferrum/kit/primitives";
import { cn, EmptyState, useShellTitle } from "@ferrum/kit";
import { api, errorMessage, t } from "@ferrum/client";
import { answerWord } from "./lib/calendar";

interface Info {
  subject: string | null;
  when: string;
  where: string | null;
  description: string | null;
  organizer: string;
  guest: { email: string; name: string | null };
  /** What they answered before (`Needs Action`: nothing yet). */
  response: string;
  cancelled: boolean;
}

type Answer = "Accepted" | "Tentative" | "Declined";
const ANSWERS: Answer[] = ["Accepted", "Tentative", "Declined"];
const PRESET: Record<string, Answer> = { yes: "Accepted", maybe: "Tentative", no: "Declined" };

export function RsvpPage() {
  const { tenant = "", link = "" } = useParams();
  const [params] = useSearchParams();
  const at = `/api/site/${encodeURIComponent(tenant)}/comms/rsvp`;
  const info = useQuery({ queryKey: ["rsvp", tenant, link], queryFn: ({ signal }) => api.get<Info>(at, { token: link }, signal), retry: false });
  const [choice, setChoice] = useState<Answer | null>(PRESET[params.get("r") ?? ""] ?? null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<Answer | null>(null);
  useShellTitle(info.data?.subject ?? "Reply to an invitation");

  if (info.isLoading) {
    return (
      <div className="mx-auto max-w-md p-4">
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (info.error || !info.data) {
    return (
      <EmptyState title={t("This link does not work any more")} icon="calendar">
        <p className="max-w-sm text-center text-sm text-muted-foreground">{info.error ? errorMessage(info.error) : "Ask the person who invited you to send it again."}</p>
      </EmptyState>
    );
  }
  const e = info.data;
  const before = ANSWERS.find((a) => a === e.response) ?? null;
  const send = async () => {
    if (!choice) return setProblem("Choose Yes, Maybe or No first.");
    setBusy(true);
    setProblem(null);
    try {
      await api.post(at, { token: link, response: choice, note: note.trim() });
      setSent(choice);
    } catch (err) {
      setProblem(`Your answer was not sent: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto grid max-w-md gap-4 p-4 py-8">
      <header className="grid gap-1">
        <p className="text-sm text-muted-foreground">{e.organizer} invited {e.guest.name || e.guest.email} to</p>
        <h1 className={cn("text-xl font-semibold", e.cancelled && "line-through")}>{e.subject || "(no title)"}</h1>
        <p className="flex items-start gap-2 text-sm">
          <CalendarDays className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> {e.when}
        </p>
        {e.where && (
          <p className="flex items-start gap-2 text-sm">
            <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> {e.where}
          </p>
        )}
        {e.description && <p className="mt-1 text-sm whitespace-pre-line text-muted-foreground">{e.description}</p>}
      </header>
      {e.cancelled ? (
        <p role="status" className="rounded-md border bg-muted px-3 py-2 text-sm">
          {t("This event was cancelled, so there is nothing to answer.")}
        </p>
      ) : sent ? (
        <div role="status" className="grid gap-3 rounded-lg border bg-card p-4">
          <p className="font-medium">{t("Thank you. Your answer is")} {answerWord(sent)}.</p>
          <p className="text-sm text-muted-foreground">{t("{organizer} has been told", { organizer: e.organizer })}{note.trim() ? ", with your note" : ""}{t(". You can change your answer any time with this link.")}</p>
          <Button variant="outline" className="justify-self-start" onClick={() => setSent(null)}>
            {t("Change my answer")}
          </Button>
        </div>
      ) : (
        <form
          className="grid gap-3 rounded-lg border bg-card p-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            void send();
          }}
        >
          <fieldset className="grid gap-2">
            <legend className="font-medium">{t("Will you come?")}</legend>
            {before && <p className="text-sm text-muted-foreground">{t("You answered")} {answerWord(before)} before.</p>}
            <div className="grid grid-cols-3 gap-2">
              {ANSWERS.map((a) => (
                <Button key={a} type="button" variant={choice === a ? "default" : "outline"} aria-pressed={choice === a} className="h-11" onClick={() => setChoice(a)}>
                  {answerWord(a)}
                </Button>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-1.5">
            <label htmlFor="rsvp-note" className="text-sm font-medium">
              {t("A note for {organizer} (optional)", { organizer: e.organizer })}
            </label>
            <Textarea id="rsvp-note" rows={3} maxLength={500} value={note} onChange={(ev) => setNote(ev.target.value)} />
          </div>
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <Button type="submit" disabled={busy} className="h-11">
            {busy ? "Sending…" : "Send my answer"}
          </Button>
        </form>
      )}
    </div>
  );
}
