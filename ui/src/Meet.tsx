// Video meetings (Comms' /meet endpoints; Ferrum docs/plan/collaboration.md, C4 and C5) on the
// LiveKit server the operator runs. Comms decides who may join and signs their token; LiveKit's own
// components show the call. /meet starts a room; /meet/{kind}/{id} is a meeting's page: a chat
// channel's call, a calendar event's meeting or a room. /meet/guest/{workspace}/{link} lets people
// outside the workspace join by their link. A call pops out into a small window that stays above
// every other one (PopOut), so people keep it in view while they work elsewhere. Where the
// operator has not set meetings up, the page says so and offers no call; on a phone the call fills
// the screen, the screen stays awake, and a browser without a camera or microphone can still join.

import "@livekit/components-styles";
import "./meet.css";
import {
  ControlBar,
  LiveKitRoom,
  ParticipantTile,
  PreJoin,
  VideoConference,
  useConnectionState,
  useRoomContext,
  useSpeakingParticipants,
  useTracks,
  type LocalUserChoices,
} from "@livekit/components-react";
import { useQuery } from "@tanstack/react-query";
import { ConnectionState, DisconnectReason, Track, type RoomOptions } from "livekit-client";
import { Copy, PictureInPicture2, UserPlus, Video, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router";
import { Button } from "@ferrum/kit/primitives";
import { Input } from "@ferrum/kit/primitives";
import { Label } from "@ferrum/kit/primitives";
import { Skeleton } from "@ferrum/kit/primitives";
import { ApiError, api, errorMessage, shell } from "@ferrum/client";
import { CHAT } from "./lib/chat";
import { MEET, mediaProblem, meetLink, notSetUp, useMeetAvailable, useMeetRecordings, type MeetKind, type MeetPass } from "./lib/meet";
import { CallTools } from "./CallTools";
import { useMe } from "@ferrum/records";
import { Alert, EmptyState, ErrorState, toast } from "@ferrum/kit";
import { goBack } from "@ferrum/kit";

const KINDS: MeetKind[] = ["channel", "event", "room"];

/** Where leaving a meeting goes when the page was opened directly. */
const home = (kind: MeetKind, id: string) => (kind === "channel" ? `/chat/${id}` : kind === "event" ? "/calendar" : "/meet");

const copy = async (link: string, what: string) => {
  try {
    await navigator.clipboard.writeText(link);
    toast(`${what} copied`);
  } catch {
    toast(`Copy this link: ${link}`);
  }
};

/** Where meetings are not set up there is no call to join, and the page says so. */
function NotSetUp({ onBack }: { onBack?: () => void }) {
  return (
    <EmptyState title="Video meetings are not set up on this server" icon="video">
      <p className="max-w-md text-center text-sm text-muted-foreground">Nobody can join a call here yet. An administrator can turn meetings on: see “Meetings” in Ferrum's operations guide.</p>
      {onBack && (
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
      )}
    </EmptyState>
  );
}

export function MeetPage() {
  const { kind = "", id = "" } = useParams();
  const navigate = useNavigate();
  const me = useMe().data;
  const available = useMeetAvailable();
  const valid = (KINDS as string[]).includes(kind);
  const pass = useQuery({
    queryKey: ["meet", kind, id],
    queryFn: () => api.post<MeetPass>(`${MEET}/${kind}/${id}/token`),
    enabled: valid && available.data === true,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  // Where the call puts its own buttons (Pop out), once it runs.
  const [tools, setTools] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (pass.data?.title) shell().title(pass.data.title);
  }, [pass.data?.title]);
  const meetKind = kind as MeetKind;
  // A call in its own window (opened from Chat or Calendar) closes it when done.
  const leave = () => (shell().host === "companion" ? window.close() : goBack(navigate, home(meetKind, id)));
  if (!valid) return <EmptyState title="Meeting not found" />;
  if (available.isLoading) return <Skeleton className="m-6 h-64" />;
  if (!available.data) return <NotSetUp onBack={leave} />;
  if (pass.error) {
    return notSetUp(errorMessage(pass.error)) ? <NotSetUp onBack={leave} /> : <ErrorState title="You can't join this meeting" error={pass.error} onRetry={() => void pass.refetch()} />;
  }
  return (
    <div data-fullbleed className="grid h-[calc(100dvh-var(--ferrum-bar-height,48px))] min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Video className="size-4 text-muted-foreground" aria-hidden="true" />
        <h1 className="min-w-0 flex-1 truncate font-semibold">{pass.data?.title ?? "Meeting"}</h1>
        <span ref={setTools} className="contents" />
        {meetKind === "room" && pass.data && <GuestLink room={id} initial={pass.data.guest_path ?? null} />}
        <Button variant="outline" size="sm" aria-label="Copy the meeting link" onClick={() => void copy(meetLink(meetKind, id), "Meeting link")}>
          <Copy /> <span className="hidden sm:inline">Copy link</span>
        </Button>
      </header>
      <div data-lk-theme="default" className="ferrum-meet min-h-0">
        {!pass.data ? (
          <Skeleton className="m-6 h-64" />
        ) : (
          <Stage
            pass={pass.data}
            name={me?.user.full_name || me?.user.email || ""}
            onRejoin={() => pass.refetch()}
            onBack={leave}
            channel={meetKind === "channel" ? id : undefined}
            tools={tools}
            meeting={{ kind: meetKind, id }}
          />
        )}
      </div>
    </div>
  );
}

/** Keeps a phone's screen on while a call runs (where the browser lets a page ask). */
function useWakeLock(on: boolean) {
  useEffect(() => {
    if (!on || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const ask = () => void navigator.wakeLock.request("screen").then((l) => (lock = l), () => undefined);
    ask();
    const again = () => document.visibilityState === "visible" && ask();
    document.addEventListener("visibilitychange", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      void lock?.release();
    };
  }, [on]);
}

/** A connection problem as a person would put it. */
const plain = (message: string) =>
  /signal|websocket|connect|fetch|timeout|timed out|network/i.test(message)
    ? "Could not reach the meeting server. Check your connection; if it keeps failing, the meeting server may be down, and an administrator should look."
    : message;

/** Tells the room it is connected (clears an earlier problem). */
function Connected({ onConnected }: { onConnected: () => void }) {
  const state = useConnectionState();
  useEffect(() => {
    if (state === ConnectionState.Connected) onConnected();
  }, [state, onConnected]);
  return null;
}

/** Getting ready (camera and microphone), the call, and after leaving it, a way back in. */
function Stage({
  pass,
  name,
  onRejoin,
  onBack,
  channel,
  tools,
  meeting,
}: {
  pass: MeetPass;
  name: string;
  onRejoin: () => Promise<unknown>;
  onBack?: () => void;
  channel?: string;
  tools?: HTMLElement | null;
  /** A meeting of the workspace's (not a guest's): its captions' transcript and recordings. */
  meeting?: { kind: MeetKind; id: string };
}) {
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const recordings = useMeetRecordings(!!meeting).data ?? false;
  const [left, setLeft] = useState<DisconnectReason | undefined | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const unable = mediaProblem();
  useWakeLock(!!choices && left === null);
  const options = useMemo<RoomOptions>(
    () => ({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: { deviceId: choices?.videoDeviceId || undefined },
      audioCaptureDefaults: { deviceId: choices?.audioDeviceId || undefined },
    }),
    [choices],
  );
  if (left !== null)
    return (
      <div className="grid h-full place-content-center justify-items-center gap-4 p-6 text-center">
        <p className="text-lg">{left === DisconnectReason.CLIENT_INITIATED ? "You left the meeting." : "You were disconnected from the meeting."}</p>
        <div className="flex gap-2">
          <Button onClick={() => void onRejoin().then(() => setLeft(null))}>Rejoin</Button>
          {onBack && (
            <Button variant="outline" onClick={onBack}>
              Back
            </Button>
          )}
        </div>
      </div>
    );
  if (!choices && unable)
    return (
      <div className="grid h-full place-content-center justify-items-center gap-4 overflow-auto p-6 text-center">
        <p className="max-w-md">{unable}</p>
        <div className="flex gap-2">
          <Button onClick={() => setChoices({ username: name, videoEnabled: false, audioEnabled: false, videoDeviceId: "", audioDeviceId: "" })}>Join without camera or microphone</Button>
          {onBack && (
            <Button variant="outline" onClick={onBack}>
              Back
            </Button>
          )}
        </div>
      </div>
    );
  if (!choices)
    return (
      <div className="grid h-full place-items-center overflow-auto p-4">
        <PreJoin
          defaults={{ username: name, videoEnabled: true, audioEnabled: true }}
          // The name others see comes from the token, so the field is hidden and never checked.
          onValidate={() => true}
          onSubmit={setChoices}
          onError={(e) => toast(e.message, "error")}
          joinLabel="Join now"
        />
      </div>
    );
  return (
    <div className="relative h-full">
      {problem && (
        <div className="absolute inset-x-0 top-0 z-30 p-2">
          <Alert
            tone="error"
            action={
              <span className="flex shrink-0 gap-1">
                <Button size="xs" variant="outline" onClick={() => void onRejoin().then(() => setProblem(null))}>
                  Try again
                </Button>
                {onBack && (
                  <Button size="xs" variant="ghost" onClick={onBack}>
                    Leave
                  </Button>
                )}
              </span>
            }
          >
            <span>{problem}</span>
          </Alert>
        </div>
      )}
      <LiveKitRoom
        serverUrl={pass.url}
        token={pass.token}
        connect
        options={options}
        video={choices.videoEnabled}
        audio={choices.audioEnabled}
        onDisconnected={(reason) => setLeft(reason)}
        onError={(e) => setProblem(plain(e.message))}
        onMediaDeviceFailure={() => toast("Your camera or microphone could not be used. Check the browser's permission for this site.", "error")}
        className="h-full"
      >
        <Connected onConnected={() => setProblem(null)} />
        <VideoConference />
        {meeting && <CallTools kind={meeting.kind} id={meeting.id} recordings={recordings} />}
        {channel && <Announce channel={channel} />}
        {tools && <PopOut slot={tools} />}
      </LiveKitRoom>
    </div>
  );
}

interface DocumentPip {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}
/** Document Picture-in-Picture (Chromium): a small window of the page's own, above every other. */
const documentPip = () => (window as unknown as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;

/** The page's styles in another window's document (the pop-out's): LiveKit's, the kit's, the theme. */
function copyStyles(to: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = to.createElement("style");
      style.textContent = Array.from(sheet.cssRules, (r) => r.cssText).join("\n");
      to.head.append(style);
    } catch {
      // A sheet the page may not read (another origin's) is linked again instead.
      if (!sheet.href) continue;
      const link = to.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      to.head.append(link);
    }
  }
  for (const [k, v] of Object.entries(document.documentElement.dataset)) if (v !== undefined) to.documentElement.dataset[k] = v;
}

/** Pop out: the call in a small window that stays above every other (Document Picture-in-Picture:
 *  Chromium, recent Firefox), or the speaker's video alone where browsers only float a video
 *  (Safari); no button where neither exists. Leaving the call, or the page, closes the small
 *  window. */
function PopOut({ slot }: { slot: HTMLElement }) {
  const [pip, setPip] = useState<Window | null>(null);
  const [floating, setFloating] = useState(false);
  // A browser that says it floats videos but cannot float this one (a camera's stream).
  const [unable, setUnable] = useState(false);
  useEffect(() => () => pip?.close(), [pip]);
  useEffect(() => {
    const on = () => setFloating(!!document.pictureInPictureElement);
    document.addEventListener("enterpictureinpicture", on, true);
    document.addEventListener("leavepictureinpicture", on, true);
    return () => {
      document.removeEventListener("enterpictureinpicture", on, true);
      document.removeEventListener("leavepictureinpicture", on, true);
    };
  }, []);
  const api = documentPip();
  if (unable || (!api && !document.pictureInPictureEnabled)) return null;
  const out = !!pip || floating;
  const toggle = async () => {
    try {
      if (pip) return pip.close();
      if (document.pictureInPictureElement) return await document.exitPictureInPicture();
      if (api) {
        const w = await api.requestWindow({ width: 420, height: 320 });
        w.document.title = document.title;
        copyStyles(w.document);
        w.addEventListener("pagehide", () => setPip(null), { once: true });
        setPip(w);
        return;
      }
      // Whoever is speaking, else the first video that plays.
      const videos = Array.from(document.querySelectorAll<HTMLVideoElement>(".ferrum-meet video")).filter((v) => v.readyState > 0 && !v.disablePictureInPicture);
      const video = videos.find((v) => v.closest("[data-lk-speaking='true']")) ?? videos[0];
      if (!video) return toast("Nobody's camera is on yet.");
      await video.requestPictureInPicture();
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotSupportedError") {
        setUnable(true);
        return toast("This browser can't pop the call out.", "error");
      }
      // Refused (the browser wants the click itself) or already floating elsewhere.
      toast(e instanceof DOMException && e.name === "NotAllowedError" ? "The browser did not allow the call to pop out; try again." : errorMessage(e), "error");
    }
  };
  return (
    <>
      {createPortal(
        <Button variant="outline" size="sm" aria-pressed={out} onClick={() => void toggle()}>
          <PictureInPicture2 /> {out ? "Bring back" : "Pop out"}
        </Button>,
        slot,
      )}
      {pip && createPortal(<MiniCall />, pip.document.body)}
    </>
  );
}

