// What the reader tells a person about a message beyond its words: whether the sender can be trusted
// (the mail server's own checks, read from the message's headers), why Spam is Spam, the unsubscribe
// link, the invitation it carries, the images it wants to load. All of it comes from one extra read
// of the message's headers over the generic JMAP call; a server that does not answer it shows none of
// these and the message still reads.

import { useQuery } from "@tanstack/react-query";
import { CalendarDays, MapPin, MoreHorizontal, ShieldAlert, TriangleAlert } from "lucide-react";
import { Badge, Button, Checkbox, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@ferrum/kit/primitives";
import { fetchBlob, isolate, queryString, t as tr } from "@ferrum/client";
import { MAIL, inTurn, jmap, type Address } from "./lib/mail";
import { inviteWhen, parseInvite, spamReasons, unsubscribeTargets, type Invite, type Unsubscribe, type Warning } from "./lib/safety";

export interface Extras {
  auth: string | null;
  spamStatus: string | null;
  spamResult: string | null;
  unsubscribe: Unsubscribe | null;
  oneClick: boolean;
  /** The message has no HTML part: it is plain text, drawn on the theme's surface. */
  plain: boolean;
  invite: Invite | null;
  /** The invitation's iCalendar text, for answering it. */
  ics: string | null;
}

interface Part {
  type?: string;
  blobId?: string;
  subParts?: Part[];
}

const findPart = (p: Part | undefined, type: string): Part | undefined => (p?.type === type ? p : p?.subParts?.map((s) => findPart(s, type)).find(Boolean));

/** The headers and parts of a message that the reader's notices come from (null when the server does not give them). */
export function useExtras(account: string, id: string | undefined) {
  return useQuery({
    queryKey: ["mail", "extras", account, id],
    enabled: !!id,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<Extras | null> => {
      try {
        const r = await jmap([
          [
            "Email/get",
            {
              accountId: account,
              ids: [id],
              properties: ["header:Authentication-Results:asText", "header:X-Spam-Status:asText", "header:X-Spam-Result:asText", "header:List-Unsubscribe:asURLs", "header:List-Unsubscribe-Post:asRaw", "htmlBody", "bodyStructure"],
              bodyProperties: ["partId", "blobId", "type"],
            },
            "0",
          ],
        ]);
        const e = (r["0"].list as Record<string, unknown>[] | undefined)?.[0];
        if (!e) return null;
        const html = (e.htmlBody as Part[] | undefined) ?? [];
        const cal = findPart(e.bodyStructure as Part | undefined, "text/calendar");
        let ics: string | null = null;
        if (cal?.blobId) ics = await inTurn(async () => (await fetchBlob(`${MAIL}/blob/${account}/${cal.blobId}${queryString({ name: "invite.ics", type: "text/calendar" })}`)).text()).catch(() => null);
        return {
          auth: (e["header:Authentication-Results:asText"] as string | null) ?? null,
          spamStatus: (e["header:X-Spam-Status:asText"] as string | null) ?? null,
          spamResult: (e["header:X-Spam-Result:asText"] as string | null) ?? null,
          unsubscribe: unsubscribeTargets(e["header:List-Unsubscribe:asURLs"] as string[] | null),
          oneClick: /List-Unsubscribe\s*=\s*One-Click/i.test(String(e["header:List-Unsubscribe-Post:asRaw"] ?? "")),
          plain: html.length > 0 && html.every((p) => p.type === "text/plain"),
          invite: parseInvite(ics),
          ics,
        };
      } catch {
        return null;
      }
    },
  });
}

/** The warning on a message that failed the sender checks or claims the workspace's domain without passing them. */
export function WarningBanner({ warning }: { warning: Warning }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-sm text-foreground">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <span>{warning.text}</span>
    </p>
  );
}

/** In Spam: why the server put the message there, when it says. */
export function WhySpam({ extras }: { extras: Extras }) {
  const why = spamReasons(extras.spamStatus, extras.spamResult);
  if (!why) return null;
  return (
    <p className="flex items-start gap-2 rounded-md border bg-muted px-3 py-2 text-sm">
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span>
        {tr("The mail server marked this as spam (score {score}).", { score: why.score })}
        {why.reasons.length > 0 && ` ${tr("Mainly because {reasons}.", { reasons: why.reasons.join("; ") })}`}
      </span>
    </p>
  );
}

/** A quiet mark on mail from outside the workspace. */
export const ExternalMark = () => (
  <Badge variant="outline" className="h-5 px-1.5 font-normal text-muted-foreground" title={tr("From outside your workspace's domains")}>
    {tr("External")}
  </Badge>
);

/** One bar for the images a message wants to load: show them once, or always from this sender. */
export function ImagesBar({ count, sender, onShow, onAlways }: { count: number; sender: string; onShow: () => void; onAlways: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1">{count === 1 ? tr("1 remote image is hidden to protect your privacy.") : tr("{count} remote images are hidden to protect your privacy.", { count })}</span>
      <Button variant="outline" size="xs" onClick={onShow}>
        {tr("Show images")}
      </Button>
      <label className="flex items-center gap-1.5">
        <Checkbox aria-label={tr("Always show images from {sender}", { sender })} onCheckedChange={(c) => c === true && onAlways()} />
        {tr("Always show from {sender}", { sender: isolate(sender) })}
      </label>
    </div>
  );
}

/** The event an invitation carries: what, when (in the person's time zone), where, who asks. */
export function InviteCard({ invite, cancelled }: { invite: Invite; cancelled: boolean }) {
  return (
    <section className="flex items-start gap-3 rounded-md border bg-card px-3 py-2" aria-label={tr("Invitation")}>
      <CalendarDays className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
      <div className="grid min-w-0 gap-0.5 text-sm">
        <p className="font-semibold break-words">
          {cancelled && <Badge variant="destructive" className="me-2">{tr("Cancelled")}</Badge>}
          {isolate(invite.title || tr("(no title)"))}
        </p>
        {invite.start && <p className="text-muted-foreground">{isolate(inviteWhen(invite))}</p>}
        {invite.where && (
          <p className="flex items-center gap-1 text-muted-foreground">
            <MapPin className="size-3.5 shrink-0" aria-hidden="true" /> {isolate(invite.where)}
          </p>
        )}
        {invite.organizer && (
          <p className="text-xs text-muted-foreground">
            {tr("Organiser")}: {isolate(invite.organizer.name)}
            {invite.organizer.name !== invite.organizer.email && <span> &lt;{isolate(invite.organizer.email)}&gt;</span>}
          </p>
        )}
      </div>
    </section>
  );
}

/** "Block sender", "Report phishing" and the rest of a message's own menu. */
export function MessageMenu({ from, onBlock, onPhishing, onUnsubscribeMail, unsubscribe }: { from: Address | undefined; onBlock: () => void; onPhishing: () => void; onUnsubscribeMail: () => void; unsubscribe: Unsubscribe | null }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon-xs" aria-label={tr("More about this message")}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {from && (
          <DropdownMenuItem onSelect={onBlock}>
            {tr("Block {sender}", { sender: isolate(from.email) })}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onPhishing}>{tr("Report phishing")}</DropdownMenuItem>
        {unsubscribe && (
          <>
            <DropdownMenuSeparator />
            {unsubscribe.web ? (
              <DropdownMenuItem asChild>
                <a href={unsubscribe.web} target="_blank" rel="noopener noreferrer">
                  {tr("Unsubscribe (opens the sender's page)")}
                </a>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={onUnsubscribeMail}>{tr("Unsubscribe by email")}</DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
