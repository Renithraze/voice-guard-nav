import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { GlowField, GuardHeader, Panel, PanelLabel } from "@/components/vg/shell";
import { AuditList, ConfidenceMeter, LevelBars, MicOrb, Pipeline } from "@/components/vg/signal";
import { useVoiceCapture, speak } from "@/lib/use-voice-capture";
import { MIN_ENROLL_SAMPLES, stripWakeWord } from "@/lib/voiceguard-config";
import {
  enrollVoiceSample,
  getGuardState,
  issueChallenge,
  verifyBackupPin,
  verifyVoice,
} from "@/lib/voiceguard.functions";
import { resolveNavigationIntent, transcribeClip } from "@/lib/voice-ai.functions";

export const Route = createFileRoute("/_authenticated/guard")({
  head: () => ({
    meta: [
      { title: "Voice console — Voice Guard" },
      {
        name: "description",
        content:
          "Enroll voice samples, pass the live challenge phrase, and speak a navigation command.",
      },
      { property: "og:title", content: "Voice console — Voice Guard" },
      {
        property: "og:description",
        content: "Speaker verification and spoken navigation in one console.",
      },
    ],
  }),
  component: Console,
});

type Stage = "Voice capture" | "Speech to text" | "Speaker verify" | "Intent · LLM" | "Navigate";

