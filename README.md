# prifly-ext-trello

A [prifly](https://github.com/jimmy927/prifly) extension that puts your Trello
board into the window. **From a Trello card…**, beside New session, lays the
board out in its columns; the card you pick becomes a session that already
knows the whole ticket — description, comments, checklists, and every attached
picture saved to disk and pointed at. The card then rides along on that
session's banner: click it to open it in Trello, or use its menu to move it to
another column when the work moves.

## Install

In prifly: status bar → the puzzle icon → Install from
`https://github.com/jimmy927/prifly-ext-trello`, then tick it to enable it. Or
clone this repository into `~/.local/share/prifly/extensions/`.

Then open **From a Trello card…** and follow the two rows it shows:

1. **Open the Trello login page** — your browser opens Trello's own approval
   page. Sign in however you normally do (Google, Microsoft, Atlassian); prifly
   never sees a password.
2. **Paste the token Trello shows you** — one paste, once. It is checked
   against Trello there and then, and kept in `auth.json` in this folder,
   readable only by you.

Then pick which of your boards to show. That is the whole setup — there is no
config file to write, and the board can be changed later from the same list
("Switch board…"), as can logging out.

### The app key

Trello wants two things on every call: a **token**, which is you, and an **app
key**, which is the name of the app asking. The token comes from your login and
reaches your boards and nobody else's. The key reads nothing on its own — it is
the same idea as the GitHub CLI's client id.

This repository ships no key, so `config.json` here holds one:

```json
{ "appKey": "…", "cwd": "", "done": ["Done"], "refreshSeconds": 60 }
```

Make one at [trello.com/power-ups/admin](https://trello.com/power-ups/admin) —
new Power-Up, then the API key tab — or paste it into the first row the chooser
offers when there is none. `cwd` is the folder a card's session starts in; left
empty you pick it in the New session form as usual. `done` names the columns
that mean the work is over, drawn in the quiet colour.

`config.json`, `auth.json`, `state.json` and the downloaded `cards/` are all
ignored by git: nothing about your account or your board is ever committed.

## What it brings

- **A launcher** — your board in its columns, filtered by title, label, member
  or card id, and the chosen card as a session's first prompt (`index.ts`).
  Attachments are downloaded to `cards/<card>/`; the prompt says where they are
  and to look at them.
- **A chip on the session** — which column the card is in, who is on it, when
  it is due, how much has been said on it. It links to the card, and its menu
  moves the card to any other column on the board.
- **A Claude Code skill** — `skills/trello`: search cards, read one whole,
  download its attachments. It uses the same login, so sessions never ask you
  for a key. The repository is also a Claude Code plugin and its own
  marketplace, so terminal sessions can have it too:

      claude plugin marketplace add jimmy927/prifly-ext-trello
      claude plugin install trello@prifly-ext-trello

- **Instructions** — `prompt.md`, added to every session prifly starts: read
  the pictures, leave moving the card to the reader, never ask for a token.

## How a card finds its session

prifly hands the extension the id of the session a launch became, and the pair
is kept in `state.json` here. A card therefore belongs to the session that was
started from it — nothing else claims a card, and an existing session cannot be
adopted by one.

## Writing an extension

An extension is a folder with a `prifly-extension.json` manifest;
`prifly-api.ts` here is prifly's whole contract, copied so this repository
type-checks on its own. This one uses all of it:

```json
{ "id": "trello", "name": "Trello board", "main": "index.ts",
  "prompt": "prompt.md",
  "launch": [{ "id": "card", "label": "From a Trello card…", "icon": "link" }] }
```

- **`main`** exports `activate(api)` — and, for a launcher, `choices(id, query)`,
  `launch(id, key, input)`, `launched(id, key, sessionId)` and
  `action(key, actionId)`.
- A row may **ask for something** (`input` on a choice) and a launch may bring
  **no prompt at all**, which leaves the chooser open and lists again. That is
  how this extension has a login and a board picker without a settings screen:
  see `setup.ts`.
- **`prompt`** is added to the system prompt of every session prifly starts.
- **`.claude-plugin/plugin.json`** in the same folder makes it a Claude Code
  plugin too; prifly passes the folder to its sessions with `--plugin-dir`.

Extensions run inside prifly's host with its rights, which is why prifly starts
none until you enable one.
