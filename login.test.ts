import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetSession, PRIFLY_APP_KEY } from "./auth";
import { type FakeOptions, type FakePrifly, fakePrifly } from "./fake-prifly";
import { runSetup } from "./setup";
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
  test("the token is filed in the vault and no file is written", async () => {
    const fake = prifly();
    const { world, launch } = await login(fake);
    expect(launch?.message).toContain("Logged in as jimmy");
    expect(fake.filed).toHaveLength(1);
    expect(fake.filed[0]?.name).toBe("trello");
    expect(fake.filed[0]?.request.token === TOKEN).toBe(true);
    expect(fake.filed[0]?.request.host).toBe("trello.com");
    expect(fake.entries.get("trello") === TOKEN).toBe(true);
    expect(readdirSync(folder)).toEqual([]);
    expect(world.session?.member).toBe("jimmy");
    // The name is not a secret and the vault holds only the token: it is kept in prifly's state.
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

  test("a reader who declines the card is not logged in, and nothing is kept", async () => {
    const fake = prifly({ answer: "declined" });
    const world = await load(fake.api);
    await expect(runSetup(world, "setup:paste-token", TOKEN)).rejects.toThrow("declined");
    expect(world.session).toBeNull();
    expect(readdirSync(folder)).toEqual([]);
    expect(fake.entries.size).toBe(0);
  });

  test("a refusal says why, without the token", async () => {
    const fake = prifly({ answer: "refused" });
    const world = await load(fake.api);
    const failure = await runSetup(world, "setup:paste-token", TOKEN).catch(
      (caught: Error) => caught,
    );
    expect((failure as Error).message).toContain("not listed");
    expect((failure as Error).message.includes(TOKEN)).toBe(false);
  });
});

describe("reading the login", () => {
  test("from the vault, with the name kept in prifly's state", async () => {
    const fake = prifly();
    fake.entries.set("trello", TOKEN);
    await fake.database.set("state", { member: "jimmy" });
    const world = await load(fake.api);
    expect(world.session?.token === TOKEN).toBe(true);
    expect(world.session?.member).toBe("jimmy");
  });

  test("a login survives a restart: token in the vault, board in the state", async () => {
    const fake = prifly();
    const { world } = await login(fake);
    await runSetup(world, "setup:board:b1|Work", "");
    // A restart: a new api over the same database, and the vault still holds the entry.
    const again = prifly({ database: fake.database });
    again.entries.set("trello", fake.entries.get("trello") ?? "");
    const back = await load(again.api);
    expect(back.session?.token === TOKEN).toBe(true);
    expect(back.state.board).toBe("b1");
    expect(back.state.boardName).toBe("Work");
  });

  test("nothing in the vault is logged out", async () => {
    expect((await load(prifly().api)).session).toBeNull();
  });
});

describe("logging out", () => {
  test("forgets the vault entry and clears the name", async () => {
    const fake = prifly();
    const { world } = await login(fake);
    const launch = await runSetup(world, "setup:log-out", "");
    expect(fake.forgotten).toEqual(["trello"]);
    expect(fake.entries.has("trello")).toBe(false);
    expect(world.session).toBeNull();
    expect((await readState(fake)).member).toBe("");
    expect(launch?.message).toContain("Logged out");
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
