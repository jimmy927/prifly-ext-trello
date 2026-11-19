import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fakePrifly } from "./fake-prifly";
import type { ConfirmSpec } from "./prifly-api";
import { updateCardTool } from "./update-card-tool";
import { load, type World } from "./world";

const realFetch = globalThis.fetch;
let calls: { url: string; method: string; body: string }[] = [];
let failPutFor = "";

const cardsById: Record<string, { id: string; name: string; desc: string; url: string; idList: string; idBoard: string }> = {
  c1: { id: "c1", name: "One", desc: "old", url: "https://trello.com/c/s1", idList: "l1", idBoard: "b1" },
  c2: { id: "c2", name: "Two", desc: "", url: "https://trello.com/c/s2", idList: "l2", idBoard: "b1" },
};

beforeEach(() => {
  calls = [];
  failPutFor = "";
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: String(init?.body ?? "") });
    if (url.includes("/boards/b1/lists"))
      return new Response(JSON.stringify([{ id: "l1", name: "Inbox" }, { id: "l2", name: "Backlog" }]));
    const found = /\/cards\/([A-Za-z0-9]+)(\/|\?)/.exec(url);
    const card = found?.[1] === undefined ? undefined : cardsById[found[1]];
    if (method === "GET" && card !== undefined) return new Response(JSON.stringify(card));
    if (method === "PUT" && card !== undefined) {
      if (card.id === failPutFor) return new Response("no", { status: 500 });
      return new Response("{}");
    }
    if (method === "POST" && url.includes("/actions/comments")) return new Response("{}");
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function setup(answer: boolean) {
  const world = await load(fakePrifly("/x").api);
  world.session = { token: "tok" } as World["session"];
  const shown: ConfirmSpec[] = [];
  world.api.confirm = async (spec) => {
    shown.push(spec);
    return answer;
  };
  const tool = updateCardTool(() => world);
  return { shown, run: (args: Record<string, unknown>) => tool.call(args, { session: "s", signal: new AbortController().signal }) };
}
const writes = () => calls.filter((c) => c.method !== "GET");

describe("trello_update_card", () => {
  test("move shows from → to and writes list and position", async () => {
    const { shown, run } = await setup(true);
    const answer = await run({ card: "c1", column: "backlog", position: "top" });
    expect(shown[0]?.content).toContain("Inbox → Backlog");
    expect(shown[0]?.content).toContain("One");
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.url).toContain("idList=l2");
    expect(writes()[0]?.url).toContain("pos=top");
    expect(answer).toContain("moved to Backlog");
  });

  test("comment is posted", async () => {
    const { run } = await setup(true);
    await run({ card: "https://trello.com/c/c1/x", comment: "obsolete" });
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0]?.body ?? "{}")).toEqual({ text: "obsolete" });
  });

  test("append keeps the old description under a blank line", async () => {
    const { run } = await setup(true);
    await run({ card: "c1", description_append: "more" });
    expect(JSON.parse(writes()[0]?.body ?? "{}")).toEqual({ desc: "old\n\nmore" });
    await run({ card: "c2", description_append: "first" });
    expect(JSON.parse(writes()[1]?.body ?? "{}")).toEqual({ desc: "first" });
  });

  test("archive comes after the other changes", async () => {
    const { shown, run } = await setup(true);
    await run({ card: "c1", comment: "done", archive: true, column: "Backlog" });
    expect(shown[0]?.content).toContain("archive");
    expect(writes().map((w) => (w.url.includes("closed=true") ? "archive" : w.method === "POST" ? "comment" : "move"))).toEqual(["move", "comment", "archive"]);
  });

  test("cancelled changes nothing", async () => {
    const { run } = await setup(false);
    const answer = await run({ card: "c1", archive: true });
    expect(answer).toStartWith("Not done: you cancelled");
    expect(writes()).toHaveLength(0);
  });

  test("an unknown column lists the valid ones and asks nothing", async () => {
    const { shown, run } = await setup(true);
    const answer = await run({ card: "c1", column: "Nope" });
    expect(answer).toContain("Valid columns: Inbox, Backlog");
    expect(shown).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  test("no change given is refused", async () => {
    const { shown, run } = await setup(true);
    const answer = await run({ card: "c1" });
    expect(answer).toContain("no change given");
    expect(shown).toHaveLength(0);
  });

  test("a batch is one confirm card and writes every update", async () => {
    const { shown, run } = await setup(true);
    const answer = await run({
      updates: [{ card: "c1", column: "Backlog" }, { card: "c2", comment: "dup", archive: true }],
    });
    expect(shown).toHaveLength(1);
    expect(shown[0]?.content).toContain("One");
    expect(shown[0]?.content).toContain("Two");
    expect(writes()).toHaveLength(3);
    expect(answer).toContain("Updated 2 cards");
  });

  test("one invalid entry refuses the whole batch, naming it", async () => {
    const { shown, run } = await setup(true);
    const answer = await run({ updates: [{ card: "c1", column: "Backlog" }, { card: "c2", column: "Nope" }] });
    expect(answer).toContain("update 2 (c2)");
    expect(shown).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  test("a part-way failure says what was done and what was not", async () => {
    const { run } = await setup(true);
    failPutFor = "c2";
    const answer = await run({
      updates: [{ card: "c1", column: "Backlog" }, { card: "c2", archive: true }],
    });
    expect(answer).toContain("Stopped at update 2");
    expect(answer).toContain("Done:\n“One”");
  });

  test("not logged in", async () => {
    const world = await load(fakePrifly("/x").api);
    const answer = await updateCardTool(() => world).call({ card: "c1", archive: true }, { session: "s", signal: new AbortController().signal });
    expect(answer).toContain("Not logged in");
  });
});
