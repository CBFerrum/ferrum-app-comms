// Mail domain health, for whoever manages Communication Settings: which DNS records the domain's
// mail needs, which are published, which are missing or different, and what to do about each, in
// plain words. It checks when opened and on "Check again"; it publishes nothing for anyone (that
// takes the DNS provider's credentials, which Ferrum does not hold).

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Copy, Download, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Button, Skeleton } from "@ferrum/kit/primitives";
import { cn, EmptyState, ErrorState, toast, useShellTitle } from "@ferrum/kit";
import { ApiError, api, formatDateTime, relativeTime, saveBlob, t } from "@ferrum/client";
import { DOMAIN, STATUS, headline, shown, zoneName, type Check, type Health } from "./lib/domain";

const copy = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast(t("Copied"));
  } catch {
    toast(t("Your browser did not let this page copy. Select the text and copy it."), "error");
  }
};

const TONE: Record<Check["status"], string> = {
  ok: "text-success",
  missing: "text-destructive",
  differs: "text-warning",
  unknown: "text-muted-foreground",
};

export function DomainPage() {
  useShellTitle("Mail domain");
  const [only, setOnly] = useState(false);
  const q = useQuery({ queryKey: ["mail", "domain"], queryFn: ({ signal }) => api.get<Health>(DOMAIN, undefined, signal), staleTime: 0, gcTime: 0 });
  const h = q.data;
  const forbidden = q.error instanceof ApiError && q.error.status === 403;

  return (
    <div className="mx-auto grid max-w-4xl gap-4 p-4">
      <div>
        <Link to="/mail" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" /> {t("Mail")}
        </Link>
      </div>
      {forbidden ? (
        <EmptyState title={t("This page is for people who manage Communication Settings")} icon="mail">
          <p className="text-sm text-muted-foreground">{t("Ask an administrator for the Comms Manager role.")}</p>
        </EmptyState>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !h ? (
        <div role="status" aria-label={t("Checking the domain")}>
          <Skeleton className="h-24" />
          <Skeleton className="mt-3 h-48" />
        </div>
      ) : !h.domain ? (
        <EmptyState title={t("No mail domain is set")} icon="mail">
          <p className="max-w-md text-center text-sm text-muted-foreground">
            {t("Set the Mail Domain in Communication Settings (for example acme.com) and everyone whose address is in it gets a mailbox. Then this page shows which DNS records that domain needs.")}
          </p>
          <Link className="text-primary underline" to="/open/CommsSettings" reloadDocument>
            {t("Open Communication Settings")}
          </Link>
        </EmptyState>
      ) : (
        <Report h={h} only={only} setOnly={setOnly} fetching={q.isFetching} again={() => void q.refetch()} />
      )}
    </div>
  );
}

function Report({ h, only, setOnly, fetching, again }: { h: Health; only: boolean; setOnly: (v: boolean) => void; fetching: boolean; again: () => void }) {
  const checks = shown(h.checks ?? [], only);
  const download = () => saveBlob(new Blob([h.zone ?? ""], { type: "text/plain" }), zoneName(h.domain!));
  return (
    <>
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">{h.domain}</h1>
        <p className="text-sm text-muted-foreground">
          {h.hosted ? (
            <>
              {h.mailboxes ?? 0} {h.mailboxes === 1 ? "mailbox" : "mailboxes"} and {h.shared ?? 0} shared {h.shared === 1 ? "mailbox" : "mailboxes"}
              {h.synced_at ? `, last brought in step with your people ${relativeTime(h.synced_at)}` : ", not brought in step with your people yet"}.
            </>
          ) : (
            "Hosted mail is not set up on this server."
          )}
        </p>
        <p className="text-base" aria-live="polite">
          {headline(h)}
        </p>
      </header>
      {h.note && (
        <p role="note" className="rounded-md border bg-muted px-3 py-2 text-sm">
          {h.note}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={again} disabled={fetching}>
          <RefreshCw className={cn(fetching && "motion-safe:animate-spin")} aria-hidden="true" /> {fetching ? "Checking…" : "Check again"}
        </Button>
        {h.checked_at && <span className="text-xs text-muted-foreground">{t("Last checked")} {formatDateTime(h.checked_at)}{t(". DNS changes can take a few hours to show.")}</span>}
        <span className="flex-1" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> {t("Only what is not right")}
        </label>
        <Button variant="outline" onClick={download} disabled={!h.zone}>
          <Download aria-hidden="true" /> {t("Download zone file")}
        </Button>
      </div>
      {checks.length === 0 ? (
        <EmptyState title={t("Everything checked is in place")} icon="check" />
      ) : (
        <ol className="grid gap-3" aria-label={t("DNS records")}>
          {checks.map((c, i) => (
            <CheckCard key={`${c.id}-${c.name}-${i}`} c={c} />
          ))}
        </ol>
      )}
      {(h.manual ?? []).length > 0 && (
        <section className="grid gap-2" aria-labelledby="by-hand">
          <h2 id="by-hand" className="font-semibold">
            {t("Two things to check by hand")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("They cannot be seen from the domain's own records.")}</p>
          <ul className="grid gap-2">
            {h.manual!.map((m) => (
              <li key={m.id} className="rounded-md border p-3 text-sm">
                <strong className="font-medium">{m.title}.</strong> {m.how}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function CheckCard({ c }: { c: Check }) {
  return (
    <li className="grid gap-2 rounded-lg border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="min-w-0 flex-1 font-medium">{c.title}</h2>
        <span className={cn("font-medium", TONE[c.status])}>{STATUS[c.status]}</span>
        {c.importance !== "optional" && <span className="text-xs text-muted-foreground">{c.importance === "required" ? "Mail needs this" : "Recommended"}</span>}
      </div>
      <p className="text-muted-foreground">{c.why}</p>
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[6rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">{t("Record")}</dt>
        <dd className="break-all">
          {c.kind} at <code className="font-mono text-xs">{c.name}</code>
        </dd>
        <dt className="text-muted-foreground">{t("Publish")}</dt>
        <dd className="flex items-start gap-2">
          <code className="min-w-0 flex-1 font-mono text-xs break-all">{c.expected}</code>
          <Button variant="ghost" size="icon-xs" aria-label={`Copy the ${c.kind} value for ${c.name}`} onClick={() => void copy(c.expected)}>
            <Copy />
          </Button>
        </dd>
        <dt className="text-muted-foreground">{t("Found now")}</dt>
        <dd>
          {c.found.length ? (
            <ul className="grid gap-1">
              {c.found.map((f, i) => (
                <li key={i}>
                  <code className="font-mono text-xs break-all">{f}</code>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">{c.status === "unknown" ? "Could not be looked up." : "Nothing is published."}</span>
          )}
        </dd>
      </dl>
      {c.note && <p>{c.note}</p>}
      {c.fix && <p className="rounded-md bg-muted px-3 py-2">{c.fix}</p>}
    </li>
  );
}
