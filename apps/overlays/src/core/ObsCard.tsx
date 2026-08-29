import { useState } from "react";
import type { ConnectionStatus, DeckView, ObsView } from "@saarathi/shared";
import type { Connection } from "../lib/connection.js";
import { append, encodeGrid, hasScene, sceneSlot } from "./deckDraft.js";

/**
 * OBS on her phone.
 *
 * This is a core card, not a module card, which is why `control.tsx` wires it
 * by hand instead of `modules/registry.ts` finding it. OBS is a service every
 * module shares through `ctx.obs`, the way gains are -- if you are here looking
 * for the gap in the module contract, there isn't one.
 *
 * Almost all of it is the connected case being one row of scene buttons. The
 * settings underneath exist for the day the server is not on the same machine
 * as OBS; on her PC they should stay closed forever, because the server reads
 * the port and password out of OBS's own config.
 *
 * It also writes deck buttons, which is why it knows the grid. A scene button
 * is the one deck action that needs an argument, and the argument is a scene
 * name -- so it is added from the card that is already showing her the scenes,
 * rather than by teaching the deck's picker to enumerate core actions and then
 * ask her to type one. That is the decision recorded in the plan: less
 * machinery, and the button is where she is already looking.
 */
export function ObsCard({
  connection,
  obs,
  status,
  deck,
}: {
  connection: Connection;
  obs: ObsView;
  status: ConnectionStatus | undefined;
  deck: DeckView;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ host: string; port: string; password: string } | null>(null);

  const connected = status?.state === "connected";

  // Same discipline as the challenge editor: a draft shadows the server only
  // while it exists, so one keystroke cannot freeze these fields against the
  // next snapshot, and a refused save leaves her text where she can fix it.
  const fields = draft ?? { host: obs.host, port: String(obs.port), password: "" };
  const dirty = draft !== null;

  async function run(action: string, args?: string[]): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    const result = await connection.invoke({ action, args });
    setBusy(false);
    if (!result.ok) setNotice(result.reason);
    return result.ok;
  }

  async function save(): Promise<void> {
    if (await run("core.obsSettings", [fields.host, fields.port, fields.password])) setDraft(null);
  }

  /** Appends and saves in one go. The deck has no half-saved state -- a save
   * replaces the whole grid -- and a full deck is refused by the server in its
   * own words, which land in the notice above. */
  async function addScene(scene: string): Promise<void> {
    await run("core.deckSet", [encodeGrid(append(deck.slots, sceneSlot(scene)))]);
  }

  return (
    <section className="card" data-testid="obs-card">
      <h2>OBS</h2>
      <p className="hint" data-state={status?.state} data-testid="obs-status">
        {status?.detail ?? "Starting up"}
      </p>

      {notice ? (
        <p className="notice" data-testid="obs-notice">
          <span>{notice}</span>
          <button
            type="button"
            className="dismiss"
            aria-label="Dismiss"
            data-testid="obs-notice-dismiss"
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </p>
      ) : null}

      {connected && obs.scenes.length > 0 ? (
        <div className="scenes" data-testid="obs-scenes">
          {obs.scenes.map((scene) => (
            <button
              key={scene}
              type="button"
              className="btn scene"
              data-active={scene === obs.currentScene}
              aria-pressed={scene === obs.currentScene}
              disabled={busy}
              onClick={() => void run("core.obsScene", [scene])}
            >
              {scene}
            </button>
          ))}
        </div>
      ) : (
        // The way out of every not-connected state is the same one sentence,
        // because it is the only step that is genuinely hers to do.
        <p className="empty" data-testid="obs-empty">
          In OBS: Tools → WebSocket Server Settings → tick <b>Enable WebSocket server</b>. Nothing
          else to set up.
        </p>
      )}

      {connected && obs.scenes.length > 0 ? (
        <details className="fold">
          <summary>
            <span>Put a scene on her deck</span>
          </summary>
          <p className="hint">
            Saved straight away, on its own. Anything half-edited in the deck card stays hers
            until she saves it.
          </p>
          <div className="scenes">
            {obs.scenes.map((scene) => {
              const already = hasScene(deck.slots, scene);
              return (
                <button
                  key={scene}
                  type="button"
                  className="btn scene"
                  data-on-deck={already}
                  data-testid="obs-add-scene"
                  disabled={busy || already}
                  onClick={() => void addScene(scene)}
                >
                  {already ? `${scene} — on her deck` : `Add ${scene}`}
                </button>
              );
            })}
          </div>
        </details>
      ) : null}

      <details className="fold">
        <summary>
          <span data-testid="obs-where">
            {obs.mode === "auto"
              ? obs.detected
                ? `Using OBS's own settings (port ${obs.port})`
                : "Looking for OBS on this machine"
              : `${obs.host}:${obs.port}`}
          </span>
          {dirty ? (
            <span className="dirty" data-testid="obs-unsaved">
              unsaved
            </span>
          ) : null}
        </summary>

        <p className="hint">
          {obs.mode === "auto"
            ? "Filled in from OBS itself. Only change these if OBS is on another machine."
            : "Set by hand. Tap “Use OBS's own settings” to go back to reading them from OBS."}
        </p>

        <label className="field">
          <span>Address</span>
          <input
            className="input"
            data-testid="obs-host"
            value={fields.host}
            autoComplete="off"
            onChange={(event) => setDraft({ ...fields, host: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Port</span>
          <input
            className="input"
            data-testid="obs-port"
            value={fields.port}
            inputMode="numeric"
            autoComplete="off"
            onChange={(event) => setDraft({ ...fields, port: event.target.value })}
          />
        </label>
        <label className="field">
          <span>{obs.hasPassword ? "Password (saved — leave blank to keep it)" : "Password"}</span>
          <input
            className="input"
            type="password"
            data-testid="obs-password"
            value={fields.password}
            autoComplete="off"
            onChange={(event) => setDraft({ ...fields, password: event.target.value })}
          />
        </label>

        <button
          type="button"
          className="btn"
          data-testid="obs-save"
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          Save and connect
        </button>
        <button
          type="button"
          className="btn"
          data-testid="obs-revert"
          disabled={busy || !dirty}
          onClick={() => setDraft(null)}
        >
          Discard changes
        </button>
        <button
          type="button"
          className="btn"
          data-testid="obs-auto"
          disabled={busy || obs.mode === "auto"}
          onClick={() => void run("core.obsAuto").then(() => setDraft(null))}
        >
          Use OBS&rsquo;s own settings
        </button>
        <button
          type="button"
          className="btn"
          data-testid="obs-forget"
          disabled={busy || !obs.hasPassword}
          onClick={() => void run("core.obsForget")}
        >
          Forget password
        </button>
        <button
          type="button"
          className="btn"
          data-testid="obs-toggle"
          disabled={busy}
          onClick={() => void run(connected ? "core.obsDisconnect" : "core.obsConnect")}
        >
          {connected ? "Disconnect from OBS" : "Try again now"}
        </button>
      </details>
    </section>
  );
}
