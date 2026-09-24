/**
 * A card as it looks on the board, and as it reads when opened.
 *
 * The face is what Trello puts on a card and nothing more: its labels as
 * coloured stripes, its title, the small marks that say how much is on it, and
 * who is on it. prifly draws all of that in its own ink — what carries over is
 * which cards share a colour and how heavy a card is, not Trello's blue.
 */

import type { LabelColour, LaunchBadges, LaunchChoice } from "./prifly-api";
import type { FullCard, TrelloCard, TrelloList } from "./trello";

/** Trello has more colours than the window draws; the near ones stand in. */
const COLOURS: Record<string, LabelColour> = {
  green: "green",
  lime: "green",
  yellow: "yellow",
  orange: "orange",
  red: "red",
  purple: "purple",
  blue: "blue",
  sky: "blue",
  pink: "pink",
  black: "grey",
};

/** A label with no colour of its own is drawn in the plain one. */
function colour(name: string | null): LabelColour {
  if (name === null) return "grey";
  // Trello writes shades as "green_dark"; the shade is not worth carrying.
  return COLOURS[name.split("_")[0] ?? ""] ?? "grey";
}

/** "2026-09-24T…" → "24 Sep", which is how a due date reads on a board. */
export function shortDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${at.getDate()} ${at.toLocaleString("en", { month: "short" })}`;
}

export function cardFace(card: TrelloCard, tone: LaunchChoice["tone"]): LaunchChoice {
  const late = card.due !== null && !card.dueComplete && Date.parse(card.due) < Date.now();
  const badges: LaunchBadges = {
    comments: card.badges.comments,
    attachments: card.badges.attachments,
    checklistDone: card.badges.checkItemsChecked,
    checklistTotal: card.badges.checkItems,
    due: card.due === null ? "" : shortDate(card.due),
    dueDone: card.dueComplete,
    dueLate: late,
  };
  return {
    key: card.shortLink,
    title: card.name,
    group: card.idList,
    detail: "",
    tone,
    url: card.url,
    stripes: card.labels.map((label) => colour(label.color)),
    people: card.members.map((member) => member.fullName),
    badges,
  };
}

/**
 * The card, written out.
 *
 * Markdown, because the window already draws that and because a ticket IS
 * prose: a description, a conversation, some lists. The pictures are carried
 * in the text as data, so that a screenshot somebody attached is simply there
 * when the card is opened, rather than a link back to Trello.
 */
export function cardMarkdown(
  full: FullCard,
  list: TrelloList | undefined,
  pictures: { name: string; dataUrl: string }[],
  links: { name: string; url: string }[],
): string {
  const { card } = full;
  const blocks = [
    facts(card, list),
    card.desc.trim(),
    checklists(full),
    pictures.length === 0
      ? ""
      : `## Attachments\n\n${pictures.map((one) => `![${one.name}](${one.dataUrl})`).join("\n\n")}`,
    links.length === 0
      ? ""
      : `${pictures.length === 0 ? "## Attachments\n\n" : ""}${links
          .map((one) => `- [${one.name}](${one.url})`)
          .join("\n")}`,
    comments(full),
  ];
  return blocks.filter((block) => block !== "").join("\n\n");
}

function facts(card: TrelloCard, list: TrelloList | undefined): string {
  const said = [
    list === undefined ? "" : `**${list.name}**`,
    card.members.length === 0 ? "" : card.members.map((member) => member.fullName).join(", "),
    card.due === null ? "" : `due ${shortDate(card.due)}${card.dueComplete ? " ✓" : ""}`,
    card.labels.length === 0
      ? ""
      : card.labels.map((label) => label.name || label.color || "label").join(" · "),
  ].filter((fact) => fact !== "");
  return said.join(" · ");
}

function checklists(full: FullCard): string {
  const written = full.checklists
    .map((checklist) => {
      const items = checklist.items
        .map((item) => `- [${item.state === "complete" ? "x" : " "}] ${item.name}`)
        .join("\n");
      return `**${checklist.name}**\n\n${items}`;
    })
    .join("\n\n");
  return written === "" ? "" : `## Checklists\n\n${written}`;
}

function comments(full: FullCard): string {
  if (full.comments.length === 0) return "";
  const written = full.comments
    .map((comment) => `**${comment.by}** · ${comment.at.slice(0, 10)}\n\n${comment.text}`)
    .join("\n\n---\n\n");
  return `## Comments\n\n${written}`;
}
