import { describe, expect, it } from "vitest";
import { frameDocument, parseAddresses, quote, replyRecipients, replySubject, sizeLabel, sortMailboxes, type Mailbox } from "./mail";

const box = (id: string, role: string | null, sortOrder = 0, name = id): Mailbox => ({ id, name, role, sortOrder, totalEmails: 0, unreadEmails: 0 });

describe("mail", () => {
  it("orders folders the usual way, then the person's own by order and name", () => {
    const sorted = sortMailboxes([box("z", null, 1), box("t", "trash"), box("a", null, 1), box("i", "inbox"), box("s", "sent"), box("j", "junk"), box("d", "drafts")]);
    expect(sorted.map((m) => m.id)).toEqual(["i", "d", "s", "j", "t", "a", "z"]);
  });

  it("reads typed addresses and points out what is not one", () => {
    expect(parseAddresses(`Ann Lee <ann@acme.com>; bob@acme.com,\n"Carol, CFO" <carol@acme.com>, nope, x@y`)).toEqual({
      list: [{ name: "Ann Lee", email: "ann@acme.com" }, { email: "bob@acme.com" }, { name: "Carol, CFO", email: "carol@acme.com" }],
      bad: ["nope", "x@y"],
    });
  });

  it("answers the sender, or everyone but oneself", () => {
    const m = {
      from: [{ name: "Ann", email: "ann@acme.com" }],
      replyTo: null,
      to: [{ email: "me@acme.com" }, { email: "bob@acme.com" }],
      cc: [{ email: "ANN@acme.com" }, { email: "cat@acme.com" }],
    };
    expect(replyRecipients(m, "me@acme.com", false)).toEqual({ to: [{ name: "Ann", email: "ann@acme.com" }], cc: [] });
    expect(replyRecipients(m, "Me@Acme.com", true)).toEqual({ to: [{ name: "Ann", email: "ann@acme.com" }], cc: [{ email: "bob@acme.com" }, { email: "cat@acme.com" }] });
    expect(replyRecipients({ ...m, replyTo: [{ email: "list@acme.com" }] }, "me@acme.com", false).to).toEqual([{ email: "list@acme.com" }]);
    // Answering one's own sent mail goes to the people it went to.
    expect(replyRecipients({ ...m, from: [{ email: "me@acme.com" }] }, "me@acme.com", false).to).toEqual([{ email: "bob@acme.com" }]);
  });

  it("prefixes subjects once and quotes the original", () => {
    expect(replySubject("Q3 numbers", "reply")).toBe("Re: Q3 numbers");
    expect(replySubject("RE: Q3 numbers", "reply")).toBe("RE: Q3 numbers");
    expect(replySubject("Fw: Q3", "forward")).toBe("Fw: Q3");
    expect(replySubject(null, "forward")).toBe("Fwd: ");
    const m = { from: [{ name: "Ann", email: "ann@acme.com" }], to: [{ email: "me@acme.com" }], receivedAt: "", subject: "Q3", text: "Hi\nNumbers attached.\n\n" };
    expect(quote(m, "reply", "1 Nov 2026")).toBe("\n\nOn 1 Nov 2026, Ann wrote:\n> Hi\n> Numbers attached.");
    expect(quote(m, "forward", "1 Nov 2026")).toContain("From: Ann <ann@acme.com>\nDate: 1 Nov 2026\nSubject: Q3\nTo: me@acme.com\n\nHi");
  });

  it("frames a message with no scripts and remote images only on request", () => {
    const doc = frameDocument("<p>Hi</p>", false);
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("img-src data:;");
    expect(doc).not.toContain("script-src");
    expect(frameDocument("<p>Hi</p>", true)).toContain("img-src data: https: http:;");
    expect(sizeLabel(900)).toBe("900 B");
    expect(sizeLabel(12_800)).toBe("13 KB");
    expect(sizeLabel(3_500_000)).toBe("3.3 MB");
  });
});
