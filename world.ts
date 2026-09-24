/**
 * What this extension knows while it runs, and what it keeps between runs.
 *
 * Three small files sit next to this one, none of them in git: `config.json`
 * (the app key, and where a card's session works), `auth.json` (the reader's
 * own Trello token — `auth.ts`), and `state.json` (which board they chose and
 * which session is on which card). Nothing here is shared, and nothing is
 * anybody's but the reader's.
 */

import { join } from "node:path";
import type { Session } from "./auth";
import { readSession } from "./auth";
import type { ExtensionApi } from "./prifly-api";
import { board as boardOf, cards as cardsOf, type Creds, lists as listsOf } from "./trello";
import type { TrelloCard, TrelloList } from "./trello";

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
  refreshSeconds: number;
};

export type State = {
  /** The board the reader chose, by id; "" until they have. */
  board: string;
  boardName: string;
  /** Which card each session was started from. */
  links: Record<string, string>;
};

export type World = {
  api: ExtensionApi;
  config: Config;
  session: Session | null;
  state: State;
  lists: TrelloList[];
  cards: TrelloCard[];
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
  return {
    api,
    config: await readConfig(api.folder),
    session: await readSession(api.folder),
    state: await readState(api.folder),
    lists: [],
    cards: [],
  };
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

export async function readConfig(folder: string): Promise<Config> {
  const raw = (await Bun.file(join(folder, "config.json"))
    .json()
    .catch(() => ({}))) as Partial<Config>;
  return {
    appKey: raw.appKey ?? Bun.env["TRELLO_APP_KEY"] ?? "",
    cwd: raw.cwd ?? "",
    done: raw.done ?? ["Done"],
    refreshSeconds: Math.max(15, raw.refreshSeconds ?? 60),
  };
}

export async function writeConfig(folder: string, config: Config): Promise<void> {
  await Bun.write(join(folder, "config.json"), JSON.stringify(config, null, 2));
}

export async function readState(folder: string): Promise<State> {
  const raw = (await Bun.file(join(folder, "state.json"))
    .json()
    .catch(() => ({}))) as Partial<State>;
  return { board: raw.board ?? "", boardName: raw.boardName ?? "", links: raw.links ?? {} };
}

export async function writeState(folder: string, state: State): Promise<void> {
  await Bun.write(join(folder, "state.json"), JSON.stringify(state, null, 2));
}
