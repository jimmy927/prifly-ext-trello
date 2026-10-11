/**
 * Setting the extension up, in the place you go to pick a card.
 *
 * There is no settings screen: when the reader is not logged in, the chooser
 * lists the way to log in; when they are, but have not said which board,
 * it lists their boards; once both are settled it lists the cards, with the
 * two setup rows kept at the end for changing their minds. Each of these rows
 * starts nothing — it answers with an empty prompt — so the list simply comes
 * again, one step further on.
 */

import {
  authorizeUrl,
  forgetSession,
  keepSession,
  looksLikeToken,
  PRIFLY_APP_KEY,
  whoami,
} from "./auth";
import { openBrowser } from "./open-browser";
import type { Launch, LaunchChoice } from "./prifly-api";
import { myBoards } from "./trello";
import { changeState, creds, ready, supported, type World } from "./world";

/** The keys this file answers to; a card's key is its short link. */
const KEYS = {
  open: "setup:open-login",
  token: "setup:paste-token",
  board: "setup:board:",
  update: "setup:update-prifly",
  switchBoard: "setup:switch-board",
  logout: "setup:log-out",
} as const;

export function isSetupKey(key: string): boolean {
  return key.startsWith("setup:");
}

/**
 * The rows that come before any card: the login, the board. Null
 * once there is nothing left to settle.
 */
export async function setupChoices(world: World): Promise<LaunchChoice[] | null> {
  if (!supported(world.api)) return [updateRow()];
  if (world.session === null) return loginRows();
  if (world.state.board === "") return await boardRows(world);
  return null;
}

/** Kept at the end of the board, for a reader who wants to change either. */
export function setupTail(world: World): LaunchChoice[] {
  return [
    {
      key: KEYS.switchBoard,
      title: "Switch board…",
      group: "prifly",
      detail: world.state.boardName,
      tone: "muted",
    },
    {
      key: KEYS.logout,
      title: "Log out of Trello",
      group: "prifly",
      detail: world.session === null ? "" : `Signed in as ${world.session.member}`,
      tone: "muted",
    },
  ];
}

/** This extension needs a prifly with settings, state and a vault: until then nothing runs. */
function updateRow(): LaunchChoice {
  return {
    key: KEYS.update,
    title: "Update prifly to use this extension",
    group: "Setup",
    detail:
      "This extension needs a prifly with extension settings, state and the vault. Update prifly, then open this list again.",
    tone: "warning",
  };
}

function loginRows(): LaunchChoice[] {
  return [
    {
      key: KEYS.open,
      title: "1. Open the Trello login page",
      group: "Log in",
      detail: "Sign in as you always do — Google, Microsoft, Atlassian — and approve prifly.",
      tone: "info",
    },
    {
      key: KEYS.token,
      title: "2. Paste the token Trello shows you",
      group: "Log in",
      detail: "Trello ends the approval with a token to copy. It is kept in prifly's vault.",
      tone: "info",
      input: {
        title: "The token from Trello",
        placeholder: "the long word Trello shows after you approve",
      },
    },
  ];
}

async function boardRows(world: World): Promise<LaunchChoice[]> {
  const auth = creds(world);
  if (auth === null) return loginRows();
  const boards = await myBoards(auth);
  if (boards.length === 0) {
    throw new Error("That Trello account has no open boards.");
  }
  return boards.map((board) => ({
    key: `${KEYS.board}${board.id}|${board.name}`,
    title: board.name,
    group: "Choose a board",
    detail: `trello.com/b/${board.shortLink}`,
    tone: "info",
  }));
}

/** Carry out one of those rows. Null when the key is not one of them. */
export async function runSetup(world: World, key: string, input: string): Promise<Launch | null> {
  if (key === KEYS.update)
    return notice("Update prifly to use this extension, then open this list again.");
  if (key === KEYS.open) return await openLogin(world);
  if (key === KEYS.token) return await saveToken(world, input);
  if (key.startsWith(KEYS.board)) return await chooseBoard(world, key.slice(KEYS.board.length));
  if (key === KEYS.switchBoard) return await switchBoard(world);
  if (key === KEYS.logout) return await logOut(world);
  return null;
}

/** A row that starts nothing: it only says what to do next. */
function notice(message: string): Launch {
  return { prompt: "", message };
}

async function openLogin(world: World): Promise<Launch> {
  const url = authorizeUrl(PRIFLY_APP_KEY);
  const opened = await openBrowser(url);
  world.api.log("login_page", { opened });
  return {
    prompt: "",
    message: opened
      ? "Approve prifly in your browser, then pick “2. Paste the token”."
      : `Open this and approve prifly, then pick “2. Paste the token”: ${url}`,
  };
}

async function saveToken(world: World, input: string): Promise<Launch> {
  const token = input.trim();
  if (!looksLikeToken(token))
    throw new Error("That is not a token — paste the one long word Trello showed you.");
  const auth = { key: PRIFLY_APP_KEY, token };
  // Asked of Trello before it is kept: a token that does not work should fail
  // here, where the reader is looking, not quietly an hour later.
  const member = await whoami(auth);
  const session = { token, member };
  const refusal = await keepSession(world.api, session);
  if (refusal !== null)
    throw new Error(`${refusal} Nothing was kept: pick “2. Paste the token” again to retry.`);
  world.session = session;
  // The vault holds only the token; the name is kept in prifly's state.
  await changeState(world, (state) => {
    state.member = member;
  });
  world.api.log("logged_in", { member });
  return { prompt: "", message: `Logged in as ${member}. Now choose a board.` };
}

async function chooseBoard(world: World, value: string): Promise<Launch> {
  const [id = "", name = ""] = value.split("|");
  await changeState(world, (state) => {
    state.board = id;
    state.boardName = name;
  });
  world.api.log("board_chosen", { board: id });
  return { prompt: "", message: `Showing ${name}.` };
}

async function switchBoard(world: World): Promise<Launch> {
  await changeState(world, (state) => {
    state.board = "";
    state.boardName = "";
  });
  return { prompt: "", message: "" };
}

async function logOut(world: World): Promise<Launch> {
  const kept = await forgetSession(world.api);
  world.session = null;
  await changeState(world, (state) => {
    state.board = "";
    state.boardName = "";
    state.member = "";
  });
  world.cards = [];
  world.lists = [];
  world.api.log("logged_out", { ready: ready(world) });
  return {
    prompt: "",
    message: kept
      ? "Logged out, but the vault entry “trello” is yours, not this extension's: remove it in the Vault dialog, or the next start logs you in again."
      : "Logged out. The saved token is gone.",
  };
}
