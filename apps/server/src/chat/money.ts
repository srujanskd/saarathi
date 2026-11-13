import type { Money } from "@saarathi/shared";

/**
 * Money as a platform showed it, turned into a number and a currency when both
 * can be read off it.
 *
 * The currency is not optional decoration. Every Super Chat she gets arrives in
 * the sender's currency, so a value with no currency beside it reads "$5" as
 * five and "₹500" as five hundred -- and anything that ever turns an amount
 * into reps or a tier would rank the dollar donor a hundred times lower. When
 * the currency cannot be named, the value is dropped with it: a number nobody
 * can compare is worse than none.
 *
 * Adapter-side and platform-neutral, so mock chat and any tips webhook reach
 * the same result YouTube does.
 */
export function parseAmount(display: unknown): Money {
  const shown = typeof display === "string" ? display.trim() : "";
  if (!shown) return { display: "a tip" };
  const value = parseNumber(shown);
  const currency = currencyOf(shown);
  return {
    display: shown,
    ...(value !== undefined && currency ? { value, currency } : {}),
  };
}

/**
 * The number, whichever way round its separators are.
 *
 * YouTube formats in the reader's locale, not the sender's, so the same five
 * euros can arrive as "€5.00" or "5,00 €", and India groups by hundreds:
 * "₹1,00,000.00". Read as digits only, the second is five hundred.
 */
function parseNumber(shown: string): number | undefined {
  // `\s` covers the no-break spaces Intl groups with in some locales.
  const raw = shown.match(/\d[\d.,\s]*\d|\d/)?.[0]?.replace(/\s/g, "");
  if (!raw) return undefined;

  const lastDot = raw.lastIndexOf(".");
  const lastComma = raw.lastIndexOf(",");
  let whole = raw;
  let fraction = "";

  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: whichever comes last is the decimal point.
    const point = Math.max(lastDot, lastComma);
    whole = raw.slice(0, point);
    fraction = raw.slice(point + 1);
    const grouping = raw[point] === "." ? "," : ".";
    if (whole.includes(raw[point]!)) return undefined;
    whole = whole.split(grouping).join("");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const mark = lastDot >= 0 ? "." : ",";
    const parts = raw.split(mark);
    const tail = parts[parts.length - 1]!;
    if (parts.length === 2 && tail.length !== 3) {
      // One mark and not three digits after it: "5.00", "5,00", "1.5".
      whole = parts[0]!;
      fraction = tail;
    } else if (tail.length === 3) {
      // Grouping, western or Indian: "1,000", "1.000", "1,00,000".
      whole = parts.join("");
    } else {
      return undefined;
    }
  }

  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) return undefined;
  const value = Number(fraction ? `${whole}.${fraction}` : whole);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Longest first, because "$" is a suffix of five other dollars and a
 * Canadian's five dollars is not an American's.
 */
const SYMBOLS: [string, string][] = ([
  ["CA$", "CAD"], ["A$", "AUD"], ["NZ$", "NZD"], ["HK$", "HKD"], ["NT$", "TWD"],
  ["MX$", "MXN"], ["R$", "BRL"], ["US$", "USD"], ["$", "USD"],
  ["₹", "INR"], ["€", "EUR"], ["£", "GBP"], ["¥", "JPY"], ["₩", "KRW"],
  ["₱", "PHP"], ["₫", "VND"], ["₪", "ILS"], ["฿", "THB"], ["₺", "TRY"],
  ["₽", "RUB"], ["₦", "NGN"], ["zł", "PLN"], ["Rs", "INR"],
] as [string, string][]).sort((a, b) => b[0].length - a[0].length);

function currencyOf(shown: string): string | undefined {
  // A three-letter code wins when there is one: Intl falls back to it for any
  // currency without a symbol in the reader's locale, "PHP 100.00".
  const code = shown.match(/\b[A-Z]{3}\b/)?.[0];
  if (code) return code;
  return SYMBOLS.find(([symbol]) => shown.includes(symbol))?.[1];
}
