/**
 * Your Trello board, in prifly.
 *
 * "From a Trello card…", beside New session, lays your board out in its
 * columns; the card you pick becomes a session that starts knowing the whole
 * ticket — description, comments, checklists and every attached picture,
 * saved to disk and pointed at. The card then stays on that session's banner:
 * click it to open it in Trello, or use its menu to move it to another column
 * when the work moves.
 *
 * There is nothing to configure by hand. The first time you open the chooser
 * it offers the login; you sign in on Trello's own page however you normally
 * do, approve prifly, and then pick which of your boards to show. See
 * `setup.ts` for that, `auth.ts` for what is kept where, and `world.ts` for
 * the three small files this folder holds.
 */

import { join } from "node:path";
import { cardFace, cardItem, shortDate } from "./card-face";
import { cardPrompt } from "./card-prompt";
import type {
  Decoration,
  DecorationTone,
  ExtensionApi,
  Launch,
  LaunchBoard,
  LaunchChoice,
  LaunchItem,
  LaunchItemFile,
} from "./prifly-api";
import { isSetupKey, runSetup, setupChoices, setupTail } from "./setup";
import {
  archiveCard,
  type Creds,
  dataUrl,
  download,
  fullCard,
  moveCard,
  type Picture,
  pictureOf,
  pictureOfFile,
  safeName,
  type TrelloCard,
} from "./trello";
import { type Config, creds, load, ready, reload, type World, writeState } from "./world";

let world: World | null = null;

export async function activate(api: ExtensionApi): Promise<() => void> {
  world = await load(api);
  let stopped = false;
  const tick = async () => {
    try {
      // Nothing is asked of Trello until the reader has logged in and chosen a
      // board: an extension that is only enabled should sit quiet, not pester.
      if (ready(here())) {
        await reload(here());
        show();
      }
    } catch (caught) {
      // Trello down, a revoked token, no network: said in the log and tried
      // again next minute, with what was last seen still on screen.
      api.log("refresh_failed", { message: message(caught) });
    }
  };
  await tick();
  const timer = setInterval(() => {
    if (!stopped) void tick();
  }, world.config.refreshSeconds * 1000);
  return () => {
    stopped = true;
    clearInterval(timer);
    world = null;
  };
}

/** The chips: one card on the session that was started from it. */
function show(): void {
  const at = here();
  const bySession: Record<string, Decoration[]> = {};
  const byShortLink = new Map(at.cards.map((card) => [card.shortLink, card]));
  const known = new Set(at.api.sessions().map((session) => session.id));
  for (const [sessionId, shortLink] of Object.entries(at.state.links)) {
    const card = byShortLink.get(shortLink);
    // A card that left the board — archived, or moved to another one — stops
    // being drawn; the link stays, in case it comes back.
    if (card === undefined || !known.has(sessionId)) continue;
    bySession[sessionId] = [chip(card, at)];
  }
  at.api.show(bySession, []);
}

function chip(card: TrelloCard, at: World): Decoration {
  const list = at.lists.find((entry) => entry.id === card.idList);
  const name = list?.name ?? "";
  return {
    key: card.shortLink,
    icon: "link",
    label: `${name === "" ? "" : `${name}: `}${short(card.name, 40)}`,
    tone: tone(card, name, at.config),
    details: [
      card.name,
      `${at.state.boardName} › ${name} · ${card.url}`,
      card.due === null ? "" : `Due ${card.due.slice(0, 10)}${card.dueComplete ? " (done)" : ""}`,
      card.members.length === 0
        ? ""
        : `Members: ${card.members.map((member) => member.fullName).join(", ")}`,
      `${card.badges.comments} comments · ${card.badges.attachments} attachments`,
    ].filter((line) => line !== ""),
    url: card.url,
    // Every other list on the board: moving a card is a click, not a turn.
    actions: at.lists
      .filter((entry) => entry.id !== card.idList)
      .map((entry) => ({ id: `move:${entry.id}`, label: `Move to ${entry.name}` })),
  };
}

