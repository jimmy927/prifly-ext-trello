/**
 * `trello_update_card`: a session moves, comments on, edits the description of
 * or archives cards (one, or a batch of up to 50 on one confirm card). The
 * reader confirms first; the extension writes with its own login.
 */

import type { ExtensionTool } from "./prifly-api";
import {
  archiveCard,
  cardInfo,
  comment,
  lists as listsOf,
  moveCardTo,
  normalizeCardId,
  setDescription,
  type CardInfo,
  type TrelloList,
} from "./trello";
import { creds, type World } from "./world";

const NOT_LOGGED_IN =
  'Not logged in to Trello: the reader has to log in from "From a Trello card…" in prifly first.';
const CANCELLED = "Not done: you cancelled. Nothing was changed.";
const MOST_UPDATES = 50;

const text = (raw: unknown): string => (typeof raw === "string" ? raw.trim() : "");

const FIELDS = {
  card: { type: "string", description: "The card: a trello.com/c/ link, short id or long id." },
  column: { type: "string", description: "Move the card to this column (list) of its board, any case." },
  position: { type: "string", enum: ["top", "bottom"], description: 'Where in the column: "bottom" (default) or "top".' },
  comment: { type: "string", description: "A comment to post, in Markdown." },
  description_append: {
    type: "string",
    description: "Markdown appended to the existing description under a blank line; never replaces it.",
  },
  archive: { type: "boolean", description: "Archive the card, after the other changes." },
};

type Planned = {
  label: string;
  info: CardInfo;
  from: string;
  list: TrelloList | null;
  position: "top" | "bottom";
  comment: string;
  append: string;
  archive: boolean;
};

function describe(plan: Planned): string[] {
  const lines: string[] = [];
  if (plan.list !== null) lines.push(`move: ${plan.from} → ${plan.list.name} (${plan.position})`);
  if (plan.comment !== "") lines.push(`comment: ${plan.comment}`);
  if (plan.append !== "") lines.push(`append to description: ${plan.append}`);
  if (plan.archive) lines.push("archive");
  return lines;
}

async function run(plan: Planned, auth: Parameters<typeof archiveCard>[1]): Promise<string[]> {
  const done: string[] = [];
  const id = plan.info.id;
  if (plan.list !== null) {
    await moveCardTo(id, plan.list.id, plan.position, auth);
    done.push(`moved to ${plan.list.name}`);
  }
  if (plan.comment !== "") {
    await comment(id, plan.comment, auth);
    done.push("commented");
  }
  if (plan.append !== "") {
    const desc = plan.info.desc.trim() === "" ? plan.append : `${plan.info.desc}\n\n${plan.append}`;
    await setDescription(id, desc, auth);
    done.push("description appended");
  }
  if (plan.archive) {
    await archiveCard(id, auth);
    done.push("archived");
  }
  return done;
}

