import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ShieldCheck, Waves, KeyRound, ScrollText } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { GlowField, GuardHeader, Panel, PanelLabel } from "@/components/vg/shell";
import { Pipeline } from "@/components/vg/signal";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Voice Guard — Sign in to the voice authentication console" },
      {
        name: "description",
        content:
          "Enroll your voice, pass a live challenge phrase, then navigate the app by speaking. Voiceprints are stored encrypted, never raw audio.",
      },
      { property: "og:title", content: "Voice Guard — Voice authentication console" },
      {
        property: "og:description",
        content:
          "Speaker verification with a live challenge phrase, PIN fallback, and spoken navigation.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/guard" });
    });
  }, [navigate]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: window.location.origin,
            data: { display_name: displayName || email.split("@")[0] },
          },
        });
        if (error) throw error;
        if (!data.session) {
          setNotice("Check your email to confirm the account, then sign in.");
          return;
        }
        navigate({ to: "/guard" });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate({ to: "/guard" });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: window.location.origin,
    });
    if (result.error) {
      toast.error("Google sign-in didn't complete. Try again.");
      return;
    }
    if (result.redirected) return;
    navigate({ to: "/guard" });
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-ink">
      <GlowField />
      <GuardHeader
        right={
          <>
            <span className="chip hidden md:inline-flex">MFCC speaker embedding · v1</span>
            <Link to="/architecture" className="chip-accent">
              Architecture & report
            </Link>
          </>
        }
      />

      <main className="relative z-10 mx-auto grid max-w-6xl grid-cols-1 gap-5 px-6 pb-12 lg:grid-cols-12">
        <Panel className="flex flex-col lg:col-span-7">
          <PanelLabel accent>Speaker verification</PanelLabel>
          <h1 className="mt-3 font-display text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
            Your voice is the key. The assistant is the door.
          </h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-mute">
            Enroll three short passphrase samples, then pass a live, randomly generated challenge
            phrase. Once your voiceprint matches, speak where you want to go and Voice Guard takes
            you there.
          </p>

          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {[
              { icon: Waves, title: "Voice biometrics", text: "Cosine match against your enrolled embedding, with a tunable decision line." },
              { icon: ShieldCheck, title: "Replay resistant", text: "Every attempt gets a fresh challenge phrase that expires in two minutes." },
              { icon: KeyRound, title: "PIN fallback", text: "Borderline confidence asks for your backup PIN instead of guessing." },
              { icon: ScrollText, title: "Audit trail", text: "Every attempt is timestamped with its method, score, and outcome." },
            ].map(({ icon: Icon, title, text }) => (
              <div key={title} className="glass-inset p-4">
                <Icon className="size-4 text-accent" />
                <p className="mt-3 text-sm font-medium text-ink">{title}</p>
                <p className="mt-1 text-xs leading-relaxed text-mute">{text}</p>
              </div>
            ))}
          </div>

          <div className="mt-8">
            <PanelLabel>Signal pipeline</PanelLabel>
            <Pipeline />
          </div>
        </Panel>

        <Panel className="lg:col-span-5">
          <div className="flex items-center justify-between">
            <PanelLabel>{mode === "signin" ? "Operator sign in" : "Create operator"}</PanelLabel>
            <button
              type="button"
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
              className="font-mono text-[11px] text-accent hover:underline"
            >
              {mode === "signin" ? "Need an account?" : "Have an account?"}
            </button>
          </div>

          <form onSubmit={handleSubmit} className="mt-6 space-y-3">
            {mode === "signup" && (
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Display name"
                className="glass-inset w-full px-4 py-3 text-sm text-ink outline-none placeholder:text-mute focus:border-accent/40"
              />
            )}
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="glass-inset w-full px-4 py-3 text-sm text-ink outline-none placeholder:text-mute focus:border-accent/40"
            />
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="glass-inset w-full px-4 py-3 text-sm text-ink outline-none placeholder:text-mute focus:border-accent/40"
            />
            <button
              type="submit"
              disabled={busy}
              className="signal-gradient w-full rounded-xl px-4 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
            </button>
          </form>

          <div className="my-5 flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="label-mono">or</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <button
            type="button"
            onClick={handleGoogle}
            className="glass-inset w-full px-4 py-3 text-sm font-medium text-ink transition-colors hover:border-accent/40"
          >
            Continue with Google
          </button>

          {notice && <p className="mt-4 text-xs leading-relaxed text-accent">{notice}</p>}
          <p className="mt-6 text-xs leading-relaxed text-mute">
            Voice Guard stores a mathematical voice signature, encrypted at rest. Your recordings
            are never saved.
          </p>
        </Panel>
      </main>
    </div>
  );
}
