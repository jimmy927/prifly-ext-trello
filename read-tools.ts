/**
 * Trello for a session to read, through the extension's own login: search the
 * cards, read one whole, list the boards, download a card's attachments.
 *
 * These tools only read, like `trello_cards`: none moves a card or asks the
 * reader anything. They exist so that a session never needs the Trello token:
 * it stays here, and what comes back is text and file paths.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionTool, ExtensionToolContext } from "./prifly-api";
import {
  boardsOf,
  type Creds,
  download,
  fullCard,
  listName,
  normalizeCardId,
  safeName,
  searchCards,
} from "./trello";
import { creds, type World } from "./world";

const NOT_LOGGED_IN =
  'Not logged in to Trello: the reader has to log in from "From a Trello card…" in prifly first.';

/** Most cards a search answers with unless asked for fewer or more. */
export const DEFAULT_LIMIT = 20;

/** A failed Trello call as one plain line, never a throw. */
function said(caught: unknown, what: string): string {
  const text = caught instanceof Error ? caught.message : String(caught);
  if (/: (401|403) /.test(text))
    return 'Trello refused the reader\'s login: they have to log in again from "From a Trello card…" in prifly.';
  if (/: 404 /.test(text)) return `Trello has no such ${what} (404). Check the id or link.`;
  return `Trello could not answer: ${text}`;
}

/** Runs `body` with the login, or answers that there is none; any failure becomes an answer. */
async function guarded(
  world: () => World | null,
  what: string,
  body: (auth: Creds) => Promise<string>,
): Promise<string> {
  const at = world();
  const auth = at === null ? null : creds(at);
  if (auth === null) return NOT_LOGGED_IN;
  try {
    return await body(auth);
  } catch (caught) {
    return said(caught, what);
  }
}

function text(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

const day = (iso: string): string => iso.slice(0, 10);

function search(world: () => World | null): ExtensionTool {
  return {
    name: "trello_search",
    description:
      "Search the reader's Trello cards by text (Trello's full-text search over names and descriptions, open boards ranked first). One entry per hit: name, then url; archived cards are marked. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        limit: { type: "number", description: `Most cards to return (default ${DEFAULT_LIMIT}).` },
      },
      required: ["query"],
    },
    async call(args) {
      const query = text(args["query"]);
      if (query === "") return "Give a query to search for.";
      const asked = Number(args["limit"]);
      const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), 100) : DEFAULT_LIMIT;
      return guarded(world, "search", async (auth) => {
        const hits = await searchCards(query, limit, auth);
        if (hits.length === 0) return "(no matches)";
        return hits.map((hit) => `- ${hit.name}${hit.closed ? " [archived]" : ""}\n  ${hit.url}`).join("\n");
      });
    },
  };
}

function card(world: () => World | null): ExtensionTool {
  return {
    name: "trello_card",
    description:
      "Read one Trello card whole: name, column, labels, members, description, comments (oldest first), checklists and the list of attachments. Read-only. After it, download and look at every attachment image with trello_attachments.",
    inputSchema: {
      type: "object",
      properties: {
        card: {
          type: "string",
          description: "The card: a trello.com/c/… link (full or short), a short id like gUDHoQtA, or a long id.",
        },
      },
      required: ["card"],
    },
    async call(args) {
      const id = normalizeCardId(text(args["card"]));
      if (id === "") return "Give the card: a Trello link or a card id.";
      return guarded(world, "card", async (auth) => {
        const full = await fullCard(id, auth);
        const column = await listName(full.card.idList, auth).catch(() => "");
        const lines = [`# ${full.card.name}`, `URL: ${full.card.url}`];
        if (column !== "") lines.push(`Column: ${column}`);
        const labels = full.card.labels.map((label) => label.name || label.color || "").filter((l) => l !== "");
        if (labels.length > 0) lines.push(`Labels: ${labels.join(", ")}`);
        if (full.card.members.length > 0)
          lines.push(`Members: ${full.card.members.map((member) => member.fullName).join(", ")}`);
        if (full.card.desc !== "") lines.push("", "## Description", full.card.desc);
        if (full.comments.length > 0) {
          lines.push("", "## Comments");
          for (const entry of full.comments)
            lines.push(`- **${entry.by}** (${day(entry.at)}): ${entry.text}`);
        }
        if (full.attachments.length > 0) {
          lines.push("", "## Attachments");
          for (const attachment of full.attachments)
            lines.push(`- ${attachment.name} (${attachment.id}) -> ${attachment.url}`);
        }
        if (full.checklists.length > 0) {
          lines.push("", "## Checklists");
          for (const list of full.checklists) {
            lines.push(`### ${list.name}`);
            for (const item of list.items)
              lines.push(`  ${item.state === "complete" ? "[x]" : "[ ]"} ${item.name}`);
          }
        }
        return lines.join("\n");
      });
    },
  };
}

