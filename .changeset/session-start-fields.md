---
"@speekl/tasks": patch
---

The SessionStart hook prints `mine` trimmed to the keys the entry decision reads and each task's last entry (`--fields id,title,yours,situation,liveness,effective_priority,last_entry`), with a note that the entry's `mine` is done for this tree; the skill and the protocol run `mine` once per tree, read the candidates' last entries before choosing (a person's `assign -m` or `note` stands there until the claim, or any later entry, displaces it), claim the task an instruction names by id, copy an assignment message's input under `## Notes` before the claim and, without the hooks, set the name and the token before that first `mine`. A session that starts with a dozen tasks reads a fraction of what it did, on every start, resume, clear and compaction. Existing installs take the new hook with `tasks hooks install --force`; until then the skill, finding rows without `last_entry`, runs `mine` once itself.
