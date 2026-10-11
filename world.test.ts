import { describe, expect, test } from "bun:test";
import type { ExtensionApi } from "./prifly-api";
import { runSetup, setupChoices } from "./setup";
import {
  cardLists,
  columnList,
  configFromSettings,
  hasSettings,
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
    expect(configFromSettings({})).toEqual({
      appKey: "",
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
