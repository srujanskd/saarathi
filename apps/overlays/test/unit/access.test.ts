import { describe, expect, it, vi } from "vitest";
import { pageAccess, pairPageAccess, resetPageAccess, type TokenMemory } from "../../src/lib/access.js";

function memory(): TokenMemory & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    read: (key) => values.get(key) ?? null,
    write: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key),
  };
}

describe("pageAccess", () => {
  it("takes an overlay capability only from its copied URL", async () => {
    const request = vi.fn();
    await expect(
      pageAccess("http://server", "overlay", { search: "?access=read-token" }, memory(), request),
    ).resolves.toEqual({ token: "read-token" });
    expect(request).not.toHaveBeenCalled();
  });

  it("bootstraps an overlay opened by the local Vite dev server", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ overlayToken: "local-read-token" }), { status: 200 }),
    );
    await expect(
      pageAccess("http://127.0.0.1:4400", "overlay", { search: "?module=media" }, memory(), request),
    ).resolves.toEqual({ token: "local-read-token" });
    expect(request).toHaveBeenCalledWith("http://127.0.0.1:4400/api/access/local");
  });

  it("exchanges a pairing code once and remembers the control capability", async () => {
    const saved = memory();
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ controlToken: "control-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await pageAccess("http://server", "control", { search: "?pair=123456" }, saved, request))
      .toEqual({ token: "control-token" });
    expect(await pageAccess("http://server", "deck", { search: "" }, saved, request))
      .toEqual({ token: "control-token" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("also exchanges a code typed on an unpaired control page", async () => {
    const saved = memory();
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ controlToken: "typed-token" }), { status: 200 }),
    );
    await expect(pairPageAccess("http://server", "123456", saved, request))
      .resolves.toEqual({ token: "typed-token" });
    expect(saved.values.get("saarathi:control:http://server")).toBe("typed-token");
  });

  it("bootstraps a page on the server PC through the loopback-only route", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ controlToken: "local-token" }), { status: 200 }),
    );
    await expect(pageAccess("http://server", "deck", { search: "" }, memory(), request))
      .resolves.toEqual({ token: "local-token" });
    expect(request).toHaveBeenCalledWith("http://server/api/access/local");
  });
});

describe("resetPageAccess", () => {
  it("forgets the saved token only after the server rotates it", async () => {
    const saved = memory();
    saved.write("saarathi:control:http://server", "control-token");
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(resetPageAccess("http://server", "control-token", saved, request))
      .resolves.toEqual({ ok: true });
    expect(saved.values.size).toBe(0);
  });
});
