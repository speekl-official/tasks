import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A static terminal transcript. Not a real emulator — it exists so the shape of
 * the CLI's output is the first thing a visitor sees, so the content is
 * hand-set rather than replayed.
 */
export function Terminal({
  title = "zsh — ~/acme-api",
  className,
  children,
}: {
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-black/10 bg-term-bg shadow-2xl shadow-black/20 dark:border-white/10",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-white/8 bg-term-chrome px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden>
          <Dot className="bg-[#ff5f57]" />
          <Dot className="bg-[#febc2e]" />
          <Dot className="bg-[#28c840]" />
        </span>
        <span className="ml-1 truncate font-mono text-[11px] text-term-dim">
          {title}
        </span>
      </div>
      <div className="overflow-x-auto p-4 font-mono text-[12.5px]/[1.7] text-term-fg sm:p-5 sm:text-[13px]/[1.75]">
        <pre className="min-w-max">{children}</pre>
      </div>
    </div>
  );
}

function Dot({ className }: { className: string }) {
  return <span className={cn("size-2.5 rounded-full", className)} />;
}

/** A typed command line, prefixed with a prompt. */
export function Cmd({ children }: { children: ReactNode }) {
  return (
    <span className="block">
      <span className="select-none text-term-accent" aria-hidden>
        ${" "}
      </span>
      <span className="text-term-fg">{children}</span>
    </span>
  );
}

/** Program output. `dim` for chrome like table headers and counts. */
export function Out({ children, dim }: { children: ReactNode; dim?: boolean }) {
  return (
    <span className={cn("block", dim ? "text-term-dim" : "text-term-fg")}>
      {children}
    </span>
  );
}

export function Blank() {
  return <span className="block h-3.5" aria-hidden />;
}

/** A `✓ …` success line, matching what the CLI actually prints. */
export function Ok({ children }: { children: ReactNode }) {
  return (
    <span className="block text-term-fg">
      <span className="text-term-success">✓ </span>
      {children}
    </span>
  );
}

const STATUS_CLASS = {
  PENDING: "status-pending",
  IN_PROGRESS: "status-progress",
  DONE: "status-done",
} as const;

export function Status({ value }: { value: keyof typeof STATUS_CLASS }) {
  return <span className={STATUS_CLASS[value]}>{value}</span>;
}
