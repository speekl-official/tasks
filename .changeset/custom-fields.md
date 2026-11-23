---
"@speekl/tasks": minor
---

Every task object carries `custom_fields` when its `task.md` has frontmatter keys the convention does not define: the project's own keys, as read, in read order, after `updated`; the key is absent when there are none, so a tree without keys of its own keeps the shape it had. `show` and `resume` print them as a `custom fields` block after the fields, so a project's own keys are read through the CLI and never from the file, and `--fields custom_fields` asks for them. The CLI still neither interprets nor writes them. `config.yml` takes `custom_fields`, the list of those keys: once any is listed, `validate` reports a key outside the list as an error (`undeclared-key`) and a listed one not at all; without the list an undefined key stays a warning (`unknown-key`). A tree whose `config.yml` lists it is read by this version and later only, since 1.0.0 refuses a `config.yml` key it does not know.