function boards(world: () => World | null): ExtensionTool {
  return {
    name: "trello_boards",
    description:
      "List the reader's Trello boards: id, name, url. Open boards only unless all is true. Read-only.",
    inputSchema: {
      type: "object",
      properties: { all: { type: "boolean", description: "Include archived boards." } },
    },
    async call(args) {
      return guarded(world, "boards", async (auth) => {
        const all = args["all"] === true;
        const shown = (await boardsOf(auth)).filter((entry) => all || !entry.closed);
        if (shown.length === 0) return "(no boards)";
        return shown
          .map((entry) => `${entry.id}  ${entry.name}${entry.closed ? " [archived]" : ""}\n  ${entry.url}`)
          .join("\n");
      });
    },
  };
}

/** Where downloads go when the caller names no folder: the session's scratchpad, else a temp folder. */
function base(ctx: ExtensionToolContext): string {
  try {
    if (ctx.scratchpad !== undefined && ctx.scratchpad !== "") return ctx.scratchpad;
  } catch {
    // prifly has no transcript to find the scratchpad from: a temp folder will do.
  }
  return mkdtempSync(join(tmpdir(), "trello-"));
}

function attachments(world: () => World | null): ExtensionTool {
  return {
    name: "trello_attachments",
    description:
      "Download every Trello-hosted attachment of a card to a folder and answer with the absolute path of each file; attachments that are only links to somewhere else are skipped and listed. Then look at every image downloaded. Read-only on Trello.",
    inputSchema: {
      type: "object",
      properties: {
        card: {
          type: "string",
          description: "The card: a trello.com/c/… link, a short id like gUDHoQtA, or a long id.",
        },
        folder: {
          type: "string",
          description: "Absolute folder to save into (default: a folder in the session's scratchpad).",
        },
      },
      required: ["card"],
    },
    async call(args, ctx) {
      const id = normalizeCardId(text(args["card"]));
      if (id === "") return "Give the card: a Trello link or a card id.";
      return guarded(world, "card", async (auth) => {
        const full = await fullCard(id, auth);
        if (full.attachments.length === 0) return "(no attachments)";
        const into = resolve(text(args["folder"]) || join(base(ctx), `trello-${safeName(id)}`));
        mkdirSync(into, { recursive: true });
        const lines: string[] = [];
        for (const attachment of full.attachments) {
          if (!attachment.isUpload) {
            lines.push(`skip (external): ${attachment.name} ${attachment.url}`);
            continue;
          }
          const saved = await download(
            attachment,
            into,
            auth,
            `${attachment.id}_${safeName(attachment.name)}`,
          ).catch(() => null);
          lines.push(saved ?? `skip (could not download): ${attachment.name} ${attachment.url}`);
        }
        return lines.join("\n");
      });
    },
  };
}

/** The four read tools. */
export function readTools(world: () => World | null): ExtensionTool[] {
  return [search(world), card(world), boards(world), attachments(world)];
}
