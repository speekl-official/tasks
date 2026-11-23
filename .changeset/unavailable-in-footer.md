---
"@speekl/tasks": patch
---

Overviews now name the listed projects they could not show in their footer line, each with the reason in a word (`55 tasks · 5 from projects api · not shown: legacy (v1), mobile (not checked out)`), instead of printing one `!` line per project after every spanning command; `tasks validate` keeps the full sentence with the remedy, and the JSON's `unavailable` is unchanged.
