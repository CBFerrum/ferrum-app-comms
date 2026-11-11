// Reading conveniences: a file looked at in place (pictures, PDFs drawn by pdf.js, text) and saved to
// Drive; a message or a whole conversation printed as a clean document; "Show original" (headers and
// the raw message, to copy or save as .eml).

import { useQuery } from "@tanstack/react-query";
import { Download, Eye, FolderArchive, FolderUp, MoreHorizontal, Paperclip } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Skeleton } from "@ferrum/kit/primitives";
import { api, download, errorMessage, fetchBlob, formatDateTime, isolate, queryString, request, shell, t as tr } from "@ferrum/client";
import { toast } from "@ferrum/kit";
import { MAIL, addressList, inTurn, jmap, sizeLabel, type Attachment, type Message } from "./lib/mail";

const PdfPages = lazy(() => import("./MailPdf"));

/** What can be shown in place. */
export function previewKind(a: Pick<Attachment, "type" | "name" | "size">): "image" | "pdf" | "text" | null {
  const t = a.type.toLowerCase();
  const n = (a.name ?? "").toLowerCase();
  if (/^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(t)) return "image";
  if (t === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if ((t.startsWith("text/") && t !== "text/html") || /\/(json|xml|csv)$/.test(t) || /\.(txt|csv|log|md|json)$/.test(n)) return a.size <= 2 * 1024 * 1024 ? "text" : null;
  return null;
}

const blobPath = (account: string, a: Attachment) => `${MAIL}/blob/${account}/${a.blobId}${queryString({ name: a.name ?? "attachment", type: a.type })}`;

/** Whether this person has Drive (it takes files straight from another app's page). */
function useDrive() {
  return useQuery({ queryKey: ["shell", "apps", "drive"], queryFn: async () => (await shell().apps()).some((e) => e.app === "drive"), staleTime: 30 * 60_000 }).data ?? false;
}

async function saveToDrive(account: string, a: Attachment) {
  try {
    const blob = await inTurn(() => fetchBlob(blobPath(account, a)));
    await request("/api/app/drive/upload", { method: "POST", query: { name: a.name ?? "attachment", on_conflict: "keep_both" }, body: blob });
    toast(tr("“{name}” was saved to your Drive.", { name: a.name ?? tr("attachment") }));
  } catch (e) {
    toast(tr("Not saved to Drive: {e}", { e: errorMessage(e) }), "error");
  }
}

/** A message's files: open one to look at it, or download it, or save it to Drive. */
export function AttachmentList({ account, files, all, subject }: { account: string; files: Attachment[]; all?: string; subject?: string | null }) {
  const [shown, setShown] = useState<Attachment | null>(null);
  const [zipping, setZipping] = useState(false);
  const drive = useDrive();
  const get = (a: Attachment) => void download(`${MAIL}/blob/${account}/${a.blobId}`, a.name ?? "attachment", { name: a.name ?? "attachment", type: a.type }).catch((e: unknown) => toast(errorMessage(e), "error"));
  const getAll = () => {
    if (!all) return;
    setZipping(true);
    void download(all, `${(subject ?? "").trim() || tr("attachments")}.zip`)
      .catch((e: unknown) => toast(tr("The attachments could not be downloaded together: {e}", { e: errorMessage(e) }), "error"))
      .finally(() => setZipping(false));
  };
  return (
    <>
      {all && (
        <Button variant="outline" size="xs" className="justify-self-start" onClick={getAll} disabled={zipping}>
          <FolderArchive aria-hidden="true" /> {zipping ? tr("Preparing the zip…") : tr("Download all ({n}, as a zip)", { n: files.length })}
        </Button>
      )}
      <ul className="flex flex-wrap gap-2 pt-1" aria-label={tr("Attachments")}>
        {files.map((a) => (
          <li key={a.blobId} className="flex items-center rounded-md border">
            <Button variant="ghost" size="xs" className="rounded-e-none" onClick={() => (previewKind(a) ? setShown(a) : get(a))} title={previewKind(a) ? tr("Open") : tr("Download")}>
              <Paperclip aria-hidden="true" /> <span className="max-w-48 truncate">{isolate(a.name ?? tr("attachment"))}</span> <span className="text-muted-foreground">{isolate(sizeLabel(a.size))}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" className="rounded-s-none border-s" aria-label={tr("More for {name}", { name: a.name ?? tr("attachment") })}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {previewKind(a) && (
                  <DropdownMenuItem onSelect={() => setShown(a)}>
                    <Eye /> {tr("Open")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => get(a)}>
                  <Download /> {tr("Download")}
                </DropdownMenuItem>
                {drive && (
                  <DropdownMenuItem onSelect={() => void saveToDrive(account, a)}>
                    <FolderUp /> {tr("Save to Drive")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
      {shown && <Preview account={account} file={shown} onClose={() => setShown(null)} onDownload={() => get(shown)} onDrive={drive ? () => void saveToDrive(account, shown) : undefined} />}
    </>
  );
}

function Preview({ account, file, onClose, onDownload, onDrive }: { account: string; file: Attachment; onClose: () => void; onDownload: () => void; onDrive?: () => void }) {
  const kind = previewKind(file);
  const blob = useQuery({ queryKey: ["mail", "file", account, file.blobId], queryFn: () => inTurn(() => fetchBlob(blobPath(account, file))), staleTime: Infinity, retry: false });
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!blob.data) return;
    if (kind === "text") void blob.data.text().then(setText);
    // A picture is shown from a blob of the exact type the server said, never as HTML.
    const u = URL.createObjectURL(new Blob([blob.data], { type: kind === "image" ? file.type : "application/octet-stream" }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob.data, kind, file.type]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="grid max-h-[94dvh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-4xl">
        <DialogHeader className="flex-row flex-wrap items-center gap-2 pe-8">
          <DialogTitle className="min-w-0 flex-1 truncate">{isolate(file.name ?? tr("attachment"))}</DialogTitle>
          <DialogDescription className="sr-only">{tr("A file of the message, shown here.")}</DialogDescription>
          <Button size="sm" variant="outline" onClick={onDownload}>
            <Download aria-hidden="true" /> {tr("Download")}
          </Button>
          {onDrive && (
            <Button size="sm" variant="outline" onClick={onDrive}>
              <FolderUp aria-hidden="true" /> {tr("Save to Drive")}
            </Button>
          )}
        </DialogHeader>
        <div className="min-h-[40dvh] overflow-auto rounded-md border bg-muted">
          {blob.error ? (
            <p role="alert" className="p-4 text-sm text-destructive">{tr("The file could not be loaded:")} {isolate(errorMessage(blob.error))}</p>
          ) : !blob.data ? (
            <Skeleton className="h-[60dvh]" />
          ) : kind === "image" && url ? (
            <img src={url} alt={file.name ?? ""} className="mx-auto max-h-[80dvh] max-w-full object-contain" />
          ) : kind === "pdf" ? (
            <Suspense fallback={<Skeleton className="h-[60dvh]" />}>
              <PdfPages data={blob.data} />
            </Suspense>
          ) : kind === "text" && text !== null ? (
            <pre className="p-4 font-mono text-xs whitespace-pre-wrap break-words">{text}</pre>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────────── print ─────────────────────────────

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page printed: each message with who, to whom and when above its words (already made safe by the server); no remote images. */
export function printDocument(subject: string, messages: Pick<Message, "from" | "to" | "cc" | "sentAt" | "receivedAt" | "html" | "attachments">[], when: (iso: string) => string): string {
  const policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
  const one = (m: (typeof messages)[number]) =>
    `<section class="m"><table class="h"><tr><th>${escapeHtml(tr("From"))}</th><td>${escapeHtml(addressList(m.from))}</td><td class="d">${escapeHtml(when(m.sentAt ?? m.receivedAt))}</td></tr>` +
    `<tr><th>${escapeHtml(tr("To"))}</th><td colspan="2">${escapeHtml(addressList(m.to))}</td></tr>` +
    (m.cc?.length ? `<tr><th>${escapeHtml(tr("Cc"))}</th><td colspan="2">${escapeHtml(addressList(m.cc))}</td></tr>` : "") +
    `</table><div class="b">${m.html}</div>` +
    (m.attachments.length ? `<p class="a">${escapeHtml(tr("Attachments"))}: ${m.attachments.map((a) => escapeHtml(`${a.name ?? "attachment"} (${sizeLabel(a.size)})`)).join(", ")}</p>` : "") +
    `</section>`;
  return (
    `<!doctype html><html dir="auto"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><title>${escapeHtml(subject)}</title>` +
    // ui-lint-allow raw-color: a printed page is black on white whatever the theme
    `<style>@page{margin:14mm}body{font:11pt/1.45 system-ui,sans-serif;color:#000;background:#fff;margin:0}h1{font-size:15pt;margin:0 0 10pt}.m{border-top:1px solid #999;padding-top:8pt;margin-top:10pt;break-inside:auto}.h{border-collapse:collapse;font-size:9.5pt;margin-bottom:6pt;width:100%}.h th{text-align:start;padding-inline-end:8pt;font-weight:600;white-space:nowrap;vertical-align:top;width:1%}.h .d{text-align:end;white-space:nowrap}img{max-width:100%;height:auto}img:not([src]){display:none}pre{white-space:pre-wrap;font:inherit}table{max-width:100%}.a{font-size:9.5pt;color:#333}</style></head>` +
    `<body><h1>${escapeHtml(subject)}</h1>${messages.map(one).join("")}</body></html>`
  );
}

/** Prints messages through a frame of their own that runs no script (the browser's print dialog). */
export async function printMessages(account: string, ids: string[], subject: string) {
  try {
    const messages = [];
    for (const id of ids) messages.push(await inTurn(() => api.get<Message>(`${MAIL}/message/${account}/${id}`)));
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin allow-modals");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;inset-inline-start:-10000px;top:0;width:800px;height:600px;border:0";
    frame.srcdoc = printDocument(subject || tr("(no subject)"), messages, (iso) => formatDateTime(iso));
    frame.onload = () => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      setTimeout(() => frame.remove(), 60_000);
    };
    document.body.append(frame);
  } catch (e) {
    toast(tr("Could not print: {e}", { e: errorMessage(e) }), "error");
  }
}

// ───────────────────────────── show original ─────────────────────────────

/** The header lines of a raw message (folded lines joined), for the list above the source. */
export function rawHeaders(raw: string): [string, string][] {
  const head = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const out: [string, string][] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1]![1] += ` ${line.trim()}`;
    else {
      const i = line.indexOf(":");
      if (i > 0) out.push([line.slice(0, i), line.slice(i + 1).trim()]);
    }
  }
  return out;
}

const KEY_HEADERS = ["message-id", "date", "from", "to", "subject", "authentication-results", "received-spf", "dkim-signature", "x-spam-status", "x-spam-result"];

export function OriginalDialog({ account, emailId, onClose }: { account: string; emailId: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["mail", "original", account, emailId],
    queryFn: async () => {
      const r = await jmap([["Email/get", { accountId: account, ids: [emailId], properties: ["blobId", "size"] }, "0"]]);
      const e = (r["0"].list as { blobId: string; size: number }[])[0];
      if (!e) throw new Error(tr("That message is not here any more"));
      const blob = await inTurn(() => fetchBlob(`${MAIL}/blob/${account}/${e.blobId}${queryString({ name: "message.eml", type: "message/rfc822" })}`));
      return { blob, text: await blob.slice(0, 2 * 1024 * 1024).text(), size: e.size };
    },
    retry: false,
  });
  const headers = q.data ? rawHeaders(q.data.text).filter(([k]) => KEY_HEADERS.includes(k.toLowerCase())) : [];
  const save = () => {
    if (!q.data) return;
    const url = URL.createObjectURL(q.data.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "message.eml";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="grid max-h-[94dvh] grid-rows-[auto_auto_minmax(0,1fr)] sm:max-w-4xl">
        <DialogHeader className="flex-row flex-wrap items-center gap-2 pe-8">
          <DialogTitle className="flex-1">{tr("Original message")}</DialogTitle>
          <DialogDescription className="sr-only">{tr("The message's headers and its source as the mail server keeps it.")}</DialogDescription>
          <Button size="sm" variant="outline" disabled={!q.data} onClick={() => q.data && void navigator.clipboard?.writeText(q.data.text).then(() => toast(tr("Copied")))}>
            {tr("Copy")}
          </Button>
          <Button size="sm" variant="outline" disabled={!q.data} onClick={save}>
            <Download aria-hidden="true" /> {tr("Download .eml")}
          </Button>
        </DialogHeader>
        {q.error ? (
          <p role="alert" className="text-sm text-destructive">{isolate(errorMessage(q.error))}</p>
        ) : !q.data ? (
          <Skeleton className="h-64" />
        ) : (
          <>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-md border bg-muted px-3 py-2 text-xs">
              {headers.map(([k, v], i) => (
                <div key={i} className="contents">
                  <dt className="font-medium">{isolate(k)}</dt>
                  <dd className="font-mono break-all">{isolate(v)}</dd>
                </div>
              ))}
            </dl>
            <pre dir="ltr" className="min-h-0 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap break-all" aria-label={tr("Source")}>
              {q.data.text}
              {q.data.size > 2 * 1024 * 1024 && `\n\n${tr("(The rest is left out here; download the .eml to see all of it.)")}`}
            </pre>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface Submission {
  deliveryStatus: Record<string, { delivered: "queued" | "yes" | "no" | "unknown"; smtpReply: string }> | null;
  undoStatus: string;
}

/**
 * Where a sent message got to, as the mail server's submission says (RFC 8621 §7): delivered, still on
 * its way (with the receiving server's last word), or refused. The server keeps this for a few days
 * after sending; older messages, and those sent from another program, show nothing.
 */
export function DeliveryStatus({ account, emailId }: { account: string; emailId: string }) {
  const q = useQuery({
    queryKey: ["mail", "delivery", account, emailId],
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const r = await inTurn(() =>
        jmap([
          ["EmailSubmission/query", { accountId: account, filter: { emailIds: [emailId] } }, "q"],
          ["EmailSubmission/get", { accountId: account, "#ids": { resultOf: "q", name: "EmailSubmission/query", path: "/ids" }, properties: ["deliveryStatus", "undoStatus"] }, "g"],
        ]),
      );
      return (r.g.list as Submission[] | undefined) ?? [];
    },
  });
  const rows = (q.data ?? []).filter((s) => s.undoStatus === "final").flatMap((s) => Object.entries(s.deliveryStatus ?? {}));
  if (!rows.length) return null;
  const group = (k: "yes" | "wait" | "no") => rows.filter(([, d]) => (d.delivered === "yes" ? "yes" : d.delivered === "no" ? "no" : "wait") === k);
  const who = (list: typeof rows) => list.map(([email]) => isolate(email)).join(", ");
  const done = group("yes");
  const waiting = group("wait");
  const failed = group("no");
  return (
    <div className="grid gap-0.5 text-xs" role="status">
      {done.length > 0 && <p className="text-muted-foreground">{tr("Delivered to {who}", { who: who(done) })}</p>}
      {waiting.length > 0 && <p className="text-muted-foreground">{tr("On its way to {who}: {reply}", { who: who(waiting), reply: isolate(waiting[0]![1].smtpReply || tr("waiting for their server")) })}</p>}
      {failed.length > 0 && <p className="text-destructive">{tr("Could not be delivered to {who}: {reply}", { who: who(failed), reply: isolate(failed[0]![1].smtpReply) })}</p>}
    </div>
  );
}
