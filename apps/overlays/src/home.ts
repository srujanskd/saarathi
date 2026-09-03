import { pageAccess } from "./lib/access.js";
import { pageHref, serverUrl } from "./lib/serverUrl.js";
import { overlayIds } from "./modules/registry.js";
import "./home.css";

document.getElementById("home-control")?.setAttribute("href", pageHref("control.html"));
document.getElementById("home-deck")?.setAttribute("href", pageHref("deck.html"));

const access = await pageAccess(serverUrl(), "overlay");
const note = document.getElementById("overlay-note");
if (note && access.token) note.textContent = "These links are ready to copy into OBS.";

const links = document.getElementById("overlay-links");
if (!links) throw new Error("Home page has no overlay link container");

for (const id of overlayIds()) {
  const params = new URLSearchParams(window.location.search);
  params.set("module", id);
  if (access.token) params.set("access", access.token);

  const link = document.createElement("a");
  link.className = "overlay-link";
  link.href = `./overlay.html?${params.toString()}`;
  link.dataset.testid = `home-overlay-${id}`;

  const name = document.createElement("strong");
  name.textContent = `${label(id)} overlay`;
  const address = document.createElement("span");
  address.textContent = `overlay.html?module=${id}`;
  link.append(name, address);
  links.append(link);
}

function label(id: string): string {
  return `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}
