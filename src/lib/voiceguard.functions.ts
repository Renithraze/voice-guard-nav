import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { cosineSimilarity } from "@/lib/voice-dsp";
import { CHALLENGE_WORDS, MATCH_THRESHOLD, BORDERLINE_MARGIN } from "@/lib/voiceguard-config";

const vectorSchema = z.array(z.number()).min(16).max(512);

/* ---------- challenge phrases (liveness) ---------- */

function randomPhrase(): string {
  const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)]!;
  return [
    pick(CHALLENGE_WORDS.adjectives),
    pick(CHALLENGE_WORDS.nouns),
    pick(CHALLENGE_WORDS.verbs),
    pick(CHALLENGE_WORDS.numbers),
  ].join(" ");
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** How much of the challenge phrase actually appears in the transcript. */
export function phraseMatchRatio(phrase: string, transcript: string): number {
  const expected = normalizeWords(phrase);
  if (expected.length === 0) return 0;
  const spoken = new Set(normalizeWords(transcript));
  const digitWords: Record<string, string> = {
    zero: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
  };
  for (const word of Array.from(spoken)) {
    const digit = digitWords[word];
    if (digit) spoken.add(digit);
  }
  let hits = 0;
  for (const word of expected) if (spoken.has(word)) hits += 1;
  return hits / expected.length;
}

/* ---------- state ---------- */

export const getGuardState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const [profileRes, printRes, attemptsRes] = await Promise.all([
      supabase.from("profiles").select("display_name, pin_hash").eq("id", userId).maybeSingle(),
      supabase
        .from("voiceprints")
        .select("sample_count, dim, updated_at")
        .eq("user_id", userId)
        .maybeSingle(),
      supabase
        .from("auth_attempts")
        .select("id, method, result, score, threshold, detail, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(25),
    ]);

    const attempts = attemptsRes.data ?? [];
    const windowStart = Date.now() - 10 * 60 * 1000;
    const recentFailures = attempts.filter(
      (a) => a.result === "denied" && new Date(a.created_at).getTime() > windowStart,
    ).length;

    return {
      displayName: profileRes.data?.display_name ?? null,
      hasPin: Boolean(profileRes.data?.pin_hash),
      enrolledSamples: printRes.data?.sample_count ?? 0,
      enrolledAt: printRes.data?.updated_at ?? null,
      dim: printRes.data?.dim ?? 0,
      threshold: MATCH_THRESHOLD,
      attempts,
      recentFailures,
      lockedOut: recentFailures >= 5,
    };
  });

export const issueChallenge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ purpose: z.enum(["enroll", "verify"]) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const phrase = randomPhrase();
    const { data: row, error } = await supabase
      .from("voice_challenges")
      .insert({ user_id: userId, phrase, purpose: data.purpose })
      .select("id, phrase, expires_at")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

async function consumeChallenge(
  supabase: typeof import("@/integrations/supabase/client").supabase,
  userId: string,
  challengeId: string,
) {
  const { data, error } = await supabase
    .from("voice_challenges")
    .select("id, phrase, used_at, expires_at")
    .eq("id", challengeId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Challenge phrase not found");
  if (data.used_at) throw new Error("That challenge phrase was already used");
  if (new Date(data.expires_at).getTime() < Date.now())
    throw new Error("That challenge phrase expired");
  await supabase
    .from("voice_challenges")
    .update({ used_at: new Date().toISOString() })
    .eq("id", data.id);
  return data;
}

/* ---------- enrollment ---------- */

export const enrollVoiceSample = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        challengeId: z.string().uuid(),
        vector: vectorSchema,
        transcript: z.string().default(""),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { encryptEmbedding, decryptEmbedding } = await import("@/lib/voiceprint.server");

    const challenge = await consumeChallenge(supabase, userId, data.challengeId);
    const spokenMatch = phraseMatchRatio(challenge.phrase, data.transcript);

    const { data: existing } = await supabase
      .from("voiceprints")
      .select("embedding_cipher, sample_count")
      .eq("user_id", userId)
      .maybeSingle();

    let merged = data.vector;
    let sampleCount = 1;

    if (existing && existing.sample_count > 0) {
      const previous = await decryptEmbedding(existing.embedding_cipher);
      sampleCount = existing.sample_count + 1;
      merged = data.vector.map((v, i) => {
        const prior = previous[i] ?? 0;
        return (prior * existing.sample_count + v) / sampleCount;
      });
      const norm = Math.sqrt(merged.reduce((sum, v) => sum + v * v, 0)) || 1;
      merged = merged.map((v) => v / norm);
    }

    const cipher = await encryptEmbedding(merged);
    const { error } = await supabase.from("voiceprints").upsert(
      {
        user_id: userId,
        embedding_cipher: cipher,
        dim: merged.length,
        sample_count: sampleCount,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error(error.message);

    await supabase.from("auth_attempts").insert({
      user_id: userId,
      method: "enroll",
      result: "granted",
      detail: `Sample ${sampleCount} captured · phrase match ${(spokenMatch * 100).toFixed(0)}%`,
    });

    return { sampleCount, spokenMatch, dim: merged.length };
  });

export const resetVoiceprint = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await supabase.from("voiceprints").delete().eq("user_id", userId);
    await supabase.from("auth_attempts").insert({
      user_id: userId,
      method: "enroll",
      result: "denied",
      detail: "Voiceprint deleted by owner",
    });
    return { ok: true };
  });