export function updateCardTool(world: () => World | null): ExtensionTool {
  return {
    name: "trello_update_card",
    description:
      "Change a Trello card as the reader: move it to a column, comment, append to its description, archive it. Give the fields for one card, or `updates` (up to 50 objects with the same fields) to change many on ONE confirm card. The reader sees each card's name, current column and changes, and nothing is written until they confirm. Every card and column is checked first and one invalid entry refuses the whole call, naming it. Answers with what was done per card; on a part-way failure, which updates were done and which were not.",
    inputSchema: {
      type: "object",
      properties: {
        ...FIELDS,
        updates: {
          type: "array",
          description: `Batch alternative to the single-card fields: up to ${MOST_UPDATES} objects, each with card and the same optional fields.`,
          items: { type: "object", properties: FIELDS, required: ["card"] },
        },
      },
    },
    async call(args) {
      const at = world();
      const auth = at === null ? null : creds(at);
      if (at === null || auth === null) return NOT_LOGGED_IN;
      const batch = Array.isArray(args["updates"]);
      const raws: Record<string, unknown>[] = batch
        ? (args["updates"] as unknown[]).filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
        : [args];
      if (batch && raws.length !== (args["updates"] as unknown[]).length) return "Not done: every entry of `updates` must be an object.";
      if (batch && text(args["card"]) !== "") return "Not done: give either `card` or `updates`, not both.";
      if (raws.length === 0) return "Not done: `updates` is empty.";
      if (raws.length > MOST_UPDATES) return `Not done: at most ${MOST_UPDATES} updates in one call.`;
      if (at.api.confirm === undefined) {
        return "Not done: this prifly cannot show a confirm card, and Trello is never changed without one. Update prifly.";
      }
      try {
        const columnsOf = new Map<string, TrelloList[]>();
        const plans: Planned[] = [];
        const seen = new Set<string>();
        for (const [index, raw] of raws.entries()) {
          const given = text(raw["card"]);
          const label = batch ? `update ${index + 1} (${given || "no card"})` : "the update";
          const id = normalizeCardId(given);
          if (id === "") return `Not done: ${label}: \`card\` is needed. Nothing was changed.`;
          const info = await cardInfo(id, auth).catch(() => null);
          if (info === null) return `Not done: ${label}: Trello does not know a card "${given}". Nothing was changed.`;
          if (seen.has(info.id)) return `Not done: ${label}: the card appears twice; combine its changes. Nothing was changed.`;
          seen.add(info.id);
          const column = text(raw["column"]);
          const comm = text(raw["comment"]);
          const append = text(raw["description_append"]);
          const archive = raw["archive"] === true;
          if (column === "" && comm === "" && append === "" && !archive) {
            return `Not done: ${label}: no change given (column, comment, description_append or archive). Nothing was changed.`;
          }
          let columns = columnsOf.get(info.idBoard);
          if (columns === undefined) {
            columns = await listsOf(info.idBoard, auth);
            columnsOf.set(info.idBoard, columns);
          }
          let list: TrelloList | null = null;
          if (column !== "") {
            const matches = columns.filter((entry) => entry.name.toLowerCase() === column.toLowerCase());
            if (matches.length !== 1 || matches[0] === undefined) {
              return `Not done: ${label}: ${matches.length === 0 ? `no column "${column}"` : `"${column}" matches ${matches.length} columns`} on the board of “${info.name}”. Valid columns: ${columns.map((entry) => entry.name).join(", ")}. Nothing was changed.`;
            }
            list = matches[0];
          }
          plans.push({
            label,
            info,
            from: columns.find((entry) => entry.id === info.idList)?.name ?? "(unknown column)",
            list,
            position: raw["position"] === "top" ? "top" : "bottom",
            comment: comm,
            append,
            archive,
          });
        }
        const blocks = plans.map((plan) => [`“${plan.info.name}” (in ${plan.from})`, ...describe(plan).map((l) => `  ${l}`)].join("\n"));
        const only = plans[0];
        const summary =
          plans.length === 1 && only !== undefined
            ? `Change “${only.info.name}”: ${describe(only).map((l) => l.split(":")[0]).join(", ")}`
            : `Change ${plans.length} cards`;
        const confirmed = await at.api.confirm({
          title: plans.length === 1 ? "Change a Trello card" : "Change Trello cards",
          summary,
          content: blocks.join("\n\n"),
          details: plans.map((plan) => `${plan.info.name} (${plan.info.id}) ${plan.info.url}`).join("\n"),
        });
        if (!confirmed) return CANCELLED;
        const report: string[] = [];
        for (const [index, plan] of plans.entries()) {
          const done: string[] = [];
          try {
            done.push(...(await run(plan, auth)));
          } catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught);
            const notDone = plans.slice(index + 1).map((p) => `“${p.info.name}”`);
            return [
              `Stopped at ${plan.label} “${plan.info.name}” after: ${done.join(", ") || "nothing"}. ${message}`,
              report.length > 0 ? `Done:\n${report.join("\n")}` : "Done: nothing before it.",
              notDone.length > 0 ? `Not done:\n${notDone.join("\n")}` : "",
            ].filter((l) => l !== "").join("\n");
          }
          report.push(`“${plan.info.name}”: ${done.join(", ")} — ${plan.info.url}`);
        }
        return `Updated ${plans.length} card${plans.length === 1 ? "" : "s"}:\n${report.join("\n")}`;
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return `Not done: Trello could not answer: ${message}`;
      }
    },
  };
}
