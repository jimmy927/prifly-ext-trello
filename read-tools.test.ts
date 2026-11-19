import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRIFLY_APP_KEY } from "./auth";
import { fakePrifly } from "./fake-prifly";
import { readTools } from "./read-tools";
import { normalizeCardId } from "./trello";
import { load, type World } from "./world";

const realFetch = globalThis.fetch;
let asked: { url: string; auth: string | null }[] = [];
/** Answers by path fragment, first match wins; a number is an HTTP error status. */
let routes: [string, unknown][] = [];

beforeEach(() => {
  asked = [];
  routes = [];
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    asked.push({ url, auth: headers.get("Authorization") });
    const route = routes.find(([fragment]) => url.includes(fragment));
    if (route === undefined) return new Response("{}", { status: 404, statusText: "Not Found" });
    if (typeof route[1] === "number")
      return new Response("", { status: route[1], statusText: "Not Found" });
    if (typeof route[1] === "string") return new Response(route[1]);
    return new Response(JSON.stringify(route[1]));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function worldWith(loggedIn = true): Promise<World> {
  const world = await load(fakePrifly("/x").api);
  if (loggedIn) world.session = { token: "tok" } as World["session"];
  return world;
}

const ctx = { session: "s", signal: new AbortController().signal };
const tool = (world: World | null, name: string) => {
  const found = readTools(() => world).find((entry) => entry.name === name);
  if (found === undefined) throw new Error(name);
  return (args: Record<string, unknown> = {}) => found.call(args, ctx);
};

const cardRoutes = (attachments: unknown[]): [string, unknown][] => [
  ["/lists/l1", { name: "In Progress" }],
  ["/actions", [
    { date: "2026-11-02T10:00:00Z", memberCreator: { fullName: "Bo" }, data: { text: "second" } },
    { date: "2026-11-01T10:00:00Z", memberCreator: { fullName: "Ann" }, data: { text: "first" } },
  ]],
  ["/checklists", [{ name: "Todo", checkItems: [{ name: "a", state: "complete" }, { name: "b", state: "incomplete" }] }]],
  ["/attachments", attachments],
  ["/cards/", {
    id: "long",
    shortLink: "gUDHoQtA",
    name: "Fix login",
    desc: "It breaks",
    url: "https://trello.com/c/gUDHoQtA/1-fix",
    idList: "l1",
    labels: [{ name: "bug", color: "red" }],
    members: [{ fullName: "Ann Lee", username: "ann" }],
  }],
];

describe("not logged in", () => {
  test("every tool answers one plain line and Trello is never asked", async () => {
    for (const world of [null, await worldWith(false)]) {
      for (const [name, args] of [
        ["trello_search", { query: "x" }],
        ["trello_card", { card: "gUDHoQtA" }],
        ["trello_boards", {}],
        ["trello_attachments", { card: "gUDHoQtA" }],
      ] as const) {
        const answer = await tool(world, name)(args);
        expect(answer).toContain("Not logged in");
        expect(answer).toContain("From a Trello card…");
        expect(answer.includes("\n")).toBe(false);
      }
    }
    expect(asked).toEqual([]);
  });
});

describe("normalizeCardId", () => {
  test("full url, short url, short id and long id", () => {
    expect(normalizeCardId("https://trello.com/c/gUDHoQtA/1505-some-title")).toBe("gUDHoQtA");
    expect(normalizeCardId("trello.com/c/gUDHoQtA")).toBe("gUDHoQtA");
    expect(normalizeCardId(" gUDHoQtA ")).toBe("gUDHoQtA");
    expect(normalizeCardId("69ef48f7ec1feb5f14fc5a62")).toBe("69ef48f7ec1feb5f14fc5a62");
  });
});

describe("trello_search", () => {
  test("lists hits, marks archived, passes query and limit", async () => {
    routes = [["/search", { cards: [
      { name: "One", url: "https://trello.com/c/a", closed: false },
      { name: "Two", url: "https://trello.com/c/b", closed: true },
    ] }]];
    const answer = await tool(await worldWith(), "trello_search")({ query: "svenska", limit: 5 });
    expect(answer).toBe("- One\n  https://trello.com/c/a\n- Two [archived]\n  https://trello.com/c/b");
    const url = new URL(asked[0]?.url ?? "");
    expect(url.searchParams.get("query")).toBe("svenska");
    expect(url.searchParams.get("cards_limit")).toBe("5");
    expect(url.searchParams.get("key")).toBe(PRIFLY_APP_KEY);
  });

  test("no hits and an empty query", async () => {
    routes = [["/search", { cards: [] }]];
    const search = tool(await worldWith(), "trello_search");
    expect(await search({ query: "zzz" })).toBe("(no matches)");
    expect(await search({ query: " " })).toContain("query");
  });
});

describe("trello_boards", () => {
  const all = [
    { id: "1", name: "Open", url: "https://trello.com/b/1", closed: false },
    { id: "2", name: "Old", url: "https://trello.com/b/2", closed: true },
  ];

  test("open boards by default, all on request", async () => {
    routes = [["/members/me/boards", all]];
    const boards = tool(await worldWith(), "trello_boards");
    const open = await boards();
    expect(open).toContain("Open");
    expect(open).not.toContain("Old");
    const everything = await boards({ all: true });
    expect(everything).toContain("Old [archived]");
  });
});

describe("trello_card", () => {
  test("reads the whole card, comments oldest first, from a url", async () => {
    routes = cardRoutes([{ id: "a1", name: "shot.png", url: "https://trello.com/1/cards/x/attachments/a1/download/shot.png", isUpload: true }]);
    const answer = await tool(await worldWith(), "trello_card")({
      card: "https://trello.com/c/gUDHoQtA/1505-fix-login",
    });
    expect(answer).toContain("# Fix login");
    expect(answer).toContain("Column: In Progress");
    expect(answer).toContain("Labels: bug");
    expect(answer).toContain("Members: Ann Lee");
    expect(answer).toContain("It breaks");
    expect(answer.indexOf("first")).toBeLessThan(answer.indexOf("second"));
    expect(answer).toContain("**Ann** (2026-11-01): first");
    expect(answer).toContain("[x] a");
    expect(answer).toContain("[ ] b");
    expect(answer).toContain("shot.png (a1) -> https://trello.com/1/cards/x/attachments/a1/download/shot.png");
    expect(asked.every((entry) => entry.url.includes("/cards/gUDHoQtA") || entry.url.includes("/lists/"))).toBe(true);
  });

  test("a 404 is an answer, not a throw", async () => {
    const answer = await tool(await worldWith(), "trello_card")({ card: "nope" });
    expect(answer).toContain("no such card");
    expect(answer).toContain("404");
  });

  test("a refused token says to log in again", async () => {
    routes = [["/cards/", 401]];
    const answer = await tool(await worldWith(), "trello_card")({ card: "gUDHoQtA" });
    expect(answer).toContain("log in again");
  });
});

describe("trello_attachments", () => {
  test("saves Trello-hosted files with the OAuth header and lists external links", async () => {
    const folder = mkdtempSync(join(tmpdir(), "trello-att-"));
    const hosted = "https://trello.com/1/cards/x/attachments/a1/download/shot.png";
    routes = [
      ["/download/", "PNGBYTES"],
      ...cardRoutes([
        { id: "a1", name: "shot.png", url: hosted, isUpload: true },
        { id: "a2", name: "issue", url: "https://github.com/o/r/issues/1", isUpload: false },
      ]),
    ];
    const answer = await tool(await worldWith(), "trello_attachments")({ card: "gUDHoQtA", folder });
    const saved = join(folder, "a1_shot.png");
    expect(answer.split("\n")[0]).toBe(saved);
    expect(readFileSync(saved, "utf8")).toBe("PNGBYTES");
    expect(answer).toContain("skip (external): issue https://github.com/o/r/issues/1");
    expect(existsSync(join(folder, "a2_issue"))).toBe(false);
    const download = asked.find((entry) => entry.url === hosted);
    expect(download?.auth).toBe(`OAuth oauth_consumer_key="${PRIFLY_APP_KEY}", oauth_token="tok"`);
    expect(asked.some((entry) => entry.url.includes("github.com"))).toBe(false);
  });

  test("defaults to a folder under the session's scratchpad", async () => {
    const scratchpad = mkdtempSync(join(tmpdir(), "trello-pad-"));
    routes = [
      ["/download/", "X"],
      ...cardRoutes([{ id: "a1", name: "a.png", url: "https://trello.com/1/cards/x/attachments/a1/download/a.png", isUpload: true }]),
    ];
    const found = readTools(() => null);
    const world = await worldWith();
    const attach = readTools(() => world).find((entry) => entry.name === "trello_attachments");
    const answer = (await attach?.call({ card: "gUDHoQtA" }, { ...ctx, scratchpad })) ?? "";
    expect(found).toHaveLength(4);
    expect(answer).toBe(join(scratchpad, "trello-gUDHoQtA", "a1_a.png"));
    expect(existsSync(answer)).toBe(true);
  });

  test("no attachments, and a missing card", async () => {
    routes = cardRoutes([]);
    expect(await tool(await worldWith(), "trello_attachments")({ card: "gUDHoQtA" })).toBe("(no attachments)");
    routes = [];
    expect(await tool(await worldWith(), "trello_attachments")({ card: "gone" })).toContain("404");
  });
});