/** The call in the pop-out: a shared screen first, else whoever speaks, else someone else, else you;
 *  and the microphone, the camera and leaving. */
function MiniCall() {
  const tracks = useTracks(
    [
      { source: Track.Source.ScreenShare, withPlaceholder: false },
      { source: Track.Source.Camera, withPlaceholder: true },
    ],
    { onlySubscribed: false },
  );
  const speaking = useSpeakingParticipants();
  const focus =
    tracks.find((t) => t.source === Track.Source.ScreenShare) ??
    tracks.find((t) => !t.participant.isLocal && speaking.some((p) => p.identity === t.participant.identity)) ??
    tracks.find((t) => !t.participant.isLocal) ??
    tracks[0];
  return (
    <div data-lk-theme="default" className="ferrum-meet ferrum-pip">
      {focus ? <ParticipantTile trackRef={focus} /> : <p className="ferrum-pip-empty">Nobody else is here yet.</p>}
      <ControlBar variation="minimal" controls={{ microphone: true, camera: true, screenShare: false, chat: false, leave: true }} />
    </div>
  );
}

/** Tells a channel that a call started, when its first person joins. */
function Announce({ channel }: { channel: string }) {
  const room = useRoomContext();
  const state = useConnectionState();
  const done = useRef(false);
  useEffect(() => {
    if (state !== ConnectionState.Connected || done.current) return;
    done.current = true;
    if (room.remoteParticipants.size > 0) return;
    // Someone reading a public channel they have not joined cannot post: the call goes on.
    api.post(`${CHAT}/channels/${channel}/messages`, { body: `📞 Started a call. [Join the call](/meet/channel/${channel})` }).catch(() => undefined);
  }, [state, room, channel]);
  return null;
}

