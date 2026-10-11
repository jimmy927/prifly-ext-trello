import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetSession, writeAppKey } from "./auth";
import type { ExtensionApi, VaultFileRequest, VaultFileResult } from "./prifly-api";
import { runSetup } from "./setup";
import { load, moveLogin, readState } from "./world";

const TOKEN = "t".repeat(40);
const OTHER = "o".repeat(40);
const KEY = "k".repeat(32);

/** A prifly's vault for one extension, in memory: what `file` is answered with is `answer`. */
type Fake = {
  api: ExtensionApi;
  entries: Map<string, string>;
  filed: { name: string; request: VaultFileRequest }[];
  forgotten: string[];
  logs: string[];
};

function fakeVault(
  folder: string,
  options: { features?: string[]; answer?: VaultFileResult["outcome"]; ownEntry?: boolean } = {},
): Fake {
  const entries = new Map<string, string>();
  const filed: Fake["filed"] = [];
  const forgotten: string[] = [];
  const logs: string[] = [];
  const features = options.features ?? ["settings", "vault-file"];
  const answer = options.answer ?? "accepted";
  const vault = features.includes("vault-file")
    ? {
        read: async (name: string) => entries.get(name) ?? null,
        file: async (name: string, request: VaultFileRequest): Promise<VaultFileResult> => {
          filed.push({ name, request });
          if (answer === "accepted") {
            entries.set(name, request.token);
            return { outcome: "accepted", level: 1 };
          }
          return answer === "refused" ? { outcome: "refused", message: "not listed" } : { outcome: answer };
        },
        forget: async (name: string) => {
          forgotten.push(name);
          // An entry the reader made themselves is not the extension's to remove.
          if (options.ownEntry === false) return false;
          return entries.delete(name);
        },
      }
    : undefined;
  const api = {
    folder,
    features,
    settings: { appKey: KEY },
    log: (event: string, fields?: Record<string, unknown>) =>
      logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
    ...(vault === undefined ? {} : { vault }),
  } as unknown as ExtensionApi;
  return { api, entries, filed, forgotten, logs };
}

let folder = "";
const realFetch = globalThis.fetch;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "trello-login-"));
  // Trello answering `whoami`.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ username: "jimmy" }), { status: 200 })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(folder, { recursive: true, force: true });
});

const authPath = () => join(folder, "auth.json");
const writeAuth = (extra: Record<string, unknown> = {}) =>
  writeFileSync(authPath(), JSON.stringify({ token: TOKEN, member: "old", key: KEY, ...extra }));
const login = async (fake: Fake, token = TOKEN) => {
  const world = await load(fake.api);
  const launch = await runSetup(world, "setup:paste-token", token);
  return { world, launch };
};

describe("logging in", () => {
  test("with the vault, the token is filed there and no auth.json is written", async () => {
    const fake = fakeVault(folder);
    const { world, launch } = await login(fake);
    expect(launch?.message).toContain("Logged in as jimmy");
    expect(fake.filed).toHaveLength(1);
    expect(fake.filed[0]?.name).toBe("trello");
    expect(fake.filed[0]?.request.token === TOKEN).toBe(true);
    expect(fake.filed[0]?.request.host).toBe("trello.com");
    expect(fake.entries.get("trello") === TOKEN).toBe(true);
    expect(existsSync(authPath())).toBe(false);
    expect(world.session?.member).toBe("jimmy");
    // The name is not a secret and the vault holds only the token: it is kept in state.json.
    expect((await readState(folder)).member).toBe("jimmy");
  });

  test("on a prifly without vault-file, the token goes to auth.json as before", async () => {
    const fake = fakeVault(folder, { features: ["settings"] });
    await login(fake);
    expect(fake.filed).toHaveLength(0);
    const kept = await Bun.file(authPath()).json();
    expect(kept).toEqual({ token: TOKEN, member: "jimmy" });
  });

  test("a reader who declines the card is not logged in, and nothing is written", async () => {
    const fake = fakeVault(folder, { answer: "declined" });
    const world = await load(fake.api);
    await expect(runSetup(world, "setup:paste-token", TOKEN)).rejects.toThrow("declined");
    expect(world.session).toBeNull();
    expect(existsSync(authPath())).toBe(false);
    expect(fake.entries.size).toBe(0);
  });

  test("a refusal says why, without the token", async () => {
    const fake = fakeVault(folder, { answer: "refused" });
    const world = await load(fake.api);
    const failure = await runSetup(world, "setup:paste-token", TOKEN).catch((caught: Error) => caught);
    expect((failure as Error).message).toContain("not listed");
    expect((failure as Error).message.includes(TOKEN)).toBe(false);
  });

  test("a fresh login drops the old auth.json token", async () => {
    writeAuth({ extra: 1 });
    const fake = fakeVault(folder);
    await login(fake, OTHER);
    expect(await Bun.file(authPath()).json()).toEqual({ extra: 1 });
  });
});

