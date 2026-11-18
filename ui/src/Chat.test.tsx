// @vitest-environment jsdom
// Chat as the page mounts it (the real route table at /chat/c1): a message's reactions are chips, pressed when the reader
// is among them, and pressing one asks the message's own action through the platform, with a key; the details list
// what is pinned.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBootstrap, installFakeShell } from "@ferrum/testing";

const ME = "tess@test.test";
const message = {
  id: "m1",
  channel: "c1",
  sender: "bob@test.test",
  sender_name: "Bob",
  body: "Ship it on Friday",
  posted_at: "2026-11-18T09:00:00Z",
  reactions: { "👍": [ME, "bob@test.test"], "🎉": ["bob@test.test"] },
  pinned_at: "2026-11-18T09:05:00Z",
};
const channel = { id: "c1", name: "general", title: "#general", type: "Public", role: "Owner", members: [{ email: ME, role: "Owner" }], unread: 0 };
const answers: Record<string, unknown> = {
  "/api/auth/me": { user: { id: "p1", email: ME, full_name: "Tess Ter", is_admin: false, roles: [] }, timezone: "UTC", packages: ["comms"] },
  "/api/app/comms/chat/channels": { channels: [channel] },
  "/api/app/comms/chat/channels/c1": channel,
  "/api/app/comms/chat/channels/c1/messages": { messages: [message] },
  "/api/app/comms/chat/channels/c1/pins": { messages: [message] },
  "/api/v1/ChatMessage/m1/actions/unreact": { id: "m1", reactions: { "🎉": ["bob@test.test"] } },
  "/api/users": { users: [{ id: "u2", email: "bob@test.test", full_name: "Bob Builder" }] },
};
const asked: { method: string; path: string; key: string | null; body?: string; query?: string }[] = [];

beforeEach(() => {
  asked.length = 0;
  installFakeShell({ bootstrap: fakeBootstrap({ person: { id: "p1", name: "Tess Ter", email: ME, kind: "member", admin: false, actor: null } }) });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Element.prototype.scrollIntoView ??= () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost");
      const headers = new Headers(init?.headers);
      asked.push({ method: init?.method ?? "GET", path: url.pathname, key: headers.get("idempotency-key"), body: typeof init?.body === "string" ? init.body : undefined, query: url.search });
      const body = answers[url.pathname];
      return new Response(JSON.stringify(body ?? { error: "not found" }), { status: body === undefined ? 404 : 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** Lets lazy chunks and answers arrive: until `ready` holds, at most 20 seconds on a busy machine. */
const settle = async (ready: () => boolean = () => false) => {
  for (let i = 0; i < 800 && !(i >= 40 && ready()); i++) await act(async () => void (await new Promise((r) => setTimeout(r, 25))));
};

async function mount(path: string) {
  const { routes } = await import("./routes");
  const host = document.createElement("div");
  document.body.append(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
      </QueryClientProvider>,
    );
  });
  await settle(() => !(host.textContent ?? "").includes("Loading") && (host.textContent ?? "").includes("Ship it"));
  return { host, close: async () => (await act(async () => root.unmount()), host.remove()) };
}

describe("chat, mounted", { timeout: 60_000 }, () => {
  it("shows the reactions as chips and takes mine back through the message's action", async () => {
    const { host, close } = await mount("/chat/c1");
    expect(host.textContent).toContain("Ship it on Friday");
    const mine = host.querySelector<HTMLButtonElement>('button[aria-label="👍, 2 reactions, you reacted"]');
    expect(mine?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('button[aria-label="🎉, 1 reactions"]')?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => mine!.click());
    await settle();
    const call = asked.find((a) => a.path === "/api/v1/ChatMessage/m1/actions/unreact");
    expect(call?.method).toBe("POST");
    expect(call?.key).toBeTruthy();
    await close();
  });

  it("lists what is pinned in the details", async () => {
    const { host, close } = await mount("/chat/c1?panel=pinned");
    const list = host.querySelector('[aria-label="Pinned messages"]');
    expect(list?.textContent).toContain("Ship it on Friday");
    await close();
  });

  // New direct message: the people's conversation when it exists (nothing is posted), else the channel's own create.
  async function startWith(found: unknown) {
    answers["/api/app/comms/chat/direct"] = { channel: found };
    answers["/api/v1/ChatChannel"] = { id: "d10" };
    const { host, close } = await mount("/chat/c1");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="New direct message"]')!.click());
    await settle(() => !!document.body.textContent?.includes("Bob Builder"));
    const bob = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Bob Builder"));
    await act(async () => bob!.click());
    const start = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Start");
    await act(async () => start!.click());
    await settle(() => asked.some((a) => a.path === "/api/app/comms/chat/direct"));
    await settle(() => true);
    await close();
  }

  it("opens the conversation those people already have, without making one", async () => {
    await startWith({ id: "d9", name: "dm-x", title: "Bob Builder", type: "Direct", role: "Member", members: [] });
    expect(asked.find((a) => a.path === "/api/app/comms/chat/direct")?.query).toContain("members=bob%40test.test");
    expect(asked.some((a) => a.path === "/api/v1/ChatChannel")).toBe(false);
  });

  it("makes the conversation through the channel's create when there is none", async () => {
    await startWith(null);
    const made = asked.find((a) => a.path === "/api/v1/ChatChannel" && a.method === "POST");
    expect(made?.key).toBeTruthy();
    expect(JSON.parse(made!.body!)).toEqual({ channel_type: "Direct", members: [{ member: ME }, { member: "bob@test.test" }] });
  });
});
