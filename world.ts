/**
 * What this extension knows while it runs, and what it keeps between runs.
 *
 * The plain configuration (where a card's session works, …) is prifly's
 * extension settings. What the extension remembers — which board they chose,
 * which session is on which card — is prifly's database (`api.state`), and the
 * login token is prifly's vault (`auth.ts`), so all of it moves with prifly's
 * data. Nothing is kept in a file here, nothing is shared, and nothing is
 * anybody's but the reader's.
 */

import type { Session } from "./auth";
import { PRIFLY_APP_KEY, readSession } from "./auth";
import type { ExtensionApi, SettingValues } from "./prifly-api";
import type { TrelloCard, TrelloList } from "./trello";
import { board as boardOf, type Creds, cards as cardsOf, lists as listsOf } from "./trello";

export type Config = {
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
  /** The Trello username of the login kept in the vault, which holds only the token. */
  member: string;
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
  if (world.session === null) return null;
  return { key: PRIFLY_APP_KEY, token: world.session.token };
}

/** Logged in, with a board chosen: everything else is setup (`setup.ts`). */
export function ready(world: World): boolean {
  return creds(world) !== null && world.state.board !== "";
}

/**
 * Whether this prifly can run the extension: it keeps the settings
 * (`api.settings`), the state (`api.state`) and files a login token in the
 * vault (`api.vault.file` and `forget`, the "vault-file" feature). Otherwise
 * nothing runs but the row that says to update prifly (`setup.ts`).
 */
export function supported(api: ExtensionApi): boolean {
  const features = api.features ?? [];
  return (
    features.includes("settings") &&
    api.settings !== undefined &&
    features.includes("state") &&
    api.state !== undefined &&
    features.includes("vault-file") &&
    api.vault?.file !== undefined &&
    api.vault.forget !== undefined
  );
}

/**
 * The world at start. On a prifly that is not `supported` it is empty and
 * nothing is read.
 */
export async function load(api: ExtensionApi): Promise<World> {
  const stored = supported(api) ? await api.state?.get<unknown>(STATE_DOC) : undefined;
  const state = parseState(stored);
  return {
    api,
    config: configFromSettings(api.settings ?? {}),
    session: supported(api) ? await readSession(api, state.member) : null,
    state,
    lists: [],
    cards: [],
    showIgnored: false,
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
    const name = (await boardOf(world.state.board, auth)).name;
    await changeState(world, (state) => {
      state.boardName = name;
    });
  }
}

/** The list called `name` on the board, whatever its case; none for "". */
export function listNamed(lists: readonly TrelloList[], name: string): TrelloList | undefined {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") return undefined;
  return lists.find((list) => list.name.trim().toLowerCase() === wanted);
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
    cwd: text("cwd", "").trim(),
    done: columnList(text("done", "Done")),
    inProgress: text("inProgress", "In Progress"),
    refreshSeconds: Math.max(15, typeof seconds === "number" ? seconds : 60),
  };
}

/** The document the board choice, card links and the rest live in. */
const STATE_DOC = "state";

/** The state a stored document holds; what is missing is empty. */
export function parseState(value: unknown): State {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Partial<State>;
  return {
    board: typeof raw.board === "string" ? raw.board : "",
    boardName: typeof raw.boardName === "string" ? raw.boardName : "",
    links: cardLists(raw.links),
    ignored: Array.isArray(raw.ignored)
      ? raw.ignored.filter((id): id is string => typeof id === "string")
      : [],
    member: typeof raw.member === "string" ? raw.member : "",
  };
}

/**
 * Change the state, on the stored document inside `update`, so two writes at
 * once cannot lose each other's change; `world.state` then takes the result.
 */
export async function changeState(world: World, mutate: (state: State) => void): Promise<void> {
  const store = world.api.state;
  if (store === undefined) throw new Error("This prifly keeps no extension state.");
  const kept = await store.update<unknown>(STATE_DOC, (current) => {
    const next = parseState(current);
    mutate(next);
    return next;
  });
  Object.assign(world.state, parseState(kept));
}

/** Each session's card short links, once each; a session with none is left out. */
export function cardLists(raw: unknown): Record<string, string[]> {
  const kept: Record<string, string[]> = {};
  if (typeof raw !== "object" || raw === null) return kept;
  for (const [session, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    const ids = value.filter((id): id is string => typeof id === "string" && id !== "");
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
