/**
 * Where she is, from the machine's point of view. Rule 3 in the shell: the
 * tray is the one place that has to name an address, because her phone cannot
 * ask the page it has not loaded yet where the server is. So it names the LAN
 * address and never "localhost" -- a QR code for 127.0.0.1 is a QR code for
 * nothing.
 */

export interface NetworkInterface {
  readonly family: string | number;
  readonly internal: boolean;
  readonly address: string;
}

/**
 * How much we want an address, higher first. Ranking beats filtering because
 * a Windows machine with Hyper-V, WSL or a VPN has several private addresses
 * and only one of them is the Wi-Fi her phone is on. None of them announce
 * that, so we prefer the range home routers actually hand out and fall back
 * rather than guessing from adapter names, which are localized.
 */
function rank(address: string): number {
  if (address.startsWith("192.168.")) return 3;
  if (address.startsWith("10.")) return 2;
  const [, second] = address.split(".");
  const octet = Number(second);
  if (address.startsWith("172.") && octet >= 16 && octet <= 31) return 1;
  // 169.254.x is what an interface gives itself when DHCP never answered, so
  // it is reachable by nothing and is worse than having no address at all.
  if (address.startsWith("169.254.")) return -1;
  return 0;
}

/**
 * The address to put in front of her, or null when this machine has no LAN
 * address at all -- which is a real state (Wi-Fi off) and has to render as
 * words rather than as a QR code pointing nowhere.
 */
export function lanAddress(
  interfaces: Record<string, NetworkInterface[] | undefined>,
): string | null {
  const candidates: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const nic of list ?? []) {
      // Node says 4 on some versions and "IPv4" on others, and IPv6 is not
      // something she is going to read off a screen.
      if (nic.family !== "IPv4" && nic.family !== 4) continue;
      if (nic.internal) continue;
      if (rank(nic.address) < 0) continue;
      candidates.push(nic.address);
    }
  }
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => rank(b) - rank(a))[0]!;
}

export interface Links {
  readonly origin: string;
  readonly control: string;
  readonly deck: string;
  readonly overlay: string;
}

/**
 * The four addresses that mean something to her. The overlay carries
 * ?server= because OBS may load it from somewhere that is not this machine
 * one day, and a URL she has already pasted into a browser source is the
 * worst place to discover that.
 */
export function links(host: string, port: number): Links {
  const origin = `http://${host}:${port}`;
  return {
    origin,
    control: `${origin}/control.html`,
    deck: `${origin}/deck.html`,
    overlay: `${origin}/overlay.html?module=wheel&server=${encodeURIComponent(origin)}`,
  };
}
