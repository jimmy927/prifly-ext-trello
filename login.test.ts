import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetSession, PRIFLY_APP_KEY } from "./auth";
import { type FakeOptions, type FakePrifly, fakePrifly } from "./fake-prifly";
import { runSetup, setupTail } from "./setup";
import { load, parseState } from "./world";

const TOKEN = "t".repeat(40);
const OTHER = "o".repeat(40);

let folder = "";
const realFetch = globalThis.fetch;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "trello-login-"));
  // Trello answering `whoami`.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ username: "jimmy" }), {
      status: 200,
    })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(folder, { recursive: true, force: true });
});

/** What the extension has kept as its state. */
const readState = async (fake: FakePrifly) => parseState(await fake.database.get("state"));
const prifly = (options: FakeOptions = {}) => fakePrifly(folder, options);
const login = async (fake: FakePrifly, token = TOKEN) => {
  const world = await load(fake.api);
  const launch = await runSetup(world, "setup:paste-token", token);
  return { world, launch };
};

describe("logging in", () => {
  test("the token is kept in api.secrets, no vault card is asked and no file is written", async () => {
    const fake = prifly();
    const { world, launch } = await login(fake);
    expect(launch?.message).toContain("Logged in as jimmy");
    expect(fake.secrets.get("token") === TOKEN).toBe(true);
    expect(fake.filed).toEqual([]);
    expect(fake.entries.size).toBe(0);
    expect(readdirSync(folder)).toEqual([]);
    expect(world.session?.member).toBe("jimmy");
    // The name is not a secret and the secrets hold only the token: it is kept in prifly's state.
    expect((await readState(fake)).member).toBe("jimmy");
  });

  test("Trello is asked with prifly's app key", async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ username: "jimmy" }), { status: 200 });
    }) as unknown as typeof fetch;
    await login(prifly());
    expect(asked[0]).toContain(`key=${PRIFLY_APP_KEY}`);
  });

  test("a store that fails says why, without the token, and nobody is logged in", async () => {
    const fake = prifly();
    const world = await load(fake.api);
    Object.assign(fake.api.secrets ?? {}, {
      set: async () => {
        throw new Error("disk full");
      },
    });
    const failure = await runSetup(world, "setup:paste-token", TOKEN).catch(
      (caught: Error) => caught,
    );
    expect((failure as Error).message).toContain("disk full");
    expect((failure as Error).message.includes(TOKEN)).toBe(false);
    expect(world.session).toBeNull();
  });
});

describe("reading the login", () => {
  test("from api.secrets, with the name kept in prifly's state", async () => {
    const fake = prifly();
    fake.secrets.set("token", TOKEN);
    await fake.database.set("state", { member: "jimmy" });
    const world = await load(fake.api);
    expect(world.session?.token === TOKEN).toBe(true);
    expect(world.session?.member).toBe("jimmy");
  });

  test("a login survives a restart: token in the secrets, board in the state", async () => {
    const fake = prifly();
    const { world } = await login(fake);
    await runSetup(world, "setup:board:b1|Work", "");
    // A restart: a new api over the same database, and the secrets still hold the token.
    const again = prifly({ database: fake.database });
    again.secrets.set("token", fake.secrets.get("token") ?? "");
    const back = await load(again.api);
    expect(back.session?.token === TOKEN).toBe(true);
    expect(back.state.board).toBe("b1");
    expect(back.state.boardName).toBe("Work");
    expect(again.filed).toEqual([]);
  });

  test("nothing in the secrets is logged out", async () => {
    expect((await load(prifly().api)).session).toBeNull();
  });
});

describe("moving an old vault login", () => {
  test("is copied into the secrets and the entry forgotten", async () => {
    const fake = prifly();
    fake.entries.set("trello", TOKEN);
    await fake.database.set("state", { member: "jimmy", board: "b1" });
    const world = await load(fake.api);
    expect(world.session?.token === TOKEN).toBe(true);
    expect(world.session?.member).toBe("jimmy");
    expect(fake.secrets.get("token") === TOKEN).toBe(true);
    expect(fake.forgotten).toEqual(["trello"]);
    expect(fake.entries.has("trello")).toBe(false);
    expect(world.vaultNote).toBe(false);
    // And it is still logged in after the next start, with no vault entry left.
    const again = prifly({ database: fake.database });
    again.secrets.set("token", fake.secrets.get("token") ?? "");
    expect((await load(again.api)).session?.token === TOKEN).toBe(true);
  });

  test("a reader-made entry (forget leaves it) keeps working and is mentioned once", async () => {
    const fake = prifly({ ownEntry: false });
    fake.entries.set("trello", TOKEN);
    const world = await load(fake.api);
    expect(world.session?.token === TOKEN).toBe(true);
    expect(fake.secrets.get("token") === TOKEN).toBe(true);
    expect(world.vaultNote).toBe(true);
    const rows = setupTail(world);
    expect(rows?.find((row) => row.title === "Log out of Trello")?.detail).toContain(
      "Vault dialog",
    );
    // The next start does not say it again.
    const again = prifly({ database: fake.database, ownEntry: false });
    again.secrets.set("token", TOKEN);
    again.entries.set("trello", TOKEN);
    const back = await load(again.api);
    expect(back.session?.token === TOKEN).toBe(true);
    expect(back.vaultNote).toBe(false);
  });

  test("Log out with a reader-made entry stays logged out after a restart", async () => {
    const fake = prifly({ ownEntry: false });
    fake.entries.set("trello", TOKEN);
    const world = await load(fake.api);
    const launch = await runSetup(world, "setup:log-out", "");
    expect(launch?.message).toContain("Vault dialog");
    expect(fake.secrets.has("token")).toBe(false);
    expect(world.session).toBeNull();
    const again = prifly({ database: fake.database, ownEntry: false });
    again.entries.set("trello", TOKEN);
    const back = await load(again.api);
    expect(back.session).toBeNull();
    expect(again.secrets.has("token")).toBe(false);
  });

  test("nothing is moved after the reader has logged out of a vault-less start", async () => {
    const fake = prifly();
    const { world } = await login(fake);
    await runSetup(world, "setup:log-out", "");
    // An entry that shows up later is not the reader's login any more.
    const again = prifly({ database: fake.database });
    again.entries.set("trello", OTHER);
    expect((await load(again.api)).session).toBeNull();
    expect(again.forgotten).toEqual([]);
  });
});

