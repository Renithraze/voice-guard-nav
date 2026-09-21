/** Shared, client-safe Voice Guard tuning constants. */

export const MATCH_THRESHOLD = 0.72;
export const BORDERLINE_MARGIN = 0.07;
export const WAKE_WORDS = ["hey guard", "hey god", "hay guard", "hey guide", "a guard"];
export const MIN_ENROLL_SAMPLES = 3;

export const CHALLENGE_WORDS = {
  adjectives: ["amber", "silver", "hollow", "quiet", "copper", "distant", "narrow", "bright"],
  nouns: ["skylight", "harbor", "lantern", "river", "orchard", "compass", "meadow", "signal"],
  verbs: ["drifts", "opens", "turns", "settles", "climbs", "waits", "hums", "folds"],
  numbers: ["at nine", "at four", "at seven", "past two", "past five", "at eleven"],
} as const;

export type NavTarget = {
  intent: string;
  path: string;
  label: string;
  phrases: string[];
};

export const NAV_TARGETS: NavTarget[] = [
  {
    intent: "open_dashboard",
    path: "/dashboard",
    label: "Dashboard",
    phrases: ["dashboard", "home", "overview", "main screen", "next page"],
  },
  {
    intent: "open_audit",
    path: "/audit",
    label: "Audit log",
    phrases: ["audit", "log", "history", "attempts", "activity"],
  },
  {
    intent: "open_settings",
    path: "/settings",
    label: "Settings",
    phrases: ["settings", "preferences", "security", "pin", "enrollment", "profile"],
  },
  {
    intent: "open_architecture",
    path: "/architecture",
    label: "Architecture & report",
    phrases: ["architecture", "diagram", "report", "pipeline", "documentation", "docs"],
  },
  {
    intent: "open_console",
    path: "/guard",
    label: "Voice console",
    phrases: ["console", "guard", "verify", "authentication", "voice check"],
  },
];

/** Cheap rule-based intent match, used before falling back to the language model. */
export function matchIntentLocally(transcript: string): NavTarget | null {
  const text = transcript.toLowerCase();
  let best: { target: NavTarget; score: number } | null = null;
  for (const target of NAV_TARGETS) {
    for (const phrase of target.phrases) {
      if (text.includes(phrase)) {
        const score = phrase.length;
        if (!best || score > best.score) best = { target, score };
      }
    }
  }
  return best?.target ?? null;
}

export function stripWakeWord(transcript: string): { wake: boolean; command: string } {
  const lower = transcript.toLowerCase();
  for (const wake of WAKE_WORDS) {
    const idx = lower.indexOf(wake);
    if (idx !== -1) {
      return { wake: true, command: transcript.slice(idx + wake.length).replace(/^[,\s]+/, "") };
    }
  }
  return { wake: false, command: transcript };
}
