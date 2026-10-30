// Video meetings (Comms' /meet endpoints; Ferrum docs/plan/collaboration.md, C4 and C5) on the
// LiveKit server the operator runs. Comms decides who may join and signs their token; LiveKit's own
// components show the call. /meet starts a room; /meet/{kind}/{id} is a meeting's page: a chat
// channel's call, a calendar event's meeting or a room. /meet/guest/{workspace}/{link} lets people
// outside the workspace join by their link.

import "@livekit/components-styles";
import "./meet.css";
import { LiveKitRoom, PreJoin, VideoConference, useConnectionState, useRoomContext, type LocalUserChoices } from "@livekit/components-react";
import { useQuery } from "@tanstack/react-query";
import { ConnectionState, DisconnectReason, type RoomOptions } from "livekit-client";
import { Copy, UserPlus, Video } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { Button } from "@ferrum/kit/primitives";
import { Input } from "@ferrum/kit/primitives";
import { Label } from "@ferrum/kit/primitives";
import { Skeleton } from "@ferrum/kit/primitives";
import { ApiError, api, errorMessage, shell } from "@ferrum/client";
import { CHAT } from "./lib/chat";
import { MEET, meetLink, useMeetAvailable, type MeetKind, type MeetPass } from "./lib/meet";
import { useMe } from "@ferrum/records";
import { EmptyState, ErrorState, toast } from "@ferrum/kit";
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

export function MeetPage() {
  const { kind = "", id = "" } = useParams();
  const navigate = useNavigate();
  const me = useMe().data;
  const valid = (KINDS as string[]).includes(kind);
  const pass = useQuery({
    queryKey: ["meet", kind, id],
    queryFn: () => api.post<MeetPass>(`${MEET}/${kind}/${id}/token`),
    enabled: valid,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  useEffect(() => {
    if (pass.data?.title) shell().title(pass.data.title);
  }, [pass.data?.title]);
  if (!valid) return <EmptyState title="Meeting not found" />;
  if (pass.error) return <ErrorState title="You can't join this meeting" error={pass.error} onRetry={() => void pass.refetch()} />;
  const meetKind = kind as MeetKind;
  return (
    <div data-fullbleed className="grid h-[calc(100dvh-var(--ferrum-bar-height,48px))] min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Video className="size-4 text-muted-foreground" aria-hidden="true" />
        <h1 className="min-w-0 flex-1 truncate font-semibold">{pass.data?.title ?? "Meeting"}</h1>
        {meetKind === "room" && pass.data && <GuestLink room={id} initial={pass.data.guest_path ?? null} />}
        <Button variant="outline" size="sm" onClick={() => void copy(meetLink(meetKind, id), "Meeting link")}>
          <Copy /> Copy link
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
            // A call in its own window (opened from Chat or Calendar) closes it when done.
            onBack={() => (shell().host === "companion" ? window.close() : goBack(navigate, home(meetKind, id)))}
            channel={meetKind === "channel" ? id : undefined}
          />
        )}
      </div>
    </div>
  );
}

/** Getting ready (camera and microphone), the call, and after leaving it, a way back in. */
function Stage({ pass, name, onRejoin, onBack, channel }: { pass: MeetPass; name: string; onRejoin: () => Promise<unknown>; onBack?: () => void; channel?: string }) {
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [left, setLeft] = useState<DisconnectReason | undefined | null>(null);
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
    <LiveKitRoom
      serverUrl={pass.url}
      token={pass.token}
      connect
      options={options}
      video={choices.videoEnabled}
      audio={choices.audioEnabled}
      onDisconnected={(reason) => setLeft(reason)}
      onError={(e) => toast(e.message, "error")}
      onMediaDeviceFailure={() => toast("Your camera or microphone could not be used. Check the browser's permission for this site.", "error")}
      className="h-full"
    >
      <VideoConference />
      {channel && <Announce channel={channel} />}
    </LiveKitRoom>
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
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void change(true)}>
        <UserPlus /> Invite guests
      </Button>
    );
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => void copy(`${location.origin}${path}`, "Guest link")}>
        <UserPlus /> Copy guest link
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void change(false)}>
        Turn off guest link
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
  if (!available.data)
    return (
      <EmptyState title="Video meetings are not set up" icon="video">
        An administrator of this server can set them up: see “Meetings” in Ferrum's operations guide.
      </EmptyState>
    );
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
      </header>
      <main className="min-h-0">
        {error ? (
          <div className="grid h-full place-content-center gap-2 p-6 text-center">
            <p className="text-lg">You can't join this meeting</p>
            <p className="opacity-70">{errorMessage(error)}</p>
          </div>
        ) : pass ? (
          <Stage pass={pass} name={pass.name} onRejoin={() => ask(askName ? name.trim() : undefined)} />
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
