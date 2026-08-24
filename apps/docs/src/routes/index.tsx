import { createFileRoute, Link } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import {
  ArrowRight,
  Bot,
  Braces,
  ScrollText,
  Terminal as TerminalIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { baseOptions } from "@/lib/layout.shared";
import { packageName, siteUrl, specVersion, standardName } from "@/lib/shared";
import {
  Blank,
  Cmd,
  Ok,
  Out,
  Status,
  Terminal,
} from "@/components/home/terminal";
import { InstallCommand } from "@/components/home/install-command";
import { AuthorCard } from "@/components/author";

export const Route = createFileRoute("/")({
  component: Home,
  head: () => {
    const title = `${standardName} — An open format for agent task state`;
    const description =
      "An open format for tracking agent work that outlives a single session. Tasks are markdown files under .tasks/, committed with your code. @speekl/tasks is the reference implementation.";

    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
      ],
      links: [{ rel: "canonical", href: `${siteUrl}/` }],
    };
  },
});

function Home() {
  return (
    // HomeLayout renders the <main> itself, so these are siblings inside it.
    <HomeLayout {...baseOptions()}>
      <Hero />
      <WhatIsIt />
      <Why />
      <HowItWorks />
      <WhereToUse />
      <OpenFormat />
      <GetStarted />
      <Author />
    </HomeLayout>
  );
}

/* -------------------------------------------------------------------------- */

function Hero() {
  return (
    // Fills the viewport below the sticky h-14 navbar. `svh` rather than `vh`
    // so mobile browser chrome cannot push the content out of view; `min-h`
    // rather than `h` so a short landscape viewport grows instead of clipping.
    <section className="relative flex min-h-[calc(100svh-3.5rem)] flex-col justify-center overflow-hidden border-b border-fd-border">
      <div
        className="hero-grid pointer-events-none absolute inset-0"
        aria-hidden
      />
      <Container className="relative py-16 text-center">
        <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          A task format for <span className="text-fd-primary">AI agents.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-pretty text-fd-muted-foreground">
          <Code>.tasks</Code> is an open format for tracking work that outlives
          a single session. Tasks are markdown files in your repository,
          committed alongside the code they describe. No server, no account, no
          network.
        </p>

        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/docs/$"
            params={{ _splat: "quickstart" }}
            className="inline-flex h-11 items-center gap-2 rounded-lg bg-fd-primary px-5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Get started
            <ArrowRight className="size-4" aria-hidden />
          </Link>
          <Link
            to="/docs/$"
            params={{ _splat: "spec" }}
            className="inline-flex h-11 items-center gap-2 rounded-lg border border-fd-border px-5 text-sm font-medium transition-colors hover:bg-fd-accent"
          >
            <ScrollText className="size-4" aria-hidden />
            Read the spec
          </Link>
        </div>

        <div className="mt-7 flex flex-col items-center gap-3">
          <span className="text-sm text-fd-muted-foreground">
            Reference implementation
          </span>
          <InstallCommand command="npm i -g @speekl/tasks" />
        </div>
      </Container>
    </section>
  );
}

/* -------------------------------------------------------------------------- */

const TREE = `.tasks/
├── config.yml           # Optional: statuses, default scope
├── auth-rework/         # A phase — just a directory
│   ├── token-schema.md  # One task
│   └── wire-refresh.md
├── .archive/            # Deleted tasks, ids stay reserved
└── _index.md            # Optional: generated overview`;

function WhatIsIt() {
  return (
    <Section title={`What is ${standardName}?`}>
      <Prose>
        <p>
          It is a directory of markdown files. Each task is one file: a YAML
          frontmatter block the tooling owns, and a body you write yourself.
        </p>
        <p>
          The directory a task sits in is its <strong>phase</strong> — a
          milestone, a quarter, a workstream, whatever you group work by. That
          is the whole structure.
        </p>
      </Prose>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Terminal title="Directory layout">
          <Out>{TREE}</Out>
        </Terminal>

        <Terminal title="auth-rework/token-schema.md">
          <Out dim>---</Out>
          <Out>
            <Key>id</Key>
            {": token-schema"}
          </Out>
          <Out>
            <Key>phase</Key>
            {": auth-rework"}
          </Out>
          <Out>
            <Key>status</Key>
            {": "}
            <Status value="PENDING" />
          </Out>
          <Out>
            <Key>depends_on</Key>
            {": [audit-current-claims]"}
          </Out>
          <Out>
            <Key>claimed_by</Key>
            {": null"}
          </Out>
          <Out dim>---</Out>
          <Blank />
          <Out>
            <span className="text-term-accent"># Design the token schema</span>
          </Out>
          <Blank />
          <Out dim>## Acceptance criteria</Out>
          <Out dim>- [ ] Refresh tokens are single-use</Out>
        </Terminal>
      </div>

      <p className="mt-6 text-sm text-fd-muted-foreground">
        A person with a text editor can do anything the tooling can — and the
        tooling can repair what they get wrong.
      </p>
    </Section>
  );
}

