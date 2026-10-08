import { describe, expect, test } from "bun:test";
import { cardLists, linkCard, type State, unlinkCard } from "./world";

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
