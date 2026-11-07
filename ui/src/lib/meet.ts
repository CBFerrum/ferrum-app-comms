// Video meetings (Comms' /api/app/comms/meet; Ferrum docs/plan/collaboration.md, C4): whether this
// server has them, and the links that open one. A meeting is `{kind}/{id}`: a chat channel's call,
// a calendar event's meeting or a room started here.

import { useQuery } from "@tanstack/react-query";
import { api, shell, t } from "@ferrum/client";

export const MEET = "/api/app/comms/meet";

export type MeetKind = "channel" | "event" | "room";

/** What Comms answers for a meeting the caller may join: LiveKit's address and their token. */
export interface MeetPass {
  url: string;
  token: string;
  title: string;
  /** A room's guest link (this app's path), while it has one. */
  guest_path?: string | null;
}

/** Whether the operator set up meetings (a LiveKit server). */
export function useMeetAvailable(enabled = true) {
  return useQuery({
    queryKey: ["meet", "available"],
    queryFn: ({ signal }) => api.get<{ available: boolean }>(MEET, undefined, signal).then((r) => r.available),
    enabled,
    retry: false,
    staleTime: 10 * 60_000,
  });
}

/** Whether the operator runs recordings too (LiveKit Egress beside LiveKit). */
export function useMeetRecordings(enabled = true) {
  return useQuery({
    queryKey: ["meet", "setup"],
    queryFn: ({ signal }) => api.get<{ available: boolean; recordings?: boolean }>(MEET, undefined, signal).then((r) => !!r.recordings),
    enabled,
    retry: false,
    staleTime: 10 * 60_000,
  });
}

/** A meeting's address, to share or to keep in a calendar event (Comms' own page). */
export const meetLink = (kind: MeetKind, id: string, origin = location.origin) => `${origin}/meet/${kind}/${id}`;

/** The page in this app (`/meet/{kind}/{id}`) a meeting link of this app opens, from today's links
 *  and those the web app made before (`/app/meet/…`); null for others. */
export function meetPath(href: string | null | undefined, origin = location.origin): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href.trim(), origin);
  } catch {
    return null;
  }
  const m = url.origin === origin ? /^(?:\/app)?\/meet\/(channel|event|room)\/([0-9a-f-]{36})\/?$/i.exec(url.pathname) : null;
  return m ? `/meet/${m[1].toLowerCase()}/${m[2].toLowerCase()}` : null;
}

/** What the browser and the device are, as far as opening a call goes. */
export interface Setting {
  /** A touch screen is the main way of pointing. */
  coarse: boolean;
  width: number;
}

/** Whether a call opens in a window of its own beside the page: on a computer yes; on a phone or
 *  a small tablet the call takes the whole screen, and Back returns to where it began. */
export const opensBeside = (s: Setting) => !s.coarse && s.width >= 768;

const here = (): Setting => ({
  coarse: typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches,
  width: typeof innerWidth === "number" ? innerWidth : 1024,
});

/** Opens a meeting in its companion window, which outlives the page that opened it (Ferrum
 *  docs/plan/apps-ui.md §12.6): inside the click, or the browser blocks it. A click with a modifier
 *  opens the link as the browser would, and so does one on a phone, where the call fills the screen. */
export function openCall(e: { preventDefault(): void; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }, url: string, setting: Setting = here()) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || !opensBeside(setting)) return;
  e.preventDefault();
  shell().companion({ kind: "meet", url, width: 1100, height: 720 });
}

/** What stands between this browser and a camera or microphone, in words; none if nothing does. */
export function mediaProblem(env: { secure: boolean; devices: boolean } = { secure: typeof isSecureContext === "boolean" ? isSecureContext : true, devices: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia }): string | null {
  if (!env.secure) return "This page was not opened over a secure connection (https), so your browser will not let it use the camera or the microphone. You can still join and listen, and watch others.";
  if (!env.devices) return "This browser cannot use a camera or a microphone. You can still join and listen, and watch others.";
  return null;
}

/** Whether a failure was the server saying video meetings are not set up (as opposed to this one failing). */
export const notSetUp = (message: string) => /not set up/i.test(message);

/** A recording of a meeting, as Comms keeps it (LiveKit Egress's status). */
export interface Recording {
  id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  location: string | null;
  error: string | null;
}

/** A segment's id: this browser's, unique in the meeting for this person. */
export const segmentId = (at: number, n: number) => `${at.toString(36)}-${n}`;

/** What a recording's status says, in words. */
export function recordingWords(r: Pick<Recording, "status" | "ended_at" | "location" | "error">): string {
  if (r.error) return `Failed: ${r.error}`;
  switch (r.status) {
    case "EGRESS_STARTING":
      return "Starting";
    case "EGRESS_ACTIVE":
      return "Recording";
    case "EGRESS_ENDING":
      return "Finishing the file";
    case "EGRESS_COMPLETE":
      return r.location ? t("Saved at {location}", { location: r.location }) : "Saved";
    case "EGRESS_LIMIT_REACHED":
      return "Stopped at the server's limit";
    default:
      return r.ended_at ? "Ended" : r.status;
  }
}
