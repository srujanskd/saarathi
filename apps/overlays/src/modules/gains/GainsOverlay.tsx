import { GAINS, GAINS_ID, type BoardRow, type GainsState } from "@saarathi/shared";
import { useModuleState, type Connection } from "../../lib/connection.js";
import { balanceText, place, streakText } from "./rank.js";
import "./gains.css";

/** Shared, so an overlay with an empty board does not hand React a new array a
 * render. */
const NONE: BoardRow[] = [];

/**
 * Who has the most, over her camera.
 *
 * It renders and it decides nothing. The board arrives ranked and trimmed, and
 * the roster it was built from never leaves the server -- so a browser source
 * that reloads gets the same ten rows the last one had, and nothing about her
 * chat that is not already on screen.
 */
export function GainsOverlay({ connection }: { connection: Connection }) {
  const state = useModuleState<GainsState>(connection, GAINS_ID);
  const rows = state?.board ?? NONE;

  return (
    <div className="board" data-empty={rows.length === 0} data-testid="board">
      {/* Hidden rather than absent when nobody has earned yet: a heading with
          no rows under it is a browser source that looks broken. */}
      <p className="board-head" hidden={rows.length === 0}>
        Most {GAINS.plural}
      </p>
      <ol className="board-rows">
        {rows.map((row, index) => (
          <Row key={row.id} row={row} index={index} />
        ))}
      </ol>
    </div>
  );
}

function Row({ row, index }: { row: BoardRow; index: number }) {
  const streak = streakText(row.streak);
  return (
    <li className="board-row" data-testid="board-row">
      <span className="board-place">{place(index)}</span>
      <span className="board-name">{row.name}</span>
      {streak ? <span className="board-streak">{streak}</span> : null}
      <span className="board-balance">{balanceText(row.balance)}</span>
    </li>
  );
}
