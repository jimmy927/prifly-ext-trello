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

import { authorizeUrl, forgetSession, looksLikeToken, whoami, writeSession } from "./auth";
import { openBrowser } from "./open-browser";
import type { Launch, LaunchChoice } from "./prifly-api";
import { myBoards } from "./trello";
import { creds, ready, type World, writeConfig, writeState } from "./world";

/** The keys this file answers to; a card's key is its short link. */
const KEYS = {
  appKey: "setup:app-key",
  open: "setup:open-login",
  token: "setup:paste-token",
  board: "setup:board:",
  switchBoard: "setup:switch-board",
  logout: "setup:log-out",
} as const;

export function isSetupKey(key: string): boolean {
  return key.startsWith("setup:");
}

/**
 * The rows that come before any card: the app key, the login, the board. Null
 * once there is nothing left to settle.
 */
export async function setupChoices(world: World): Promise<LaunchChoice[] | null> {
  if (world.config.appKey === "") return [appKeyRow()];
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

function appKeyRow(): LaunchChoice {
  return {
    key: KEYS.appKey,
    title: "Add a Trello app key",
    group: "Setup",
    detail:
      "The key that names this app to Trello. Make one at trello.com/power-ups/admin — it reads nothing by itself; your login does that.",
    tone: "warning",
    input: { title: "Trello app key", placeholder: "32 hex characters" },
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
      detail: "Trello ends the approval with a token to copy. It is kept on this machine only.",
      tone: "info",
      input: { title: "The token from Trello", placeholder: "the long word Trello shows after you approve" },
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
  if (key === KEYS.appKey) return await saveAppKey(world, input);
  if (key === KEYS.open) return await openLogin(world);
  if (key === KEYS.token) return await saveToken(world, input);
  if (key.startsWith(KEYS.board)) return await chooseBoard(world, key.slice(KEYS.board.length));
  if (key === KEYS.switchBoard) return await switchBoard(world);
  if (key === KEYS.logout) return await logOut(world);
  return null;
}

async function saveAppKey(world: World, input: string): Promise<Launch> {
  const key = input.trim();
  if (!/^[0-9a-fA-F]{16,64}$/.test(key)) throw new Error("That does not look like a Trello key.");
  world.config.appKey = key;
  await writeConfig(world.api.folder, world.config);
  return { prompt: "", message: "Key saved. Now log in to Trello." };
}

async function openLogin(world: World): Promise<Launch> {
  const url = authorizeUrl(world.config.appKey);
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
  const auth = { key: world.config.appKey, token };
  // Asked of Trello before it is kept: a token that does not work should fail
  // here, where the reader is looking, not quietly an hour later.
  const member = await whoami(auth);
  world.session = { token, member };
  await writeSession(world.api.folder, world.session);
  world.api.log("logged_in", { member });
  return { prompt: "", message: `Logged in as ${member}. Now choose a board.` };
}

async function chooseBoard(world: World, value: string): Promise<Launch> {
  const [id = "", name = ""] = value.split("|");
  world.state.board = id;
  world.state.boardName = name;
  await writeState(world.api.folder, world.state);
  world.api.log("board_chosen", { board: id });
  return { prompt: "", message: `Showing ${name}.` };
}

async function switchBoard(world: World): Promise<Launch> {
  world.state.board = "";
  world.state.boardName = "";
  await writeState(world.api.folder, world.state);
  return { prompt: "", message: "" };
}

async function logOut(world: World): Promise<Launch> {
  await forgetSession(world.api.folder);
  world.session = null;
  world.state.board = "";
  world.state.boardName = "";
  await writeState(world.api.folder, world.state);
  world.cards = [];
  world.lists = [];
  world.api.log("logged_out", { ready: ready(world) });
  return { prompt: "", message: "Logged out. The token on this machine is gone." };
}
