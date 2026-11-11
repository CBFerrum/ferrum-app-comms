// @vitest-environment jsdom
// What a written message goes out as: its subject, HTML, plain text, MIME structure and hold.

import { describe, expect, it } from "vitest";
import {
  answerSubject,
  cleanHtml,
  directionOf,
  emailCreate,
  envelope,
  fileProblem,
  fromEditor,
  holdParams,
  htmlToText,
  mailBody,
  mentionsAttachment,
  MAX_FILE,
  quoteHtml,
  recentRecipients,
  richOf,
  schedulePresets,
  structure,
  suggest,
  textToHtml,
  threadOf,
} from "./compose";
import { replyRecipients } from "./mail";

describe("subjects of answers", () => {
  it("adds Re: and Fwd: once, recognising other languages' prefixes", () => {
    expect(answerSubject("Q3 numbers", "reply")).toBe("Re: Q3 numbers");
    expect(answerSubject("RE: Q3 numbers", "reply")).toBe("RE: Q3 numbers");
    expect(answerSubject("AW: Angebot", "reply")).toBe("AW: Angebot");
    expect(answerSubject("SV: Möte", "reply")).toBe("SV: Möte");
    expect(answerSubject("رد: الميزانية", "reply")).toBe("رد: الميزانية");
    expect(answerSubject("回复：预算", "reply")).toBe("回复：预算");
    expect(answerSubject("Re[2]: Q3", "reply")).toBe("Re[2]: Q3");
    expect(answerSubject("Fwd: Q3", "reply")).toBe("Re: Fwd: Q3");
    expect(answerSubject("Re: Q3", "forward")).toBe("Fwd: Re: Q3");
    expect(answerSubject("WG: Angebot", "forward")).toBe("WG: Angebot");
    expect(answerSubject("TR: Devis", "forward")).toBe("TR: Devis");
    expect(answerSubject("Fw: Q3", "forward")).toBe("Fw: Q3");
    expect(answerSubject("Return of goods", "reply")).toBe("Re: Return of goods");
    expect(answerSubject("Rebate", "forward")).toBe("Fwd: Rebate");
    expect(answerSubject(null, "forward")).toBe("Fwd: ");
  });
});

describe("who an answer goes to", () => {
  const m = { from: [{ name: "Priya", email: "priya@x.test" }], to: [{ email: "me@x.test" }, { email: "omar@x.test" }], cc: [{ email: "ann@y.test" }], replyTo: null };
  it("Reply: the sender only; Reply all: the sender, then To and Cc without oneself", () => {
    expect(replyRecipients(m, "me@x.test", false)).toEqual({ to: [{ name: "Priya", email: "priya@x.test" }], cc: [] });
    expect(replyRecipients(m, "me@x.test", true)).toEqual({ to: [{ name: "Priya", email: "priya@x.test" }], cc: [{ email: "omar@x.test" }, { email: "ann@y.test" }] });
  });
  it("leaves out every address of one's own, not only the account's", () => {
    expect(replyRecipients({ ...m, to: [{ email: "Sales@X.test" }, { email: "omar@x.test" }] }, ["me@x.test", "sales@x.test"], true).cc).toEqual([{ email: "omar@x.test" }, { email: "ann@y.test" }]);
  });
  it("an answer to one's own message goes to its recipients (Reply: its To; Reply all: To and Cc)", () => {
    const own = { ...m, from: [{ email: "me@x.test" }], to: [{ email: "priya@x.test" }, { email: "omar@x.test" }] };
    expect(replyRecipients(own, "me@x.test", false)).toEqual({ to: [{ email: "priya@x.test" }, { email: "omar@x.test" }], cc: [] });
    expect(replyRecipients(own, "me@x.test", true)).toEqual({ to: [{ email: "priya@x.test" }, { email: "omar@x.test" }], cc: [{ email: "ann@y.test" }] });
  });
  it("Reply-To wins over From", () => {
    expect(replyRecipients({ ...m, replyTo: [{ email: "list@x.test" }] }, "me@x.test", false).to).toEqual([{ email: "list@x.test" }]);
  });
});

describe("threading", () => {
  it("answers and forwards carry In-Reply-To and the chain of References", () => {
    expect(threadOf({ messageId: ["c@x"], references: ["a@x", "b@x"] })).toEqual({ inReplyTo: ["c@x"], references: ["a@x", "b@x", "c@x"] });
    expect(threadOf({ messageId: ["c@x"], references: null, inReplyTo: ["b@x"] })).toEqual({ inReplyTo: ["c@x"], references: ["b@x", "c@x"] });
    expect(threadOf({ messageId: null })).toEqual({});
    const long = threadOf({ messageId: ["z@x"], references: Array.from({ length: 30 }, (_, i) => `${i}@x`) });
    expect(long.references).toHaveLength(20);
    expect(long.references![0]).toBe("0@x");
    expect(long.references!.at(-1)).toBe("z@x");
  });
});

