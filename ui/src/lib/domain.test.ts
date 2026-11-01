import { describe, expect, it } from "vitest";
import { headline, shown, zoneName, type Check } from "./domain";

const check = (id: string, status: Check["status"]): Check => ({ id, title: id, importance: "optional", why: "", kind: "TXT", name: "n", expected: "v", found: [], status, note: null, fix: null });

describe("the mail domain's health", () => {
  it("says in a sentence how it stands", () => {
    expect(headline({ summary: { ok: 9, total: 9, required_wrong: 0 } })).toBe("All 9 checks pass.");
    expect(headline({ summary: { ok: 5, total: 9, required_wrong: 0 } })).toBe("5 of 9 checks pass.");
    expect(headline({ summary: { ok: 5, total: 9, required_wrong: 1 } })).toBe("5 of 9 checks pass. One record that mail needs is missing or wrong, so mail from this domain is likely to land in spam.");
    expect(headline({ summary: { ok: 4, total: 9, required_wrong: 2 } })).toContain("2 records that mail needs are missing or wrong");
    expect(headline({})).toBe("There is nothing to check yet.");
    expect(headline({ summary: { ok: 0, total: 0, required_wrong: 0 } })).toBe("There is nothing to check yet.");
  });

  it("lists only the problems when asked, what could not be checked among them", () => {
    const all = [check("a", "ok"), check("b", "missing"), check("c", "unknown"), check("d", "differs")];
    expect(shown(all, false)).toHaveLength(4);
    expect(shown(all, true).map((c) => c.id)).toEqual(["b", "c", "d"]);
  });

  it("names the zone file safely", () => {
    expect(zoneName("acme.com")).toBe("acme.com.zone");
    expect(zoneName("a/b c")).toBe("a_b_c.zone");
  });
});
