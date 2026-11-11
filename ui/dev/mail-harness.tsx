// Development only: Mail's real components (list, reader, composer) on fixture data, for looking at the
// layout in a browser when the workspace has no hosted mailbox. Served by the Vite dev server at
// /dev/mail-harness.html?s=inbox|open|compose|empty|failed|loading|locked; it is not imported by the app
// and not an entry of the build, so it is not in a release. No server is called: fetch is answered here.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { ConfirmHost, Toaster } from "@ferrum/kit";
import "../src/styles.css";
import { MailPage } from "../src/Mail";

const scenario = new URLSearchParams(location.search).get("s") ?? "inbox";
const ACCOUNT = "a1";
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const who = (name: string, email: string) => [{ name, email }];
const E = (id: string, thread: string, from: [string, string], subject: string, preview: string, mins: number, keywords: Record<string, boolean>, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: thread,
  mailboxIds: { inbox: true },
  keywords,
  from: who(...from),
  to: who("Demo Admin", "admin@demo.test"),
  subject,
  receivedAt: ago(mins),
  preview,
  hasAttachment: false,
  ...extra,
});
const emails = scenario === "empty"
  ? []
  : [
      E("e1", "t1", ["Priya Nair", "priya@supplier.test"], "Purchase order PO-0042 needs your approval", "Hi, the revised quantities are attached. Please confirm before Friday so we can book the carrier.", 6, {}, { hasAttachment: true }),
      E("e2", "t2", ["Stock alerts", "alerts@demo.test"], "Low stock: 12 items below reorder level", "These items fell under their reorder level overnight.", 55, { $seen: true, $flagged: true }),
      E("e3", "t3", ["Marcus Lindqvist", "marcus@client.test"], "Re: Supplier review", "Thanks, that works for us. I will send the minutes after the call and we can pick it up next week.", 130, {}),
      E("e3b", "t3", ["Demo Admin", "admin@demo.test"], "Re: Supplier review", "Great, see you then.", 190, { $seen: true }),
      E("e4", "t4", ["Aiko Tanaka", "aiko@demo.test"], "Store managers stand-up moved to 10:30", "Heads up: tomorrow's stand-up starts half an hour later.", 400, { $seen: true }),
      E("e5", "t5", ["Billing", "billing@vendor.test"], "Invoice INV-2026-1187", "Your invoice for October is ready. Payment is due in 14 days.", 1500, { $seen: true }, { hasAttachment: true }),
      E("e6", "t6", ["An extremely long sender display name that has to be cut with an ellipsis", "long@sender.test"], "A subject that is also rather long so that it has to be truncated by the list instead of wrapping onto a second line", "A preview that goes on and on and on and on and on and on and on and on and on.", 2900, { $seen: true }),
      E("e7", "t7", ["Sam Okafor", "sam@demo.test"], "(no subject)", "", 4000, { $seen: true }),
    ];
const threads = [...new Set(emails.map((e) => e.threadId))].map((id) => ({ id, emailIds: emails.filter((e) => e.threadId === id).map((e) => e.id) }));
const boxes = [
  { id: "inbox", name: "Inbox", role: "inbox", sortOrder: 1, totalEmails: emails.length, unreadEmails: emails.filter((e) => !e.keywords.$seen).length },
  { id: "drafts", name: "Drafts", role: "drafts", sortOrder: 2, totalEmails: 1, unreadEmails: 0 },
  { id: "sent", name: "Sent", role: "sent", sortOrder: 3, totalEmails: 12, unreadEmails: 0 },
  { id: "archive", name: "Archive", role: "archive", sortOrder: 4, totalEmails: 40, unreadEmails: 0 },
  { id: "junk", name: "Junk", role: "junk", sortOrder: 5, totalEmails: 0, unreadEmails: 0 },
  { id: "trash", name: "Trash", role: "trash", sortOrder: 6, totalEmails: 3, unreadEmails: 0 },
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const answer = (calls: [string, Record<string, any>, string][]) => {
  const out: [string, unknown, string][] = [];
  let queried: string[] = [];
  let got: typeof emails = [];
  for (const [name, args, id] of calls) {
    if (name === "Mailbox/get") out.push([name, { list: boxes }, id]);
    else if (name === "Email/query") {
      const seen = new Set<string>();
      queried = emails.filter((e) => (!args.filter?.text || (e.subject + e.preview).toLowerCase().includes(String(args.filter.text).toLowerCase())) && !seen.has(e.threadId) && seen.add(e.threadId)).map((e) => e.id);
      out.push([name, { ids: queried, total: queried.length }, id]);
    } else if (name === "Email/get") {
      const ids: string[] = args.ids ?? (args["#ids"]?.path === "/ids" ? queried : []);
      got = ids.map((i) => emails.find((e) => e.id === i)).filter(Boolean) as typeof emails;
      if (args.properties?.length === 1 && args.properties[0] === "threadId") out.push([name, { list: got.map((e) => ({ id: e.id, threadId: e.threadId })) }, id]);
      else out.push([name, { list: got }, id]);
    } else if (name === "Thread/get") out.push([name, { list: threads.filter((t) => got.some((e) => e.threadId === t.id)) }, id]);
    else if (name === "Email/set") out.push([name, { updated: {}, notUpdated: {} }, id]);
    else out.push([name, { list: [] }, id]);
  }
  return { methodResponses: out };
};
const message = (id: string) => {
  const e = emails.find((x) => x.id === id)!;
  return { ...e, cc: null, bcc: null, replyTo: null, sentAt: e.receivedAt, messageId: [id], references: null, html: `<p>${e.preview}</p><p>Kind regards,<br>${e.from?.[0]?.name}</p>`, text: e.preview, remote_images: 0, attachments: e.hasAttachment ? [{ blobId: "b1", name: "po-0042.pdf", type: "application/pdf", size: 183_000 }] : [] };
};
const real = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!url.pathname.startsWith("/api/")) return real(input, init);
  if (scenario === "loading") return new Promise<Response>(() => undefined);
  if (url.pathname === "/api/app/comms/mail") {
    if (scenario === "locked") return json({ error: "forbidden" }, 403);
    return json({ username: "admin@demo.test", accounts: { [ACCOUNT]: { name: "admin@demo.test", isPersonal: true, isReadOnly: false } }, primaryAccounts: { "urn:ietf:params:jmap:mail": ACCOUNT }, capabilities: {} });
  }
  if (url.pathname.endsWith("/jmap")) {
    if (scenario === "failed") return json({ error: "unavailable", message: "The mail server is temporarily unavailable." }, 503);
    return json(answer(JSON.parse(String(init?.body)).methodCalls));
  }
  const m = url.pathname.match(/\/message\/[^/]+\/([^/]+)$/);
  if (m) return json(message(m[1]!));
  if (url.pathname.includes("/identities")) return json({ identities: [] });
  return json({ users: [], entities: [] });
};

const start = scenario === "open" ? "/mail/inbox/e3" : scenario === "compose" ? "/mail/compose" : "/mail";
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })}>
    <MemoryRouter initialEntries={[start]}>
      <Routes>
        <Route path="/mail/compose" element={<MailPage compose />} />
        <Route path="/mail/:mailbox?/:email?" element={<MailPage />} />
      </Routes>
    </MemoryRouter>
    <Toaster />
    <ConfirmHost />
  </QueryClientProvider>,
);
