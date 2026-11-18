// Comms' own interface (Ferrum docs/plan/apps-ui.md §13): one interface, four routes, Mail at
// /mail/, Chat at /chat/, Calendar at /calendar/ and Meet at /meet/, under the platform's bar.
// Calls open in a companion window that outlives the page (§12.6); a meeting's guests join on its
// public page (/meet/guest/…). What Comms does for other apps (compose, schedule, share, the Chat
// panel) is in Intents.tsx.

import { mountApp } from "@ferrum/records/frame";
import { routes } from "./routes";
import "./styles.css";

// One interface at the root, no base of its own: its four routes (mail, chat, calendar, meet) are in the paths below, so
// the route given is "" (routeBase("") is "/").
mountApp({
  route: "",
  catalogs: { ar: () => import("./locales/ar.json"), hi: () => import("./locales/hi.json") },
  routes,
});