/** A room's guest link: anyone outside the workspace who has it joins as a guest. */
function GuestLink({ room, initial }: { room: string; initial: string | null }) {
  const [path, setPath] = useState(initial);
  const [busy, setBusy] = useState(false);
  const change = async (on: boolean) => {
    setBusy(true);
    try {
      const r = on
        ? await api.post<{ guest_path: string | null }>(`${MEET}/room/${room}/guest-link`)
        : await api.del<{ guest_path: string | null }>(`${MEET}/room/${room}/guest-link`);
      setPath(r.guest_path);
      if (r.guest_path) await copy(`${location.origin}${r.guest_path}`, "Guest link");
      else toast("The guest link no longer works");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  if (!path)
    return (
      <Button variant="outline" size="sm" disabled={busy} aria-label="Invite guests" onClick={() => void change(true)}>
        <UserPlus /> <span className="hidden sm:inline">Invite guests</span>
      </Button>
    );
  return (
    <>
      <Button variant="outline" size="sm" aria-label="Copy the guest link" onClick={() => void copy(`${location.origin}${path}`, "Guest link")}>
        <UserPlus /> <span className="hidden sm:inline">Copy guest link</span>
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} aria-label="Turn off the guest link" onClick={() => void change(false)}>
        <X /> <span className="hidden sm:inline">Turn off guest link</span>
      </Button>
    </>
  );
}

/** /meet: a room to meet in now, whose link admits anyone in the workspace. */
export function MeetHomePage() {
  const navigate = useNavigate();
  const available = useMeetAvailable();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const room = await api.post<{ id: string }>(`${MEET}/rooms`, { title: title.trim() || undefined });
      void navigate(`/meet/room/${room.id}`);
    } catch (err) {
      toast(errorMessage(err), "error");
      setBusy(false);
    }
  };
  if (available.isLoading) return <Skeleton className="mx-auto mt-10 h-48 max-w-md" />;
  if (!available.data) return <NotSetUp />;
  return (
    <div className="mx-auto grid max-w-md gap-4 py-10">
      <h1 className="text-xl font-semibold">Meet</h1>
      <p className="text-muted-foreground">
        Start a meeting now and share its link with people in your workspace. Chat channels have their own calls, and calendar events their own meetings.
      </p>
      <form onSubmit={(e) => void start(e)} className="grid gap-2">
        <Label htmlFor="meet-title">Name (optional)</Label>
        <Input id="meet-title" maxLength={140} placeholder="Meeting" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Button type="submit" disabled={busy}>
          <Video /> Start a meeting
        </Button>
      </form>
    </div>
  );
}

