/**
 * Logging in to Trello, the way a desktop app does.
 *
 * Two halves make a Trello call: the app key, which names the app and reads
 * nothing on its own, and a token, which is the person. The key ships with the
 * extension (or sits in `config.json`); the token is made by the reader on
 * Trello's own page, where they sign in however they normally do — Google,
 * Microsoft, Atlassian — and approve prifly by name. prifly never sees a
 * password, and the token is theirs: it reaches their boards and nobody
 * else's.
 *
 * The token is kept in `auth.json` next to this file, readable only by the
 * user who owns it, and can be revoked at any time from Trello's own account
 * settings or by logging out here.
 */

import { chmod } from "node:fs/promises";
import { join } from "node:path";

export type Auth = { key: string; token: string };

export type Session = { token: string; member: string };

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

export async function readSession(folder: string): Promise<Session | null> {
  const raw = (await Bun.file(join(folder, "auth.json"))
    .json()
    .catch(() => null)) as Partial<Session> | null;
  return raw?.token === undefined ? null : { token: raw.token, member: raw.member ?? "you" };
}

export async function writeSession(folder: string, session: Session): Promise<void> {
  const path = join(folder, "auth.json");
  await Bun.write(path, JSON.stringify(session, null, 2));
  // Someone else's account, on a machine with other users on it.
  await chmod(path, 0o600);
}

export async function forgetSession(folder: string): Promise<void> {
  await Bun.file(join(folder, "auth.json"))
    .delete()
    .catch(() => undefined);
}
