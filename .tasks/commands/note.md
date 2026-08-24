---
id: note
phase: commands
status: PENDING
depends_on: []
created: "2026-08-22T01:43:16Z"
updated: "2026-08-22T01:43:16Z"
claimed_by: null
claimed_at: null
---

# Add tasks note to append progress notes

## Description

The template scaffolds a `## Notes` section for progress, blockers, and mid-task decisions, but an agent has to hand-edit markdown to use it. Give it a CLI surface so appending a note is a single scriptable call.

This also establishes the body-section editing helper that `check` will reuse.

## Acceptance criteria

- [ ] `tasks note <id> "text"` appends a timestamped entry under `## Notes`
- [ ] Creates the section when a hand-written task lacks it
- [ ] Body content outside the target section is untouched
- [ ] Reusable section-locating helper extracted for other body-editing commands
- [ ] `--json` output and tests for the missing-section path

## Notes

Body editing is new territory: the CLI has only ever rewritten frontmatter and treated the body as opaque. Keep the parsing conservative — match on heading text, never on line offsets.
