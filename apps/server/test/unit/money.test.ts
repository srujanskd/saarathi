import { describe, expect, it } from "vitest";
import { parseAmount } from "../../src/chat/money.js";

describe("parseAmount", () => {
  it("keeps what was displayed and reads the number and currency off it", () => {
    expect(parseAmount("$5.00")).toEqual({ display: "$5.00", value: 5, currency: "USD" });
    expect(parseAmount("₹500.00")).toEqual({ display: "₹500.00", value: 500, currency: "INR" });
    expect(parseAmount("CA$1.99")).toEqual({ display: "CA$1.99", value: 1.99, currency: "CAD" });
  });

  it("tells one dollar from another", () => {
    expect(parseAmount("A$10.00").currency).toBe("AUD");
    expect(parseAmount("NT$150").currency).toBe("TWD");
    expect(parseAmount("R$25,00").currency).toBe("BRL");
  });

  it("reads a decimal comma as a decimal, not as five hundred", () => {
    expect(parseAmount("5,00 €")).toMatchObject({ value: 5, currency: "EUR" });
    expect(parseAmount("1.234,50 €")).toMatchObject({ value: 1234.5 });
  });

  it("reads grouping as grouping, western and Indian", () => {
    expect(parseAmount("₹1,000.00").value).toBe(1000);
    expect(parseAmount("₹1,00,000.00").value).toBe(100000);
    expect(parseAmount("₹1,00,000").value).toBe(100000);
    expect(parseAmount("¥1,000").value).toBe(1000);
    expect(parseAmount("1 000,00 zł")).toMatchObject({ value: 1000, currency: "PLN" });
  });

  it("takes a three-letter code when there is no symbol", () => {
    expect(parseAmount("PHP 100.00")).toEqual({ display: "PHP 100.00", value: 100, currency: "PHP" });
  });

  it("drops the value when it cannot name the currency, since nobody can compare it", () => {
    expect(parseAmount("5.00")).toEqual({ display: "5.00" });
  });

  it("still reports the display when it cannot find a number", () => {
    expect(parseAmount("a lot")).toEqual({ display: "a lot" });
  });

  it("says 'a tip' rather than nothing when there is no display at all", () => {
    for (const input of ["", "  ", null, undefined, 5, {}]) {
      expect(parseAmount(input), String(input)).toEqual({ display: "a tip" });
    }
  });

  it("omits the value instead of guessing at a malformed number", () => {
    for (const input of ["$1.2.3", "$1,2,3", "€1.000.0"]) {
      expect("value" in parseAmount(input), input).toBe(false);
    }
  });
});
