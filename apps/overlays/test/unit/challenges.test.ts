import { describe, expect, it } from "vitest";
import { linesOf, textOf } from "../../src/modules/wheel/challenges.js";

describe("the challenge editor", () => {
  it("keeps one challenge per line", () => {
    expect(linesOf("20 squats\n30s plank")).toEqual(["20 squats", "30s plank"]);
  });

  it("drops blank lines, because the server refuses an empty wheel", () => {
    expect(linesOf("  \n20 squats\n\n30s plank\n")).toEqual(["20 squats", "30s plank"]);
  });

  it("trims padding a phone keyboard leaves behind", () => {
    expect(linesOf("  20 squats  ")).toEqual(["20 squats"]);
  });

  it("round-trips the list she is already running", () => {
    const list = ["20 squats", "30s plank"];
    expect(linesOf(textOf(list))).toEqual(list);
  });
});
