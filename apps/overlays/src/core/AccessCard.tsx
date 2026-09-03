import { useState } from "react";
import { useAccess, type Connection } from "../lib/connection.js";
import { Notice, type NoticeText } from "./Notice.js";

export function AccessCard({ connection }: { connection: Connection }) {
  const access = useAccess(connection);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeText | null>(null);
  if (access.phase === "checking") return null;

  const pair = async () => {
    setBusy(true);
    const result = await connection.pair(code);
    setBusy(false);
    if (!result.ok) setNotice({ text: result.reason, ok: false });
  };

  if (access.phase === "unpaired") {
    return (
      <section className="card" id="access-setup" data-testid="access-card">
        <h2>Pair this device</h2>
        <p className="hint">Open Connect your phone from the Saarathi tray, then scan its QR code or type the six-digit code.</p>
        {notice ? <Notice notice={notice} testId="access-notice" onDismiss={() => setNotice(null)} /> : null}
        <label className="field">
          <span>Pairing code</span>
          <input
            className="input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
          />
        </label>
        <button className="btn btn-primary" type="button" disabled={busy || code.length !== 6} onClick={() => void pair()}>
          {busy ? "Pairing…" : "Pair device"}
        </button>
      </section>
    );
  }

  const reset = async () => {
    if (!window.confirm("Disconnect every phone, deck and OBS overlay from Saarathi?")) return;
    setBusy(true);
    const result = await connection.resetAccess();
    setBusy(false);
    if (!result.ok) setNotice({ text: result.reason, ok: false });
  };

  return (
    <section className="card" id="access-setup" data-testid="access-card">
      <h2>Paired devices</h2>
      <p className="hint">
        Phones and deck windows can control Saarathi. OBS links can only show their overlay.
      </p>
      {notice ? <Notice notice={notice} testId="access-notice" onDismiss={() => setNotice(null)} /> : null}
      <details className="fold">
        <summary>Disconnect devices</summary>
        <p className="hint">
          This expires every paired phone and copied OBS URL. Use Connect your phone and copy fresh overlay URLs afterwards.
        </p>
        <button type="button" className="btn danger" disabled={busy} onClick={() => void reset()}>
          {busy ? "Disconnecting…" : "Disconnect all devices"}
        </button>
      </details>
    </section>
  );
}
