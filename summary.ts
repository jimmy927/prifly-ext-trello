/**
 * What a session leaves on its card when it is done: a summary of the work,
 * written by the session itself, with pictures of what changed.
 *
 * The archive dialog offers it as a box under the card's columns ("Post a
 * summary of this session on the card"). Ticked, prifly runs the action,
 * which hands the session one more turn (`api.prompt`) asking it to write the
 * summary and post it with `trello_post_summary`; prifly archives the session
 * once that turn is over. The same action is in the chip's menu, for a
 * summary half-way through.
 */

import { basename } from "node:path";
import type { ExtensionApi, ExtensionTool } from "./prifly-api";
import { attach, type Creds, comment } from "./trello";

/** The chip's menu id prefix for the summary; the full session id follows. */
export const SUMMARY_PREFIX = "summary:";

/** Most pictures one summary carries: a comment, not an album. */
const MOST_PICTURES = 8;

/** The reader's settings, with the defaults of a prifly that has none. */
export type ArchiveSettings = { summaryOnArchive: boolean; archiveColumn: string };

export function archiveSettings(api: ExtensionApi): ArchiveSettings {
  const values = api.settings ?? {};
  const summary = values["summaryOnArchive"];
  const column = values["archiveColumn"];
  return {
    summaryOnArchive: typeof summary === "boolean" ? summary : true,
    archiveColumn: typeof column === "string" ? column : "",
  };
}

/** Whether this prifly takes `archive` and `place`: an older one refuses the whole chip. */
export function hasArchiveFollowUps(api: ExtensionApi): boolean {
  return api.features?.includes("archive-follow-ups") === true;
}

/** The turn the session is given: what to write, for whom, and how to post it. */
export function summaryPrompt(card: { name: string; shortLink: string; url: string }): string {
  return [
    `This session is about to be archived. Before it is, post a summary of what it did on its Trello card “${card.name}” (${card.url}) with the \`mcp__prifly__trello_post_summary\` tool, card \`${card.shortLink}\`.`,
    "",
    "Write it for the people on the board, not for developers: what was wrong or asked for, what changed, what they will see now and where, how to try it, and anything left undone or waiting (a deploy, a review). A few short paragraphs or bullets in Markdown; no file paths, diffs or commit hashes unless someone on the board needs them.",
    "",
    "Show it, where there is anything to see: pass `pictures` with PNG files of the mockups this session posted of the change as built, and of any screenshots it took. A mockup posted from an HTML file can be saved as a PNG by opening that file with `mcp__prifly__browser_open` and taking `mcp__prifly__browser_screenshot`. A change nobody sees gets text alone.",
    "",
    "Do not move the card or archive the session yourself: prifly does both. Post the summary once, then end your turn.",
  ].join("\n");
}

/** The tool a session posts its summary with: the comment, and its pictures attached first. */
export function summaryTool(creds: () => Creds | null): ExtensionTool {
  return {
    name: "trello_post_summary",
    description:
      "Post a summary of this session's work as a comment on a Trello card, with pictures (mockups, screenshots) attached to the card and shown in the comment. Use when prifly asks for a summary on the card, or the user asks for one.",
    inputSchema: {
      type: "object",
      properties: {
        card: { type: "string", description: "The card's short link or id." },
        text: { type: "string", description: "The summary, in Markdown." },
        pictures: {
          type: "array",
          description: `Up to ${MOST_PICTURES} image files on disk (png, jpeg, gif, webp), shown under the text in this order.`,
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute path of the file." },
              caption: { type: "string", description: "One line on what it shows." },
            },
            required: ["path"],
          },
        },
      },
      required: ["card", "text"],
    },
    async call(args) {
      const auth = creds();
      if (auth === null) throw new Error("Not logged in to Trello: log in from the board first.");
      const card = String(args["card"] ?? "").trim();
      const text = String(args["text"] ?? "").trim();
      if (card === "" || text === "") throw new Error("Both `card` and `text` are needed.");
      const pictures = picturesOf(args["pictures"]);
      if (pictures.length > MOST_PICTURES) {
        throw new Error(`At most ${MOST_PICTURES} pictures; pick the ones that show the change.`);
      }
      const shown: string[] = [];
      for (const picture of pictures) {
        if (!(await Bun.file(picture.path).exists())) throw new Error(`No file at ${picture.path}`);
        const name = basename(picture.path);
        const at = await attach(card, picture.path, name, auth);
        shown.push(`![${picture.caption === "" ? name : picture.caption}](${at})`);
      }
      await comment(card, [text, ...shown].join("\n\n"), auth);
      return `Posted the summary on card ${card}${pictures.length > 0 ? ` with ${pictures.length} picture(s)` : ""}.`;
    },
  };
}

function picturesOf(raw: unknown): { path: string; caption: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { path, caption } = entry as { path?: unknown; caption?: unknown };
    if (typeof path !== "string" || path === "") return [];
    return [{ path, caption: typeof caption === "string" ? caption : "" }];
  });
}
