/**
 * The board's active cards, for whoever reads them: a mind map of the work in
 * flight, another extension's panel.
 *
 * `trello_cards` only reads. It never moves a card and never asks the reader
 * for anything, which is what lets prifly's `tools.read` call it: that
 * refuses a tool that shows a card.
 */

import type { ExtensionTool } from "./prifly-api";
import { knownSessions } from "./session-lookup";
import { cards, lists as listsOf, type TrelloCard } from "./trello";
import { creds, ready, type World } from "./world";

/** Most cards one answer lists: a map to read, not the whole board. */
export const MOST_CARDS = 30;

/** One card of the answer. */
export type CardEntry = {
  id: string;
  name: string;
  column: string;
  labels: string[];
  url: string;
  lastActivity: string;
  /** The full id of the live session the card rides on, or null. */
  sessionId: string | null;
};

/** Whether a column's name contains one of `words`, whatever the case. */
export function isActive(column: string, words: readonly string[]): boolean {
  const name = column.toLowerCase();
  return words.some((word) => name.includes(word.toLowerCase()));
}

/** The live session each card (by short link) rides on: the first that carries it. */
function ridden(world: World): Map<string, string> {
  const known = knownSessions(world.api);
  const sessions = new Map<string, string>();
  for (const [sessionId, shortLinks] of Object.entries(world.state.links)) {
    if (!known(sessionId)) continue;
    for (const shortLink of shortLinks) {
      if (!sessions.has(shortLink)) sessions.set(shortLink, sessionId);
    }
  }
  return sessions;
}

function wordsOf(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const words = raw.filter((word): word is string => typeof word === "string" && word.trim() !== "");
  return words.length > 0 ? words.map((word) => word.trim()) : null;
}

const newest = (a: TrelloCard, b: TrelloCard): number =>
  b.dateLastActivity.localeCompare(a.dateLastActivity);

/** The tool: cards in active columns, and every card a live session carries. */
export function cardsTool(world: () => World | null): ExtensionTool {
  return {
    name: "trello_cards",
    description: `List the active cards of the reader's Trello board as JSON: id, name, column, labels, url, lastActivity and sessionId (the prifly session the card rides on, or null). Cards in active columns, plus every card a live session carries wherever it sits; at most ${MOST_CARDS}, those with a session first. Read-only.`,
    inputSchema: {
      type: "object",
      properties: {
        columns: {
          type: "array",
          items: { type: "string" },
          description:
            "Words that make a column active (any column whose name contains one, any case), instead of the reader's setting.",
        },
      },
    },
    async call(args) {
      const at = world();
      const auth = at === null ? null : creds(at);
      if (at === null || auth === null || !ready(at)) {
        return "Trello is not connected: the reader has to log in and choose a board from the board chooser first.";
      }
      const words = wordsOf(args["columns"]) ?? at.config.active;
      const [columns, all] = await Promise.all([listsOf(at.state.board, auth), cards(at.state.board, auth)]);
      const names = new Map(columns.map((column) => [column.id, column.name]));
      const sessions = ridden(at);
      const carried = all.filter((card) => sessions.has(card.shortLink)).sort(newest);
      const active = all
        .filter(
          (card) =>
            !sessions.has(card.shortLink) &&
            !at.state.ignored.includes(card.shortLink) &&
            isActive(names.get(card.idList) ?? "", words),
        )
        .sort(newest);
      const entries: CardEntry[] = [...carried, ...active].slice(0, MOST_CARDS).map((card) => ({
        id: card.id,
        name: card.name,
        column: names.get(card.idList) ?? "",
        labels: card.labels.map((label) => label.name).filter((name) => name !== ""),
        url: card.url,
        lastActivity: new Date(card.dateLastActivity).toISOString(),
        sessionId: sessions.get(card.shortLink) ?? null,
      }));
      return JSON.stringify(entries);
    },
  };
}
