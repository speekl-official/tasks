import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The install line, click-to-copy. Rendered as a button rather than a code
 * block because copying it is the only thing anyone wants to do with it.
 */
export function InstallCommand({
  command,
  className,
}: {
  command: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      // Clipboard access can be denied (insecure origin, permissions); the
      // command is still selectable on the page, so a failure is silent.
      onClick={() => {
        navigator.clipboard?.writeText(command).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
      aria-label={`Copy "${command}" to clipboard`}
      className={cn(
        "group inline-flex h-11 items-center gap-3 rounded-lg border border-fd-border bg-fd-card px-4 font-mono text-sm text-fd-foreground transition-colors hover:bg-fd-accent",
        className,
      )}
    >
      <span className="select-none text-fd-primary" aria-hidden>
        $
      </span>
      <span className="truncate">{command}</span>
      {copied ? (
        <Check className="size-4 shrink-0 text-fd-primary" aria-hidden />
      ) : (
        <Copy
          className="size-4 shrink-0 text-fd-muted-foreground transition-colors group-hover:text-fd-foreground"
          aria-hidden
        />
      )}
      <span className="sr-only" role="status">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
