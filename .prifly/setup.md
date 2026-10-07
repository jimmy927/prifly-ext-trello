---
setup: []
---

Nothing to install. The extension is plain TypeScript that the prifly host runs with Bun, and it
imports only its own files and Node built-ins (`node:path`, `node:fs`). The skill's
`skills/trello/trello.py` uses the Python standard library only. There is no package.json, no
lockfile and no pyproject.

What it relies on outside the worktree: `bun` on PATH to run or test the TypeScript, and
`python3` for the skill's script. A logged-in Trello account (`auth.json`, `config.json` and
`state.json`) exists only in the installed copy under `~/.local/share/prifly/extensions/`, and is
never needed to work in a worktree.
