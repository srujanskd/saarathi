import { describe, expect, it } from "vitest";
import { obsBrowserSourceName, trustedOverlayOrigin } from "../../src/core/obs.js";

describe("OBS browser source identity", () => {
  it("uses the stable unique module id rather than its display title", () => {
    expect(obsBrowserSourceName("wheel")).toBe("Saarathi wheel");
    expect(obsBrowserSourceName("goals")).toBe("Saarathi goals");
  });
});

describe("trusted overlay origin", () => {
  it("accepts the connected host while preserving the externally visible scheme", () => {
    expect(trustedOverlayOrigin("https://stream.example/control", "stream.example")).toBe(
      "https://stream.example",
    );
  });

  it("refuses another host, credentials, and non-web schemes", () => {
    expect(trustedOverlayOrigin("https://attacker.example", "stream.example")).toBeNull();
    expect(trustedOverlayOrigin("https://name:secret@stream.example", "stream.example")).toBeNull();
    expect(trustedOverlayOrigin("file:///tmp/overlay.html", "stream.example")).toBeNull();
    expect(trustedOverlayOrigin("https://stream.example", undefined)).toBeNull();
  });
});
