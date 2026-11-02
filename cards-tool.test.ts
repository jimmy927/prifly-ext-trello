import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PRIFLY_APP_KEY } from "./auth";
import { cardsTool, MOST_CARDS } from "./cards-tool";
import { fakePrifly } from "./fake-prifly";
import type { ExtensionApi, ExtensionSession } from "./prifly-api";
import type { TrelloCard } from "./trello";
import { load, type World } from "./world";

const columns = [
  { id: "l1", name: "Backlog" },
  { id: "l2", name: "In Progress" },
  { id: "l3", name: "Denna vecka" },
  { id: "l4", name: "Done" },
];

const card = (id: string, idList: string, at = "2026-11-01T10:00:00.000Z"): TrelloCard => ({
  id: `id-${id}`,
  shortLink: id,
  name: `Card ${id}`,
  desc: "",
  url: `https://trello.com/c/${id}`,
  idList,
  due: null,
  dueComplete: false,
  dateLastActivity: at,
  labels: [
    { name: "bug", color: "red" },
    { name: "", color: "green" },
  ],
  members: [],
  badges: { comments: 0, attachments: 0, checkItems: 0, checkItemsChecked: 0 },
});

const realFetch = globalThis.fetch;
let board: TrelloCard[] = [];
let asked: string[] = [];

beforeEach(() => {
  asked = [];
  globalThis.fetch = (async (input: Request | string | URL) => {
    const url = String(input);
    asked.push(url);
    return new Response(JSON.stringify(url.includes("/lists") ? columns : board));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A world logged in to a board, with the sessions prifly lists and the cards they carry. */
async function worldWith(
  links: Record<string, string[]> = {},
  sessions: string[] = Object.keys(links),
  settings: Record<string, string> = {},
): Promise<{ world: World; filed: unknown[] }> {
  const fake = fakePrifly("/x", { settings });
  const list: ExtensionSession[] = sessions.map((id) => ({
    id,
    title: id,
    cwd: "/",
    state: "idle",
  }));
  const api = { ...fake.api, sessions: () => list } as ExtensionApi;
  const world = await load(api);
  world.session = { token: "tok" } as World["session"];
  world.state.board = "b1";
  world.state.links = links;
  return { world, filed: fake.filed };
}

const run = async (world: World | null, args: Record<string, unknown> = {}): Promise<string> =>
  cardsTool(() => world).call(args, { session: "s", signal: new AbortController().signal });

const ids = (text: string): string[] => JSON.parse(text).map((entry: { id: string }) => entry.id);

describe("trello_cards", () => {
  test("by default the columns with progress, denna vecka or this week in them", async () => {
    board = [card("a", "l1"), card("b", "l2"), card("c", "l3"), card("d", "l4")];
    const listed = JSON.parse(await run((await worldWith()).world));
    expect(listed.map((entry: { id: string }) => entry.id)).toEqual(["id-b", "id-c"]);
    expect(listed[0]).toEqual({
      id: "id-b",
      name: "Card b",
      column: "In Progress",
      labels: ["bug"],
      url: "https://trello.com/c/b",
      lastActivity: "2026-11-01T10:00:00.000Z",
      sessionId: null,
    });
    expect(asked[0]).toContain(`key=${PRIFLY_APP_KEY}`);
  });

  test("the setting changes the default", async () => {
    board = [card("a", "l1"), card("b", "l2")];
    const { world } = await worldWith({}, [], { activeColumns: "backlog" });
    expect(ids(await run(world))).toEqual(["id-a"]);
  });

  test("columns replaces the default", async () => {
    board = [card("a", "l1"), card("b", "l2"), card("d", "l4")];
    const { world } = await worldWith();
    expect(ids(await run(world, { columns: ["DONE", "backlog"] })).sort()).toEqual(["id-a", "id-d"]);
  });

  test("a card a live session carries is listed from any column, with the session's id", async () => {
    board = [card("a", "l1"), card("b", "l2"), card("d", "l4")];
    const { world } = await worldWith(
      { "session-0001-full": ["d"], "gone-session": ["a"] },
      ["session-0001-full"],
    );
    const listed = JSON.parse(await run(world));
    expect(listed.map((entry: { id: string }) => entry.id)).toEqual(["id-d", "id-b"]);
    expect(listed[0].sessionId).toBe("session-0001-full");
    expect(listed[1].sessionId).toBeNull();
  });

  test(`at most ${MOST_CARDS}, the carried ones kept first`, async () => {
    board = Array.from({ length: 40 }, (_, i) =>
      card(`c${i}`, "l2", new Date(Date.UTC(2026, 9, 1, i)).toISOString()),
    );
    board.push(card("old", "l4", "2020-01-01T00:00:00.000Z"));
    const { world } = await worldWith({ s1: ["old"] });
    const listed = ids(await run(world));
    expect(listed).toHaveLength(MOST_CARDS);
    expect(listed.slice(0, 2)).toEqual(["id-old", "id-c39"]);
  });

  test("not connected: a plain answer, and Trello is never asked", async () => {
    for (const world of [null, await load(fakePrifly("/x").api)]) {
      const answer = await run(world);
      expect(answer).toContain("not connected");
      expect(() => JSON.parse(answer)).toThrow();
    }
    expect(asked).toEqual([]);
  });

  test("it only reads: no confirm card, and only GETs of the board", async () => {
    board = [card("b", "l2")];
    const { world, filed } = await worldWith();
    await run(world);
    expect(filed).toEqual([]);
    expect(asked).toHaveLength(2);
    expect(asked.every((url) => url.includes("/boards/b1/"))).toBe(true);
  });
});

