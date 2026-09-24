#!/usr/bin/env python3
"""
Trello CLI: search/read cards and download attachments.

Credentials come from the prifly Trello extension this skill ships with: the
app key from its config.json and the token from its auth.json, which the
reader made by logging in to Trello from prifly. TRELLO_API_KEY and
TRELLO_TOKEN override both, for a machine that has no prifly on it.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

API = "https://api.trello.com/1"
EXTENSION_ROOT = Path(__file__).resolve().parent.parent.parent


def load_creds() -> tuple[str, str]:
    """The app key and the reader's own token, in that order of preference."""
    key = os.environ.get("TRELLO_API_KEY")
    tok = os.environ.get("TRELLO_TOKEN")
    if key and tok:
        return key, tok

    def read(name: str) -> dict[str, Any]:
        path = EXTENSION_ROOT / name
        try:
            return json.loads(path.read_text())
        except (OSError, ValueError):
            return {}

    key = key or read("config.json").get("appKey")
    tok = tok or read("auth.json").get("token")
    if key and tok:
        return key, tok
    sys.exit(
        "not logged in to Trello: open prifly, click 'From a Trello card…' and log in "
        "(or set TRELLO_API_KEY and TRELLO_TOKEN)"
    )


def http_get(
    url: str,
    params: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
) -> bytes:
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        # A dead token is the one failure worth a sentence rather than a stack:
        # it means logging in again, not a bug in the caller.
        if e.code in (401, 403):
            sys.exit(
                "Trello refused these credentials. Log in again from prifly: "
                "'From a Trello card…' → Log out, then log in."
            )
        sys.exit(f"Trello answered {e.code} {e.reason} for {url.split('?')[0]}")


def api(path: str, params: dict[str, str] | None = None) -> Any:  # noqa: ANN401
    key, tok = load_creds()
    p = {"key": key, "token": tok, **(params or {})}
    return json.loads(http_get(f"{API}{path}", p))


CARD_URL_RE = re.compile(r"trello\.com/c/([A-Za-z0-9]+)")


def normalize_card_id(s: str) -> str:
    m = CARD_URL_RE.search(s)
    return m.group(1) if m else s.strip()


def cmd_search(args: argparse.Namespace) -> None:
    res = api(
        "/search",
        {
            "query": args.query,
            "modelTypes": "cards",
            "card_fields": "name,url,desc,idBoard,closed",
            "cards_limit": str(args.limit),
            "partial": "true",
        },
    )
    cards = res.get("cards", [])
    if args.json:
        print(json.dumps(cards, indent=2, ensure_ascii=False))
        return
    if not cards:
        print("(no matches)")
        return
    for c in cards:
        marker = " [archived]" if c.get("closed") else ""
        print(f"- {c['name']}{marker}")
        print(f"  {c['url']}")


def cmd_card(args: argparse.Namespace) -> None:
    cid = normalize_card_id(args.id)
    card = api(
        f"/cards/{cid}",
        {
            "attachments": "true",
            "members": "true",
            "checklists": "all",
        },
    )
    if args.json:
        print(json.dumps(card, indent=2, ensure_ascii=False))
        return

    print(f"# {card['name']}")
    print(f"URL: {card['shortUrl']}")
    if card.get("closed"):
        print("Status: ARCHIVED")
    members = ", ".join(m.get("fullName", "") for m in card.get("members", []))
    if members:
        print(f"Members: {members}")
    print()

    if card.get("desc"):
        print("## Description")
        print(card["desc"])
        print()

    comments = api(f"/cards/{cid}/actions", {"filter": "commentCard", "limit": "50"})
    if comments:
        print("## Comments")
        for c in reversed(comments):
            who = c.get("memberCreator", {}).get("fullName", "?")
            when = c.get("date", "")[:10]
            text = c.get("data", {}).get("text", "")
            print(f"- **{who}** ({when}): {text}")
        print()

    atts = card.get("attachments", [])
    if atts:
        print("## Attachments")
        for a in atts:
            print(f"- {a.get('name', '?')} ({a.get('id')}) -> {a.get('url')}")

    cls = card.get("checklists", [])
    if cls:
        print()
        print("## Checklists")
        for cl in cls:
            print(f"### {cl['name']}")
            for it in cl.get("checkItems", []):
                box = "[x]" if it.get("state") == "complete" else "[ ]"
                print(f"  {box} {it['name']}")


def cmd_attachments(args: argparse.Namespace) -> None:
    cid = normalize_card_id(args.id)
    key, tok = load_creds()
    atts = api(f"/cards/{cid}/attachments")
    if not atts:
        print("(no attachments)")
        return

    out = Path(args.out) if args.out else Path(f"/tmp/trello-{cid}")
    out.mkdir(parents=True, exist_ok=True)

    auth = f'OAuth oauth_consumer_key="{key}", oauth_token="{tok}"'
    for a in atts:
        url = a.get("url") or ""
        if not url.startswith("https://trello.com/"):
            print(f"skip (external): {a.get('name')} {url}")
            continue
        name = a.get("fileName") or a.get("name") or a["id"]
        # Sanitise filename
        name = re.sub(r"[^\w.\- ]", "_", name)
        dest = out / f"{a['id']}_{name}"
        data = http_get(url, headers={"Authorization": auth})
        dest.write_bytes(data)
        print(f"{dest} ({len(data)} bytes)")


def cmd_boards(args: argparse.Namespace) -> None:
    boards = api("/members/me/boards", {"fields": "name,url,closed"})
    if args.json:
        print(json.dumps(boards, indent=2, ensure_ascii=False))
        return
    for b in boards:
        if args.all or not b.get("closed"):
            mark = " [archived]" if b.get("closed") else ""
            print(f"{b['id']}  {b['name']}{mark}")
            print(f"  {b['url']}")


def main() -> None:
    p = argparse.ArgumentParser(prog="trello")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search", help="search cards")
    s.add_argument("query")
    s.add_argument("--limit", type=int, default=20)
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_search)

    c = sub.add_parser("card", help="show card details + comments + attachments")
    c.add_argument("id", help="card URL, short ID, or long ID")
    c.add_argument("--json", action="store_true")
    c.set_defaults(func=cmd_card)

    a = sub.add_parser("attachments", help="download all attachments to a directory")
    a.add_argument("id", help="card URL, short ID, or long ID")
    a.add_argument("--out", help="output dir (default: /tmp/trello-<id>)")
    a.set_defaults(func=cmd_attachments)

    b = sub.add_parser("boards", help="list boards")
    b.add_argument("--all", action="store_true", help="include archived")
    b.add_argument("--json", action="store_true")
    b.set_defaults(func=cmd_boards)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
