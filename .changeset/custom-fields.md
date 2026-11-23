---
"@speekl/tasks": minor
---

Every task object carries `custom_fields` when its `task.md` has frontmatter keys the convention does not define: the project's own keys, as read, in read order, after `updated`; the key is absent when there are none, so a tree without keys of its own keeps the shape it had. `show` and `resume` print them with the fields, so a project's own keys are read through the CLI and never from the file, and `--fields custom_fields` asks for them. The CLI still neither interprets nor writes them, and `validate` still names each as `unknown-key`.
