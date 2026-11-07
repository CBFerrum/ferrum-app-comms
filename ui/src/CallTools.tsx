// Captions, the transcript and recording in a call (Comms' /meet/{kind}/{id}/transcript and
// /recordings). Captions are each person's own: their browser's speech recognition captions their
// voice into the call on LiveKit's `lk.transcription` text stream (an operator's LiveKit
// transcription agent shows the same way) and into the meeting's transcript. Recording is LiveKit
// Egress, where the operator runs it; everyone in the call sees that it is recording.

import { useIsRecording, useLocalParticipant, useRoomContext, useTranscriptions } from "@livekit/components-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Captions, CircleDot, FileText, Mic } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@ferrum/kit/primitives";
import { api, errorMessage, t as tr, isolate } from "@ferrum/client";
import { confirmDialog, Dialog, toast } from "@ferrum/kit";
import { MEET, recordingWords, segmentId, type MeetKind, type Recording } from "./lib/meet";

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

/** The browser's speech recognition, where it has one (Chrome, Edge and Safari do; Firefox does not). */
const recognizer = (): (new () => Recognition) | undefined => {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

interface Segment {
  name: string;
  text: string;
  said_at: string;
}

function Transcript({ kind, id, onClose }: { kind: MeetKind; id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["meet", "transcript", kind, id], queryFn: () => api.get<{ segments: Segment[] }>(`${MEET}/${kind}/${id}/transcript`).then((r) => r.segments) });
  return (
    <Dialog open title={tr("Transcript")} onClose={onClose} footer={<Button onClick={onClose}>{tr("Done")}</Button>}>
      {q.isPending ? (
        <p className="text-sm text-muted-foreground">{tr("Loading…")}</p>
      ) : q.isError ? (
        <p className="text-sm">{isolate(errorMessage(q.error))}</p>
      ) : q.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr("Nothing yet. What people caption of their own voices appears here.")}</p>
      ) : (
        <ol className="grid gap-2 text-sm">
          {q.data.map((s, i) => (
            <li key={`${s.said_at}-${i}`}>
              <strong>{isolate(s.name)}</strong> <span className="text-muted-foreground">{isolate(new Date(s.said_at).toLocaleTimeString())}</span>
              <div>{isolate(s.text)}</div>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}

export function CallTools({ kind, id, recordings }: { kind: MeetKind; id: string; recordings: boolean }) {
  const room = useRoomContext();
  const { localParticipant, microphoneTrack } = useLocalParticipant();
  const transcriptions = useTranscriptions();
  const recording = useIsRecording();
  const qc = useQueryClient();
  const [shown, setShown] = useState(false);
  const [mine, setMine] = useState(false);
  const [reading, setReading] = useState(false);
  const canHear = !!recognizer();

  useEffect(() => {
    const Recognizer = recognizer();
    if (!mine || !Recognizer) return;
    const r = new Recognizer();
    r.continuous = true;
    r.interimResults = false;
    r.lang = document.documentElement.lang || navigator.language;
    let over = false;
    let n = 0;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const text = result.isFinal ? result[0].transcript.trim() : "";
        if (!text) continue;
        const segment = segmentId(Date.now(), n++);
        const track = microphoneTrack?.trackSid;
        void localParticipant
          .sendText(text, { topic: "lk.transcription", attributes: { "lk.transcription_final": "true", "lk.segment_id": segment, ...(track ? { "lk.transcribed_track_id": track } : {}) } })
          .catch(() => undefined);
        void api.post(`${MEET}/${kind}/${id}/transcript`, { segment, text }).catch(() => undefined);
      }
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        over = true;
        setMine(false);
        toast(tr("This browser would not let captions hear your microphone."), "error");
      }
    };
    // Recognition stops by itself after a silence: it starts again while captions are on.
    r.onend = () => {
      if (over) return;
      try {
        r.start();
      } catch {
        /* already started */
      }
    };
    r.start();
    return () => {
      over = true;
      r.onend = null;
      r.stop();
    };
  }, [mine, kind, id, localParticipant, microphoneTrack]);

  const recs = useQuery({
    queryKey: ["meet", "recordings", kind, id],
    queryFn: () => api.get<{ recordings: Recording[] }>(`${MEET}/${kind}/${id}/recordings`).then((r) => r.recordings),
    enabled: recordings,
    refetchInterval: (q) => (q.state.data?.some((r) => !r.ended_at) ? 10_000 : false),
  });
  const going = recs.data?.find((r) => !r.ended_at && r.status !== "EGRESS_ENDING");
  const record = useMutation({
    mutationFn: () => (going ? api.post(`${MEET}/${kind}/${id}/recordings/${going.id}/stop`, {}) : api.post(`${MEET}/${kind}/${id}/recordings`, {})),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["meet", "recordings", kind, id] }),
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const nameOf = (identity: string) =>
    identity === localParticipant.identity ? tr("You") : (room.getParticipantByIdentity(identity)?.name ?? tr("Someone"));
  const latest = transcriptions.slice(-3);
  return (
    <>
      <div className="absolute end-2 top-2 z-20 flex flex-wrap items-center justify-end gap-1">
        {recording && (
          <span className="flex items-center gap-1 rounded bg-red-600 px-2 py-1 text-xs font-medium text-white" role="status">
            <CircleDot className="size-3" aria-hidden /> {tr("Recording")}
          </span>
        )}
        <Button size="xs" variant={shown ? "default" : "outline"} aria-pressed={shown} onClick={() => setShown(!shown)}>
          <Captions className="size-3.5" aria-hidden /> {tr("Captions")}
        </Button>
        {canHear && (
          <Button
            size="xs"
            variant={mine ? "default" : "outline"}
            aria-pressed={mine}
            title={tr("Your browser's speech recognition hears your voice, and may send it to the browser's maker to recognise it. What it hears goes to everyone in the call and into the meeting's transcript.")}
            onClick={() => {
              setMine(!mine);
              if (!mine) setShown(true);
            }}
          >
            <Mic className="size-3.5" aria-hidden /> {mine ? tr("Captioning my voice") : tr("Caption my voice")}
          </Button>
        )}
        <Button size="xs" variant="outline" onClick={() => setReading(true)}>
          <FileText className="size-3.5" aria-hidden /> {tr("Transcript")}
        </Button>
        {recordings && (
          <Button
            size="xs"
            variant="outline"
            disabled={record.isPending}
            onClick={async () => {
              if (
                !going &&
                !(await confirmDialog({ title: tr("Record this call?"), message: tr("Everyone in the call sees that it is being recorded. The recording is kept where this server's operator stores them."), confirmLabel: tr("Record") }))
              )
                return;
              record.mutate();
            }}
          >
            <CircleDot className="size-3.5" aria-hidden /> {going ? tr("Stop recording") : tr("Record")}
          </Button>
        )}
      </div>
      {recordings && !!recs.data?.length && !going && recs.data[0].ended_at === null && (
        <p className="absolute start-2 top-2 z-20 rounded bg-background/80 px-2 py-1 text-xs" role="status">
          {isolate(recordingWords(recs.data[0]))}
        </p>
      )}
      {shown && (
        <div className="pointer-events-none absolute inset-x-0 bottom-20 z-20 flex justify-center px-4" aria-live="polite">
          <div className="max-w-2xl rounded bg-black/70 px-3 py-2 text-center text-sm text-white">
            {latest.length === 0 ? (
              <span className="opacity-80">{tr("Captions appear here when someone captions their voice.")}</span>
            ) : (
              latest.map((t) => (
                <div key={t.streamInfo.id}>
                  <strong>{isolate(nameOf(t.participantInfo.identity))}:</strong> {isolate(t.text)}
                </div>
              ))
            )}
          </div>
        </div>
      )}
      {reading && <Transcript kind={kind} id={id} onClose={() => setReading(false)} />}
    </>
  );
}
