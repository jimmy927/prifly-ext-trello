import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeUrl, PRIFLY_APP_KEY } from "./auth";
import { fakePrifly, type Needed } from "./fake-prifly";
import { activate, choices } from "./index";
import type { ExtensionApi } from "./prifly-api";
import { runSetup, setupChoices } from "./setup";
import {
  cardLists,
  changeState,
  columnList,
  configFromSettings,
  linkCard,
  listNamed,
  load,
  type State,
  supported,
  unlinkCard,
} from "./world";

const state = (links: Record<string, string[]>): State => ({
  board: "",
  boardName: "",
  links,
  ignored: [],
  member: "",
});

describe("cardLists", () => {
  test("keeps only string short links, once each", () => {
    expect(cardLists({ s1: ["a", 7, "b", "a"], s2: 7, s3: [] })).toEqual({ s1: ["a", "b"] });
    expect(cardLists(null)).toEqual({});
  });
});

describe("linkCard and unlinkCard", () => {
  test("a second card joins the first instead of replacing it", () => {
    const at = state({ s1: ["a"] });
    linkCard(at, "s1", "b");
    linkCard(at, "s1", "b");
    expect(at.links).toEqual({ s1: ["a", "b"] });
  });

  test("unlinking the last card forgets the session", () => {
    const at = state({ s1: ["a", "b"] });
    unlinkCard(at, "s1", "a");
    expect(at.links).toEqual({ s1: ["b"] });
    unlinkCard(at, "s1", "b");
    expect(at.links).toEqual({});
  });
});

describe("listNamed", () => {
  const lists = [
    { id: "1", name: "Backlog" },
    { id: "2", name: "In Progress" },
  ];

  test("finds the column whatever its case", () => {
    expect(listNamed(lists, "in progress")?.id).toBe("2");
  });

  test("an empty name or a missing column is none", () => {
    expect(listNamed(lists, "")).toBeUndefined();
    expect(listNamed(lists, "Doing")).toBeUndefined();
  });
});

describe("configFromSettings", () => {
  test("reads every key from the settings", () => {
    expect(
      configFromSettings({
        cwd: "C:\\Users\\jimmy\\src\\odi",
        done: "Done, Shipped ,",
        inProgress: "Doing now",
        refreshSeconds: 30,
      }),
    ).toEqual({
      // A Windows path is kept as typed.
      cwd: "C:\\Users\\jimmy\\src\\odi",
      done: ["Done", "Shipped"],
      inProgress: "Doing now",
      refreshSeconds: 30,
    });
  });

  test("nothing set gives the declared defaults", () => {
    expect(configFromSettings({})).toEqual({
      cwd: "",
      done: ["Done"],
      inProgress: "In Progress",
      refreshSeconds: 60,
    });
  });

  test("a refresh rate under 15 seconds is raised to 15", () => {
    expect(configFromSettings({ refreshSeconds: 3 }).refreshSeconds).toBe(15);
  });

  test("an empty done list means no column is over", () => {
    expect(columnList(" , ")).toEqual([]);
  });
});

describe("the app key", () => {
  test("is prifly's own, 32 hex characters, and the login page uses it", () => {
    expect(PRIFLY_APP_KEY).toMatch(/^[0-9a-f]{32}$/);
    expect(authorizeUrl(PRIFLY_APP_KEY)).toContain(`key=${PRIFLY_APP_KEY}`);
  });
});

