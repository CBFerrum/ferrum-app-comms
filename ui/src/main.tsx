// Comms' own interface (Ferrum docs/plan/apps-ui.md §13): one interface, four routes, Mail at
// /mail/, Chat at /chat/, Calendar at /calendar/ and Meet at /meet/, under the platform's bar.
// Calls open in a companion window that outlives the page (§12.6); a meeting's guests join on its
// public page (/meet/guest/…). What Comms does for other apps (compose, schedule, share, the Chat
// panel) is in Intents.tsx.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, Outlet, RouterProvider, useLocation, useRouteError } from "react-router";
import { routeBase, shell } from "@ferrum/client";
import { ConfirmHost, EmptyState, ErrorState, Toaster } from "@ferrum/kit";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } },
});

/** A route's first segment as the bootstrap gives it (`mail`). ponytail: pages link to `/mail/…`
 *  directly; an operator's remapped routes cover these entries only (docs/plan/apps-ui.md §10.1). */
const at = (route: string) => routeBase(route).replace(/^\/+|\/+$/g, "");
const TITLES: Record<string, string> = { [at("mail")]: "Mail", [at("chat")]: "Chat", [at("calendar")]: "Calendar", [at("meet")]: "Meet" };

function Frame() {
  const { pathname } = useLocation();
  useEffect(() => shell().ready(), []);
  // Moving between Mail, Chat, Calendar and Meet stays in this page: the bar follows.
  const title = TITLES[pathname.split("/")[1] ?? ""];
  useEffect(() => {
    if (title) shell().title(title);
  }, [title]);
  return (
    <main id="main" className="comms-app">
      <Outlet />
    </main>
  );
}

function RouteError() {
  return <ErrorState error={useRouteError()} onRetry={() => window.location.reload()} />;
}

function NotFound() {
  return (
    <EmptyState title="Page not found">
      <Link to="/mail">Go to Mail</Link>
    </EmptyState>
  );
}

const page = (load: () => Promise<Record<string, unknown>>, name: string) => () => load().then((m) => ({ Component: m[name] as React.ComponentType }));
const mail = () => import("./Mail");
const chat = () => import("./Chat");
const calendar = () => import("./Calendar");
const meet = () => import("./Meet");
const intents = () => import("./Intents");

const router = createBrowserRouter([
  {
    path: "/",
    element: <Frame />,
    errorElement: <RouteError />,
    // A first page that loads its code later shows nothing meanwhile (the bar is there already).
    hydrateFallbackElement: <span />,
    children: [
      { path: `${at("mail")}/_intent/compose`, lazy: page(intents, "ComposeIntentPage") },
      { path: `${at("mail")}/compose`, lazy: () => mail().then((m) => ({ Component: () => <m.MailPage compose /> })) },
      { path: `${at("mail")}/:mailbox?/:email?`, lazy: page(mail, "MailPage") },
      { path: `${at("chat")}/_intent/share`, lazy: page(intents, "ShareIntentPage") },
      { path: `${at("chat")}/_panel/*`, lazy: page(intents, "ChatPanel") },
      { path: `${at("chat")}/:channel?`, lazy: page(chat, "ChatPage") },
      { path: `${at("calendar")}/_intent/schedule`, lazy: page(intents, "ScheduleIntentPage") },
      { path: at("calendar"), lazy: page(calendar, "CalendarPage") },
      { path: at("meet"), lazy: page(meet, "MeetHomePage") },
      { path: `${at("meet")}/guest/:tenant/:link`, lazy: page(meet, "GuestMeetPage") },
      { path: `${at("meet")}/:kind/:id`, lazy: page(meet, "MeetPage") },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
      <ConfirmHost />
    </QueryClientProvider>
  </StrictMode>,
);
