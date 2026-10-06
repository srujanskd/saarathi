import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Connection } from "../lib/connection.js";

/** Search results belong to this phone, never a shared module slice. */
export function UserSearch<T>({ connection, module, children }: {
  connection: Connection;
  module: string;
  children: (rows: T[] | null, refresh: () => void) => ReactNode;
}) {
  const connected = useSyncExternalStore(connection.subscribe, () => connection.getState().connected);
  const [text, setText] = useState("");
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ text: string; rows?: T[]; reason?: string } | null>(null);
  const query = text.trim();
  const refresh = () => setRevision((current) => current + 1);

  useEffect(() => {
    if (!query || !connected) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void connection.request<T[]>("/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: `${module}.users`, args: [query] }),
        signal: controller.signal,
      }).then((answer) => {
        if (controller.signal.aborted) return;
        setResult(answer.ok ? { text: query, rows: answer.value } : { text: query, reason: answer.reason });
      });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [connection, module, query, revision, connected]);

  const current = result?.text === query ? result : null;
  return (
    <>
      <form onSubmit={(event) => { event.preventDefault(); setResult(null); refresh(); }}>
        <label className="field">
          <span>Search users</span>
          <input className="input" type="search" maxLength={120} value={text}
            placeholder="Name or user ID" autoComplete="off"
            data-testid={`${module}-search`}
            onChange={(event) => { setText(event.target.value); setResult(null); }} />
        </label>
        {query ? (
          <div className="rule-tools">
            <button className="btn" type="submit" disabled={!connected}>Search again</button>
            <button className="btn" type="button" onClick={() => { setText(""); setResult(null); }}>Clear search</button>
          </div>
        ) : null}
      </form>
      {query ? (
        <div aria-live="polite">
          <p className="hint">
            {!connected ? "Cannot reach Saarathi" : current?.reason ?? (!current?.rows ? "Searching..." :
              current.rows.length === 0 ? "No users found" : `${current.rows.length} match${current.rows.length === 1 ? "" : "es"}${current.rows.length === 20 ? ". Showing up to 20, narrow your search to find others" : ""}`)}
          </p>
          {connected && current?.rows ? children(current.rows, refresh) : null}
        </div>
      ) : children(null, refresh)}
    </>
  );
}
