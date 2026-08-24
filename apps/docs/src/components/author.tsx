import { Globe } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { author, authorHandle } from "@/lib/author";
import { cn } from "@/lib/cn";
import { standardName } from "@/lib/shared";

/**
 * Who wrote the thing. Lucide dropped its brand marks, so GitHub, X and
 * LinkedIn are inlined below; only the generic globe comes from the icon set.
 */
const LINKS: {
  label: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { label: "Website", href: author.site, icon: Globe },
  { label: "GitHub", href: author.github, icon: GithubIcon },
  { label: authorHandle, href: author.x, icon: XIcon },
  { label: "LinkedIn", href: author.linkedin, icon: LinkedinIcon },
];

export function AuthorCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-6 rounded-xl border border-fd-border bg-fd-card p-6 text-center sm:flex-row sm:items-start sm:gap-8 sm:p-8 sm:text-left",
        className,
      )}
    >
      <img
        src={author.photo}
        alt={author.name}
        width={96}
        height={96}
        loading="lazy"
        decoding="async"
        className="size-24 shrink-0 rounded-full border border-fd-border object-cover"
      />

      <div className="min-w-0">
        <h3 className="text-lg font-semibold tracking-tight">{author.name}</h3>
        <p className="mt-2 max-w-prose text-sm/6 text-fd-muted-foreground">
          Dan writes the <Code>{standardName}</Code> specification and maintains
          the CLI that implements it. Questions, disagreements with the spec,
          and implementations of your own are all welcome.
        </p>

        <ul className="mt-5 flex flex-wrap justify-center gap-2 sm:justify-start">
          {LINKS.map((link) => (
            <li key={link.href}>
              <AuthorLink href={link.href} icon={link.icon}>
                {link.label}
              </AuthorLink>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function AuthorLink({
  href,
  icon: Icon,
  children,
}: {
  href: string;
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="me noopener noreferrer"
      className="inline-flex h-9 items-center gap-2 rounded-lg border border-fd-border px-3 text-sm text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground"
    >
      <Icon className="size-4 shrink-0" />
      {children}
    </a>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded border border-fd-border bg-fd-muted px-1 py-0.5 font-mono text-[0.85em] text-fd-foreground">
      {children}
    </code>
  );
}

/* -- Brand marks. 24x24 viewBox, filled with the surrounding text color. ---- */

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932zm-1.29 19.49h2.039L6.486 3.24H4.298z" />
    </svg>
  );
}

function LinkedinIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0z" />
    </svg>
  );
}
