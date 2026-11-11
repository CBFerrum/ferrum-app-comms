// Bringing mail in and taking it out: .eml and .mbox files dropped or picked go into a folder
// (Email/import, each message uploaded first, with progress), and a folder or the selection goes out
// as one .mbox file (each message's original, as the mail server keeps it).

import { useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { useState } from "react";
import { Button, Progress } from "@ferrum/kit/primitives";
import { errorMessage, fetchBlob, queryString, request, t as tr } from "@ferrum/client";
import { toast } from "@ferrum/kit";
import { folderName, moveTargets } from "./lib/folders";
import { MAIL, byRole, inTurn, jmap, type Mailbox } from "./lib/mail";
import { mboxEntry, splitMbox } from "./lib/mbox";

/** Messages into a folder; resolves to how many went in and how many were refused. */
export async function importMessages(account: string, folder: string, texts: string[], progress: (done: number) => void): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const [i, raw] of texts.entries()) {
    try {
      const up = await inTurn(() => request<{ blobId: string }>(`${MAIL}/upload/${account}`, { method: "POST", body: new Blob([raw], { type: "message/rfc822" }) }));
      const r = await jmap([["Email/import", { accountId: account, emails: { m: { blobId: up.blobId, mailboxIds: { [folder]: true }, keywords: { $seen: true } } } }, "0"]]);
      if ((r["0"].created as Record<string, unknown> | undefined)?.m) ok++;
      else failed++;
    } catch {
      failed++;
    }
    progress(i + 1);
  }
  return { ok, failed };
}

/** Messages as one .mbox file, downloaded. */
export async function exportMessages(account: string, ids: string[], name: string, progress: (done: number) => void): Promise<void> {
  const parts: string[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await jmap([["Email/get", { accountId: account, ids: ids.slice(i, i + 100), properties: ["blobId", "receivedAt", "from"] }, "0"]]);
    for (const e of r["0"].list as { blobId: string; receivedAt: string; from: { email: string }[] | null }[]) {
      const raw = await inTurn(async () => (await fetchBlob(`${MAIL}/blob/${account}/${e.blobId}${queryString({ name: "message.eml", type: "message/rfc822" })}`)).text());
      parts.push(mboxEntry(raw, e.from?.[0]?.email ?? "", new Date(e.receivedAt)));
      progress(parts.length);
    }
  }
  const url = URL.createObjectURL(new Blob(parts, { type: "application/mbox" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[\\/:*?"<>|]/g, "_") || "mail"}.mbox`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Import and export in Mail settings: files into a chosen folder, a folder out. */
export function MailTransfer({ account, boxes, folder }: { account: string; boxes: Mailbox[]; folder?: Mailbox }) {
  const qc = useQueryClient();
  const targets = moveTargets(boxes);
  const [into, setInto] = useState(folder && !folder.id.startsWith("~") ? folder.id : (byRole(boxes, "archive") ?? byRole(boxes, "inbox"))?.id ?? "");
  const [out, setOut] = useState(into);
  const [busy, setBusy] = useState<{ what: string; done: number; total: number } | null>(null);
  const [over, setOver] = useState(false);

  const take = async (files: File[]) => {
    const texts = (await Promise.all(files.filter((f) => /\.(eml|mbox|mbx)$/i.test(f.name) || /rfc822|mbox/.test(f.type)).map((f) => f.text()))).flatMap(splitMbox);
    if (!texts.length) return toast(tr("Choose .eml or .mbox files."), "error");
    setBusy({ what: tr("Importing"), done: 0, total: texts.length });
    try {
      const r = await importMessages(account, into, texts, (done) => setBusy((b) => b && { ...b, done }));
      const box = boxes.find((b) => b.id === into);
      toast(r.failed ? tr("{ok} messages imported into {folder}; {failed} could not be read.", { ok: r.ok, failed: r.failed, folder: box ? folderName(box) : "" }) : tr("{ok} messages imported into {folder}.", { ok: r.ok, folder: box ? folderName(box) : "" }), r.failed ? "error" : "success");
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ["mail"], predicate: (q) => q.queryKey[1] !== "session" });
    }
  };

  const exportFolder = async () => {
    const box = boxes.find((b) => b.id === out);
    if (!box) return;
    try {
      const ids: string[] = [];
      for (;;) {
        const r = await jmap([["Email/query", { accountId: account, filter: { inMailbox: box.id }, limit: 500, position: ids.length }, "0"]]);
        const got = r["0"].ids as string[];
        ids.push(...got);
        if (got.length < 500 || ids.length >= 5000) break;
      }
      if (!ids.length) return toast(tr("{folder} is empty.", { folder: folderName(box) }), "info");
      setBusy({ what: tr("Exporting"), done: 0, total: ids.length });
      await exportMessages(account, ids, folderName(box), (done) => setBusy((b) => b && { ...b, done }));
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const select = (value: string, onChange: (v: string) => void, label: string) => (
    <select aria-label={label} className="h-(--control-h) min-w-0 rounded-md border border-input bg-card px-2 text-sm" value={value} onChange={(e) => onChange(e.target.value)}>
      {targets.map(({ box, depth }) => (
        <option key={box.id} value={box.id}>
          {" ".repeat(depth * 2)}
          {folderName(box)}
        </option>
      ))}
    </select>
  );
  return (
    <div className="grid gap-4 pt-2 text-sm">
      <section className="grid gap-2" aria-labelledby="imp-h">
        <h3 id="imp-h" className="font-semibold">{tr("Import")}</h3>
        <p className="text-muted-foreground">{tr("Bring in mail saved from another mail program: .eml files (one message each) or .mbox files (many). They keep their dates and are marked as read.")}</p>
        <label className="flex flex-wrap items-center gap-2">
          {tr("Into")} {select(into, setInto, tr("Folder to import into"))}
        </label>
        <div
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            if (!busy) void take(Array.from(e.dataTransfer.files));
          }}
          className={`grid place-items-center gap-2 rounded-md border border-dashed p-4 text-center ${over ? "bg-primary-soft" : ""}`}
        >
          <Upload className="size-5 text-muted-foreground" aria-hidden="true" />
          <span>{tr("Drop .eml or .mbox files here, or")}</span>
          <label className="cursor-pointer">
            <input type="file" multiple accept=".eml,.mbox,.mbx,message/rfc822,application/mbox" className="sr-only" disabled={!!busy} onChange={(e) => (void take(Array.from(e.target.files ?? [])), (e.target.value = ""))} />
            <span className="inline-flex h-(--control-h-sm) items-center rounded-md border px-3 hover:bg-accent">{tr("Choose files")}</span>
          </label>
        </div>
      </section>
      <section className="grid gap-2" aria-labelledby="exp-h">
        <h3 id="exp-h" className="font-semibold">{tr("Export")}</h3>
        <p className="text-muted-foreground">{tr("Save a folder as one .mbox file that other mail programs open (up to 5,000 messages at a time). To save only some conversations, select them in the list and choose Export from the selection's menu.")}</p>
        <div className="flex flex-wrap items-center gap-2">
          {select(out, setOut, tr("Folder to export"))}
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void exportFolder()}>
            <Download aria-hidden="true" /> {tr("Export as .mbox")}
          </Button>
        </div>
      </section>
      {busy && (
        <div role="status" className="grid gap-1">
          <span>{tr("{what}: {done} of {total}", { what: busy.what, done: busy.done, total: busy.total })}</span>
          <Progress value={(busy.done / busy.total) * 100} aria-label={busy.what} />
        </div>
      )}
    </div>
  );
}