describe("reading the login", () => {
  test("from the vault, with the name kept in state.json", async () => {
    const fake = fakeVault(folder);
    fake.entries.set("trello", TOKEN);
    writeFileSync(join(folder, "state.json"), JSON.stringify({ member: "jimmy" }));
    const world = await load(fake.api);
    expect(world.session?.token === TOKEN).toBe(true);
    expect(world.session?.member).toBe("jimmy");
  });

  test("the vault wins over a leftover auth.json", async () => {
    const fake = fakeVault(folder);
    fake.entries.set("trello", OTHER);
    writeAuth();
    expect((await load(fake.api)).session?.token === OTHER).toBe(true);
  });

  test("falls back to auth.json when the vault reads nothing, and on an older prifly", async () => {
    writeAuth();
    const world = await load(fakeVault(folder).api);
    expect(world.session?.token === TOKEN).toBe(true);
    expect(world.session?.member).toBe("old");
    const older = await load(fakeVault(folder, { features: ["settings"] }).api);
    expect(older.session?.token === TOKEN).toBe(true);
  });

  test("nothing anywhere is logged out", async () => {
    expect((await load(fakeVault(folder).api)).session).toBeNull();
  });
});

describe("moving auth.json into the vault", () => {
  test("accepted: filed, then the token leaves auth.json and the file goes", async () => {
    writeAuth();
    const fake = fakeVault(folder);
    const world = await load(fake.api);
    await moveLogin(world);
    expect(fake.filed).toHaveLength(1);
    expect(fake.filed[0]?.request.token === TOKEN).toBe(true);
    expect(fake.entries.get("trello") === TOKEN).toBe(true);
    expect(existsSync(authPath())).toBe(false);
    expect(world.state.member).toBe("old");
    expect((await readState(folder)).member).toBe("old");
    // And the next start reads it from the vault.
    expect((await load(fake.api)).session?.token === TOKEN).toBe(true);
  });

  test("accepted: anything else in auth.json stays", async () => {
    writeAuth({ extra: 1 });
    const fake = fakeVault(folder);
    await moveLogin(await load(fake.api));
    expect(await Bun.file(authPath()).json()).toEqual({ extra: 1 });
  });

  test("declined: auth.json stays, still logged in, and the next start does not ask", async () => {
    writeAuth();
    const fake = fakeVault(folder, { answer: "declined" });
    const world = await load(fake.api);
    await moveLogin(world);
    expect(fake.filed).toHaveLength(1);
    expect(existsSync(authPath())).toBe(true);
    expect(world.session?.token === TOKEN).toBe(true);
    expect((await readState(folder)).vaultDeclined).toBe(true);
    const next = await load(fake.api);
    await moveLogin(next);
    expect(fake.filed).toHaveLength(1);
    expect(next.session?.token === TOKEN).toBe(true);
  });

  test("a fresh login clears the decline, so the next old login is asked about again", async () => {
    writeAuth();
    const declined = fakeVault(folder, { answer: "declined" });
    await moveLogin(await load(declined.api));
    expect((await readState(folder)).vaultDeclined).toBe(true);
    const fake = fakeVault(folder);
    await login(fake, OTHER);
    expect((await readState(folder)).vaultDeclined).toBe(false);
    writeAuth();
    const again = fakeVault(folder);
    await moveLogin(await load(again.api));
    expect(again.filed).toHaveLength(1);
  });

  test("a timeout is not remembered as a decline", async () => {
    writeAuth();
    const fake = fakeVault(folder, { answer: "timed out" });
    await moveLogin(await load(fake.api));
    expect((await readState(folder)).vaultDeclined).toBe(false);
    expect(existsSync(authPath())).toBe(true);
  });

  test("nothing to ask: no auth.json login, an entry already there, or no vault-file", async () => {
    const empty = fakeVault(folder);
    await moveLogin(await load(empty.api));
    expect(empty.filed).toHaveLength(0);
    writeAuth();
    const there = fakeVault(folder);
    there.entries.set("trello", OTHER);
    await moveLogin(await load(there.api));
    expect(there.filed).toHaveLength(0);
    const older = fakeVault(folder, { features: ["settings"] });
    await moveLogin(await load(older.api));
    expect(older.filed).toHaveLength(0);
    expect(existsSync(authPath())).toBe(true);
  });
});

