import type { DecorationAction, ExtensionSession } from "./prifly-api";

/** How many sessions a card's menu offers to link to; more would be a list to scroll. */
export const MOST_LINKS = 4;

/** The menu id prefix; what follows it is the full session id. */
export const LINK_PREFIX = "link:";

/** A menu row the host may grey out; `prifly-api.ts` does not name that yet. */
export type LinkAction = DecorationAction & { disabled: boolean };

/**
 * "Link to session: <title>" for the recent sessions a card could be linked to.
 *
 * The host lists running and recent sessions first and older ones, marked
 * "ended", after them — so skipping the ended ones and keeping the list's
 * order is what "recent" means here. A session already on this card is left
 * out: offering it would do nothing.
 */
export function linkActions(
  sessions: readonly ExtensionSession[],
  links: Readonly<Record<string, string>>,
  card: string,
): LinkAction[] {
  return sessions
    .filter((session) => session.state !== "ended" && links[session.id] !== card)
    .slice(0, MOST_LINKS)
    .map((session) => ({
      id: `${LINK_PREFIX}${session.id}`,
      label: `Link to session: ${session.title}`,
      confirm: "",
      destructive: false,
      disabled: false,
    }));
}

/** The card's menu with the link rows just before "Archive card", the destructive one. */
export function withLinks<T extends { id: string }>(actions: readonly T[], links: readonly T[]): T[] {
  const at = actions.findIndex((action) => action.id === "archive");
  return at === -1
    ? [...actions, ...links]
    : [...actions.slice(0, at), ...links, ...actions.slice(at)];
}
