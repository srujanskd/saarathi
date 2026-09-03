import { useState } from "react";
import { CORE_ACTIONS, type ConnectionStatus, type ObsView } from "@saarathi/shared";
import type { Connection } from "../lib/connection.js";
import { useInvoke } from "../lib/invoke.js";
import { Notice } from "./Notice.js";
import { addToDeck } from "./addToDeck.js";
import { hasScene, sceneSlot } from "./deckDraft.js";
import type { DeckDraft } from "./useDeckDraft.js";

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
 * It also writes deck buttons, which is why it shares the deck card's draft.
 * A scene button is the one deck action that needs an argument, and the
 * argument is a scene name -- so it is added from the card that is already
 * showing her the scenes, rather than by teaching the deck's picker to
 * enumerate core actions and then ask her to type one. That is the decision
 * recorded in the plan: less machinery, and the button is where she is already
 * looking.
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
  /** Shared with the deck card, which is the other thing that writes buttons. */
  deck: DeckDraft;
}) {
  const invoke = useInvoke(connection);
  const [draft, setDraft] = useState<{ host: string; port: string; password: string } | null>(null);

  const busy = invoke.working;
  const connected = status?.state === "connected";

  // Same discipline as the challenge editor: a draft shadows the server only
  // while it exists, so one keystroke cannot freeze these fields against the
  // next snapshot, and a refused save leaves her text where she can fix it.
  const fields = draft ?? { host: obs.host, port: String(obs.port), password: "" };
  const dirty = draft !== null;

  const { run } = invoke;

  async function save(): Promise<void> {
    const args = [fields.host, fields.port, fields.password];
    if (await run(CORE_ACTIONS.obsSettings, args)) setDraft(null);
  }

  /** A scene, onto the grid she is looking at. See `addToDeck`. */
  async function addScene(scene: string): Promise<void> {
    await addToDeck(deck, invoke, sceneSlot(scene));
  }

  return (
    <section className="card" id="obs-setup" data-testid="obs-card">
      <h2>OBS</h2>
      <p className="hint" data-state={status?.state} data-testid="obs-status">
        {status?.detail ?? "Starting up"}
      </p>

      {invoke.notice ? (
        <Notice notice={invoke.notice} testId="obs-notice" onDismiss={invoke.dismiss} />
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
              onClick={() => void run(CORE_ACTIONS.obsScene, [scene])}
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
            {deck.editing
              ? "Added to the arrangement in the deck card, so one Save keeps both."
              : "Saved straight away, on its own."}
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

      {connected ? (
        <details className="fold" id="obs-media-setup">
          <summary>
            <span>Microphone and browser sources</span>
          </summary>
          <div className="obs-checks">
            <div>
              <b>Microphone</b>
              {obs.microphones.length === 0 ? (
                <p className="hint">
                  In OBS, open Settings → Audio and choose your microphone under Mic/Aux.
                </p>
              ) : (
                <ul>
                  {obs.microphones.map((input) => (
                    <li key={input.name} data-muted={input.muted === true}>
                      {input.name}
                      {input.muted === true
                        ? " is muted"
                        : input.muted === false
                          ? " is unmuted"
                          : " needs a mute check"}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <b>Browser sources</b>
              {obs.browserSources.length === 0 ? (
                <p className="hint">
                  In OBS, choose Sources → + → Browser, then paste the address of the Saarathi
                  overlay you want to show.
                </p>
              ) : (
                <ul>
                  {obs.browserSources.map((source) => (
                    <li key={source}>{source}</li>
                  ))}
                </ul>
              )}
            </div>
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
          onClick={() => void run(CORE_ACTIONS.obsAuto).then(() => setDraft(null))}
        >
          Use OBS&rsquo;s own settings
        </button>
        <button
          type="button"
          className="btn"
          data-testid="obs-forget"
          disabled={busy || !obs.hasPassword}
          onClick={() => void run(CORE_ACTIONS.obsForget)}
        >
          Forget password
        </button>
        <button
          type="button"
          className="btn"
          data-testid="obs-toggle"
          disabled={busy}
          onClick={() => void run(connected ? CORE_ACTIONS.obsDisconnect : CORE_ACTIONS.obsConnect)}
        >
          {connected ? "Disconnect from OBS" : "Try again now"}
        </button>
      </details>
    </section>
  );
}
