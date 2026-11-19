/**
 * Logging in to Trello, the way a desktop app does.
 *
 * Two halves make a Trello call: the app key, which names the app and reads
 * nothing on its own, and a token, which is the person. The key is prifly's own
 * (`PRIFLY_APP_KEY`); the token is made by the reader on Trello's own page,
 * where they sign in however they normally do — Google, Microsoft, Atlassian —
 * and approve prifly by name. prifly never sees a password, and the token is
 * theirs: it reaches their boards and nobody else's.
 *
 * The token is kept in the extension's own `api.secrets` (sealed on disk, so it
 * moves with prifly's data). It can be revoked at any time from Trello's own
 * account settings or by logging out here.
 */

import type { ExtensionApi } from "./prifly-api";

/**
 * prifly's own Trello app key. It is public on purpose: the key only names the
 * app asking, the token is the person and stays secret (Trello's docs: the API
 * key "is intended to be publicly accessible"). `skills/trello/trello.py` has
 * the same value as `KEY`; a test keeps the two equal.
 */
export const PRIFLY_APP_KEY = "d7eef1652518d7226a0ad96b985a97f7";

export type Auth = { key: string; token: string };

export type Session = { token: string; member: string };

/** The key the token is kept under in `api.secrets`. */
export const TOKEN_KEY = "token";

/**
 * The vault entry earlier versions filed the token in. The manifest's `vault`
 * list still names it (JSON has no comments, so it is said here and in the
 * README): for moving that token into `api.secrets` once, and nothing else.
 */
export const VAULT_ENTRY = "trello";

/**
 * Where the reader approves prifly.
 *
 * `expiration=never` because a session that logs itself out every month is a
 * worse thing to own than a token the reader can revoke when they mean to;
 * `scope=read,write` because moving a card to another column is the point.
 */
export function authorizeUrl(key: string): string {
  const query = new URLSearchParams({
    expiration: "never",
    scope: "read,write",
    response_type: "token",
    name: "prifly",
    key,
  });
  return `https://trello.com/1/authorize?${query.toString()}`;
}

/**
 * A token is one long unbroken word: 64 hex characters from the old scheme, or
 * an `ATTA…` one from Atlassian's. Both are checked against Trello itself
 * before they are kept — this only catches a paste that brought a whole
 * sentence, or the URL, with it.
 */
export function looksLikeToken(text: string): boolean {
  return /^[A-Za-z0-9_-]{32,}$/.test(text.trim());
}

/** Who that token belongs to — and proof that it works at all. */
export async function whoami(auth: Auth): Promise<string> {
  const query = new URLSearchParams({ key: auth.key, token: auth.token, fields: "username" });
  const response = await fetch(`https://api.trello.com/1/members/me?${query.toString()}`);
  if (response.status === 401) throw new Error("Trello refused that token.");
  if (!response.ok) throw new Error(`Trello answered ${response.status}.`);
  return ((await response.json()) as { username?: string }).username ?? "you";
}

/** The login: the token in `api.secrets`, with the name kept in prifly's state (`world.ts`). Null for no token. */
export async function readSession(api: ExtensionApi, member: string): Promise<Session | null> {
  const kept = await api.secrets?.get(TOKEN_KEY).catch(() => null);
  return typeof kept === "string" && kept !== "" ? { token: kept, member: member || "you" } : null;
}

/** Keeps a new login in `api.secrets`, and null once it is kept; otherwise why it was not. */
export async function keepSession(api: ExtensionApi, session: Session): Promise<string | null> {
  if (api.secrets === undefined) return "This prifly keeps no extension secrets.";
  try {
    await api.secrets.set(TOKEN_KEY, session.token);
    return null;
  } catch (caught) {
    return `prifly could not keep it: ${caught instanceof Error ? caught.message : String(caught)}`;
  }
}

/**
 * Log out: removes the token from `api.secrets`, and the old vault entry if
 * this extension filed it (`forget` removes only that). True when the vault
 * still reads a token afterwards: an entry the reader made themselves, which
 * only they can remove. It is no longer used, and `world.ts` never copies it
 * once the reader has logged out.
 */
export async function forgetSession(api: ExtensionApi): Promise<boolean> {
  await api.secrets?.set(TOKEN_KEY, null);
  await api.vault?.forget?.(VAULT_ENTRY).catch(() => false);
  return ((await api.vault?.read(VAULT_ENTRY).catch(() => null)) ?? null) !== null;
}

/**
 * Moves a token an earlier version filed in the vault into `api.secrets`, and
 * forgets the entry. `moved` is false when the vault had none; `left` is true
 * when the vault still reads a token afterwards (an entry the reader made
 * themselves). Nothing is forgotten unless the copy succeeded.
 */
export async function moveFromVault(api: ExtensionApi): Promise<{ moved: boolean; left: boolean }> {
  const old = await api.vault?.read(VAULT_ENTRY).catch(() => null);
  if (typeof old !== "string" || old === "" || api.secrets === undefined)
    return { moved: false, left: false };
  await api.secrets.set(TOKEN_KEY, old);
  await api.vault?.forget?.(VAULT_ENTRY).catch(() => false);
  const left = ((await api.vault?.read(VAULT_ENTRY).catch(() => null)) ?? null) !== null;
  return { moved: true, left };
}
