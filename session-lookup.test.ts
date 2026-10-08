import { describe, expect, test } from "bun:test";
import type { ExtensionApi, ExtensionSession } from "./prifly-api";
import { knownSessions, linkedSessions, sessionById } from "./session-lookup";

const session = (id: string, title: string): ExtensionSession =>
  ({ id, title }) as ExtensionSession;

const recent = session("recent", "Recent one");
const old = session("old", "Weeks old");

/** A prifly whose sidebar holds `recent` and whose history also knows `old`. */
function fake(extra: Partial<ExtensionApi>): ExtensionApi {
  return {
    sessions: () => [recent],
    session: (id: string) => [recent, old].find((s) => s.id === id) ?? null,
    ...extra,
  } as ExtensionApi;
}

const withFeature = fake({ features: ["session-lookup"] });
// Hosts that cannot look a session up: no list, no such name, no function.
const older = [
  fake({}),
  fake({ features: ["something-else"] }),
  fake({ features: ["session-lookup"], session: undefined }),
];

const links = { recent: ["a"], old: ["a", "b"], gone: ["a"] };

describe("sessionById (the title in link and unlink)", () => {
  test("with session-lookup finds a session the sidebar no longer lists", () => {
    expect(sessionById(withFeature, "old")?.title).toBe("Weeks old");
    expect(sessionById(withFeature, "gone")).toBeNull();
  });

  test("without it only the sidebar's sessions are found", () => {
    for (const api of older) {
      expect(sessionById(api, "recent")?.title).toBe("Recent one");
      expect(sessionById(api, "old")).toBeNull();
    }
  });
});

describe("knownSessions (the filter in show)", () => {
  test("with session-lookup keeps a link to an old session, drops an unknown one", () => {
    const known = knownSessions(withFeature);
    expect([known("recent"), known("old"), known("gone")]).toEqual([true, true, false]);
  });

  test("without it keeps only the sidebar's sessions", () => {
    for (const api of older) {
      const known = knownSessions(api);
      expect([known("recent"), known("old"), known("gone")]).toEqual([true, false, false]);
    }
  });
});

describe("linkedSessions (sessionsOf)", () => {
  test("with session-lookup lists an old session too, skipping unknown ones", () => {
    expect(linkedSessions(withFeature, links, "a").map((s) => s.id)).toEqual(["recent", "old"]);
    expect(linkedSessions(withFeature, links, "b").map((s) => s.id)).toEqual(["old"]);
  });

  test("without it lists only the sidebar's sessions", () => {
    for (const api of older) {
      expect(linkedSessions(api, links, "a").map((s) => s.id)).toEqual(["recent"]);
      expect(linkedSessions(api, links, "b")).toEqual([]);
    }
  });
});
