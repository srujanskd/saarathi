import type { Links } from "./net.js";

/**
 * The one page this shell renders itself. Everything else she touches is
 * served by the server and lives in apps/overlays; this exists because of a
 * bootstrapping problem those pages cannot solve -- her phone has to reach a
 * page before it can be told where the server is.
 *
 * It is a string rather than a React route on purpose: pulling the overlay
 * build into the tray to draw two QR codes would tie the shell to the page
 * bundle, and this window has no state, no socket and no reason to reload.
 */

export interface ConnectEntry {
  readonly title: string;
  readonly hint: string;
  readonly url: string;
  /** An <svg> element as text. Inline, because this page loads no network. */
  readonly qr: string;
}

/** The two pages worth a QR code: the ones that live on her phone. */
export function connectTargets(links: Links, code: string): { title: string; hint: string; url: string }[] {
  return [
    {
      title: "Control page",
      hint: "Spin the wheel, edit challenges, switch scenes.",
      url: links.control,
    },
    {
      title: "Deck",
      hint: "Your button grid. Add it to your home screen.",
      url: links.deck,
    },
  ].map((target) => {
    const url = new URL(target.url);
    url.searchParams.set("pair", code);
    return { ...target, url: url.toString() };
  });
}

const PALETTE = `
  --bg: #0f1117;
  --card: #171a23;
  --line: #2a2f3e;
  --text: #f4f5f8;
  --muted: #9aa1b2;
  --accent: #4ade80;
`;

/**
 * Escaped because a URL carries a query string, and one of these is going into
 * an attribute. The QR markup is ours and goes in raw -- it is the only thing
 * on this page that is not text.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function connectPageHtml(entries: readonly ConnectEntry[], code: string): string {
  const cards = entries
    .map(
      (entry) => `
      <section class="card">
        <div class="qr">${entry.qr}</div>
        <h2>${escapeHtml(entry.title)}</h2>
        <p class="hint">${escapeHtml(entry.hint)}</p>
        <p class="url">${escapeHtml(entry.url)}</p>
      </section>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Connect your phone</title>
<style>
  :root {${PALETTE}}
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.5 system-ui, sans-serif;
    text-align: center;
  }
  h1 { font-size: 1.15rem; margin: 0 0 4px; }
  .lede { color: var(--muted); margin: 0 0 20px; }
  .code { font: 700 1.45rem/1 ui-monospace, monospace; letter-spacing: .16em; color: var(--accent); }
  .cards { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 16px;
    width: 240px;
  }
  .qr { background: #fff; border-radius: 8px; padding: 8px; line-height: 0; }
  .qr svg { width: 100%; height: auto; }
  h2 { font-size: 1rem; margin: 12px 0 2px; color: var(--accent); }
  .hint { color: var(--muted); margin: 0 0 8px; font-size: 0.85rem; }
  .url { margin: 0; font-size: 0.75rem; color: var(--muted); word-break: break-all; }
</style>
</head>
<body>
  <h1>Connect your phone</h1>
  <p class="lede">Point your camera at a code. Your phone has to be on the same Wi-Fi. The code lasts ten minutes.</p>
  <p class="code">${escapeHtml(code)}</p>
  <div class="cards">${cards}</div>
</body>
</html>
`;
}