describe("HTML going out", () => {
  it("cleans what another program could run or would draw from our stylesheet", () => {
    const out = cleanHtml(
      `<div class="x gmail_quote" onclick="a()" style="color:red;position:fixed;background:url(https://t.example/p)"><script>alert(1)</script><style>p{}</style><a href="javascript:x()">j</a><a href="https://ok.example/a">ok</a><img src="https://t.example/i.png"><img src="file:///etc"><form><input></form><custom-el>kept text</custom-el><!-- note --></div>`,
    );
    expect(out).toBe(`<div class="gmail_quote" style="color:red"><a>j</a><a href="https://ok.example/a">ok</a><img src="https://t.example/i.png"><img>kept text</div>`);
  });

  it("turns the editor's paragraphs into lines mail programs draw alike", () => {
    expect(fromEditor(`<p style="text-align: center">Hi <strong>Omar</strong></p><p></p><ul><li><p>one</p></li><li><p>two</p><p>more</p></li></ul><blockquote><p>q</p></blockquote><p><a target="_blank" rel="noopener noreferrer nofollow" href="https://x.test">x</a></p>`)).toBe(
      `<div style="text-align: center">Hi <strong>Omar</strong></div><div><br></div><ul><li>one</li><li>two<br>more</li></ul><blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex"><div>q</div></blockquote><div><a href="https://x.test">x</a></div>`,
    );
  });

  it("makes the text part read well: lines, lists, links with their address, quotes", () => {
    const text = htmlToText(
      `<div>Hello Omar,</div><div><br></div><div>The plan:</div><ol><li>Review the <a href="https://docs.test/plan">plan</a></li><li>Book the <b>room</b><ul><li>Banyan</li></ul></li></ol><div>Write to <a href="mailto:p@x.test">p@x.test</a></div><blockquote><p>Earlier words</p><p>more</p></blockquote>`,
    );
    expect(text).toBe("Hello Omar,\n\nThe plan:\n1. Review the plan <https://docs.test/plan>\n2. Book the room\n  - Banyan\nWrite to p@x.test\n> Earlier words\n>\n> more");
  });

  it("builds one body: words, signature, quote; images as cid parts; direction from the words", () => {
    const body = mailBody({
      body: `<p>مرحبا عمر</p><p><img src="/api/app/comms/mail/blob/d/B1?name=chart.png" data-cid="ii_1@ferrum" data-blob-id="B1" data-type="image/png" data-name="chart.png" width="240"></p><p><img src="data:image/png;base64,AAAA"></p>`,
      signature: "<b>Priya</b>",
      quote: quoteHtml("reply", { from: [{ name: "Omar Haddad", email: "omar@x.test" }] }, "12 Nov 2026, 10:02", `<div>Earlier <img data-remote="https://cdn.test/logo.png"></div>`),
    });
    expect(body.inline).toEqual([{ blobId: "B1", cid: "ii_1@ferrum", type: "image/png", name: "chart.png" }]);
    expect(body.missing).toEqual(["data:image/png;base64,AAAA"]);
    expect(body.html.startsWith(`<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;font-size:14px">`)).toBe(true);
    expect(body.html).toContain(`<img src="cid:ii_1@ferrum" width="240" alt="chart.png">`);
    expect(body.html).toContain(`<img src="https://cdn.test/logo.png">`);
    expect(body.html).not.toMatch(/data-|\/api\/|base64/);
    expect(body.html).toContain(`<div class="gmail_signature" dir="auto">-- <br><b>Priya</b></div>`);
    expect(body.html).toContain(`On 12 Nov 2026, 10:02, Omar Haddad &lt;omar@x.test&gt; wrote:`);
    expect(body.text).toBe("مرحبا عمر\n[image: chart.png]\n\n-- \nPriya\n\nOn 12 Nov 2026, 10:02, Omar Haddad <omar@x.test> wrote:\n> Earlier");
  });

  it("forwards with the original's header block and its words as they were", () => {
    const q = quoteHtml("forward", { from: [{ name: "Ann", email: "ann@y.test" }], to: [{ email: "me@x.test" }], subject: "Q3 <draft>" }, "1 Nov 2026", "<p>Numbers</p>");
    expect(htmlToText(q)).toBe("---------- Forwarded message ---------\nFrom: Ann <ann@y.test>\nDate: 1 Nov 2026\nSubject: Q3 <draft>\nTo: me@x.test\n\nNumbers");
  });

  it("draws a signature's lines as a browser does: no empty line after the \"-- \"", () => {
    const body = mailBody({ body: "<p>Thanks</p>", signature: "<div><strong>Priya Nair</strong></div><div>Operations</div>" });
    expect(body.text).toBe("Thanks\n\n-- \nPriya Nair\nOperations");
  });

  it("plain text and direction", () => {
    expect(textToHtml("a <b>\n\nc")).toBe("<div>a &lt;b&gt;</div><div><br></div><div>c</div>");
    expect([directionOf("  123 مرحبا Hello"), directionOf("Hello مرحبا"), directionOf("नमस्ते"), directionOf("")]).toEqual(["rtl", "ltr", "ltr", "ltr"]);
  });

  it("an answered message's images stay references to its own parts, remote ones are not loaded while writing", () => {
    const html = richOf(
      {
        htmlBody: [{ partId: "1", type: "text/html" }],
        bodyValues: { "1": { value: `<p>Logo <img src="cid:<logo@acme>"> and <img src="https://track.test/p.gif"> <img src="cid:gone"></p>` } },
        attachments: [{ blobId: "Blogo", cid: "<logo@acme>", type: "image/png", name: "logo.png", disposition: "inline" }],
      },
      (b, n, t) => `/blob/${b}?name=${n}&type=${t}`,
    );
    expect(html).toMatch(/^<p>Logo <img src="\/blob\/Blogo\?name=logo\.png&amp;type=image\/png" data-cid="ii_[0-9a-f]+@ferrum" data-blob-id="Blogo" data-type="image\/png" data-name="logo\.png"> and <img data-remote="https:\/\/track\.test\/p\.gif"> <\/p>$/);
  });
});

