import { Mic } from "lucide-react";

export function MicOrb({
  active,
  onClick,
  disabled,
}: {
  active: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={active ? "Stop recording" : "Start recording"}
      className="relative grid size-20 shrink-0 place-items-center disabled:opacity-40"
    >
      {active && <span className="vg-pulse absolute inset-0 rounded-full bg-brand/40" />}
      <span className="absolute inset-0 rounded-full border border-brand/40" />
      <span className="signal-gradient grid size-14 place-items-center rounded-full text-primary-foreground">
        <Mic className="size-6" />
      </span>
    </button>
  );
}

const BAR_DELAYS = [0, 0.15, 0.3, 0.1, 0.4, 0.22, 0.5, 0.08, 0.36, 0.28, 0.44, 0.12];

export function LevelBars({ level, active }: { level: number; active: boolean }) {
  return (
    <div className="flex h-16 flex-1 items-center gap-1.5">
      {BAR_DELAYS.map((delay, index) => (
        <span
          key={index}
          className={`w-1.5 rounded-full bg-accent/70 ${active ? "vg-bar" : ""}`}
          style={{
            animationDelay: `${delay}s`,
            height: active ? `${Math.max(12, level * 56 + 8)}px` : "10px",
          }}
        />
      ))}
    </div>
  );
}

export function ConfidenceMeter({
  score,
  threshold,
  state,
  samples,
}: {
  score: number | null;
  threshold: number;
  state: "idle" | "granted" | "borderline" | "denied";
  samples: number;
}) {
  const percent = Math.max(0, Math.min(1, score ?? 0)) * 100;
  const tone =
    state === "granted"
      ? "border-accent/20 bg-accent/[0.06]"
      : state === "borderline"
        ? "border-warn/25 bg-warn/[0.06]"
        : state === "denied"
          ? "border-destructive/25 bg-destructive/[0.06]"
          : "glass-inset";

  const statusChip =
    state === "granted"
      ? { text: "Identity confirmed", className: "chip-accent" }
      : state === "borderline"
        ? { text: "Borderline — PIN needed", className: "chip text-warn" }
        : state === "denied"
          ? { text: "Access denied", className: "chip text-destructive" }
          : { text: "Awaiting sample", className: "chip" };

  return (
    <div className={`rounded-2xl border p-5 ${tone}`}>
      <div className="flex items-center justify-between">
        <span className="label-mono text-accent">Match confidence</span>
        <span className="font-display text-2xl font-semibold text-ink">
          {score === null ? "—" : score.toFixed(3)}
        </span>
      </div>
      <div className="relative mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className="signal-gradient h-full rounded-full" style={{ width: `${percent}%` }} />
        <span
          className="absolute top-0 h-full w-px bg-warn"
          style={{ left: `${threshold * 100}%` }}
        />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className={statusChip.className}>{statusChip.text}</span>
        <span className="chip">Threshold {threshold.toFixed(2)}</span>
        <span className="chip">{samples} samples enrolled</span>
      </div>
    </div>
  );
}

const RESULT_TONE: Record<string, string> = {
  granted: "text-accent",
  borderline: "text-warn",
  denied: "text-destructive",
  locked: "text-destructive",
};

export type AttemptRow = {
  id: string;
  method: string;
  result: string;
  score: number | null;
  detail: string | null;
  created_at: string;
};

export function AuditList({ attempts }: { attempts: AttemptRow[] }) {
  if (attempts.length === 0) {
    return <p className="mt-4 text-sm text-mute">No attempts recorded yet.</p>;
  }
  return (
    <div className="mt-4 space-y-2.5">
      {attempts.map((attempt) => (
        <div
          key={attempt.id}
          className="flex items-center justify-between rounded-lg border border-border bg-white/[0.03] px-3 py-2"
        >
          <span className="font-mono text-[11px] text-mute">
            {new Date(attempt.created_at).toLocaleTimeString()}
          </span>
          <span className="text-xs text-ink">
            <span className="capitalize">{attempt.method}</span> ·{" "}
            <span className={RESULT_TONE[attempt.result] ?? "text-mute"}>{attempt.result}</span>
            {attempt.score !== null && (
              <span className="ml-2 font-mono text-[11px] text-mute">
                {attempt.score.toFixed(3)}
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Pipeline({ activeStage }: { activeStage?: string }) {
  const stages = ["Voice capture", "Speech to text", "Speaker verify", "Intent · LLM", "Navigate"];
  return (
    <div className="mt-5 flex flex-wrap items-center gap-3">
      {stages.map((stage, index) => (
        <div key={stage} className="flex items-center gap-3">
          <div
            className={`flex items-center gap-2 rounded-xl border px-3.5 py-2 ${
              activeStage === stage
                ? "border-accent/30 bg-accent/10 text-accent"
                : "border-border bg-white/[0.05]"
            }`}
          >
            <span
              className={`size-2 rounded-full ${activeStage === stage ? "bg-accent" : "bg-brand"}`}
            />
            <span className="text-sm">{stage}</span>
          </div>
          {index < stages.length - 1 && (
            <span className="signal-gradient hidden h-px w-6 shrink-0 md:block" />
          )}
        </div>
      ))}
    </div>
  );
}
