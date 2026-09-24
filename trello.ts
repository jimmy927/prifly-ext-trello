/**
 * Trello, as much of it as this extension needs: the reader's boards, one
 * board's lists and cards, a card read whole, its attachments on disk, and a
 * card moved to another list.
 *
 * Every call carries the app key and the reader's own token (`auth.ts`): the
 * key names prifly, the token is the person, and `/members/me/...` means
 * whoever that token belongs to — so each reader sees their own boards and
 * nobody else's.
 */

const API = "https://api.trello.com/1";

import type { Auth as Creds } from "./auth";

export type { Creds };

export type TrelloList = { id: string; name: string };

export type TrelloCard = {
  id: string;
  shortLink: string;
  name: string;
  desc: string;
  url: string;
  idList: string;
  due: string | null;
  dueComplete: boolean;
  labels: { name: string; color: string }[];
  members: { fullName: string; username: string }[];
  badges: { comments: number; attachments: number };
};

export type TrelloComment = { at: string; by: string; text: string };

export type TrelloCheckItem = { name: string; state: string };

export type TrelloChecklist = { name: string; items: TrelloCheckItem[] };

export type TrelloAttachment = { id: string; name: string; url: string; isUpload: boolean };

/** A card with everything on it: what a session is meant to start from. */
export type FullCard = {
  card: TrelloCard;
  comments: TrelloComment[];
  checklists: TrelloChecklist[];
  attachments: TrelloAttachment[];
};

/** Trello wants its key and token on every request. */
function url(path: string, creds: Creds, params: Record<string, string> = {}): string {
  const query = new URLSearchParams({ key: creds.key, token: creds.token, ...params });
  return `${API}${path}?${query.toString()}`;
}

async function get<T>(path: string, creds: Creds, params?: Record<string, string>): Promise<T> {
  const response = await fetch(url(path, creds, params));
  if (!response.ok) throw new Error(`Trello ${path}: ${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

/** The board's open lists, left to right as the board shows them. */
export function lists(board: string, creds: Creds): Promise<TrelloList[]> {
  return get<TrelloList[]>(`/boards/${board}/lists`, creds, { filter: "open", fields: "id,name" });
}

/** Every open card on the board, with what the chooser and the chips show. */
export function cards(board: string, creds: Creds): Promise<TrelloCard[]> {
  return get<TrelloCard[]>(`/boards/${board}/cards`, creds, {
    filter: "open",
    members: "true",
    member_fields: "fullName,username",
    fields: "id,shortLink,name,desc,url,idList,due,dueComplete,labels,badges",
  });
}

export function board(id: string, creds: Creds): Promise<{ id: string; name: string }> {
  return get(`/boards/${id}`, creds, { fields: "id,name" });
}

export type BoardSummary = { id: string; name: string; shortLink: string; closed: boolean };

/** The boards this token can see: the reader's own, whoever they are. */
export function myBoards(creds: Creds): Promise<BoardSummary[]> {
  return get<BoardSummary[]>("/members/me/boards", creds, {
    filter: "open",
    fields: "id,name,shortLink,closed",
  });
}

/** One card and everything hanging off it. */
export async function fullCard(id: string, creds: Creds): Promise<FullCard> {
  const [card, actions, checklists, attachments] = await Promise.all([
    get<TrelloCard>(`/cards/${id}`, creds, {
      members: "true",
      member_fields: "fullName,username",
      fields: "id,shortLink,name,desc,url,idList,due,dueComplete,labels,badges",
    }),
    get<CommentAction[]>(`/cards/${id}/actions`, creds, {
      filter: "commentCard",
      limit: "100",
    }),
    get<RawChecklist[]>(`/cards/${id}/checklists`, creds),
    get<RawAttachment[]>(`/cards/${id}/attachments`, creds),
  ]);
  return {
    card,
    // Trello hands them back newest first; a conversation reads the other way.
    comments: actions
      .map((action) => ({
        at: action.date,
        by: action.memberCreator?.fullName ?? action.memberCreator?.username ?? "someone",
        text: action.data?.text ?? "",
      }))
      .reverse(),
    checklists: checklists.map((list) => ({
      name: list.name,
      items: list.checkItems.map((item) => ({ name: item.name, state: item.state })),
    })),
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      url: attachment.url,
      isUpload: attachment.isUpload,
    })),
  };
}

type CommentAction = {
  date: string;
  memberCreator?: { fullName?: string; username?: string };
  data?: { text?: string };
};
type RawChecklist = { name: string; checkItems: { name: string; state: string }[] };
type RawAttachment = { id: string; name: string; url: string; isUpload: boolean };

/** Move a card to another list: what the chip's menu does. */
export async function moveCard(id: string, idList: string, creds: Creds): Promise<void> {
  const response = await fetch(url(`/cards/${id}`, creds, { idList }), { method: "PUT" });
  if (!response.ok) throw new Error(`Trello could not move the card: ${response.status}`);
}

/**
 * An attachment, saved beside the others.
 *
 * Trello serves an upload's bytes only to a request that signs itself in the
 * OAuth header — key and token in the query string are refused — while an
 * attachment that is only a link to somewhere else is not Trello's to serve
 * at all, and is left to the session to fetch if it wants it.
 */
export async function download(
  attachment: TrelloAttachment,
  into: string,
  creds: Creds,
  /** What to call it: unique within the card, since "image.png" rarely is. */
  filename: string,
): Promise<string | null> {
  if (!attachment.isUpload) return null;
  const response = await fetch(attachment.url, {
    headers: {
      Authorization: `OAuth oauth_consumer_key="${creds.key}", oauth_token="${creds.token}"`,
    },
  });
  if (!response.ok) return null;
  const path = `${into}/${filename}`;
  await Bun.write(path, await response.arrayBuffer());
  return path;
}

/** A file name that is only a file name: no folders, no surprises. */
export function safeName(name: string): string {
  const cleaned = name.replaceAll(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "");
  return cleaned === "" ? "attachment" : cleaned.slice(0, 80);
}
