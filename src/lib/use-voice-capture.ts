import { useCallback, useEffect, useRef, useState } from "react";
import { audioBufferToMono, computeVoiceEmbedding, type EmbeddingResult } from "@/lib/voice-dsp";

export type CapturedClip = {
  embedding: EmbeddingResult;
  audioBase64: string;
  mimeType: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/**
 * Microphone capture with a live input level, plus browser-side embedding
 * extraction when the recording stops.
 */
export function useVoiceCapture() {
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setLevel(0);
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.start();
      recorderRef.current = recorder;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);

      const tick = () => {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) sum += buffer[i]! * buffer[i]!;
        setLevel(Math.min(1, Math.sqrt(sum / buffer.length) * 5));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();

      setRecording(true);
      return true;
    } catch {
      setError("Microphone access is needed. Allow it in your browser, then try again.");
      teardown();
      return false;
    }
  }, [teardown]);

  const stop = useCallback(async (): Promise<CapturedClip | null> => {
    const recorder = recorderRef.current;
    if (!recorder) return null;

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () =>
        resolve(new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" }));
      recorder.stop();
    });

    setRecording(false);
    teardown();

    const arrayBuffer = await blob.arrayBuffer();
    if (arrayBuffer.byteLength < 2048) {
      setError("That recording was empty — please speak the phrase out loud.");
      return null;
    }

    const ctx = audioCtxRef.current ?? new AudioContext();
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const embedding = computeVoiceEmbedding(audioBufferToMono(decoded), decoded.sampleRate);
    await ctx.close().catch(() => undefined);
    audioCtxRef.current = null;

    if (!embedding) {
      setError("Not enough clear speech in that clip — try again a little louder and slower.");
      return null;
    }

    return {
      embedding,
      audioBase64: bytesToBase64(new Uint8Array(arrayBuffer)),
      mimeType: blob.type || "audio/webm",
    };
  }, [teardown]);

  return { recording, level, error, setError, start, stop };
}

/** Short spoken confirmation, when the browser supports speech synthesis. */
export function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}
