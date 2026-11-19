import { type FakeState, fakeState } from "./fake-state";
import type { ExtensionApi, SettingValues, VaultFileRequest, VaultFileResult } from "./prifly-api";

/** The three things this extension needs of a prifly: `supported` wants all of them. */
export type Needed = "settings" | "state" | "secrets";

export type FakePrifly = {
  api: ExtensionApi;
  /** prifly's database for the extension. */
  database: FakeState;
  /** The extension's `api.secrets`, by key. */
  secrets: Map<string, string>;
  /** The vault's entries, by name: an old login, for the migration. */
  entries: Map<string, string>;
  filed: { name: string; request: VaultFileRequest }[];
  forgotten: string[];
  logs: string[];
};

export type FakeOptions = {
  /** Features (and the api that goes with each) this prifly lacks. */
  without?: Needed[];
  /** What the reader answers on the vault's card. */
  answer?: VaultFileResult["outcome"];
  /** False for an entry the reader made themselves, which `forget` cannot remove. */
  ownEntry?: boolean;
  settings?: SettingValues;
  /** A database that outlives this api, as prifly's does across a restart. */
  database?: FakeState;
};

/** A prifly's api for one extension, in memory: settings, `api.state` and the vault. */
export function fakePrifly(folder: string, options: FakeOptions = {}): FakePrifly {
  const lacks = new Set<Needed>(options.without ?? []);
  const database = options.database ?? fakeState();
  const entries = new Map<string, string>();
  const filed: FakePrifly["filed"] = [];
  const forgotten: string[] = [];
  const logs: string[] = [];
  const answer = options.answer ?? "accepted";
  const secrets = new Map<string, string>();
  const secretsApi = {
    get: async (key: string) => secrets.get(key) ?? null,
    set: async (key: string, value: string | null) => {
      if (value === null) secrets.delete(key);
      else secrets.set(key, value);
    },
    keys: async (prefix = "") => [...secrets.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
  const vault = {
    read: async (name: string) => entries.get(name) ?? null,
    file: async (name: string, request: VaultFileRequest): Promise<VaultFileResult> => {
      filed.push({ name, request });
      if (answer === "accepted") {
        entries.set(name, request.token);
        return { outcome: "accepted", level: 1 };
      }
      return answer === "refused"
        ? { outcome: "refused", message: "not listed" }
        : { outcome: answer };
    },
    forget: async (name: string) => {
      forgotten.push(name);
      if (options.ownEntry === false) return false;
      return entries.delete(name);
    },
  };
  const api = {
    folder,
    features: (["settings", "state", "secrets"] as const).filter(
      (feature) => !lacks.has(feature),
    ),
    log: (event: string, fields?: Record<string, unknown>) =>
      logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
    vault,
    ...(lacks.has("secrets") ? {} : { secrets: secretsApi }),
    ...(lacks.has("settings") ? {} : { settings: options.settings ?? {} }),
    ...(lacks.has("state") ? {} : { state: database }),
  } as unknown as ExtensionApi;
  return { api, database, secrets, entries, filed, forgotten, logs };
}
