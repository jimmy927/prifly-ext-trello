import { describe, expect, test } from "bun:test";
import type { ExtensionApi } from "./prifly-api";
import { archiveSettings, hasArchiveFollowUps, summaryPrompt } from "./summary";

const api = (fields: Partial<ExtensionApi>) => fields as ExtensionApi;

describe("archiveSettings", () => {
  test("a prifly without settings: summary ticked, the card left where it is", () => {
    expect(archiveSettings(api({}))).toEqual({ summaryOnArchive: true, archiveColumn: "" });
  });

  test("the reader's values", () => {
    const settings = { summaryOnArchive: false, archiveColumn: "Done" };
    expect(archiveSettings(api({ settings }))).toEqual(settings);
  });
});

test("archive fields only for a prifly that takes them", () => {
  expect(hasArchiveFollowUps(api({}))).toBe(false);
  expect(hasArchiveFollowUps(api({ features: ["archive-follow-ups"] }))).toBe(true);
});

test("the summary turn names the card and the tool", () => {
  const prompt = summaryPrompt({ name: "Fix login", shortLink: "aB3dE", url: "https://t/c/aB3dE" });
  expect(prompt).toContain("“Fix login”");
  expect(prompt).toContain("card `aB3dE`");
  expect(prompt).toContain("mcp__prifly__trello_post_summary");
});
