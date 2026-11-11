// Mail wave 3: the managed Sieve script (blocked senders, filters, settings), its escaping and its round trip.

import { describe, expect, it } from "vitest";
import { EMPTY_DATA, buildScript, cleanRule, forwardsTo, parseData, ruleFromQuery, rulePatch, ruleProblem, ruleQuery, sieveString, type Folders, type MailData } from "./filters";
import { tokenize } from "./search";

const F: Folders = {
  inbox: { id: "a", name: "Inbox" },
  junk: { id: "c", name: "Junk Mail" },
  trash: { id: "b", name: "Deleted Items" },
  archive: { id: "h", name: "Archive" },
  byId: { k: { id: "k", name: 'Invoices "2026"' }, a: { id: "a", name: "Inbox" } },
};
const data = (d: Partial<MailData>): MailData => ({ ...EMPTY_DATA, ...d });

describe("Sieve strings", () => {
  it("escapes quotes and backslashes and drops line breaks", () => {
    expect(sieveString('a"b')).toBe('"a\\"b"');
    expect(sieveString("a\\b")).toBe('"a\\\\b"');
    expect(sieveString("a\r\nb")).toBe('"a  b"');
    expect(sieveString("*?${hex:41}")).toBe('"*?${hex:41}"');
  });
});

describe("the script", () => {
  it("files blocked senders to Spam first, then the filters, then the vacation reply", () => {
    const s = buildScript(
      data({
        blocked: ["Bad@X.example"],
        rules: [
          cleanRule({ id: "r1", when: { from: "bank.example" }, then: { folder: "k", skipInbox: true, star: true } }),
          cleanRule({ id: "r2", when: { list: "news.example", larger: 1000 }, then: { read: true, skipInbox: true } }),
          cleanRule({ id: "r3", when: { to: "boss@demo.test" }, then: { forward: "me@home.example" } }),
          cleanRule({ id: "r4", when: { subject: "Important" }, then: { neverSpam: true } }),
          cleanRule({ id: "r5", on: false, when: { words: "x" }, then: { trash: true } }),
        ],
        vacation: true,
      }),
      F,
    );
    expect(s).toContain('if address :is "from" ["bad@x.example"] { fileinto :mailboxid "c" "Junk Mail"; stop; }');
    expect(s).toContain('if allof (header :contains "from" "bank.example", not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50") {');
    expect(s).toContain('  addflag "\\\\Flagged";\n  fileinto :mailboxid "k" "Invoices \\"2026\\"";');
    expect(s).toContain('header :contains "list-id" "news.example", size :over 1000');
    expect(s).toContain('  addflag "\\\\Seen";\n  fileinto :mailboxid "h" "Archive";');
    expect(s).toContain('redirect :copy "me@home.example";');
    expect(s).toContain('if allof (header :contains "subject" "Important") {\n  fileinto :mailboxid "a" "Inbox";');
    expect(s).not.toContain("Filter r5");
    expect(s).toContain('if not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50" { include :personal :optional "vacation"; }');
    expect(s).toMatch(/require \["fileinto", "mailboxid", "copy", "imap4flags", "relational", "spamtest", "spamtestplus", "comparator-i;ascii-numeric", "include"\];/);
    expect(s.indexOf("address :is")).toBeLessThan(s.indexOf("Filter r1"));
    expect(s.indexOf("Filter r4")).toBeLessThan(s.indexOf("include :personal"));
  });

  it("keeps a filed copy in the inbox unless the inbox is skipped", () => {
    const s = buildScript(data({ rules: [cleanRule({ id: "r", when: { from: "x" }, then: { folder: "k" } })] }), F);
    expect(s).toContain('fileinto :copy :mailboxid "k"');
    expect(s).toContain('"copy"');
  });

  it("an empty one needs nothing and does nothing", () => {
    const s = buildScript(EMPTY_DATA, F);
    expect(s).not.toContain("require");
    expect(s).not.toContain("if ");
  });

  it("hostile values stay inside their strings", () => {
    const evil = 'x" { discard; } if true { redirect "a@evil.example"; } #\r\nstop; \\';
    const s = buildScript(data({ rules: [cleanRule({ id: "r", when: { from: evil, subject: "*", words: "a\\b\"c" }, then: { star: true } })] }), F);
    const code = s.split("\n").filter((l) => !l.startsWith("#"));
    // Outside the quoted strings nothing of the value is left.
    const bare = code.join("\n").replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(bare).not.toContain("discard");
    expect(bare).not.toContain("evil");
    expect(code.every((l) => !/\r/.test(l))).toBe(true);
  });
});

