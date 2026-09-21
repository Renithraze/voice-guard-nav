import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function GlowField() {
  return (
    <div className="pointer-events-none fixed inset-0">
      <div className="absolute -top-40 -left-24 size-[520px] rounded-full bg-brand/25 blur-[120px]" />
      <div className="absolute top-24 right-0 size-[460px] rounded-full bg-accent/15 blur-[130px]" />
      <div className="absolute bottom-0 left-1/3 size-[500px] rounded-full bg-brand/20 blur-[150px]" />
    </div>
  );
}

export function GuardHeader({ right }: { right?: ReactNode }) {
  return (
    <header className="relative z-10 flex items-center justify-between px-6 py-5 sm:px-8">
      <Link to="/" className="flex items-center gap-3">
        <div className="signal-gradient grid size-9 place-items-center rounded-xl font-display text-base font-bold text-primary-foreground">
          G
        </div>
        <div>
          <p className="font-display text-[15px] leading-none font-semibold tracking-tight">
            Voice Guard
          </p>
          <p className="label-mono mt-1">VoxAegis Console</p>
        </div>
      </Link>
      <div className="flex items-center gap-4">{right}</div>
    </header>
  );
}

export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`glass p-6 sm:p-8 ${className}`}>{children}</section>;
}

export function PanelLabel({ children, accent }: { children: ReactNode; accent?: boolean }) {
  return <p className={`label-mono ${accent ? "text-accent" : ""}`}>{children}</p>;
}
