/**
 * What this extension knows while it runs, and what it keeps between runs.
 *
 * The plain configuration (app key, where a card's session works, …) is
 * prifly's extension settings, never a file (`configFromSettings`). Two small
 * files sit next to this one, neither in git: `auth.json` (the reader's own
 * Trello token where the vault is not used — `auth.ts`) and `state.json` (which board they chose and which
 * session is on which card). Nothing here is shared, and nothing is anybody's
 * but the reader's.
 */

import { join } from "node:path";
import type { Session } from "./auth";
import { moveToVault, readSession } from "./auth";
import type { ExtensionApi, SettingValues } from "./prifly-api";
import type { TrelloCard, TrelloList } from "./trello";
import { board as boardOf, type Creds, cards as cardsOf, lists as listsOf } from "./trello";

export type Config = {
  /**
   * The key that names the app to Trello. It reads nothing on its own — the
   * token does that — and lives here rather than in the code so that a clone
   * of this repository carries nobody's registration.
   */
  appKey: string;
  /** Where a card's session works; "" leaves the folder to the reader. */
  cwd: string;
  /** The lists that mean the work is over, drawn in the quiet colour. */
  done: string[];
  /**
   * The list a card moves to when a session is started from it, matched by
   * name without regard to case; "" leaves the card where it is.
   */
  inProgress: string;
  refreshSeconds: number;
};

export type State = {
  /** The board the reader chose, by id; "" until they have. */
  board: string;
  boardName: string;
  /** The cards (by short link) each session was started from or linked to, oldest first. */
  links: Record<string, string[]>;
  /**
   * Cards the reader said never to start a session from, by short link: not
   * software work at all. Left off the board, and listed on their own.
   */
  ignored: string[];
  /** The Trello username of a login kept in the vault, which holds only the token. */
  member: string;
  /**
   * The reader declined moving `auth.json`'s token into the vault: not asked
   * again until they log in again.
   */
  vaultDeclined: boolean;
};

export type World = {
  api: ExtensionApi;
  config: Config;
  session: Session | null;
  state: State;
  lists: TrelloList[];
  cards: TrelloCard[];
  /** The board shows the ignored cards instead of the rest, until switched back. */
  showIgnored: boolean;
};

/** The two halves of a Trello call, when both are in hand. */
export function creds(world: World): Creds | null {
  if (world.config.appKey === "" || world.session === null) return null;
  return { key: world.config.appKey, token: world.session.token };
}

/** Logged in, with a board chosen: everything else is setup (`setup.ts`). */
export function ready(world: World): boolean {
  return creds(world) !== null && world.state.board !== "";
}

export async function load(api: ExtensionApi): Promise<World> {
  const state = await readState(api.folder);
  return {
    api,
    config: configFromSettings(api.settings ?? {}),
    session: await readSession(api, state.member),
    state,
    lists: [],
    cards: [],
    showIgnored: false,
  };
}

/**
 * A login made before the vault moves into it once the reader confirms on
 * prifly's card, which may wait for them: so callers never await it at start.
 * A decline is remembered, so the card does not come back on every start.
 */
export async function moveLogin(world: World): Promise<void> {
  if (world.state.vaultDeclined) return;
  try {
    const moved = await moveToVault(world.api);
    if (moved.outcome === "moved") world.state.member = moved.member;
    else if (moved.outcome === "declined") world.state.vaultDeclined = true;
    else return;
    await writeState(world.api.folder, world.state);
  } catch (caught) {
    world.api.log("login_move_failed", {
      message: caught instanceof Error ? caught.message : String(caught),
    });
  }
}

/** What the board has now. Leaves what was last seen alone when it cannot ask. */
export async function reload(world: World): Promise<void> {
  const auth = creds(world);
  if (auth === null || world.state.board === "") return;
  const [lists, cards] = await Promise.all([
    listsOf(world.state.board, auth),
    cardsOf(world.state.board, auth),
  ]);
  world.lists = lists;
  world.cards = cards;
  if (world.state.boardName === "") {
    world.state.boardName = (await boardOf(world.state.board, auth)).name;
    await writeState(world.api.folder, world.state);
  }
}

/** The list called `name` on the board, whatever its case; none for "". */
export function listNamed(lists: readonly TrelloList[], name: string): TrelloList | undefined {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") return undefined;
  return lists.find((list) => list.name.trim().toLowerCase() === wanted);
}

/**
 * Whether this prifly keeps the extension's plain settings (`api.settings`).
 * Without them the extension has no configuration and does nothing (`setup.ts`).
 */
export function hasSettings(api: ExtensionApi): boolean {
  return api.features?.includes("settings") === true && api.settings !== undefined;
}

/** The column names of a comma-separated setting, trimmed, none empty. */
export function columnList(text: string): string[] {
  return text
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/**
 * The config from the manifest's settings. `cwd` is taken as typed, never
 * normalised: on Windows it is `C:\Users\…`.
 */
export function configFromSettings(values: SettingValues): Config {
  const text = (id: string, fallback: string): string => {
    const value = values[id];
    return typeof value === "string" ? value : fallback;
  };
  const seconds = values["refreshSeconds"];
  return {
    appKey: text("appKey", "").trim(),
    cwd: text("cwd", "").trim(),
    done: columnList(text("done", "Done")),
    inProgress: text("inProgress", "In Progress"),
    refreshSeconds: Math.max(15, typeof seconds === "number" ? seconds : 60),
  };
}

export async function readState(folder: string): Promise<State> {
  const raw = (await Bun.file(join(folder, "state.json"))
    .json()
    .catch(() => ({}))) as Partial<State>;
  return {
    board: raw.board ?? "",
    boardName: raw.boardName ?? "",
    links: cardLists(raw.links),
    ignored: raw.ignored ?? [],
    member: raw.member ?? "",
    vaultDeclined: raw.vaultDeclined === true,
  };
}

export async function writeState(folder: string, state: State): Promise<void> {
  await Bun.write(join(folder, "state.json"), JSON.stringify(state, null, 2));
}

/**
 * Each session's card short links. A `state.json` from before a session could
 * carry several cards holds one short link as a string; it is read as a list
 * of one.
 */
export function cardLists(raw: unknown): Record<string, string[]> {
  const kept: Record<string, string[]> = {};
  if (typeof raw !== "object" || raw === null) return kept;
  for (const [session, value] of Object.entries(raw)) {
    const ids = (Array.isArray(value) ? value : [value]).filter(
      (id): id is string => typeof id === "string" && id !== "",
    );
    if (ids.length > 0) kept[session] = [...new Set(ids)];
  }
  return kept;
}

/** The card added to the session's, once; the ones it already carries stay. */
export function linkCard(state: State, sessionId: string, shortLink: string): void {
  const cards = state.links[sessionId] ?? [];
  if (!cards.includes(shortLink)) state.links[sessionId] = [...cards, shortLink];
}

/** The card taken off the session; a session left with none is forgotten. */
export function unlinkCard(state: State, sessionId: string, shortLink: string): void {
  const cards = (state.links[sessionId] ?? []).filter((card) => card !== shortLink);
  if (cards.length === 0) delete state.links[sessionId];
  else state.links[sessionId] = cards;
}