describe("a prifly missing settings, state or the vault", () => {
  let folder = "";
  const realFetch = globalThis.fetch;
  let asked: string[] = [];
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "trello-world-"));
    asked = [];
    globalThis.fetch = (async (input: unknown) => {
      asked.push(String(input));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(folder, { recursive: true, force: true });
  });

  test("supported needs all three, as feature and as api", () => {
    expect(supported(fakePrifly(folder).api)).toBe(true);
    for (const missing of ["settings", "state", "vault-file"] as Needed[])
      expect(supported(fakePrifly(folder, { without: [missing] }).api)).toBe(false);
    // The feature name alone, without the api behind it, is not enough.
    const noApi = fakePrifly(folder).api as { state?: unknown };
    delete noApi.state;
    expect(supported(noApi as ExtensionApi)).toBe(false);
    expect(supported({ features: [] } as unknown as ExtensionApi)).toBe(false);
  });

  for (const missing of ["settings", "state", "vault-file"] as Needed[]) {
    test(`without ${missing}: only the Update row shows, nothing runs and no file is written`, async () => {
      const fake = fakePrifly(folder, { without: [missing] });
      // A login in the vault and a board in the state must not wake anything up.
      fake.entries.set("trello", "t".repeat(40));
      let shown = 0;
      let tools = 0;
      Object.assign(fake.api, {
        show: () => {
          shown += 1;
        },
        tools: {
          register: () => {
            tools += 1;
          },
        },
        onSettings: () => {
          tools += 1;
        },
      });
      const stop = await activate(fake.api);
      const rows = await choices("card", "");
      expect(Array.isArray(rows)).toBe(true);
      const list = rows as { key: string; title: string; input?: unknown }[];
      expect(list.map((row) => row.title)).toEqual(["Update prifly to use this extension"]);
      expect(list[0]?.input).toBeUndefined();
      const world = await load(fake.api);
      expect(world.session).toBeNull();
      const launch = await runSetup(world, list[0]?.key ?? "", "");
      expect(launch?.message).toContain("Update prifly");
      stop();
      expect(asked).toEqual([]);
      expect(shown).toBe(0);
      expect(tools).toBe(0);
      expect(readdirSync(folder)).toEqual([]);
      expect(fake.database.writes()).toBe(0);
      expect(fake.filed).toEqual([]);
    });
  }

  test("the chooser is the Update row even when everything else is in place", async () => {
    const fake = fakePrifly(folder, { without: ["state"] });
    const world = await load(fake.api);
    world.session = { token: "t", member: "m" };
    world.state.board = "board";
    const rows = await setupChoices(world);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.title).toBe("Update prifly to use this extension");
  });

  test("a supported prifly starts at the login rows", async () => {
    const world = await load(fakePrifly(folder).api);
    const rows = await setupChoices(world);
    expect(rows?.map((row) => row.title)).toEqual([
      "1. Open the Trello login page",
      "2. Paste the token Trello shows you",
    ]);
  });
});

describe("state in prifly's database", () => {
  let folder = "";
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "trello-state-"));
  });
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  test("a new install starts empty and stores nothing", async () => {
    const fake = fakePrifly(folder);
    const world = await load(fake.api);
    expect(world.state).toEqual(state({}));
    expect(fake.database.docs.has("state")).toBe(false);
  });

  test("changes persist through a restart", async () => {
    const fake = fakePrifly(folder);
    const world = await load(fake.api);
    await changeState(world, (at) => {
      at.board = "b1";
      at.boardName = "Work";
      linkCard(at, "s1", "abc");
    });
    expect(world.state.links).toEqual({ s1: ["abc"] });
    const restarted = await load(fakePrifly(folder, { database: fake.database }).api);
    expect(restarted.state).toEqual({ ...state({ s1: ["abc"] }), board: "b1", boardName: "Work" });
  });

  test("two changes at once both land", async () => {
    const fake = fakePrifly(folder);
    const world = await load(fake.api);
    await Promise.all([
      changeState(world, (at) => linkCard(at, "s1", "a")),
      changeState(world, (at) => linkCard(at, "s1", "b")),
      changeState(world, (at) => linkCard(at, "s2", "c")),
    ]);
    expect((await load(fake.api)).state.links).toEqual({ s1: ["a", "b"], s2: ["c"] });
  });

  test("a stored document with parts missing is read with those parts empty", async () => {
    const fake = fakePrifly(folder);
    await fake.database.set("state", { board: "b1" });
    expect((await load(fake.api)).state).toEqual({ ...state({}), board: "b1" });
  });
});
