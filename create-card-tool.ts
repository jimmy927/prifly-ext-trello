/**
 * `trello_create_card`: a session asks for a card, the reader confirms it on a
 * card of prifly's own, and the extension writes it with the reader's login.
 * The session never sees the token; nothing is created before Confirm.
 */

import type { ExtensionTool } from "./prifly-api";
import { boardsOf, createCard, type Creds, lists as listsOf } from "./trello";
import { creds, type World } from "./world";

const NOT_LOGGED_IN =
  'Not logged in to Trello: the reader has to log in from "From a Trello card…" in prifly first.';
const CANCELLED = "Not done: you cancelled. No card was created.";

const text = (raw: unknown): string => (typeof raw === "string" ? raw.trim() : "");

/** The board a name, id or trello.com/b/ link means; refuses with the valid ones. */
async function resolveBoard(
  wanted: string,
  fallback: { id: string; name: string },
  auth: Creds,
): Promise<{ id: string; name: string } | string> {
  if (wanted === "") {
    if (fallback.id === "") return "No board given and the reader has not chosen one: pass `board`.";
    return fallback;
  }
  const link = /trello\.com\/b\/([A-Za-z0-9]+)/.exec(wanted)?.[1];
  const boards = (await boardsOf(auth)).filter((entry) => !entry.closed);
  const lower = (link ?? wanted).toLowerCase();
  const found =
    boards.find((entry) => entry.id === (link ?? wanted)) ??
    boards.find((entry) => entry.url.toLowerCase().includes(`/b/${lower}`)) ??
    boards.find((entry) => entry.name.toLowerCase() === lower);
  if (found !== undefined) return { id: found.id, name: found.name };
  return `No open board "${wanted}". Valid boards: ${boards.map((entry) => entry.name).join(", ")}`;
}

export function createCardTool(world: () => World | null): ExtensionTool {
  return {
    name: "trello_create_card",
    description:
      "Create a card in a column of the reader's Trello board, as the reader. The reader sees a confirm card (board, column, title, description) and nothing is created until they confirm. Answers with the new card's URL and id. An unknown board or column is refused with the valid ones.",
    inputSchema: {
      type: "object",
      properties: {
        board: {
          type: "string",
          description:
            "Board id, name or trello.com/b/… link. Default: the board the reader chose in the extension.",
        },
        column: { type: "string", description: 'The column (list) name, any case, e.g. "Denna Vecka".' },
        title: { type: "string", description: "The card's title." },
        description: { type: "string", description: "The card's description, in Markdown." },
        position: {
          type: "string",
          enum: ["top", "bottom"],
          description: 'Where in the column: "bottom" (default) or "top".',
        },
      },
      required: ["column", "title"],
    },
    async call(args) {
      const at = world();
      const auth = at === null ? null : creds(at);
      if (at === null || auth === null) return NOT_LOGGED_IN;
      const column = text(args["column"]);
      const title = text(args["title"]);
      const description = text(args["description"]);
      const position = args["position"] === "top" ? "top" : "bottom";
      if (column === "" || title === "") return "Both `column` and `title` are needed.";
      if (at.api.confirm === undefined) {
        return "Not done: this prifly cannot show a confirm card, and Trello is never changed without one. Update prifly.";
      }
      try {
        const board = await resolveBoard(
          text(args["board"]),
          { id: at.state.board, name: at.state.boardName },
          auth,
        );
        if (typeof board === "string") return `Not done: ${board}`;
        const columns = await listsOf(board.id, auth);
        const matches = columns.filter((entry) => entry.name.toLowerCase() === column.toLowerCase());
        if (matches.length !== 1 || matches[0] === undefined) {
          const valid = columns.map((entry) => entry.name).join(", ");
          return matches.length === 0
            ? `Not done: no column "${column}" on ${board.name}. Valid columns: ${valid}`
            : `Not done: "${column}" matches ${matches.length} columns on ${board.name}; ask the reader which.`;
        }
        const list = matches[0];
        const confirmed = await at.api.confirm({
          title: "Create a Trello card",
          summary: `Create "${title}" at the ${position} of ${list.name} on ${board.name}`,
          content: description,
          details: [`board: ${board.name} (${board.id})`, `column: ${list.name} (${list.id})`, `position: ${position}`, `title: ${title}`].join("\n"),
        });
        if (!confirmed) return CANCELLED;
        const made = await createCard(list.id, title, description, position, auth);
        return `Created "${title}" in ${list.name} on ${board.name}.\nURL: ${made.url}\nid: ${made.id}`;
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return `Not done: Trello could not answer: ${message}`;
      }
    },
  };
}
