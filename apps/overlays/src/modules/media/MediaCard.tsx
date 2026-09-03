import { useState } from "react";
import {
  MAX_MEDIA_BYTES,
  MAX_MEDIA_ITEMS,
  MEDIA_ID,
  type MediaItem,
  type MediaState,
} from "@saarathi/shared";
import { Notice } from "../../core/Notice.js";
import { addToDeck } from "../../core/addToDeck.js";
import { useModuleState } from "../../lib/connection.js";
import { useInvoke } from "../../lib/invoke.js";
import type { CardProps } from "../types.js";
import { inspectMedia } from "./file.js";
import "./media-card.css";

interface Draft {
  file: File;
  label: string;
  durationMs: number;
  volume: number;
}

export function MediaCard({ connection, deck }: CardProps) {
  const state = useModuleState<MediaState>(connection, MEDIA_ID);
  const invoke = useInvoke(connection);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const items = state?.items ?? [];

  async function choose(file: File | undefined): Promise<void> {
    if (!file) return;
    if (file.size > MAX_MEDIA_BYTES) {
      invoke.say(`Keep media under ${Math.floor(MAX_MEDIA_BYTES / 1024 / 1024)} MB`, false);
      return;
    }
    const inspected = await inspectMedia(file);
    if (!inspected) {
      invoke.say("Use a supported clip no longer than 30 seconds", false);
      return;
    }
    setDraft({
      file,
      label: file.name.replace(/\.[^.]+$/, "").slice(0, 48),
      durationMs: inspected.durationMs,
      volume: 0.8,
    });
  }

  async function upload(): Promise<void> {
    if (!draft) return;
    setUploading(true);
    const query = new URLSearchParams({
      label: draft.label,
      durationMs: String(draft.durationMs),
      volume: String(draft.volume),
    });
    const result = await connection.request<{ item: MediaItem }>(`/api/media?${query}`, {
      method: "POST",
      headers: { "content-type": draft.file.type },
      body: draft.file,
    });
    setUploading(false);
    if (!result.ok) return invoke.say(result.reason, false);
    invoke.say(`${result.value.item.label} is ready`);
    setDraft(null);
  }

  async function remove(item: MediaItem): Promise<void> {
    const result = await connection.request<{ ok: true }>(`/api/media/${item.id}`, { method: "DELETE" });
    if (!result.ok) return invoke.say(result.reason, false);
    if (preview === item.id) setPreview(null);
    invoke.say(`${item.label} removed`);
  }

  async function putOnDeck(item: MediaItem): Promise<void> {
    await addToDeck(deck, invoke, {
      action: `${MEDIA_ID}.play`,
      args: [item.id],
      label: item.label,
      icon: item.kind === "audio" ? "♪" : "▶",
    });
  }

  return (
    <section className="card" data-testid="media-card">
      <h2>Media</h2>
      <p className="hint">Images and clips appear in OBS through the Media overlay from the Saarathi tray.</p>
      {invoke.notice ? <Notice notice={invoke.notice} testId="media-notice" onDismiss={invoke.dismiss} /> : null}

      {state?.active ? (
        <div className="media-live" data-testid="media-active">
          <span>Playing {items.find((item) => item.id === state.active?.itemId)?.label ?? "a clip"}</span>
          <button className="tool" type="button" onClick={() => void invoke.run(`${MEDIA_ID}.stop`)}>
            Stop all
          </button>
        </div>
      ) : <p className="hint">Nothing is playing.</p>}

      {items.length > 0 ? (
        <ul className="media-rows">
          {items.map((item) => (
            <li key={item.id}>
              <div className="media-name">
                <strong>{item.label}</strong>
                <span>{Math.ceil(item.durationMs / 1000)}s · {formatBytes(item.bytes)}</span>
              </div>
              {preview === item.id ? (
                <Preview item={item} src={connection.assetUrl(assetPath(item))} />
              ) : null}
              <div className="media-tools">
                <button className="tool" type="button" onClick={() => setPreview(preview === item.id ? null : item.id)}>
                  {preview === item.id ? "Close preview" : "Preview"}
                </button>
                <button className="tool" type="button" disabled={invoke.working} onClick={() => void invoke.run(`${MEDIA_ID}.play`, [item.id])}>
                  Play live
                </button>
                <button className="tool" type="button" disabled={invoke.working} onClick={() => void putOnDeck(item)}>
                  On the deck
                </button>
                <button className="tool" data-tool="remove" type="button" disabled={uploading} onClick={() => void remove(item)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="empty">No clips yet. Add the first one below.</p>}

      <details className="fold">
        <summary>Add a clip</summary>
        <label className="field">
          <span>Sound, image or short video</span>
          <input
            className="input media-file"
            type="file"
            accept="audio/mpeg,audio/ogg,audio/wav,image/gif,image/jpeg,image/png,image/webp,video/mp4,video/webm"
            disabled={uploading || items.length >= MAX_MEDIA_ITEMS}
            onChange={(event) => void choose(event.target.files?.[0])}
          />
        </label>
        {draft ? (
          <>
            <label className="field">
              <span>Button name</span>
              <input className="input" value={draft.label} maxLength={48} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
            </label>
            <label className="field">
              <span>Live volume, {Math.round(draft.volume * 100)}%</span>
              <input type="range" min="0" max="1" step="0.05" value={draft.volume} onChange={(event) => setDraft({ ...draft, volume: Number(event.target.value) })} />
            </label>
            <button className="btn btn-primary" type="button" disabled={uploading || !draft.label.trim()} onClick={() => void upload()}>
              {uploading ? "Adding…" : "Add clip"}
            </button>
            <button className="btn" type="button" disabled={uploading} onClick={() => setDraft(null)}>Cancel</button>
          </>
        ) : null}
      </details>
    </section>
  );
}

function Preview({ item, src }: { item: MediaItem; src: string }) {
  const setVolume = (element: HTMLMediaElement) => {
    element.volume = item.volume;
  };
  if (item.kind === "audio") return <audio className="media-preview" src={src} controls autoPlay onLoadedMetadata={(event) => setVolume(event.currentTarget)} />;
  if (item.kind === "video") return <video className="media-preview" src={src} controls autoPlay playsInline onLoadedMetadata={(event) => setVolume(event.currentTarget)} />;
  return <img className="media-preview" src={src} alt="" />;
}

function assetPath(item: MediaItem): string {
  return `/api/media/${encodeURIComponent(item.id)}/${encodeURIComponent(item.assetKey)}`;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