/** Over its due date and not ticked off is the one thing worth a loud chip. */
function tone(card: TrelloCard, list: string, config: Config): DecorationTone {
  if (config.done.includes(list)) return "muted";
  if (card.due !== null && !card.dueComplete && Date.parse(card.due) < Date.now()) return "warning";
  return "info";
}

/**
 * What the chooser shows: the setup steps until there are none, and then the
 * board — every column it has, the cards the filter leaves, and the two things
 * that are about the board rather than about a card.
 *
 * The columns stay when a filter empties them: a board with its columns
 * missing is not the board the reader knows.
 */
export async function choices(_launchId: string, query: string): Promise<LaunchChoice[] | LaunchBoard> {
  const at = here();
  const setup = await setupChoices(at);
  if (setup !== null) return setup;
  if (at.cards.length === 0) await reload(at);
  const words = query.trim().toLowerCase();
  return {
    columns: at.lists.map((list) => ({ id: list.id, name: list.name })),
    items: at.cards
      .filter((card) => matches(card, words))
      .map((card) => cardFace(card, tone(card, listName(at, card.idList), at.config))),
    actions: setupTail(at),
  };
}

function listName(at: World, id: string): string {
  return at.lists.find((list) => list.id === id)?.name ?? "";
}

/** One card, read: its text, its checklists, its files and its conversation. */
export async function open(_launchId: string, key: string): Promise<LaunchItem> {
  const at = here();
  const auth = creds(at);
  if (auth === null) throw new Error("Not logged in to Trello.");
  const full = await fullCard(key, auth);
  const files: LaunchItemFile[] = [];
  for (const attachment of full.attachments) {
    // A picture is carried across so it can be looked at here; anything else
    // — a link to a GitHub issue, a file on a drive — stays where it is.
    const shot = await pictureOf(attachment, auth, PICTURE_LIMIT).catch(() => null);
    files.push({
      id: attachment.id,
      name: attachment.name,
      url: attachment.isUpload ? "" : attachment.url,
      data: shot === null ? "" : dataUrl(shot),
      at: attachment.at === "" ? "" : shortDate(attachment.at),
    });
  }
  return cardItem(
    full,
    at.lists.find((list) => list.id === full.card.idList),
    files,
  );
}

/** Dragged into another column, or sent there from a card's menu. */
export async function move(_launchId: string, key: string, column: string): Promise<void> {
  const at = here();
  const auth = creds(at);
  if (auth === null) throw new Error("Not logged in to Trello.");
  await moveCard(key, column, auth);
  at.api.log("moved", { card: key, list: column });
  await reload(at);
  show();
}

/** Big enough for a screenshot, small enough for a frame on the socket. */
const PICTURE_LIMIT = 4_000_000;

/** What one opening message will carry: how many pictures, and how much of them. */
const MOST_PICTURES = 20;
const PICTURES_LIMIT = 16_000_000;

/** Title, description, labels and members: what a person would search by. */
function matches(card: TrelloCard, words: string): boolean {
  if (words === "") return true;
  const haystack = [
    card.name,
    card.desc,
    card.shortLink,
    ...card.labels.map((label) => label.name),
    ...card.members.map((member) => member.fullName),
  ]
    .join(" ")
    .toLowerCase();
  return words.split(/\s+/).every((word) => haystack.includes(word));
}

/**
 * The whole card, as a session's first prompt, with its pictures on disk —
 * or, for one of the setup rows, a step taken and no session at all.
 */
export async function launch(_launchId: string, key: string, input: string): Promise<Launch> {
  const at = here();
  if (isSetupKey(key)) {
    const done = await runSetup(at, key, input);
    if (done !== null) {
      if (ready(at)) {
        await reload(at);
        show();
      } else at.api.show({}, []);
      return done;
    }
  }
  return await cardLaunch(at, key);
}

/** The picture formats a session can be handed directly. */
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * A card, as a session starts from it: the whole ticket as its first prompt,
 * every attachment saved beside it, and the pictures handed over with the
 * message rather than left as paths.
 *
 * Both, deliberately. The pictures are in the opening turn because a
 * screenshot is usually half of what a ticket says and a session that has to
 * go and open one often does not; the files are on disk because that is how
 * it looks at one again later, and how it reaches the ones too big to carry.
 */
