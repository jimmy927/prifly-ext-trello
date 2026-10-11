import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeState } from "./fake-state";
import type { ExtensionApi } from "./prifly-api";
import { runSetup, setupChoices } from "./setup";
import {
  cardLists,
  changeState,
  columnList,
  configFromSettings,
  hasSettings,
  hasState,
  linkCard,
  listNamed,
  load,
  type State,
  unlinkCard,
  type World,
} from "./world";

const state = (links: Record<string, string[]>): State => ({
  board: "",
  boardName: "",
  links,
  ignored: [],
  member: "",
  vaultDeclined: false,
});

describe("cardLists", () => {
  test("keeps only string short links, once each", () => {
    expect(cardLists({ s1: ["a", 7, "b", "a"], s2: 7, s3: [] })).toEqual({ s1: ["a", "b"] });
    expect(cardLists(null)).toEqual({});
  });

  test("reads a one-card link from an older state.json as a list of one", () => {
    expect(cardLists({ s1: "abc" })).toEqual({ s1: ["abc"] });
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

/** A prifly api; with `settings` it offers them, as a prifly that has the feature does. */
function fakeApi(settings?: Record<string, string | number>): ExtensionApi {
  return {
    folder: "/nonexistent/trello-extension",
    features: settings === undefined ? [] : ["settings"],
    log: () => {},
    ...(settings === undefined ? {} : { settings }),
  } as unknown as ExtensionApi;
}

describe("configFromSettings", () => {
  test("reads every key from the settings", () => {
    expect(
      configFromSettings({
        appKey: " " + "b".repeat(32) + " ",
        cwd: "C:\\Users\\jimmy\\src\\odi",
        done: "Done, Shipped ,",
        inProgress: "Doing now",
        refreshSeconds: 30,
      }),
    ).toEqual({
      appKey: "b".repeat(32),
      // A Windows path is kept as typed.
      cwd: "C:\\Users\\jimmy\\src\\odi",
      done: ["Done", "Shipped"],
      inProgress: "Doing now",
      refreshSeconds: 30,
    });
  });

  test("nothing set gives the declared defaults, and no app key from the environment", () => {
    const before = Bun.env["TRELLO_APP_KEY"];
    Bun.env["TRELLO_APP_KEY"] = "e".repeat(32);
    try {
      expect(configFromSettings({})).toEqual({
        appKey: "",
        cwd: "",
        done: ["Done"],
        inProgress: "In Progress",
        refreshSeconds: 60,
      });
    } finally {
      if (before === undefined) delete Bun.env["TRELLO_APP_KEY"];
      else Bun.env["TRELLO_APP_KEY"] = before;
    }
  });

  test("a refresh rate under 15 seconds is raised to 15", () => {
    expect(configFromSettings({ refreshSeconds: 3 }).refreshSeconds).toBe(15);
  });

  test("an empty done list means no column is over", () => {
    expect(columnList(" , ")).toEqual([]);
  });
});

describe("a prifly without extension settings", () => {
  const worldOf = async (api: ExtensionApi): Promise<World> => await load(api);

  test("hasSettings needs both the feature and the values", () => {
    expect(hasSettings(fakeApi())).toBe(false);
    expect(hasSettings({ features: [], settings: {} } as unknown as ExtensionApi)).toBe(false);
    expect(hasSettings({ features: ["settings"] } as unknown as ExtensionApi)).toBe(false);
    expect(hasSettings(fakeApi({}))).toBe(true);
  });

  test("the chooser is a single row saying to update prifly, even with an app key and login", async () => {
    const world = await worldOf(fakeApi());
    world.config.appKey = "a".repeat(32);
    world.session = { token: "t", member: "m" };
    world.state.board = "board";
    const rows = await setupChoices(world);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.title).toBe("Update prifly to use this extension");
    expect(rows?.[0]?.input).toBeUndefined();
    const launch = await runSetup(world, rows?.[0]?.key ?? "", "");
    expect(launch?.message).toContain("Update prifly");
  });
});

describe("the app key row", () => {
  test("points at the Extensions dialog, takes no input and writes nothing", async () => {
    const world = await load(fakeApi({}));
    const rows = await setupChoices(world);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.input).toBeUndefined();
    expect(rows?.[0]?.title).toContain("Extensions");
    const launch = await runSetup(world, "setup:app-key", "c".repeat(32));
    expect(launch?.message).toContain("Extensions");
    expect(world.config.appKey).toBe("");
  });
});

/** A prifly api with `api.state` in memory (when `withState`), an extension folder and a log. */
function stateApi(folder: string, withState = true) {
  const database = fakeState();
  const logs: string[] = [];
  const api = {
    folder,
    features: withState ? ["settings", "state"] : ["settings"],
    settings: {},
    log: (event: string) => logs.push(event),
    ...(withState ? { state: database } : {}),
  } as unknown as ExtensionApi;
  return { api, database, logs };
}

describe("state in prifly's database", () => {
  let folder = "";
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "trello-state-"));
  });
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  const legacy = {
    board: "b1",
    boardName: "Work",
    links: { s1: "abc", s2: ["d", "e"] },
    ignored: ["x"],
    member: "jimmy",
    vaultDeclined: true,
  };

  test("an existing state.json is imported once, with a one-card link read as a list", async () => {
    writeFileSync(join(folder, "state.json"), JSON.stringify(legacy));
    const { api, database } = stateApi(folder);
    const world = await load(api);
    expect(world.state).toEqual({ ...legacy, links: { s1: ["abc"], s2: ["d", "e"] } });
    expect(JSON.parse(database.docs.get("state") ?? "null")).toEqual(world.state);
  });

  test("an imported state.json is never read or written again", async () => {
    writeFileSync(join(folder, "state.json"), JSON.stringify(legacy));
    const { api, database } = stateApi(folder);
    await load(api);
    // Changed after the import: the database is the truth, the file is ignored.
    const other = JSON.stringify({ board: "other" });
    writeFileSync(join(folder, "state.json"), other);
    const again = await load(api);
    expect(again.state.board).toBe("b1");
    await changeState(again, (state) => {
      state.board = "b2";
    });
    expect(readFileSync(join(folder, "state.json"), "utf8")).toBe(other);
    expect((await load(api)).state.board).toBe("b2");
    // The import, then the one change.
    expect(database.writes()).toBe(2);
  });

  test("no state.json starts empty and stores nothing, so a later start asks again", async () => {
    const { api, database } = stateApi(folder);
    const world = await load(api);
    expect(world.state).toEqual(state({}));
    expect(database.docs.has("state")).toBe(false);
    writeFileSync(join(folder, "state.json"), JSON.stringify({ board: "late" }));
    expect((await load(api)).state.board).toBe("late");
  });

  test("a state.json that is not JSON imports nothing", async () => {
    writeFileSync(join(folder, "state.json"), "{ not json");
    const { api, database } = stateApi(folder);
    expect((await load(api)).state).toEqual(state({}));
    expect(database.docs.has("state")).toBe(false);
  });

  test("changes persist through a restart", async () => {
    const { api } = stateApi(folder);
    const world = await load(api);
    await changeState(world, (at) => {
      at.board = "b1";
      at.boardName = "Work";
      linkCard(at, "s1", "abc");
    });
    expect(world.state.links).toEqual({ s1: ["abc"] });
    const restarted = await load(api);
    expect(restarted.state).toEqual({ ...state({ s1: ["abc"] }), board: "b1", boardName: "Work" });
  });

  test("two changes at once both land", async () => {
    const { api } = stateApi(folder);
    const world = await load(api);
    await Promise.all([
      changeState(world, (at) => linkCard(at, "s1", "a")),
      changeState(world, (at) => linkCard(at, "s1", "b")),
      changeState(world, (at) => linkCard(at, "s2", "c")),
    ]);
    expect((await load(api)).state.links).toEqual({ s1: ["a", "b"], s2: ["c"] });
  });

  test("without the state feature: logged once, kept in memory, no files written", async () => {
    writeFileSync(join(folder, "state.json"), JSON.stringify(legacy));
    const { api, logs } = stateApi(folder, false);
    const world = await load(api);
    expect(logs.filter((event) => event === "needs_newer_prifly")).toHaveLength(1);
    // The old file is not even imported.
    expect(world.state).toEqual(state({}));
    await changeState(world, (at) => {
      at.board = "b9";
      linkCard(at, "s1", "abc");
    });
    expect(world.state.board).toBe("b9");
    expect(world.state.links).toEqual({ s1: ["abc"] });
    expect(readdirSync(folder)).toEqual(["state.json"]);
    expect(readFileSync(join(folder, "state.json"), "utf8")).toBe(JSON.stringify(legacy));
    expect(logs.filter((event) => event === "needs_newer_prifly")).toHaveLength(1);
  });

  test("hasState needs both the feature and the api", () => {
    expect(hasState(stateApi(folder).api)).toBe(true);
    expect(hasState(stateApi(folder, false).api)).toBe(false);
    expect(hasState({ features: ["state"] } as unknown as ExtensionApi)).toBe(false);
    expect(hasState({ features: [], state: fakeState() } as unknown as ExtensionApi)).toBe(false);
  });
});
