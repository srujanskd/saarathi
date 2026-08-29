import { describe, expect, it } from "vitest";
import { lanAddress, links } from "../../src/net.js";

const nic = (address: string, extra: Partial<{ internal: boolean; family: string }> = {}) => ({
  address,
  family: extra.family ?? "IPv4",
  internal: extra.internal ?? false,
});

describe("lanAddress", () => {
  it("skips loopback, because a QR code for 127.0.0.1 scans to nothing", () => {
    expect(lanAddress({ lo0: [nic("127.0.0.1", { internal: true })] })).toBeNull();
  });

  it("skips IPv6, in both spellings Node uses", () => {
    expect(
      lanAddress({
        en0: [nic("fe80::1", { family: "IPv6" }), { address: "::1", family: 6, internal: false }],
      }),
    ).toBeNull();
  });

  it("prefers the range a home router hands out over Hyper-V's", () => {
    expect(
      lanAddress({
        "vEthernet (WSL)": [nic("172.28.240.1")],
        "Wi-Fi": [nic("192.168.1.24")],
      }),
    ).toBe("192.168.1.24");
  });

  it("still answers when the only address is a 10. one", () => {
    expect(lanAddress({ eth0: [nic("10.1.2.3")] })).toBe("10.1.2.3");
  });

  it("refuses a self-assigned address, which is reachable by nothing", () => {
    expect(lanAddress({ "Wi-Fi": [nic("169.254.4.4")] })).toBeNull();
  });

  it("is null with the Wi-Fi off, which the menu has to say in words", () => {
    expect(lanAddress({})).toBeNull();
  });
});

describe("links", () => {
  const built = links("192.168.1.24", 4400);

  it("names the LAN address, never localhost", () => {
    expect(built.origin).toBe("http://192.168.1.24:4400");
    expect(built.control).toBe("http://192.168.1.24:4400/control.html");
    expect(built.deck).toBe("http://192.168.1.24:4400/deck.html");
  });

  it("carries ?server= on the overlay, so OBS can live somewhere else", () => {
    expect(built.overlay).toContain("module=wheel");
    expect(built.overlay).toContain(`server=${encodeURIComponent(built.origin)}`);
  });
});
