/**
 * Logging in to Trello, the way a desktop app does.
 *
 * Two halves make a Trello call: the app key, which names the app and reads
 * nothing on its own, and a token, which is the person. The key is a setting in
 * prifly's Extensions dialog; the token is made by the reader on
 * Trello's own page, where they sign in however they normally do — Google,
 * Microsoft, Atlassian — and approve prifly by name. prifly never sees a
 * password, and the token is theirs: it reaches their boards and nobody
 * else's.
 *
 * The token is kept in prifly's vault, as the entry `trello`, so it moves with
 * prifly's data; the reader confirms the filing on a card. A prifly without
 * `api.vault.file` keeps it in `auth.json` next to this file, readable only by
 * the user who owns it, as this extension always did. Either way it can be
 * revoked at any time from Trello's own account settings or by logging out
 * here. The app key is no secret: it is copied to `app.json` for the skill.
 */

import { chmod } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionApi } from "./prifly-api";

export type Auth = { key: string; token: string };

export type Session = { token: string; member: string };

/** The vault entry the token is kept in; the manifest's `vault` list names it. */
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

/** Whether this prifly files a login token in the vault for the extension. */
export function canFile(api: ExtensionApi): boolean {
  return (
    api.features?.includes("vault-file") === true &&
    api.vault?.file !== undefined &&
    api.vault.forget !== undefined
  );
}

/** The token `auth.json` holds, from before the vault or on a prifly without it. */
async function readLegacy(folder: string): Promise<Session | null> {
  const raw = (await Bun.file(join(folder, "auth.json"))
    .json()
    .catch(() => null)) as Partial<Session> | null;
  return typeof raw?.token === "string" && raw.token !== ""
    ? { token: raw.token, member: raw.member ?? "you" }
    : null;
}

/**
 * The login: the vault's token when it reads one, else `auth.json`'s. The vault
 * reads null for no entry, and for one the reader set above level 1; the file
 * still answers while a move has not happened yet or was declined. `member`
 * is the name kept in prifly's state (`world.ts`) beside a vault token.
 */
export async function readSession(api: ExtensionApi, member: string): Promise<Session | null> {
  const filed = await api.vault?.read(VAULT_ENTRY).catch(() => null);
  if (typeof filed === "string" && filed !== "") return { token: filed, member: member || "you" };
  return await readLegacy(api.folder);
}

/**
 * Keeps a new login, and null once it is kept; otherwise why it was not. With
 * the vault the reader is asked on a card and the token never lands in a file
 * (an old `auth.json` goes); without, it is written to `auth.json`.
 */
export async function keepSession(api: ExtensionApi, session: Session): Promise<string | null> {
  if (!canFile(api)) {
    await writeLegacy(api.folder, session);
    return null;
  }
  const filed = await api.vault?.file?.(VAULT_ENTRY, {
    token: session.token,
    label: `Trello, ${session.member}`,
    host: "trello.com",
    why: "Your Trello board in prifly, and the Trello skill",
  });
  if (filed?.outcome === "accepted") {
    await dropLegacy(api.folder);
    return null;
  }
  if (filed?.outcome === "refused") return `prifly would not file it in the vault: ${filed.message}`;
  if (filed?.outcome === "timed out") return "Nobody confirmed filing it in the vault.";
  return "You declined filing it in the vault.";
}

async function writeLegacy(folder: string, session: Session): Promise<void> {
  const path = join(folder, "auth.json");
  await Bun.write(path, JSON.stringify(session, null, 2));
  // Someone else's account, on a machine with other users on it.
  await chmod(path, 0o600);
}

/**
 * Takes the login out of `auth.json`: the token, the name and the app key that
 * used to sit beside it (the key is in `app.json` now). The file goes when
 * nothing else is left in it.
 */
async function dropLegacy(folder: string): Promise<void> {
  const path = join(folder, "auth.json");
  const raw = (await Bun.file(path)
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== "object") return;
  for (const field of ["token", "member", "key"]) delete raw[field];
  if (Object.keys(raw).length === 0) await Bun.file(path).delete();
  else await Bun.write(path, JSON.stringify(raw, null, 2));
}

export type Moved =
  | { outcome: "moved"; member: string }
  | { outcome: "declined" }
  | { outcome: "skipped"; why: string };

/**
 * The one-time move of an `auth.json` token into the vault, for a login made
 * before the vault. Asks the reader on a card; nothing but the answer is
 * looked at. A vault entry that already reads is left alone, and so is the
 * file.
 */
export async function moveToVault(api: ExtensionApi): Promise<Moved> {
  if (!canFile(api)) return { outcome: "skipped", why: "no vault-file" };
  const legacy = await readLegacy(api.folder);
  if (legacy === null) return { outcome: "skipped", why: "no auth.json login" };
  if (typeof (await api.vault?.read(VAULT_ENTRY).catch(() => null)) === "string")
    return { outcome: "skipped", why: "already in the vault" };
  const filed = await api.vault?.file?.(VAULT_ENTRY, {
    token: legacy.token,
    label: `Trello, ${legacy.member}`,
    host: "trello.com",
    why: "Moving your Trello login from auth.json into the vault",
  });
  if (filed?.outcome === "accepted") {
    await dropLegacy(api.folder);
    return { outcome: "moved", member: legacy.member };
  }
  if (filed?.outcome === "declined") return { outcome: "declined" };
  return { outcome: "skipped", why: filed?.outcome ?? "no answer" };
}

/**
 * Log out: the vault entry (only one this extension filed is removed) and
 * `auth.json`. True when the vault still reads a token afterwards — an entry
 * the reader made themselves, which only they can remove.
 */
export async function forgetSession(api: ExtensionApi): Promise<boolean> {
  if (canFile(api)) await api.vault?.forget?.(VAULT_ENTRY).catch(() => false);
  await Bun.file(join(api.folder, "auth.json"))
    .delete()
    .catch(() => undefined);
  return ((await api.vault?.read(VAULT_ENTRY).catch(() => null)) ?? null) !== null;
}

/**
 * Copies the app key to `app.json`, where `skills/trello/trello.py` looks for
 * it: the key is no secret and the token is not in a file any more. Written
 * only when it differs; an empty key writes nothing.
 */
export async function writeAppKey(folder: string, key: string): Promise<void> {
  if (key === "") return;
  const file = Bun.file(join(folder, "app.json"));
  const raw = (await file.json().catch(() => null)) as { key?: unknown } | null;
  if (raw?.key === key) return;
  await Bun.write(file, JSON.stringify({ key }, null, 2));
}
