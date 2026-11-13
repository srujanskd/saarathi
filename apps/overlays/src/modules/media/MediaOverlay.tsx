import { useEffect, useRef, useState, type CSSProperties } from "react";
import { MEDIA_ID, type MediaItem, type MediaState, type PaidMessage } from "@saarathi/shared";
import { useModuleState, type Connection } from "../../lib/connection.js";
import "./media.css";

export function MediaOverlay({ connection }: { connection: Connection }) {
  const state = useModuleState<MediaState>(connection, MEDIA_ID);
  const [, redraw] = useState(0);
  const cue = state?.active ?? null;
  const item = cue ? (state?.speech?.id === cue.itemId ? state.speech : state?.items.find((candidate) => candidate.id === cue.itemId)) : null;
  const remaining = cue ? cue.endsAt - connection.serverNow() : 0;

  useEffect(() => {
    if (!cue || remaining <= 0) return;
    const timer = setTimeout(() => redraw((value) => value + 1), remaining);
    return () => clearTimeout(timer);
  }, [cue, remaining]);

  const message = cue?.paidId ? state?.paid.find((candidate) => candidate.id === cue.paidId) : undefined;

  if (!cue || (!item && !message) || remaining <= 0) return null;
  const elapsedSeconds = Math.max(0, (connection.serverNow() - cue.startedAt) / 1000);
  return (
    <>
      {item ? <Cue key={cue.id} item={item} elapsedSeconds={elapsedSeconds}
        src={connection.assetUrl(`/api/media/${encodeURIComponent(item.id)}/${encodeURIComponent(item.assetKey)}`)} /> : null}
      {message ? <PaidAlert key={`alert-${cue.id}`} message={message} remainingMs={remaining} /> : null}
    </>
  );
}

const ALERT_FADE_MS = 400;

/**
 * Who paid, how much, and what they said. Rendered from the queue entry, so a
 * browser source that OBS reloads mid-alert comes back to the same card with
 * the time it has left; the exit is scheduled off that, not off a timer here.
 */
function PaidAlert({ message, remainingMs }: { message: PaidMessage; remainingMs: number }) {
  const style = { "--alert-out": `${Math.max(0, remainingMs - ALERT_FADE_MS)}ms` } as CSSProperties;
  return (
    <div className="paid-alert" style={style} data-testid="paid-alert">
      <p className="paid-alert-top">
        <span className="paid-alert-name">{message.name}</span>
        <span className="paid-alert-amount">{message.amount}</span>
      </p>
      {message.text ? <p className="paid-alert-text">{message.text}</p> : null}
    </div>
  );
}

function Cue({ item, src, elapsedSeconds }: { item: MediaItem; src: string; elapsedSeconds: number }) {
  const media = useRef<HTMLMediaElement | null>(null);
  const remember = (element: HTMLMediaElement | null) => {
    media.current = element;
  };

  useEffect(() => {
    if (media.current) media.current.volume = item.volume;
  }, [item.volume]);

  const join = () => {
    const element = media.current;
    if (!element) return;
    element.volume = item.volume;
    if (Number.isFinite(element.duration)) element.currentTime = Math.min(elapsedSeconds, element.duration);
    void element.play().catch(() => undefined);
  };

  if (item.kind === "audio") {
    return <audio ref={remember} src={src} autoPlay onLoadedMetadata={join} data-testid="media-audio" />;
  }
  if (item.kind === "video") {
    return <video ref={remember} className="media-cue" src={src} autoPlay playsInline onLoadedMetadata={join} data-testid="media-video" />;
  }
  return <img className="media-cue" src={src} alt="" data-testid="media-image" />;
}