async function cardLaunch(at: World, key: string): Promise<Launch> {
  const auth = creds(at);
  if (auth === null) throw new Error("Not logged in to Trello.");
  const full = await fullCard(key, auth);
  const folder = join(at.api.folder, "cards", safeName(full.card.shortLink));
  const files: string[] = [];
  const external: { name: string; url: string }[] = [];
  const pictures: Picture[] = [];
  let carried = 0;
  for (const [index, attachment] of full.attachments.entries()) {
    const filename = `${index + 1}-${safeName(attachment.name)}`;
    const saved = await download(attachment, folder, auth, filename).catch(() => null);
    if (saved === null) {
      external.push({ name: attachment.name, url: attachment.url });
      continue;
    }
    files.push(saved);
    const mediaType = typeOf(saved);
    // Twenty is the most a turn takes, and a message of tens of megabytes
    // helps nobody: past either, the file on disk is what is left.
    if (mediaType === null || pictures.length >= MOST_PICTURES) continue;
    const picture = await pictureOfFile(saved, mediaType).catch(() => null);
    if (picture === null) continue;
    carried += picture.base64.length;
    if (carried > PICTURES_LIMIT) continue;
    pictures.push(picture);
  }
  at.api.log("launch", { card: full.card.shortLink, files: files.length, carried: pictures.length });
  return {
    prompt: cardPrompt({
      full,
      list: at.lists.find((list) => list.id === full.card.idList),
      boardName: at.state.boardName,
      folder,
      files,
      external,
      carried: pictures.length,
    }),
    cwd: at.config.cwd,
    name: worktreeName(full.card),
    images: pictures.map((picture) => ({
      mediaType: picture.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
      data: picture.base64,
    })),
  };
}

/** What a saved file is, by its name; null for anything a turn cannot take. */
function typeOf(path: string): string | null {
  const ext = path.toLowerCase().split(".").at(-1) ?? "";
  const guess = ext === "jpg" ? "jpeg" : ext;
  const mediaType = `image/${guess}`;
  return INLINE.has(mediaType) ? mediaType : null;
}

/** The session that card became: remembered, so the chip finds its row again. */
export async function launched(_launchId: string, key: string, sessionId: string): Promise<void> {
  const at = here();
  at.state.links[sessionId] = key;
  await writeState(at.api.folder, at.state);
  show();
}

/**
 * What a card's menu offers, wherever that menu is: the chip on a session, or
 * the card on the board. The board is read again afterwards, so an archived
 * card is simply not there any more.
 */
export async function action(key: string, actionId: string): Promise<string> {
  const at = here();
  const auth = creds(at);
  if (auth === null) throw new Error("Not logged in to Trello.");
  const name = at.cards.find((card) => card.shortLink === key)?.name ?? "The card";
  const done = await carryOut(at, auth, key, actionId, name);
  await reload(at);
  show();
  return done;
}

async function carryOut(
  at: World,
  auth: Creds,
  key: string,
  actionId: string,
  name: string,
): Promise<string> {
  if (actionId === "archive") {
    await archiveCard(key, auth);
    at.api.log("archived", { card: key });
    return `Archived “${name}”.`;
  }
  if (actionId.startsWith("move:")) {
    const idList = actionId.slice("move:".length);
    await moveCard(key, idList, auth);
    at.api.log("moved", { card: key, list: idList });
    const list = at.lists.find((entry) => entry.id === idList)?.name ?? "another list";
    return `Moved “${name}” to ${list}.`;
  }
  throw new Error(`Nothing to do for ${actionId}`);
}

function here(): World {
  if (world === null) throw new Error("The Trello extension is not running");
  return world;
}

/** A branch git will take, from the card: `gUDHoQtA-the-banner-is-blank`. */
function worktreeName(card: TrelloCard): string {
  const words = card.name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-");
  // Whole words only: a branch called …-arbetsf helps nobody read the tree.
  let slug = "";
  for (const word of words) {
    if (slug.length + word.length + 1 > 40) break;
    slug = slug === "" ? word : `${slug}-${word}`;
  }
  return slug === "" ? card.shortLink : `${card.shortLink}-${slug}`;
}

function short(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
