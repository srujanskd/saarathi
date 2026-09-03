import { pageAccess } from "./lib/access.js";
import { pageHref, serverUrl } from "./lib/serverUrl.js";
import "./home.css";

document.getElementById("home-control")?.setAttribute("href", pageHref("control.html"));
document.getElementById("home-deck")?.setAttribute("href", pageHref("deck.html"));

const server = serverUrl();
const access = await pageAccess(server, "overlay");
const note = document.getElementById("overlay-note");
const overlays = access.token ? await declaredOverlays(server, access.token) : [];
if (note && access.token) {
  note.textContent = overlays.length > 0
    ? "These links are ready to copy into OBS."
    : "Saarathi could not load its overlay list.";
}

const links = document.getElementById("overlay-links");
if (!links) throw new Error("Home page has no overlay link container");

for (const { id, title } of overlays) {
  const params = new URLSearchParams(window.location.search);
  params.set("module", id);
  if (access.token) params.set("access", access.token);

  const link = document.createElement("a");
  link.className = "overlay-link";
  link.href = `./overlay.html?${params.toString()}`;
  link.dataset.testid = `home-overlay-${id}`;

  const name = document.createElement("strong");
  name.textContent = `${title} overlay`;
  const address = document.createElement("span");
  address.textContent = `overlay.html?module=${id}`;
  link.append(name, address);
  links.append(link);
}

async function declaredOverlays(server: string, token: string): Promise<{ id: string; title: string }[]> {
  try {
    const response = await fetch(`${server}/api/overlays`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { overlays?: unknown };
    if (!Array.isArray(body.overlays)) return [];
    return body.overlays.filter(isOverlay);
  } catch {
    return [];
  }
}

function isOverlay(value: unknown): value is { id: string; title: string } {
  if (!value || typeof value !== "object") return false;
  const entry = value as { id?: unknown; title?: unknown };
  return typeof entry.id === "string" && typeof entry.title === "string";
}