interface GuestPass extends MeetPass {
  name: string;
}

/** /meet/guest/{workspace}/{link}: someone outside the workspace joins by their link, without
 *  signing in. An event's link names its guest; a room's asks for a name. */
export function GuestMeetPage() {
  const { tenant = "", link = "" } = useParams();
  const [pass, setPass] = useState<GuestPass | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [askName, setAskName] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<HTMLElement | null>(null);
  const asked = useRef(false);
  const ask = async (typed?: string) => {
    setBusy(true);
    try {
      setPass(await api.post<GuestPass>(`/api/site/${encodeURIComponent(tenant)}/comms/meet/guest`, { token: link, name: typed }));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.fields.some((f) => f.field === "name")) setAskName(true);
      else setError(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void ask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div data-lk-theme="default" className="ferrum-meet grid h-dvh grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex items-center gap-2 px-4 py-3">
        <Video className="size-4 opacity-70" aria-hidden="true" />
        <h1 className="min-w-0 flex-1 truncate font-semibold">{pass?.title ?? "Meeting"}</h1>
        {pass && <span className="text-sm opacity-70">You are joining as {pass.name} (guest)</span>}
        <span ref={setTools} className="contents" />
      </header>
      <main className="min-h-0">
        {error ? (
          <div className="grid h-full place-content-center gap-2 p-6 text-center">
            {notSetUp(errorMessage(error)) ? (
              <>
                <p className="text-lg">Video meetings are not set up here</p>
                <p className="opacity-70">The organization that invited you has not turned them on yet. Ask the person who invited you.</p>
              </>
            ) : (
              <>
                <p className="text-lg">You can't join this meeting</p>
                <p className="opacity-70">{errorMessage(error)}</p>
              </>
            )}
          </div>
        ) : pass ? (
          <Stage pass={pass} name={pass.name} onRejoin={() => ask(askName ? name.trim() : undefined)} tools={tools} />
        ) : askName ? (
          <form
            className="mx-auto grid max-w-sm gap-3 p-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void ask(name.trim());
            }}
          >
            <Label htmlFor="guest-name">Your name</Label>
            <Input id="guest-name" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="As others will see it" />
            <Button type="submit" disabled={busy || !name.trim()}>
              Continue
            </Button>
          </form>
        ) : (
          <Skeleton className="m-6 h-64" />
        )}
      </main>
    </div>
  );
}