describe("the message the mail server takes", () => {
  const files = [{ blobId: "F1", name: "plan.pdf", type: "application/pdf", size: 10 }];
  const inline = [{ blobId: "I1", cid: "ii_1@ferrum", type: "image/png", name: "chart.png" }];
  it("mixed ⊃ related ⊃ alternative (text, html), each part a blob reference", () => {
    expect(structure({ text: "Hi", html: "<div>Hi</div>", inline, files })).toEqual({
      bodyValues: { t: { value: "Hi" }, h: { value: "<div>Hi</div>" } },
      bodyStructure: {
        type: "multipart/mixed",
        subParts: [
          {
            type: "multipart/related",
            subParts: [
              { type: "multipart/alternative", subParts: [{ partId: "t", type: "text/plain" }, { partId: "h", type: "text/html" }] },
              { blobId: "I1", type: "image/png", name: "chart.png", cid: "ii_1@ferrum", disposition: "inline" },
            ],
          },
          { blobId: "F1", type: "application/pdf", name: "plan.pdf", disposition: "attachment" },
        ],
      },
    });
  });
  it("plain text alone when written as plain text; no empty wrappers", () => {
    expect(structure({ text: "Hi" })).toEqual({ bodyValues: { t: { value: "Hi" } }, bodyStructure: { partId: "t", type: "text/plain" } });
    expect(structure({ text: "Hi", inline }).bodyStructure).toEqual({ partId: "t", type: "text/plain" });
    expect(structure({ text: "Hi", html: "<b>Hi</b>" }).bodyStructure).toEqual({ type: "multipart/alternative", subParts: [{ partId: "t", type: "text/plain" }, { partId: "h", type: "text/html" }] });
  });
  it("the whole creation: addresses, subject, threading, draft keywords", () => {
    const e = emailCreate(
      { from: { name: "", email: "me@x.test" }, to: [{ name: "Omar", email: "omar@x.test" }], cc: [], bcc: [{ email: "b@x.test" }], subject: "  Plan ", text: "Hi", html: "<div>Hi</div>", files, inReplyTo: ["c@x"], references: ["a@x", "c@x"] },
      "D",
    );
    expect(e).toMatchObject({ mailboxIds: { D: true }, keywords: { $seen: true, $draft: true }, from: [{ email: "me@x.test" }], to: [{ name: "Omar", email: "omar@x.test" }], bcc: [{ email: "b@x.test" }], subject: "Plan", inReplyTo: ["c@x"], references: ["a@x", "c@x"] });
    expect(Object.keys(e)).not.toContain("textBody");
    expect(Object.keys(e)).not.toContain("cc");
    expect(Object.keys(emailCreate({ from: { email: "me@x.test" }, to: [], cc: [], bcc: [], subject: "", text: "" }, "D"))).not.toContain("inReplyTo");
  });
});

