import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DeckGrid } from "./core/DeckGrid.js";
import { Status } from "./core/Status.js";
import { connect, useCoreState, type Connection } from "./lib/connection.js";
import { pageHref, serverUrl } from "./lib/serverUrl.js";
import "./deck.css";

/**
 * The deck: her grid, full screen, and nothing else.
 *
 * It is a third surface rather than a tab on the control page because it is
 * used differently -- propped on a stand, glanced at, pressed with one hand
 * mid-set -- and because `surface: "deck"` is what makes the wheel's history
 * say the deck spun it rather than the control page.
 *
 * It subscribes to no module slices at all. The grid is core state, so a page
 * that only presses buttons has no reason to be paying for a wheel it does not
 * draw or a chat log it does not show. That is the same reasoning the overlay
 * uses to ask for one module, applied to a page that needs none.
 */

function Deck({ url, connection }: { url: string; connection: Connection }) {
  const core = useCoreState(connection);

  return (
    <div className="page" data-surface="deck">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <h1>Deck</h1>
            <Status url={url} connection={connection} />
          </div>
        </div>
      </header>

      <main>
        {/* Nothing until the first snapshot: an empty grid drawn while the
            socket is still connecting reads as "she has no buttons", and she
            would go and make some. */}
        {core ? <DeckGrid connection={connection} slots={core.deck.slots} /> : null}
      </main>

      {/* The way back. Arranging the grid happens on the control page, so a
          deck with the wrong buttons on it has to be able to get there --
          including the empty one she is looking at the first time. */}
      <footer>
        <p className="hint away">
          <a href={pageHref("control.html")} data-testid="deck-to-control">
            Control page
          </a>
        </p>
      </footer>
    </div>
  );
}

const root = document.getElementById("root")!;
const url = serverUrl();
const connection = connect({ url, surface: "deck", modules: [] });

createRoot(root).render(
  <StrictMode>
    <Deck url={url} connection={connection} />
  </StrictMode>,
);