/* ---------- verification ---------- */

export const verifyVoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        challengeId: z.string().uuid(),
        vector: vectorSchema,
        transcript: z.string().default(""),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { decryptEmbedding } = await import("@/lib/voiceprint.server");

    // rate limiting / lockout: 5 denials inside 10 minutes
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("auth_attempts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("result", "denied")
      .eq("method", "voice")
      .gte("created_at", since);

    if ((count ?? 0) >= 5) {
      return {
        result: "locked" as const,
        score: 0,
        threshold: MATCH_THRESHOLD,
        phraseMatch: 0,
        detail: "Too many failed attempts. Locked for 10 minutes — use your backup PIN.",
      };
    }

    const { data: print } = await supabase
      .from("voiceprints")
      .select("embedding_cipher, sample_count")
      .eq("user_id", userId)
      .maybeSingle();

    if (!print || print.sample_count < 2) {
      return {
        result: "unenrolled" as const,
        score: 0,
        threshold: MATCH_THRESHOLD,
        phraseMatch: 0,
        detail: "No voiceprint on file yet — enroll at least 2 samples first.",
      };
    }

    const challenge = await consumeChallenge(supabase, userId, data.challengeId);
    const phraseMatch = phraseMatchRatio(challenge.phrase, data.transcript);
    const score = cosineSimilarity(await decryptEmbedding(print.embedding_cipher), data.vector);

    let result: "granted" | "borderline" | "denied";
    let detail: string;

    if (phraseMatch < 0.5) {
      result = "denied";
      detail = "Liveness check failed — the spoken phrase did not match the live challenge.";
    } else if (score >= MATCH_THRESHOLD) {
      result = "granted";
      detail = "Voiceprint matched above threshold.";
    } else if (score >= MATCH_THRESHOLD - BORDERLINE_MARGIN) {
      result = "borderline";
      detail = "Borderline confidence — confirm with your backup PIN.";
    } else {
      result = "denied";
      detail = "Voiceprint similarity below the decision line.";
    }

    await supabase.from("auth_attempts").insert({
      user_id: userId,
      method: "voice",
      result,
      score,
      threshold: MATCH_THRESHOLD,
      detail,
    });

    return { result, score, threshold: MATCH_THRESHOLD, phraseMatch, detail };
  });

/* ---------- PIN fallback ---------- */

export const setBackupPin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ pin: z.string().regex(/^\d{4,8}$/, "PIN must be 4-8 digits") }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { hashPin } = await import("@/lib/voiceprint.server");
    const { error } = await supabase
      .from("profiles")
      .update({ pin_hash: await hashPin(data.pin, userId) })
      .eq("id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const verifyBackupPin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ pin: z.string().min(4).max(8) }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { hashPin } = await import("@/lib/voiceprint.server");

    const { data: profile } = await supabase
      .from("profiles")
      .select("pin_hash")
      .eq("id", userId)
      .maybeSingle();

    if (!profile?.pin_hash) {
      return { ok: false as const, detail: "No backup PIN is set on this account." };
    }

    const ok = profile.pin_hash === (await hashPin(data.pin, userId));
    await supabase.from("auth_attempts").insert({
      user_id: userId,
      method: "pin",
      result: ok ? "granted" : "denied",
      detail: ok ? "Backup PIN accepted" : "Backup PIN rejected",
    });
    return { ok, detail: ok ? "PIN accepted." : "That PIN is incorrect." };
  });
