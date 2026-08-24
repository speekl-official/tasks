---
id: claude-skill
phase: agent
status: PENDING
depends_on: [publish-v1]
created: "2026-08-22T01:43:17Z"
updated: "2026-08-22T01:43:23Z"
claimed_by: null
claimed_at: null
---

# Ship a Claude Code skill

## Description

Getting an agent to use this tool well means teaching it the workflow: check ready, claim before working, update status on completion, never hand-edit frontmatter. A packaged skill delivers that guidance at the point of use instead of relying on the agent reading `.tasks/README.md`.

## Acceptance criteria

- [ ] Skill describes the ready/claim/work/complete loop
- [ ] Documents the exit-code contract so the agent branches on codes, not text
- [ ] Explains that missing and archived dependencies block rather than pass
- [ ] Detects whether the project has a `.tasks/` directory before engaging
- [ ] Tested end to end against a real repo with a populated backlog

## Notes

Depends on publication so the skill can reference an installable package rather than a local path.
