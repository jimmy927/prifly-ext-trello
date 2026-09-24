/**
 * A card, as the first thing a session is told.
 *
 * The whole ticket goes in: the description, every comment in the order they
 * were written, the checklists, and where each picture was saved — because
 * the value of a Trello card is usually in the screenshot somebody attached,
 * and a session that only reads the text starts on half the story.
 */

import type { FullCard, TrelloList } from "./trello";

export type PromptParts = {
  full: FullCard;
  list: TrelloList | undefined;
  boardName: string;
  /** Where the attachments were saved, and what landed there. */
  folder: string;
  files: string[];
  /** Attachments that live somewhere else: named, not fetched. */
  external: { name: string; url: string }[];
  /** How many of the pictures travel in the message itself. */
  carried: number;
};

export function cardPrompt(parts: PromptParts): string {
  const { card } = parts.full;
  const blocks = [
    `# ${card.name}`,
    `${card.url} · ${parts.boardName} › ${parts.list?.name ?? "somewhere"}${facts(parts)}`,
    section("Description", card.desc.trim()),
    section("Checklists", checklists(parts)),
    section("Comments", comments(parts)),
    section("Attachments", attachments(parts)),
    instruction(parts),
  ];
  return blocks.filter((block) => block !== "").join("\n\n");
}

function facts(parts: PromptParts): string {
  const { card } = parts.full;
  const said = [
    card.members.length === 0
      ? ""
      : `members: ${card.members.map((member) => member.fullName).join(", ")}`,
    card.due === null ? "" : `due ${card.due.slice(0, 10)}${card.dueComplete ? " (done)" : ""}`,
    card.labels.length === 0
      ? ""
      : `labels: ${card.labels.map((label) => label.name || label.color).join(", ")}`,
  ].filter((fact) => fact !== "");
  return said.length === 0 ? "" : ` · ${said.join(" · ")}`;
}

function section(heading: string, body: string): string {
  return body === "" ? "" : `## ${heading}\n\n${body}`;
}

function checklists(parts: PromptParts): string {
  return parts.full.checklists
    .map((list) => {
      const items = list.items
        .map((item) => `- [${item.state === "complete" ? "x" : " "}] ${item.name}`)
        .join("\n");
      return `**${list.name}**\n${items}`;
    })
    .join("\n\n");
}

function comments(parts: PromptParts): string {
  return parts.full.comments
    .map((comment) => `**${comment.by}** (${comment.at.slice(0, 10)}):\n${comment.text}`)
    .join("\n\n");
}

function attachments(parts: PromptParts): string {
  const saved = parts.files
    .map((file, at) => `- ${file}${at < parts.carried ? " (in this message)" : ""}`)
    .join("\n");
  const elsewhere = parts.external
    .map((item) => `- ${item.name}: ${item.url} (not Trello's to serve — fetch it if you need it)`)
    .join("\n");
  return [
    saved === "" ? "" : `Saved in ${parts.folder}:\n${saved}`,
    elsewhere === "" ? "" : `Linked from elsewhere:\n${elsewhere}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * What to do first. Reading the pictures is spelled out because it is the step
 * that gets skipped: the text looks complete, and the screenshot is where the
 * bug actually is.
 */
function instruction(parts: PromptParts): string {
  const carried =
    parts.carried === 0
      ? ""
      : ` The ${parts.carried === 1 ? "picture is" : `${parts.carried} pictures are`} in this message: look at ${parts.carried === 1 ? "it" : "them"} — a screenshot on a card is usually half of what the card says.`;
  const rest =
    parts.files.length > parts.carried
      ? " The rest are saved beside them; open one with the Read tool when you need it."
      : "";
  return `---\n\nThis session is for that card.${carried}${rest} Start by saying briefly what you take the task to be and what you plan to do; then do it.`;
}
