import { describe, expect, it } from "vitest";
import { connectPageHtml, connectTargets } from "../../src/connect-page.js";
import { links } from "../../src/net.js";

describe("connectTargets", () => {
  it("offers the two pages that live on her phone, and not the overlay", () => {
    const targets = connectTargets(links("192.168.1.24", 4400), "123456");
    expect(targets.map((target) => target.url)).toEqual([
      "http://192.168.1.24:4400/control.html?pair=123456",
      "http://192.168.1.24:4400/deck.html?pair=123456",
    ]);
  });
});

describe("connectPageHtml", () => {
  const html = connectPageHtml([
    { title: "Control page", hint: "Spin the wheel.", url: "http://1.2.3.4:4400/control.html", qr: "<svg id='a'></svg>" },
  ], "123456");

  it("inlines the QR markup, because the window loads nothing over the network", () => {
    expect(html).toContain("<svg id='a'></svg>");
  });

  it("prints the address as text too, for the phone whose camera will not focus", () => {
    expect(html).toContain("http://1.2.3.4:4400/control.html");
  });

  it("escapes the URL, which carries a query string on its way into a page", () => {
    const escaped = connectPageHtml([
      { title: "x", hint: "y", url: "http://h/overlay.html?a=1&b=<2>", qr: "" },
    ], "123456");
    expect(escaped).toContain("a=1&amp;b=&lt;2&gt;");
    expect(escaped).not.toContain("b=<2>");
  });

  it("shows the manual code when her camera will not scan", () => {
    expect(html).toContain("123456");
  });
});
