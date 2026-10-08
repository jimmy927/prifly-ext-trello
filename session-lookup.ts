/**
 * Finding a session by its id. A prifly that offers "session-lookup" knows any
 * session, however old; an older one only lists the sessions in its sidebar,
 * so there a session that has left the list is unknown.
 */

import type { ExtensionApi, ExtensionSession } from "./prifly-api";

type Lookup = ExtensionApi & { session(id: string): ExtensionSession | null };

function canLookUp(api: ExtensionApi): api is Lookup {
  return api.features?.includes("session-lookup") === true && typeof api.session === "function";
}

/** The session with this id, or null when prifly does not know it. */
export function sessionById(api: ExtensionApi, id: string): ExtensionSession | null {
  if (canLookUp(api)) return api.session(id);
  return api.sessions().find((session) => session.id === id) ?? null;
}

/** Whether prifly knows a session id: asked of the id, or of the list read once. */
export function knownSessions(api: ExtensionApi): (id: string) => boolean {
  if (canLookUp(api)) return (id) => api.session(id) !== null;
  const ids = new Set(api.sessions().map((session) => session.id));
  return (id) => ids.has(id);
}

/** The sessions linked to this card, out of `links` (session id to the cards it carries). */
export function linkedSessions(
  api: ExtensionApi,
  links: Record<string, string[]>,
  shortLink: string,
): ExtensionSession[] {
  if (canLookUp(api)) {
    return Object.entries(links)
      .filter(([, shortLinks]) => shortLinks.includes(shortLink))
      .flatMap(([sessionId]) => api.session(sessionId) ?? []);
  }
  return api.sessions().filter((session) => links[session.id]?.includes(shortLink) === true);
}
