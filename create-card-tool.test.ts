import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCardTool } from "./create-card-tool";
import { fakePrifly } from "./fake-prifly";
import type { ConfirmSpec } from "./prifly-api";
import { load, type World } from "./world";

const realFetch = globalThis.fetch;
let calls: { url: string; method: string; body: string }[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (url.includes("/boards/b1/lists"))
      return new Response(JSON.stringify([{ id: "l1", name: "Inbox" }, { id: "l2", name: "Denna Vecka" }]));
    if (url.includes("/boards/b2/lists")) return new Response(JSON.stringify([{ id: "l9", name: "Other" }]));
    if (url.includes("/members/me/boards"))
      return new Response(
        JSON.stringify([
          { id: "b1", name: "Work", url: "https://trello.com/b/AAA/work", closed: false },
          { id: "b2", name: "Home", url: "https://trello.com/b/BBB/home", closed: false },
        ]),
      );
    if (url.includes("/1/cards") && init?.method === "POST")
      return new Response(JSON.stringify({ id: "c1", shortLink: "sl", url: "https://trello.com/c/sl" }));
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function setup(answer: boolean) {
  const world = await load(fakePrifly("/x").api);
  world.session = { token: "tok" } as World["session"];
  world.state.board = "b1";
  world.state.boardName = "Work";
  const shown: ConfirmSpec[] = [];
  world.api.confirm = async (spec) => {
    shown.push(spec);
    return answer;
  };
  const tool = createCardTool(() => world);
  return { shown, run: (args: Record<string, unknown>) => tool.call(args, { session: "s", signal: new AbortController().signal }) };
}
const posts = () => calls.filter((c) => c.method === "POST");

describe("trello_create_card", () => {
  test("a confirmed create writes the card and answers with url and id", async () => {
    const { shown, run } = await setup(true);
    const answer = await run({ column: "denna vecka", title: "Do it", description: "# Why", position: "top" });
    expect(shown[0]?.summary).toContain("Do it");
    expect(shown[0]?.summary).toContain("Denna Vecka");
    expect(shown[0]?.content).toBe("# Why");
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0]?.body ?? "{}")).toEqual({ idList: "l2", name: "Do it", desc: "# Why", pos: "top" });
    expect(answer).toContain("https://trello.com/c/sl");
    expect(answer).toContain("c1");
  });

  test("the default board and bottom position when none is given", async () => {
    const { run } = await setup(true);
    await run({ column: "Inbox", title: "T" });
    expect(calls.some((c) => c.url.includes("/boards/b1/lists"))).toBe(true);
    expect(JSON.parse(posts()[0]?.body ?? "{}").pos).toBe("bottom");
  });

  test("a board by name or link is resolved", async () => {
    const { run } = await setup(true);
    await run({ board: "home", column: "Other", title: "T" });
    await run({ board: "https://trello.com/b/BBB/home", column: "Other", title: "T2" });
    expect(posts().map((p) => JSON.parse(p.body).idList)).toEqual(["l9", "l9"]);
  });

  test("cancelled creates nothing", async () => {
    const { run } = await setup(false);
    const answer = await run({ column: "Inbox", title: "T" });
    expect(answer).toStartWith("Not done: you cancelled");
    expect(posts()).toHaveLength(0);
  });

  test("an unknown column lists the valid ones and asks nothing", async () => {
    const { shown, run } = await setup(true);
    const answer = await run({ column: "Nope", title: "T" });
    expect(answer).toContain("Valid columns: Inbox, Denna Vecka");
    expect(shown).toHaveLength(0);
    expect(posts()).toHaveLength(0);
  });

  test("an unknown board lists the valid ones", async () => {
    const { run } = await setup(true);
    const answer = await run({ board: "Nope", column: "Inbox", title: "T" });
    expect(answer).toContain("Valid boards: Work, Home");
    expect(posts()).toHaveLength(0);
  });

  test("not logged in", async () => {
    const world = await load(fakePrifly("/x").api);
    const answer = await createCardTool(() => world).call({ column: "a", title: "b" }, { session: "s", signal: new AbortController().signal });
    expect(answer).toContain("Not logged in");
  });
});