describe("logging out", () => {
  test("clears the secrets, forgets an old vault entry and clears the name", async () => {
    const fake = prifly();
    const { world } = await login(fake);
    // An entry an earlier version filed and a later start did not migrate.
    fake.entries.set("trello", TOKEN);
    const launch = await runSetup(world, "setup:log-out", "");
    expect(fake.secrets.has("token")).toBe(false);
    expect(fake.forgotten).toEqual(["trello"]);
    expect(fake.entries.has("trello")).toBe(false);
    expect(world.session).toBeNull();
    expect((await readState(fake)).member).toBe("");
    expect(launch?.message).toContain("Logged out");
    expect(launch?.message).not.toContain("Vault dialog");
    expect((await load(fake.api)).session).toBeNull();
  });

  test("an entry the reader made themselves stays, and the reader is told", async () => {
    const fake = prifly({ ownEntry: false });
    fake.entries.set("trello", TOKEN);
    const world = await load(fake.api);
    const launch = await runSetup(world, "setup:log-out", "");
    expect(launch?.message).toContain("Vault dialog");
    expect(await forgetSession(fake.api)).toBe(true);
  });
});

describe("the token is never logged", () => {
  test("not through a login, a refused login or a logout", async () => {
    const fake = prifly({ answer: "refused" });
    const world = await load(fake.api);
    await runSetup(world, "setup:paste-token", OTHER).catch(() => undefined);
    await runSetup(world, "setup:log-out", "");
    const ok = prifly();
    await login(ok, TOKEN);
    const all = [...fake.logs, ...ok.logs].join("\n");
    expect(all.includes(TOKEN) || all.includes(OTHER)).toBe(false);
  });
});

describe("the skill", () => {
  const trello = join(import.meta.dir, "skills/trello");
  const source = () => Bun.file(join(trello, "trello.py")).text();

  const credsIn = async (env: Record<string, string>) => {
    const code =
      "import sys, trello\n" +
      "try:\n" +
      "    key, tok = trello.load_creds()\n" +
      "    print('key=' + key + ' token=' + tok)\n" +
      "except SystemExit as e:\n" +
      "    print('exit: ' + str(e))\n";
    const run = Bun.spawn(["python3", "-c", code], {
      cwd: trello,
      // A HOME and a PRIFLY_TRELLO_HOME holding a login file do not matter: only TRELLO_TOKEN counts.
      env: {
        PATH: Bun.env["PATH"] ?? "",
        PYTHONDONTWRITEBYTECODE: "1",
        HOME: folder,
        PRIFLY_TRELLO_HOME: folder,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await new Response(run.stdout).text()).trim();
  };

  test("its KEY is the extension's PRIFLY_APP_KEY", async () => {
    const found = /^KEY = "([0-9a-f]+)"$/m.exec(await source());
    expect(found?.[1]).toBe(PRIFLY_APP_KEY);
  });

  test("the token is TRELLO_TOKEN, as vault_run sets it, and the key is its own", async () => {
    expect(await credsIn({ TRELLO_TOKEN: "from-vault" })).toBe(
      `key=${PRIFLY_APP_KEY} token=from-vault`,
    );
  });

  test("TRELLO_API_KEY changes nothing", async () => {
    expect(await credsIn({ TRELLO_TOKEN: "x", TRELLO_API_KEY: "other" })).toBe(
      `key=${PRIFLY_APP_KEY} token=x`,
    );
  });

  test("no TRELLO_TOKEN says to use vault_run, or to set it", async () => {
    const said = await credsIn({});
    expect(said).toContain("TRELLO_TOKEN is not set");
    expect(said).toContain("vault_run");
  });

  test("no login file is looked for", async () => {
    const text = await source();
    for (const gone of [
      "auth.json",
      "app.json",
      "extension_roots",
      "PRIFLY_TRELLO_HOME",
      "TRELLO_API_KEY",
    ])
      expect(text.includes(gone)).toBe(false);
  });
});
