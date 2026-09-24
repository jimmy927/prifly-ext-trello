/**
 * A copy of prifly's extension contract (apps/desktop-host/src/extensions/api.ts
 * in jimmy927/prifly), kept here so this extension type-checks on its own.
 *
 * What an extension is given, and what it gives back — the whole contract.
 *
 * An extension is a folder with a `prifly-extension.json` manifest and a
 * TypeScript or JavaScript module the host imports:
 *
 *     { "id": "vastai", "name": "Vast.ai boxes", "main": "index.ts",
 *       "description": "…", "version": "0.1.0" }
 *
 * The module exports `activate(api)`, which may return a function the host
 * calls to stop it. It runs inside the host, with the host's rights: enable
 * only extensions you would run yourself.
 */

export type DecorationTone = "good" | "warning" | "critical" | "info" | "muted";

/** One of the icons the window has: see `DECORATION_ICONS` in `@prifly/wire`. */
export type DecorationIcon =
  | "server"
  | "cpu"
  | "gpu"
  | "hard-drive"
  | "cloud"
  | "box"
  | "zap"
  | "activity"
  | "dollar"
  | "clock"
  | "alert"
  | "check"
  | "link"
  | "dot";

/** One item in a chip's own menu: "Move to Doing" on a Trello card. */
export type DecorationAction = { id: string; label: string };

export type Decoration = {
  /** Stable within the extension, so the window keeps an item's place. */
  key: string;
  icon: DecorationIcon;
  /** A few words: "lc-box1 $0.42/h". */
  label: string;
  tone: DecorationTone;
  /** Shown on hover, one line each. */
  details: string[];
  /** Where clicking the chip leads, in the reader's browser; left out, nowhere. */
  url?: string;
  /** What the chip's menu offers; left out, it has no menu. */
  actions?: DecorationAction[];
};

/** One thing a launcher can start a session from: a card, an issue, a ticket. */
export type LaunchChoice = {
  /** The extension's own name for it; handed back when the reader picks it. */
  key: string;
  title: string;
  /** What it is filed under, drawn as a column: a board's list. */
  group?: string;
  /** A line under the title: who is on it, when it is due. */
  detail?: string;
  tone?: DecorationTone;
  /** Picking it asks this first; what is typed reaches `launch` as `input`. */
  input?: { title: string; placeholder?: string };
};

/**
 * What a chosen thing becomes: the New session form, filled in — or, with an
 * empty prompt, nothing at all. An empty one leaves the chooser open, says
 * `message` and lists again, which is how a row can log the reader in or
 * choose which board to show instead of starting a session.
 */
export type Launch = {
  /** The session's first prompt — everything it needs to start. */
  prompt: string;
  /** Where to work; left out, the reader chooses as usual. */
  cwd?: string;
  /** A suggested name for the session and its worktree. */
  name?: string;
  /** A line for the chooser, whether or not a session follows. */
  message?: string;
};

/** A session the host knows, for an extension to match its things against. */
export type ExtensionSession = { id: string; title: string; cwd: string; state: string };

export type ExtensionApi = {
  /**
   * Replace everything this extension shows. `bySession` is keyed by a
   * session id or any unique start of one (a label has room for 8 characters);
   * items for an id no session has, and `unclaimed`, go to the status bar.
   */
  show(bySession: Record<string, Decoration[]>, unclaimed: Decoration[]): void;
  /** The sessions on this machine the host knows now. */
  sessions(): ExtensionSession[];
  /** A line in the host's log, under `ext.<id>.<event>`. */
  log(event: string, fields?: Record<string, string | number | boolean | null>): void;
  /** The extension's own folder: where it keeps its config. */
  folder: string;
};

export type ExtensionModule = {
  activate: (api: ExtensionApi) => (() => void) | undefined | Promise<(() => void) | undefined>;
  /**
   * What the launcher `launchId` offers now, narrowed by what the reader has
   * typed. Called on every keystroke's worth of typing, so answer from what is
   * already in hand rather than asking the network each time.
   */
  choices?: (launchId: string, query: string) => LaunchChoice[] | Promise<LaunchChoice[]>;
  /** The chosen one, as a session would start from it, with what was typed into its row. */
  launch?: (launchId: string, key: string, input: string) => Launch | Promise<Launch>;
  /**
   * The session that launch became, once it is running — where a card learns
   * which session is its. Only for a launch the reader went through with.
   */
  launched?: (launchId: string, key: string, sessionId: string) => void | Promise<void>;
  /** An item from a chip's menu, by the decoration's `key`. */
  action?: (key: string, actionId: string) => void | Promise<void>;
};
