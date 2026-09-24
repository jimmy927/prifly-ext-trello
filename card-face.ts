/**
 * A card as it looks on the board, and as it reads when opened.
 *
 * The face is what Trello puts on a card and nothing more: its labels as
 * coloured stripes, its title, the small marks that say how much is on it, and
 * who is on it. prifly draws all of that in its own ink — what carries over is
 * which cards share a colour and how heavy a card is, not Trello's blue.
 */

import type {
  LabelColour,
  LaunchBadges,
  LaunchChoice,
  LaunchItem,
  LaunchItemFile,
} from "./prifly-api";
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

/** A title as long as a sentence, cut to something a dialog can say. */
function short(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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
    // What a card's own menu offers. Archiving is Trello's own idea of
    // deleting — the card leaves the board and can be sent back — so it asks
    // first and is drawn as the dangerous one.
    actions: [
      {
        id: "archive",
        label: "Archive card",
        confirm: `“${short(card.name, 60)}” leaves the board. Trello can send it back.`,
        destructive: true,
      },
    ],
    people: card.members.map((member) => member.fullName),
    badges,
  };
}

/**
 * The card, as a ticket rather than as a page of prose.
 *
 * The description and the checklists are Markdown, because that is what they
 * are. Everything else is kept apart — the column it sits in, the people on
 * it, the files, the conversation — so that the window can lay it out the way
 * a card is laid out, and so that a screenshot is a picture rather than a
 * line of base64 in the middle of a sentence.
 */
export function cardItem(
  full: FullCard,
  list: TrelloList | undefined,
  files: LaunchItemFile[],
): LaunchItem {
  const { card } = full;
  const shown = pictures(files);
  return {
    title: card.name,
    url: card.url,
    column: card.idList,
    columnName: list?.name ?? "",
    labels: card.labels.map((label) => ({ colour: colour(label.color), name: label.name })),
    people: card.members.map((member) => member.fullName),
    due: card.due === null ? "" : shortDate(card.due),
    dueLate: card.due !== null && !card.dueComplete && Date.parse(card.due) < Date.now(),
    markdown: inlineFiles(card.desc.trim(), shown),
    checklists: checklists(full),
    files,
    notes: full.comments.map((comment) => ({
      by: comment.by,
      at: shortDate(comment.at),
      text: inlineFiles(comment.text, shown),
    })),
  };
}

/** The attachments that came across as pictures, by Trello's id for them. */
function pictures(files: readonly LaunchItemFile[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of files) {
    if (file.id !== undefined && file.data !== undefined && file.data !== "") {
      found.set(file.id, file.data);
    }
  }
  return found;
}

/** `…/attachments/<id>/…` — the id is what ties an embed to the file it is. */
const EMBED = /!\[([^\]]*)]\((https:\/\/trello\.com\/1\/cards\/[^)\s]*?\/attachments\/([0-9a-f]{24})\/[^)\s]*)\)/g;

/**
 * Pictures written into the prose, made to draw.
 *
 * A picture dropped into a description is written as a link to Trello, and
 * Trello serves its own attachments only to a request that signs itself — so
 * in the window it was a broken image with a filename under it. The bytes
 * were already fetched for the Attachments section, so the embed is pointed
 * at those instead. One we could not fetch becomes a link, which opens in the
 * reader's browser where they are signed in.
 */
export function inlineFiles(text: string, shown: ReadonlyMap<string, string>): string {
  return text.replace(EMBED, (whole, alt: string, url: string, id: string) => {
    const data = shown.get(id);
    if (data !== undefined) return `![${alt}](${data})`;
    return `[${alt === "" ? "attachment" : alt}](${url})`;
  });
}

function checklists(full: FullCard): string {
  return full.checklists
    .map((checklist) => {
      const items = checklist.items
        .map((item) => `- [${item.state === "complete" ? "x" : " "}] ${item.name}`)
        .join("\n");
      return `**${checklist.name}**\n\n${items}`;
    })
    .join("\n\n");
}
