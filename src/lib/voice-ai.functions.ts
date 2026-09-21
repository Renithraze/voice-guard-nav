import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { NAV_TARGETS, matchIntentLocally } from "@/lib/voiceguard-config";

const GATEWAY = "https://ai.gateway.lovable.dev/v1";

function requireKey(): string {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("AI is not configured for this project yet.");
  return key;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Transcribe a short recording. Audio is passed through, never stored. */
export const transcribeClip = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        audioBase64: z.string().min(64),
        mimeType: z.string().default("audio/webm"),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const key = requireKey();
    const bytes = base64ToBytes(data.audioBase64);
    if (bytes.byteLength > 8 * 1024 * 1024) {
      throw new Error("That recording is too long — keep it under a few seconds.");
    }

    const extension =
      { "audio/webm": "webm", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav" }[
        data.mimeType.split(";")[0] ?? ""
      ] ?? "webm";

    const form = new FormData();
    form.append("model", "openai/gpt-4o-mini-transcribe");
    form.append("file", new Blob([bytes], { type: data.mimeType }), `clip.${extension}`);

    const response = await fetch(`${GATEWAY}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`Transcription failed [${response.status}]: ${body}`);
      if (response.status === 402) {
        throw new Error("The AI workspace is out of credits, so speech could not be transcribed.");
      }
      if (response.status === 429) {
        throw new Error("Too many voice requests at once — wait a moment and try again.");
      }
      throw new Error(`Speech could not be transcribed (${response.status}).`);
    }

    const payload = (await response.json()) as { text?: string };
    return { text: (payload.text ?? "").trim() };
  });

/** Map an open-ended spoken command onto one of the app's navigation targets. */
export const resolveNavigationIntent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ transcript: z.string().min(1).max(500) }).parse(input),
  )
  .handler(async ({ data }) => {
    const local = matchIntentLocally(data.transcript);
    if (local) {
      return {
        intent: local.intent,
        path: local.path,
        label: local.label,
        source: "rules" as const,
        spoken: `Access granted — opening ${local.label.toLowerCase()}.`,
      };
    }

    const key = requireKey();
    const catalog = NAV_TARGETS.map((t) => `${t.intent} -> ${t.label}`).join("; ");

    const response = await fetch(`${GATEWAY}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-6-astra",
        reasoning_effort: "low",
        max_completion_tokens: 2000,
        messages: [
          {
            role: "system",
            content:
              "You map a spoken navigation command onto exactly one destination id. " +
              `Destinations: ${catalog}. ` +
              'Reply with JSON only: {"intent":"<id or none>","spoken":"<one short confirmation sentence>"}. ' +
              'Use "none" when no destination is a reasonable match.',
          },
          { role: "user", content: data.transcript },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`Intent parsing failed [${response.status}]: ${body}`);
      if (response.status === 402) {
        throw new Error("The AI workspace is out of credits, so the command could not be read.");
      }
      throw new Error(`The command could not be interpreted (${response.status}).`);
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = payload.choices?.[0]?.message?.content ?? "";
    const jsonText = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);

    let parsed: { intent?: string; spoken?: string } = {};
    try {
      parsed = JSON.parse(jsonText) as { intent?: string; spoken?: string };
    } catch {
      parsed = {};
    }

    const target = NAV_TARGETS.find((t) => t.intent === parsed.intent);
    if (!target) {
      return {
        intent: "none",
        path: null,
        label: "No match",
        source: "llm" as const,
        spoken: "I couldn't match that to a page. Try 'open dashboard' or 'go to settings'.",
      };
    }

    return {
      intent: target.intent,
      path: target.path,
      label: target.label,
      source: "llm" as const,
      spoken: parsed.spoken?.slice(0, 160) || `Opening ${target.label.toLowerCase()}.`,
    };
  });
