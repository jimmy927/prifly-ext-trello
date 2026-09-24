---
name: trello
description: Search and read Trello cards, list boards, and download card attachments. Use when the user references a Trello ticket, asks "find this Trello card", or wants the images/files attached to a card.
---

## Trello

Wraps `trello.py`, which sits next to this SKILL.md — run it as `python3 <this skill's folder>/trello.py`. A small Python CLI (stdlib only) that talks to the Trello REST API.

Credentials come from the prifly Trello extension this skill ships with: the reader logged in to Trello from prifly ("From a Trello card…"), and the token is in the extension's `auth.json`. Nothing to set up here. `TRELLO_API_KEY` / `TRELLO_TOKEN` override it on a machine with no prifly. If the script says it is not logged in, say so — do not go looking for keys elsewhere.

In prifly, a session started from a card already has that card's whole contents in its first prompt and its attachments on disk: use this skill for the cards it was *not* started from, and to search.

### ⛔ ABSOLUTE RULE — READ EVERYTHING ⛔

When a card is identified (via URL, ID, or top search hit), you MUST consume the **entire** card before responding:

1. `trello.py card <id>` — title, description, members, comments, checklists, attachment list
2. `trello.py attachments <id>` — download every attachment to `/tmp/trello-<id>/`
3. **Inspect every downloaded image (PNG/JPG/GIF/WEBP/PDF) with the available image-viewing tool.** No exceptions. Images are part of the ticket — text alone is not the full ticket.
4. Only after all of the above: summarize / answer / propose action.

Skipping attachments because "the description seems clear" is forbidden. The user already saw the text; the value you add is reading the screenshots they attached.

### How to dispatch on the invoking user's arguments

- **Looks like a Trello URL or short card ID** (`trello.com/c/...`, or 8-char alphanumeric like `gUDHoQtA`): run the full read-everything flow above.
- **Starts with `attachments`**: download attachments for the card that follows, then inspect each image with the available image-viewing tool.
- **Starts with `boards`**: list boards.
- **Anything else**: treat as a free-text search query — then run the full read-everything flow on the top hit (or ask which card if ambiguous).

If the invoking message has no arguments, ask the user what they want to look up.

### Commands

```bash
# Search cards (full-text, ranks open boards above closed)
python3 <this skill's folder>/trello.py search "svenska Elementary"
python3 <this skill's folder>/trello.py search "ODI matching" --limit 10
python3 <this skill's folder>/trello.py search "..." --json   # for programmatic use

# Read a card (description + comments + attachments + checklists)
python3 <this skill's folder>/trello.py card gUDHoQtA
python3 <this skill's folder>/trello.py card https://trello.com/c/gUDHoQtA/1505-...

# Download attachments to /tmp/trello-<id>/ (then inspect them with the image-viewing tool)
python3 <this skill's folder>/trello.py attachments gUDHoQtA
python3 <this skill's folder>/trello.py attachments gUDHoQtA --out /tmp/foo

# List boards (open by default; --all includes archived)
python3 <this skill's folder>/trello.py boards
python3 <this skill's folder>/trello.py boards --all
```

Card IDs accepted in any form: full URL, short URL, short ID (`gUDHoQtA`), or long ID (`69ef48f7ec1feb5f14fc5a62`).

### Standard workflow (single canonical flow)

For ANY request that resolves to a specific card — search hit, URL, ID, or "what does this ticket say":

1. `trello.py card <id>` — read description, comments, checklists, attachment list.
2. `trello.py attachments <id>` — download all attachments.
3. Inspect every downloaded image/PDF in `/tmp/trello-<id>/` with the available image-viewing tool. Run independent inspections in parallel.
4. Then respond, integrating what the **images** show, not just the text.

If a card has zero attachments, step 2–3 are no-ops — that's fine, but you must verify (don't assume).

### Notes

- Search is Trello's native full-text — it matches card name and description, ranks open boards higher, and returns up to `--limit` cards.
- Attachment downloads use OAuth header auth (Trello requires it for `trello.com/1/cards/.../download/...` URLs); external attachment URLs (e.g. linked from Google Drive) are skipped with a "skip (external)" line.
- Comments are fetched separately and shown oldest-first under `## Comments`.
- The script uses only stdlib (`urllib`, `json`) — no `requests` dependency.
