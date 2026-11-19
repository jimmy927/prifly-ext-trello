import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachFileTool } from "./attach-file-tool";
import { fakePrifly } from "./fake-prifly";
import type { ConfirmSpec } from "./prifly-api";
import { load, type World } from "./world";

const realFetch = globalThis.fetch;
let calls: { url: string; method: string }[] = [];
const dir = mkdtempSync(join(tmpdir(), "attach-"));
const pdf = join(dir, "offer.pdf");
writeFileSync(pdf, "%PDF-1.4 hello");

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.includes("/cards/c1/attachments") && init?.method === "POST")
      return new Response(JSON.stringify({ url: "https://trello.com/1/cards/c1/attachments/a1/download/offer.pdf" }));
    if (url.includes("/cards/sl?")) return new Response(JSON.stringify({ id: "c1", name: "Offer" }));
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
  const tool = attachFileTool(() => world);
  return { shown, run: (args: Record<string, unknown>) => tool.call(args, { session: "s", signal: new AbortController().signal }) };
}
const posts = () => calls.filter((c) => c.method === "POST");

describe("trello_attach_file", () => {
  test("confirmed uploads each file and lists name and url", async () => {
    const { shown, run } = await setup(true);
    const answer = await run({ card: "https://trello.com/c/sl/1-offer", files: [pdf] });
    expect(shown[0]?.summary).toContain("Offer");
    expect(shown[0]?.content).toContain("offer.pdf (14 B)");
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.url).toContain("/cards/c1/attachments");
    expect(answer).toContain("offer.pdf: https://trello.com/1/cards/c1/attachments/a1/download/offer.pdf");
  });

  test("cancelled uploads nothing", async () => {
    const { run } = await setup(false);
    expect(await run({ card: "sl", files: [pdf] })).toStartWith("Not done: you cancelled");
    expect(posts()).toHaveLength(0);
  });

  test("a missing file is refused before asking or uploading", async () => {
    const { shown, run } = await setup(true);
    const answer = await run({ card: "sl", files: [pdf, join(dir, "nope.pdf")] });
    expect(answer).toContain("no file at");
    expect(shown).toHaveLength(0);
    expect(posts()).toHaveLength(0);
  });

  test("an unknown card is refused", async () => {
    const { shown, run } = await setup(true);
    const answer = await run({ card: "zzz", files: [pdf] });
    expect(answer).toContain("does not know a card");
    expect(shown).toHaveLength(0);
    expect(posts()).toHaveLength(0);
  });

  test("not logged in", async () => {
    const world = await load(fakePrifly("/x").api);
    const answer = await attachFileTool(() => world).call({ card: "a", files: ["b"] }, { session: "s", signal: new AbortController().signal });
    expect(answer).toContain("Not logged in");
  });
});