describe("holding a message back", () => {
  it("HOLDFOR for undo, HOLDUNTIL for a time, nothing when undo is off", () => {
    expect(holdParams({ seconds: 10 })).toEqual({ HOLDFOR: "10" });
    expect(holdParams({ seconds: 0 })).toBeNull();
    expect(holdParams({ until: new Date("2026-11-13T02:30:00.000Z") })).toEqual({ HOLDUNTIL: "2026-11-13T02:30:00Z" });
    expect(envelope("me@x.test", { to: [{ email: "A@x.test" }], cc: [{ email: "a@x.test" }], bcc: [{ email: "b@x.test" }] }, { HOLDFOR: "10" })).toEqual({
      mailFrom: { email: "me@x.test", parameters: { HOLDFOR: "10" } },
      rcptTo: [{ email: "A@x.test" }, { email: "b@x.test" }],
    });
  });
  it("offers tomorrow morning, this or tomorrow afternoon, Monday morning, on the person's clock", () => {
    // The person's clock is UTC+5:30; it is Thursday 12 Nov 2026, 09:00 there.
    const wall = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 16);
    const moment = (local: string) => new Date(new Date(`${local}:00Z`).getTime() - 330 * 60_000).toISOString();
    const now = new Date("2026-11-12T03:30:00Z");
    const p = schedulePresets(now, wall, moment);
    expect(p.map((x) => [x.label, wall(x.at.toISOString())])).toEqual([
      ["Tomorrow morning", "2026-11-13T08:00"],
      ["This afternoon", "2026-11-12T13:00"],
      ["Monday morning", "2026-11-16T08:00"],
    ]);
    // Sunday evening: tomorrow is Monday, so Monday morning is not offered twice.
    const sunday = schedulePresets(new Date("2026-11-15T14:00:00Z"), wall, moment);
    expect(sunday.map((x) => x.label)).toEqual(["Tomorrow morning", "Tomorrow afternoon"]);
  });
});

describe("before sending, and recipients", () => {
  it("notices a file mentioned and not attached, in several languages", () => {
    for (const w of ["Please find the report attached.", "See the attachment", "पत्र संलग्न है", "التقرير مرفق", "Anbei der Anhang", "ci-joint le devis"]) expect(mentionsAttachment(w)).toBe(true);
    for (const w of ["The attaché arrives Monday", "Thanks for lunch", "unattached"]) expect(mentionsAttachment(w)).toBe(false);
  });
  it("refuses a file larger than the platform takes, or too much together", () => {
    expect(fileProblem(MAX_FILE + 1, 0, 50_000_000)).toContain("at most 32 MB");
    expect(fileProblem(20_000_000, 40_000_000, 50_000_000)).toContain("at most 50 MB of files");
    expect(fileProblem(1000, 0, 50_000_000)).toBeNull();
  });
  it("offers colleagues and people written to before, most often first, never twice or oneself", () => {
    const recent = recentRecipients(
      [{ to: [{ email: "ann@acme.test" }], cc: [{ email: "me@x.test" }] }, { to: [{ name: "Bob Ray", email: "bob@acme.test" }] }, { to: [{ email: "bob@acme.test" }, { email: "Ann@acme.test", name: "Ann Lee" }] }],
      ["me@x.test"],
    );
    expect(recent).toEqual([{ name: "Ann Lee", email: "ann@acme.test" }, { name: "Bob Ray", email: "bob@acme.test" }]);
    const people = [{ full_name: "Omar Haddad", email: "omar@x.test" }, { full_name: "Anil Rao", email: "anil@x.test" }];
    expect(suggest("an", people, recent, ["anil@x.test"]).map((s) => [s.email, s.source])).toEqual([["ann@acme.test", "recent"]]);
    expect(suggest("a", people, recent, []).map((s) => s.email)).toEqual(["anil@x.test", "ann@acme.test", "bob@acme.test", "omar@x.test"]);
    expect(suggest("", people, recent, [])).toEqual([]);
  });
});

import { quoteForEditor, quoteHtml as quoteHtmlForEditor } from "./compose";
describe("an opened quote", () => {
  it("loses the breaks that would become empty lines in the editor, keeps the words", () => {
    const reply = quoteHtmlForEditor("reply", { from: [{ name: "Priya", email: "p@x.example" }] }, "Tue", "<div>Hi<br></div>");
    const r = quoteForEditor(reply);
    expect(r.startsWith('<div class="gmail_quote">')).toBe(true);
    expect(r).toContain("wrote:</div><blockquote");
    expect(r).toContain("<div>Hi<br></div>");
    const fwd = quoteForEditor(quoteHtmlForEditor("forward", { from: [{ email: "p@x.example" }], subject: "S" }, "Tue", "<p>body</p>"));
    expect(fwd).toMatch(/To: <\/div><p>body<\/p>/);
  });
});
