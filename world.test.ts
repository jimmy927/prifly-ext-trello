import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionApi } from "./prifly-api";
import { runSetup, setupChoices } from "./setup";
import {
  cardLists,
  columnList,
  configFromSettings,
  linkCard,
  listNamed,
  loadConfig,
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

/** A prifly api over a folder holding `config.json`; with `settings` it offers them. */
function fakeApi(folder: string, settings?: Record<string, string | number>): ExtensionApi {
  return {
    folder,
    features: settings === undefined ? [] : ["settings"],
    ...(settings === undefined ? {} : { settings }),
  } as unknown as ExtensionApi;
}

function withFolder(run: (folder: string) => Promise<void>): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "trello-config-"));
  return run(folder).finally(() => rmSync(folder, { recursive: true, force: true }));
}

const fileConfig = {
  appKey: "a".repeat(32),
  cwd: "/home/jimmy/src/odi",
  done: ["Done", "Released"],
  inProgress: "Doing",
  refreshSeconds: 120,
};

describe("loadConfig with prifly's settings", () => {
  test("reads every key from api.settings and ignores config.json", () =>
    withFolder(async (folder) => {
      writeFileSync(join(folder, "config.json"), JSON.stringify(fileConfig));
      const config = await loadConfig(
        fakeApi(folder, {
          appKey: "b".repeat(32),
          cwd: "C:\\Users\\jimmy\\src\\odi",
          done: "Done, Shipped ,",
          inProgress: "Doing now",
          refreshSeconds: 30,
        }),
      );
      expect(config).toEqual({
        appKey: "b".repeat(32),
        // A Windows path is kept as typed.
        cwd: "C:\\Users\\jimmy\\src\\odi",
        done: ["Done", "Shipped"],
        inProgress: "Doing now",
        refreshSeconds: 30,
      });
    }));

  test("config.json is not imported: the declared defaults apply until the reader sets them", () =>
    withFolder(async (folder) => {
      writeFileSync(join(folder, "config.json"), JSON.stringify(fileConfig));
      const config = await loadConfig(
        fakeApi(folder, { appKey: "", cwd: "", done: "Done", inProgress: "In Progress", refreshSeconds: 60 }),
      );
      expect(config.cwd).toBe("");
      expect(config.done).toEqual(["Done"]);
      expect(config.refreshSeconds).toBe(60);
    }));

  test("a refresh rate under 15 seconds is raised to 15", () => {
    expect(configFromSettings({ refreshSeconds: 3 }).refreshSeconds).toBe(15);
  });

  test("an empty done list means no column is over", () => {
    expect(columnList(" , ")).toEqual([]);
  });
});

describe("loadConfig without settings", () => {
  test("reads config.json as before", () =>
    withFolder(async (folder) => {
      writeFileSync(join(folder, "config.json"), JSON.stringify(fileConfig));
      expect(await loadConfig(fakeApi(folder))).toEqual(fileConfig);
    }));

  test("settings present but the feature not offered still means config.json", () =>
    withFolder(async (folder) => {
      writeFileSync(join(folder, "config.json"), JSON.stringify(fileConfig));
      const api = { ...fakeApi(folder), settings: { cwd: "/elsewhere" } } as ExtensionApi;
      expect((await loadConfig(api)).cwd).toBe("/home/jimmy/src/odi");
    }));

  test("no file gives today's defaults", () =>
    withFolder(async (folder) => {
      const config = await loadConfig(fakeApi(folder));
      expect(config.done).toEqual(["Done"]);
      expect(config.inProgress).toBe("In Progress");
      expect(config.refreshSeconds).toBe(60);
    }));
});

describe("the app key row", () => {
  const worldOf = (api: ExtensionApi): World =>
    ({ api, config: { appKey: "" }, session: null, state: { board: "" } }) as unknown as World;

  test("with settings it points at the Extensions dialog and writes no config.json", () =>
    withFolder(async (folder) => {
      const world = worldOf(fakeApi(folder, {}));
      const rows = await setupChoices(world);
      expect(rows?.[0]?.input).toBeUndefined();
      const launch = await runSetup(world, "setup:app-key", "c".repeat(32));
      expect(launch?.message).toContain("Extensions");
      expect(await Bun.file(join(folder, "config.json")).exists()).toBe(false);
    }));

  test("without settings it takes the pasted key and writes config.json", () =>
    withFolder(async (folder) => {
      const world = worldOf(fakeApi(folder));
      const rows = await setupChoices(world);
      expect(rows?.[0]?.input).toBeDefined();
      await runSetup(world, "setup:app-key", "c".repeat(32));
      expect((await Bun.file(join(folder, "config.json")).json()).appKey).toBe("c".repeat(32));
    }));
});