function Key({ children }: { children: ReactNode }) {
  return <span className="text-term-cyan">{children}</span>;
}

/* -------------------------------------------------------------------------- */

const BENEFITS = [
  {
    title: "One source of truth",
    body: "Task state is committed with the code it describes, so it branches, merges, and reviews like everything else in the repo.",
  },
  {
    title: "Safe to run in parallel",
    body: "A task is claimed before it is worked, and a claim takes an exclusive lock. Two agents cannot pick up the same task.",
  },
  {
    title: "Order that means something",
    body: 'Tasks declare what they wait on, so "what can I start right now" is a real answer instead of a guess.',
  },
];

function Why() {
  return (
    <Section title={`Why ${standardName}?`} border>
      <Prose>
        <p>
          An agent working across sessions needs somewhere to put state that
          survives losing its context. Left alone, it invents something: a{" "}
          <Code>TODO.md</Code>, a checklist buried in a pull request, a plan
          rewritten from scratch every session.
        </p>
        <p>
          None of that survives a second agent working in parallel, and none of
          it says what is actually ready to start. A shared format gives you:
        </p>
      </Prose>

      <ul className="mt-8 grid gap-px overflow-hidden rounded-xl border border-fd-border bg-fd-border sm:grid-cols-3">
        {BENEFITS.map((benefit) => (
          <li key={benefit.title} className="bg-fd-background p-6">
            <h3 className="text-base font-semibold">{benefit.title}</h3>
            <p className="mt-2 text-sm/6 text-fd-muted-foreground">
              {benefit.body}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */

const STAGES = [
  {
    title: "Describe the work",
    body: (
      <>
        Create a task in a phase and say what it waits on. The phase directory
        is created for you.
      </>
    ),
  },
  {
    title: "Claim it",
    body: (
      <>
        Claiming records who took the task and when, and it fails if the task is
        blocked or someone else already has it. Claim before working, not after.
      </>
    ),
  },
  {
    title: "Finish it",
    body: (
      <>
        Completing a task unblocks whatever was waiting on it, so the next{" "}
        <Code>ready</Code> answer is different.
      </>
    ),
  },
];

function HowItWorks() {
  return (
    <Section title={`How does ${standardName} work?`} border>
      <Prose>
        <p>
          Every tool that implements the format answers one question the same
          way: <strong>what can be worked on right now?</strong> A task is ready
          when it has not been started and everything it depends on is done.
        </p>
      </Prose>

      <div className="mt-8 grid items-start gap-10 lg:grid-cols-2">
        <ol className="space-y-6">
          {STAGES.map((stage, i) => (
            <li key={stage.title} className="flex gap-4">
              <span
                className="flex size-7 shrink-0 items-center justify-center rounded-full border border-fd-border font-mono text-xs font-medium text-fd-primary"
                aria-hidden
              >
                {i + 1}
              </span>
              <div>
                <h3 className="text-base font-semibold">{stage.title}</h3>
                <p className="mt-1 text-sm/6 text-fd-muted-foreground">
                  {stage.body}
                </p>
              </div>
            </li>
          ))}
        </ol>

        <Terminal>
          <Cmd>tasks new auth-rework &quot;Wire refresh&quot;</Cmd>
          <Ok>
            {"Created "}
            <span className="font-bold">wire-refresh</span>
            {" in phase auth-rework"}
          </Ok>
          <Cmd>tasks dep add wire-refresh token-schema</Cmd>
          <Blank />
          <Cmd>tasks ready</Cmd>
          <Out dim>
            {" ID             STATUS    PHASE         DEPENDS ON   UPDATED"}
          </Out>
          <Out>
            {" token-schema   "}
            <Status value="PENDING" />
            {"   auth-rework   —            "}
            <span className="text-term-dim">2026-08-21 09:14</span>
          </Out>
          <Blank />
          <Out dim>{"# wire-refresh is blocked, so it is not listed"}</Out>
          <Blank />
          <Cmd>tasks claim token-schema</Cmd>
          <Ok>
            {"Claimed "}
            <span className="font-bold">token-schema</span>
            {" as dan → "}
            <Status value="IN_PROGRESS" />
          </Ok>
          <Blank />
          <Cmd>tasks status token-schema DONE</Cmd>
          <Ok>
            <span className="font-bold">token-schema</span>
            {"  "}
            <Status value="IN_PROGRESS" />
            {" → "}
            <Status value="DONE" />
          </Ok>
          <Out dim>{"# wire-refresh is now ready"}</Out>
        </Terminal>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */

const CONSUMERS = [
  {
    icon: TerminalIcon,
    title: "The CLI",
    body: `${packageName} is the reference implementation. It enforces every rule in the specification, and it is the fastest way to try the format.`,
  },
  {
    icon: Bot,
    title: "An agent, directly",
    body: "Agents already read and write files. An agent can open the directory, parse the frontmatter, and answer what is ready without installing anything.",
  },
  {
    icon: Braces,
    title: "Something you build",
    body: "A CI check, an editor plugin, a dashboard, an MCP server. Pick a conformance role and implement against the spec.",
  },
];

function WhereToUse() {
  return (
    <Section title={`Where can you use ${standardName}?`} border>
      <Prose>
        <p>
          The format is the interface, so nothing is obliged to shell out to a
          particular tool. Anything that can read a directory can read a task
          tree.
        </p>
      </Prose>

      <div className="mt-8 grid gap-px overflow-hidden rounded-xl border border-fd-border bg-fd-border sm:grid-cols-3">
        {CONSUMERS.map((consumer) => (
          <div key={consumer.title} className="bg-fd-background p-6">
            <consumer.icon className="size-5 text-fd-primary" aria-hidden />
            <h3 className="mt-4 text-base font-semibold">{consumer.title}</h3>
            <p className="mt-2 text-sm/6 text-fd-muted-foreground">
              {consumer.body}
            </p>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */

const ROLES = [
  ["Reader", "Parses a tree and answers questions about it. Never writes."],
  ["Writer", "Creates and modifies tasks, preserving every invariant."],
  ["Manager", "Writer, plus claims, validation, repair, and archival."],
];

function OpenFormat() {
  return (
    <Section title="An open format" border>
      <div className="grid items-start gap-10 lg:grid-cols-2">
        <Prose>
          <p>
            The specification is written independently of any tool and versioned
            on its own. <Code>{standardName}</Code> {specVersion} is current.
          </p>
          <p>
            An implementation states which role it fills, so you know what it
            can be trusted to do. Where the spec and an implementation disagree,
            that is a bug in one of them.
          </p>
        </Prose>

        <dl className="divide-y divide-fd-border border-y border-fd-border">
          {ROLES.map(([role, meaning]) => (
            <div key={role} className="flex gap-4 py-3">
              <dt className="w-20 shrink-0 font-mono text-sm font-medium text-fd-primary">
                {role}
              </dt>
              <dd className="text-sm/6 text-fd-muted-foreground">{meaning}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */

const NEXT = [
  {
    title: "Quick start",
    body: "Set up a project and work your first task.",
    splat: "quickstart",
  },
  {
    title: "Specification",
    body: `The complete format definition for ${standardName} ${specVersion}.`,
    splat: "spec",
  },
];

function GetStarted() {
  return (
    <Section title={`Get started with ${standardName}`} border>
      <div className="grid gap-4 sm:grid-cols-2">
        {NEXT.map((item) => (
          <Link
            key={item.splat}
            to="/docs/$"
            params={{ _splat: item.splat }}
            className="group rounded-xl border border-fd-border bg-fd-card p-6 transition-colors hover:bg-fd-accent"
          >
            <h3 className="flex items-center gap-2 text-base font-semibold">
              {item.title}
              <ArrowRight
                className="size-4 text-fd-primary transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </h3>
            <p className="mt-2 text-sm/6 text-fd-muted-foreground">
              {item.body}
            </p>
          </Link>
        ))}
      </div>
    </Section>
  );
}

function Author() {
  return (
    <Section title="Who builds it" border>
      <AuthorCard className="mt-8" />
    </Section>
  );
}

/* -------------------------------------------------------------------------- */

function Container({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full max-w-6xl px-4 sm:px-6 ${className ?? ""}`}>
      {children}
    </div>
  );
}

function Section({
  title,
  border,
  children,
}: {
  title: string;
  border?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={border ? "border-t border-fd-border" : undefined}>
      <Container className="py-16 sm:py-20">
        <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          {title}
        </h2>
        {children}
      </Container>
    </section>
  );
}

/** Body copy under a section heading. */
function Prose({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 max-w-3xl space-y-4 text-base/7 text-fd-muted-foreground">
      {children}
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded border border-fd-border bg-fd-muted px-1 py-0.5 font-mono text-[0.85em] text-fd-foreground">
      {children}
    </code>
  );
}