describe("the data round trip", () => {
  it("reads back what it wrote, and drops what is not well formed", () => {
    const d = data({
      blocked: ["a@x.example"],
      rules: [cleanRule({ id: "r1", when: { from: 'a"b\\c' }, then: { folder: "k" } })],
      prefs: { undoSeconds: 10, density: "compact", notify: "people", signatureInReplies: false },
      saved: [{ id: "s1", name: "Bank", query: "from:bank has:attachment" }],
      colors: { k: "success" },
      vacation: true,
    });
    expect(parseData(buildScript(d, F))).toEqual(d);
    expect(parseData('# ferrum: {"rules":[{"when":{},"then":{"star":true}}],"colors":{"k":"url(x)","../x":"success"},"prefs":{"density":"huge","undoSeconds":999},"blocked":["nope"]}')).toEqual(EMPTY_DATA);
    expect(parseData("# ferrum: {not json")).toEqual(EMPTY_DATA);
    expect(parseData(null)).toEqual(EMPTY_DATA);
  });
  it("reads a wave-1 blocked-senders script", () => {
    expect(parseData('# Ferrum Mail: blocked senders.\nrequire ["fileinto"];\n# blocked: a@x.example\n# blocked: B@y.example\n').blocked).toEqual(["a@x.example", "b@y.example"]);
  });
});

describe("checks and helpers", () => {
  const fwd = (id: string, to: string) => cleanRule({ id, when: { from: "x" }, then: { forward: to } });
  it("refuses a forwarding loop, a second forward and a bad address", () => {
    expect(ruleProblem(fwd("a", "admin@demo.test"), ["Admin@demo.test"], [])).toBe("loop");
    expect(ruleProblem(fwd("a", "x@y.example"), [], [fwd("b", "z@y.example")])).toBe("one-forward");
    expect(ruleProblem(fwd("a", "not an address"), [], [])).toBe("address");
    expect(ruleProblem(cleanRule({ when: {}, then: { star: true } }), [], [])).toBe("condition");
    expect(ruleProblem(cleanRule({ when: { from: "x" }, then: {} }), [], [])).toBe("action");
    expect(forwardsTo(data({ rules: [fwd("a", "x@y.example"), { ...fwd("b", "z@y.example"), on: false }] }))).toEqual(["x@y.example"]);
  });
  it("a filter from a search takes what a filter can test", () => {
    expect(ruleFromQuery(tokenize('from:bank subject:"monthly statement" urgent -spam is:unread')).when).toEqual({ from: "bank", subject: "monthly statement", words: "urgent" });
  });
  it("the query and patch that apply a filter to mail already there", () => {
    expect(ruleQuery({ from: "bank", larger: 10 })).toEqual({ operator: "AND", conditions: [{ from: "bank" }, { minSize: 10 }] });
    expect(rulePatch({ folder: "k", skipInbox: true, star: true }, F, { a: true })).toEqual({ mailboxIds: { k: true }, "keywords/$flagged": true });
    expect(rulePatch({ folder: "k" }, F, { a: true })).toEqual({ "mailboxIds/k": true });
    expect(rulePatch({ skipInbox: true, read: true }, F, { a: true })).toEqual({ "keywords/$seen": true, "mailboxIds/a": null, "mailboxIds/h": true });
    expect(rulePatch({ neverSpam: true }, F, { c: true })).toEqual({ "mailboxIds/c": null, "mailboxIds/a": true, "keywords/$junk": null, "keywords/$notjunk": true });
    expect(rulePatch({ forward: "x@y.example" }, F, { a: true })).toBeNull();
  });
});