describe("logging out", () => {
  test("forgets the vault entry and the file, and clears the name", async () => {
    const fake = fakeVault(folder);
    const { world } = await login(fake);
    writeAuth();
    const launch = await runSetup(world, "setup:log-out", "");
    expect(fake.forgotten).toEqual(["trello"]);
    expect(fake.entries.has("trello")).toBe(false);
    expect(existsSync(authPath())).toBe(false);
    expect(world.session).toBeNull();
    expect((await readState(folder)).member).toBe("");
    expect(launch?.message).toContain("Logged out");
    expect((await load(fake.api)).session).toBeNull();
  });

  test("an entry the reader made themselves stays, and the reader is told", async () => {
    const fake = fakeVault(folder, { ownEntry: false });
    fake.entries.set("trello", TOKEN);
    const world = await load(fake.api);
    const launch = await runSetup(world, "setup:log-out", "");
    expect(launch?.message).toContain("Vault dialog");
    expect(await forgetSession(fake.api)).toBe(true);
  });

  test("on an older prifly it only removes auth.json", async () => {
    writeAuth();
    const fake = fakeVault(folder, { features: ["settings"] });
    const world = await load(fake.api);
    await runSetup(world, "setup:log-out", "");
    expect(existsSync(authPath())).toBe(false);
    expect(fake.forgotten).toHaveLength(0);
  });
});

describe("the token is never logged", () => {
  test("not through a login, a move, a failed move or a logout", async () => {
    writeAuth();
    const fake = fakeVault(folder, { answer: "refused" });
    const world = await load(fake.api);
    await moveLogin(world);
    await runSetup(world, "setup:paste-token", OTHER).catch(() => undefined);
    await runSetup(world, "setup:log-out", "");
    const ok = fakeVault(folder);
    writeAuth();
    await moveLogin(await load(ok.api));
    const all = [...fake.logs, ...ok.logs].join("\n");
    expect(all.includes(TOKEN) || all.includes(OTHER)).toBe(false);
  });
});

describe("the skill finds the app key", () => {
  const trello = join(import.meta.dir, "skills/trello");
  const credsIn = async (home: string, env: Record<string, string>) => {
    const code =
      "import sys, trello\n" +
      "try:\n" +
      "    key, tok = trello.load_creds()\n" +
      "    print('key=' + key + ' token=' + str(tok == 'from-vault'))\n" +
      "except SystemExit as e:\n" +
      "    print('exit: ' + str(e))\n";
    const run = Bun.spawn(["python3", "-c", code], {
      cwd: trello,
      env: { PATH: Bun.env["PATH"] ?? "", PYTHONDONTWRITEBYTECODE: "1", HOME: home, PRIFLY_TRELLO_HOME: folder, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await new Response(run.stdout).text()).trim();
  };

  test("app.json is written once and read, with the token from vault_run's TRELLO_TOKEN", async () => {
    await writeAppKey(folder, KEY);
    expect(await Bun.file(join(folder, "app.json")).json()).toEqual({ key: KEY });
    expect(await credsIn(folder, { TRELLO_TOKEN: "from-vault" })).toBe(`key=${KEY} token=True`);
  });

  test("an empty key writes no app.json", async () => {
    await writeAppKey(folder, "");
    expect(existsSync(join(folder, "app.json"))).toBe(false);
  });

  test("a key without a token says to use vault_run", async () => {
    await writeAppKey(folder, KEY);
    expect(await credsIn(folder, {})).toContain("vault_run");
  });

  test("an auth.json login on an older prifly is still found, with its own key", async () => {
    writeAuth();
    expect(await credsIn(folder, {})).toBe(`key=${KEY} token=False`);
  });
});
