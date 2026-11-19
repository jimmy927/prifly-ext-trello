/**
 * `trello_attach_file`: a session puts local files (a PDF from an email, a
 * picture) on a card. The reader confirms the card and each file first; the
 * extension uploads with its own login, so the session never sees a token.
 */

import { basename } from "node:path";
import type { ExtensionTool } from "./prifly-api";
import { attach, cardHead, normalizeCardId } from "./trello";
import { creds, type World } from "./world";

const NOT_LOGGED_IN =
  'Not logged in to Trello: the reader has to log in from "From a Trello card…" in prifly first.';
const CANCELLED = "Not done: you cancelled. Nothing was uploaded.";
const MOST_FILES = 20;

/** The local path a Windows or WSL spelling of `raw` points at, if a file is there. */
export async function resolvePath(raw: string): Promise<string | null> {
  const candidates = [raw];
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(raw);
  if (drive?.[1] !== undefined && drive[2] !== undefined) {
    candidates.push(`/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`);
  }
  const wsl = /^\/mnt\/([a-z])\/(.*)$/.exec(raw);
  if (wsl?.[1] !== undefined && wsl[2] !== undefined) {
    candidates.push(`${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, "\\")}`);
  }
  for (const path of candidates) {
    if (await Bun.file(path).exists()) return path;
  }
  return null;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function attachFileTool(world: () => World | null): ExtensionTool {
  return {
    name: "trello_attach_file",
    description:
      "Attach local files of any type (PDF, png, docx…) to a Trello card, as the reader. The reader sees a confirm card with the card's name and each file's name and size, and nothing is uploaded until they confirm. Answers with each attachment's name and URL. A missing file or unknown card is refused and nothing is uploaded.",
    inputSchema: {
      type: "object",
      properties: {
        card: { type: "string", description: "The card: a trello.com/c/ link, short id or long id." },
        files: {
          type: "array",
          description: `Up to ${MOST_FILES} absolute local paths, Windows (C:\\...) or WSL (/mnt/c/...) spelling.`,
          items: { type: "string" },
        },
      },
      required: ["card", "files"],
    },
    async call(args) {
      const at = world();
      const auth = at === null ? null : creds(at);
      if (at === null || auth === null) return NOT_LOGGED_IN;
      const card = normalizeCardId(typeof args["card"] === "string" ? args["card"] : "");
      const given = Array.isArray(args["files"])
        ? args["files"].filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
        : [];
      if (card === "" || given.length === 0) return "Both `card` and `files` are needed.";
      if (given.length > MOST_FILES) return `Not done: at most ${MOST_FILES} files in one call.`;
      if (at.api.confirm === undefined) {
        return "Not done: this prifly cannot show a confirm card, and Trello is never changed without one. Update prifly.";
      }
      const files: { path: string; name: string; bytes: number }[] = [];
      for (const raw of given) {
        const path = await resolvePath(raw.trim());
        if (path === null) return `Not done: no file at ${raw}. Nothing was uploaded.`;
        files.push({ path, name: basename(path.replace(/\\/g, "/")), bytes: Bun.file(path).size });
      }
      try {
        const head = await cardHead(card, auth).catch(() => null);
        if (head === null) return `Not done: Trello does not know a card "${card}". Nothing was uploaded.`;
        const lines = files.map((file) => `${file.name} (${size(file.bytes)})`);
        const confirmed = await at.api.confirm({
          title: "Attach files to a Trello card",
          summary: `Attach ${files.length} file${files.length === 1 ? "" : "s"} to “${head.name}”`,
          content: lines.join("\n"),
          details: [`card: ${head.name} (${head.id})`, ...files.map((file) => `${file.path} ${file.bytes} bytes`)].join("\n"),
        });
        if (!confirmed) return CANCELLED;
        const done: string[] = [];
        for (const file of files) {
          try {
            done.push(`${file.name}: ${await attach(head.id, file.path, file.name, auth)}`);
          } catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught);
            return `Attached ${done.length} of ${files.length} to “${head.name}”, then stopped: ${message}${done.length > 0 ? `\nDone:\n${done.join("\n")}` : ""}`;
          }
        }
        return `Attached ${files.length} file${files.length === 1 ? "" : "s"} to “${head.name}”:\n${done.join("\n")}`;
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return `Not done: Trello could not answer: ${message}`;
      }
    },
  };
}
