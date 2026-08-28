import { describe, expect, it } from "vitest";
import { MAX_CHALLENGES } from "@saarathi/shared";
import { countLabel, toLines, toText } from "../../src/modules/wheel/challenges.js";

describe("the challenge editor", () => {
  it("keeps one challenge per line", () => {
    expect(toLines("20 squats\n30s plank")).toEqual(["20 squats", "30s plank"]);
  });

  it("drops blank lines, because the server refuses an empty wheel", () => {
    expect(toLines("  \n20 squats\n\n30s plank\n")).toEqual(["20 squats", "30s plank"]);
  });

  it("trims padding a phone keyboard leaves behind", () => {
    expect(toLines("  20 squats  ")).toEqual(["20 squats"]);
  });

  it("round-trips the list she is already running", () => {
    const list = ["20 squats", "30s plank"];
    expect(toLines(toText(list))).toEqual(list);
  });
});

describe("the count in the fold", () => {
  it("says one challenge without a stray plural", () => {
    expect(countLabel(1)).toBe("1 challenge");
  });

  it("counts a list that fits", () => {
    expect(countLabel(MAX_CHALLENGES)).toBe(`${MAX_CHALLENGES} challenges`);
  });

  it("says why a list over the cap will not save, before she tries", () => {
    const label = countLabel(MAX_CHALLENGES + 1);
    expect(label).toContain(String(MAX_CHALLENGES + 1));
    expect(label).toContain(String(MAX_CHALLENGES));
  });
});