function Console() {
  const navigate = useNavigate();
  const fetchState = useServerFn(getGuardState);
  const newChallenge = useServerFn(issueChallenge);
  const enroll = useServerFn(enrollVoiceSample);
  const verify = useServerFn(verifyVoice);
  const checkPin = useServerFn(verifyBackupPin);
  const transcribe = useServerFn(transcribeClip);
  const resolveIntent = useServerFn(resolveNavigationIntent);

  const state = useQuery({ queryKey: ["guard-state"], queryFn: () => fetchState() });
  const capture = useVoiceCapture();

  const [challenge, setChallenge] = useState<{ id: string; phrase: string } | null>(null);
  const [stage, setStage] = useState<Stage | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [score, setScore] = useState<number | null>(null);
  const [verdict, setVerdict] = useState<"idle" | "granted" | "borderline" | "denied">("idle");
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [intentLine, setIntentLine] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [wakeListening, setWakeListening] = useState(false);
  const [wakeHeard, setWakeHeard] = useState(false);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);

  const enrolled = (state.data?.enrolledSamples ?? 0) >= MIN_ENROLL_SAMPLES;
  const verified = verdict === "granted";
  const mode: "enroll" | "verify" | "command" = !enrolled ? "enroll" : verified ? "command" : "verify";

  const requestChallenge = useCallback(
    async (purpose: "enroll" | "verify") => {
      const row = await newChallenge({ data: { purpose } });
      setChallenge({ id: row.id, phrase: row.phrase });
      return row;
    },
    [newChallenge],
  );

  useEffect(() => {
    if (mode === "command" || challenge) return;
    requestChallenge(mode === "enroll" ? "enroll" : "verify").catch(() => undefined);
  }, [mode, challenge, requestChallenge]);

  /* ---------- wake word ---------- */

  const stopWakeListener = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setWakeListening(false);
  }, []);

  const startWakeListener = useCallback(() => {
    const SR =
      (window as unknown as { SpeechRecognition?: new () => never; webkitSpeechRecognition?: new () => never })
        .SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => never }).webkitSpeechRecognition;
    if (!SR) {
      toast.error("This browser can't listen for a wake word. Use the mic button instead.");
      return;
    }
    const recognition = new (SR as unknown as new () => {
      continuous: boolean;
      interimResults: boolean;
      lang: string;
      onresult: (event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
      onerror: () => void;
      onend: () => void;
      start: () => void;
      stop: () => void;
    })();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      let heard = "";
      for (let i = 0; i < event.results.length; i++) {
        heard += ` ${event.results[i]?.[0]?.transcript ?? ""}`;
      }
      if (stripWakeWord(heard).wake) {
        setWakeHeard(true);
        speak("Guard listening.");
        recognition.stop();
      }
    };
    recognition.onerror = () => setWakeListening(false);
    recognition.onend = () => setWakeListening(false);
    recognition.start();
    recognitionRef.current = recognition;
    setWakeListening(true);
  }, []);

  useEffect(() => () => recognitionRef.current?.stop(), []);

  /* ---------- capture flow ---------- */

  async function handleMic() {
    if (capture.recording) {
      setBusy(true);
      try {
        setStage("Voice capture");
        const clip = await capture.stop();
        if (!clip) {
          toast.error(capture.error ?? "Nothing was recorded.");
          return;
        }

        setStage("Speech to text");
        const { text } = await transcribe({
          data: { audioBase64: clip.audioBase64, mimeType: clip.mimeType },
        });
        setTranscript(text || "(nothing heard)");

        if (mode === "command") {
          setStage("Intent · LLM");
          const command = stripWakeWord(text).command || text;
          const intent = await resolveIntent({ data: { transcript: command } });
          setIntentLine(`${intent.intent} · ${intent.source}`);
          setStatusLine(intent.spoken);
          speak(intent.spoken);
          if (intent.path) {
            setStage("Navigate");
            const path = intent.path;
            setTimeout(() => navigate({ to: path }), 1800);
          } else {
            setStage(undefined);
          }
          return;
        }

        if (!challenge) {
          toast.error("No challenge phrase is active. Refresh and try again.");
          return;
        }

        setStage("Speaker verify");
        if (mode === "enroll") {
          const result = await enroll({
            data: {
              challengeId: challenge.id,
              vector: clip.embedding.vector,
              transcript: text,
            },
          });
          setChallenge(null);
          await state.refetch();
          setStatusLine(
            result.sampleCount >= MIN_ENROLL_SAMPLES
              ? "Enrollment complete — you can verify now."
              : `Sample ${result.sampleCount} of ${MIN_ENROLL_SAMPLES} stored.`,
          );
          setStage(undefined);
          return;
        }

        const result = await verify({
          data: { challengeId: challenge.id, vector: clip.embedding.vector, transcript: text },
        });
        setChallenge(null);
        setScore(result.score);
        setStatusLine(result.detail);
        await state.refetch();

        if (result.result === "granted") {
          setVerdict("granted");
          speak("Access granted. What would you like to open?");
          setStage(undefined);
        } else if (result.result === "borderline") {
          setVerdict("borderline");
          speak("Borderline match. Please confirm with your PIN.");
          setStage(undefined);
        } else {
          setVerdict("denied");
          speak("Access denied.");
          setStage(undefined);
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Something went wrong.");
        setStage(undefined);
      } finally {
        setBusy(false);
        setWakeHeard(false);
      }
      return;
    }

    if (mode !== "command" && !challenge) {
      await requestChallenge(mode === "enroll" ? "enroll" : "verify");
    }
    setStatusLine(null);
    setTranscript(null);
    await capture.start();
  }

  useEffect(() => {
    if (wakeHeard && !capture.recording && !busy) {
      handleMic().catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wakeHeard]);

  async function submitPin() {
    setBusy(true);
    try {
      const result = await checkPin({ data: { pin } });
      setPin("");
      await state.refetch();
      if (result.ok) {
        setVerdict("granted");
        setStatusLine("PIN accepted — voice fallback cleared.");
        speak("PIN accepted. What would you like to open?");
      } else {
        toast.error(result.detail);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The PIN check failed.");
    } finally {
      setBusy(false);
    }
  }

  const samples = state.data?.enrolledSamples ?? 0;
  const threshold = state.data?.threshold ?? 0.72;

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-ink">
      <GlowField />
      <GuardHeader
        right={
          <>
            <span className={verified ? "chip-accent" : "chip"}>
              ● {verified ? "Secure session" : "Awaiting verification"}
            </span>
            <button
              type="button"
              onClick={async () => {
                await supabase.auth.signOut();
                navigate({ to: "/" });
              }}
              className="font-mono text-[11px] text-mute hover:text-ink"
            >
              Sign out
            </button>
          </>
        }
      />

      <main className="relative z-10 mx-auto grid max-w-6xl grid-cols-1 gap-5 px-6 pb-12 lg:grid-cols-12">
        <Panel className="flex flex-col lg:col-span-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <PanelLabel accent>
                {mode === "enroll"
                  ? "Voice enrollment"
                  : mode === "verify"
                    ? "Speaker verification"
                    : "Assistant command"}
              </PanelLabel>
              <h1 className="mt-3 font-display text-3xl leading-tight font-semibold tracking-tight">
                {mode === "enroll"
                  ? "Enrollment"
                  : mode === "verify"
                    ? "Authentication"
                    : "Where to?"}
              </h1>
              <p className="mt-2 max-w-sm text-sm leading-relaxed text-mute">
                {mode === "enroll"
                  ? `Record ${MIN_ENROLL_SAMPLES} short samples. Each one uses a different phrase so no single recording can be replayed.`
                  : mode === "verify"
                    ? "Speak the live challenge phrase to verify your voiceprint against your enrolled embedding."
                    : "Say where you want to go — for example “take me to the dashboard” or “open settings”."}
              </p>
            </div>
            <span className="chip shrink-0">
              Liveness <span className="ml-1 text-accent">active</span>
            </span>
          </div>

          {mode !== "command" && (
            <div className="glass-inset mt-6 p-5">
              <PanelLabel>Challenge phrase</PanelLabel>
              <p className="mt-2 text-base font-medium text-ink">
                {challenge ? `“${challenge.phrase}.”` : "Requesting a fresh phrase…"}
              </p>
            </div>
          )}

          <div className="mt-6 flex items-center gap-6">
            <MicOrb active={capture.recording} onClick={handleMic} disabled={busy} />
            <LevelBars level={capture.level} active={capture.recording} />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleMic}
              disabled={busy}
              className="signal-gradient rounded-xl px-5 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {capture.recording ? "Stop & analyse" : busy ? "Working…" : "Start recording"}
            </button>
            <button
              type="button"
              onClick={wakeListening ? stopWakeListener : startWakeListener}
              className={wakeListening ? "chip-accent" : "chip"}
            >
              {wakeListening ? "Listening for “Hey Guard”" : "Enable wake word"}
            </button>
            {mode === "verify" && (
              <button
                type="button"
                onClick={() => requestChallenge("verify")}
                className="chip"
                disabled={capture.recording}
              >
                New phrase
              </button>
            )}
          </div>

          {capture.error && <p className="mt-3 text-xs text-destructive">{capture.error}</p>}

          <div className="mt-6">
            <ConfidenceMeter
              score={score}
              threshold={threshold}
              state={verdict}
              samples={samples}
            />
          </div>

          {verdict === "borderline" && (
            <div className="mt-4 rounded-2xl border border-warn/25 bg-warn/[0.06] p-5">
              <PanelLabel>Borderline — PIN fallback</PanelLabel>
              <p className="mt-2 text-xs text-mute">
                {state.data?.hasPin
                  ? "Confidence sits just under the decision line. Enter your backup PIN to continue."
                  : "No backup PIN is set yet. Add one in Settings to clear borderline attempts."}
              </p>
              <div className="mt-3 flex items-center gap-2">
                <input
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
                  inputMode="numeric"
                  placeholder="PIN"
                  className="glass-inset w-32 px-3 py-2 font-mono text-sm tracking-[0.3em] text-ink outline-none placeholder:tracking-normal placeholder:text-mute"
                />
                <button
                  type="button"
                  onClick={submitPin}
                  disabled={busy || pin.length < 4}
                  className="rounded-xl bg-warn px-4 py-2 font-mono text-[12px] font-medium text-background disabled:opacity-50"
                >
                  Verify
                </button>
                <Link to="/settings" className="chip">
                  Settings
                </Link>
              </div>
            </div>
          )}

          {state.data?.lockedOut && (
            <p className="mt-4 text-xs text-destructive">
              Voice attempts are locked for 10 minutes after 5 failures. Use your backup PIN.
            </p>
          )}
        </Panel>

        <div className="flex flex-col gap-5 lg:col-span-5">
          <Panel className="p-6">
            <div className="flex items-center justify-between">
              <PanelLabel>Assistant</PanelLabel>
              <span className="flex items-center gap-2 font-mono text-[10px] text-accent">
                <span className="size-1.5 rounded-full bg-accent" />
                {capture.recording ? "Listening" : busy ? "Thinking" : "Idle"}
              </span>
            </div>
            <div className="mt-4 space-y-3">
              {transcript && (
                <div className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm bg-brand/25 px-4 py-2.5 text-sm">
                  {transcript}
                </div>
              )}
              {intentLine && (
                <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-border bg-white/[0.06] px-4 py-2.5 text-sm">
                  <span className="text-mute">Intent detected · </span>
                  <span className="text-ink">{intentLine}</span>
                </div>
              )}
              {!transcript && !intentLine && (
                <p className="text-sm text-mute">
                  Nothing spoken yet. Say “Hey Guard, open the dashboard” once verified.
                </p>
              )}
            </div>
            {statusLine && (
              <div className="glass-inset mt-4 flex items-center gap-2 border-accent/20 px-3 py-2.5">
                <span className="text-accent">◀</span>
                <p className="flex-1 text-sm text-ink">{statusLine}</p>
              </div>
            )}
          </Panel>

          <Panel className="p-6">
            <div className="flex items-center justify-between">
              <PanelLabel>Enrollment</PanelLabel>
              <span className="font-mono text-[10px] text-mute">
                {Math.min(samples, MIN_ENROLL_SAMPLES)} / {MIN_ENROLL_SAMPLES}
              </span>
            </div>
            <div className="mt-4 space-y-2">
              {Array.from({ length: MIN_ENROLL_SAMPLES }).map((_, index) => {
                const done = index < samples;
                return (
                  <div
                    key={index}
                    className={`flex items-center justify-between rounded-lg border px-3 py-2 ${
                      done ? "border-accent/25 bg-accent/5" : "border-border bg-white/[0.03]"
                    }`}
                  >
                    <span className="font-mono text-[11px] text-ink">
                      SLOT {String(index + 1).padStart(2, "0")}
                    </span>
                    <span
                      className={`size-1.5 rounded-full ${done ? "bg-accent" : "bg-muted-foreground/40"}`}
                    />
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel className="p-6">
            <div className="flex items-center justify-between">
              <PanelLabel>Audit log</PanelLabel>
              <Link to="/audit" className="font-mono text-[10px] text-accent hover:underline">
                View all
              </Link>
            </div>
            <AuditList attempts={(state.data?.attempts ?? []).slice(0, 4)} />
          </Panel>
        </div>

        <Panel className="p-6 lg:col-span-12">
          <div className="flex items-center justify-between">
            <PanelLabel>Signal pipeline</PanelLabel>
            <span className="font-mono text-[10px] text-mute">audio → nav trigger</span>
          </div>
          <Pipeline activeStage={stage} />
        </Panel>
      </main>
    </div>
  );
}
