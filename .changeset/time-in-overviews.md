---
"@speekl/tasks": minor
---

Overviews show an UPDATED column after the situation in `ready`, `list`, `tree` and `mine`: the time since the task's manifest was last written by the tool, as a compact age (`3h`, `2d`, `5w`, `4mo`, `1y`). `list` and `tree` take `--sort created|updated` and `--reverse` (newest first by default, among siblings in `tree`), `list` takes `--updated-before <when>` and `--created-since <when>` in the grammar of `log --since`, and a CREATED column joins UPDATED while `created` is the key or the bound; the JSON is unchanged.
