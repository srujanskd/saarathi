import { describe, expect, it } from "vitest";
import { pageHref, serverUrl, type PageLocation, type ServerMemory } from "../../src/lib/serverUrl.js";

const at = (search: string): PageLocation => ({
  search,
  origin: "http://pages.example",
  protocol: "http:",
  hostname: "pages.example",
});

function memory(initial: string | null = null): ServerMemory & { value: string | null } {
  return {
    value: initial,
    read() {
      return this.value;
    },
    write(url: string) {
      this.value = url;
    },
  };
}

describe("where the page thinks the server is", () => {
  it("takes the address from the parameter, whatever it was served from", () => {
    expect(serverUrl(at("?server=http://192.168.1.20:4400"), memory())).toBe(
      "http://192.168.1.20:4400",
    );
  });

  it("accepts what a phone keyboard produces: no scheme, a trailing slash", () => {
    expect(serverUrl(at("?server=192.168.1.20:4400/"), memory())).toBe("http://192.168.1.20:4400");
  });

  it("remembers a parameter she typed, because a manifest cannot carry one", () => {
    const store = memory();
    serverUrl(at("?server=192.168.1.20:4400"), store);
    expect(store.value).toBe("http://192.168.1.20:4400");
  });

  // This is the installed PWA: Chrome launches `start_url`, which is
  // `control.html` with no query on it at all. Falling back to the origin here
  // would point her app at the host that served the page rather than the
  // server, which is the whole IRL failure.
  it("uses the remembered address when the launch has no parameter", () => {
    expect(serverUrl(at(""), memory("http://192.168.1.20:4400"))).toBe("http://192.168.1.20:4400");
  });

  it("lets a new parameter replace a remembered one, so there is a way back out", () => {
    const store = memory("http://192.168.1.20:4400");
    expect(serverUrl(at("?server=http://10.0.0.5:4400"), store)).toBe("http://10.0.0.5:4400");
    expect(store.value).toBe("http://10.0.0.5:4400");
  });

  // The last-resort fallback -- the origin the page came from -- is the one
  // branch that reads `import.meta.env`, so it is proven against a real built
  // bundle in `server-param.spec.ts` rather than guessed at here.
});

describe("linking from one of her pages to another", () => {
  it("carries the address the current page was given", () => {
    expect(pageHref("deck.html", { search: "?server=http%3A%2F%2F192.168.1.20%3A4400" })).toBe(
      "./deck.html?server=http%3A%2F%2F192.168.1.20%3A4400",
    );
  });

  it("stays relative, so a pages host serving from a subpath still works", () => {
    expect(pageHref("control.html", { search: "" })).toBe("./control.html");
  });
});
