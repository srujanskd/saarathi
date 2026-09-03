import { useEffect, useRef, useState } from "react";
import { MEDIA_ID, type MediaItem, type MediaState } from "@saarathi/shared";
import { useModuleState, type Connection } from "../../lib/connection.js";
import "./media.css";

export function MediaOverlay({ connection }: { connection: Connection }) {
  const state = useModuleState<MediaState>(connection, MEDIA_ID);
  const [, redraw] = useState(0);
  const cue = state?.active ?? null;
  const item = cue ? state?.items.find((candidate) => candidate.id === cue.itemId) : null;
  const remaining = cue ? cue.endsAt - connection.serverNow() : 0;

  useEffect(() => {
    if (!cue || remaining <= 0) return;
    const timer = setTimeout(() => redraw((value) => value + 1), remaining);
    return () => clearTimeout(timer);
  }, [cue, remaining]);

  if (!cue || !item || remaining <= 0) return null;
  const elapsedSeconds = Math.max(0, (connection.serverNow() - cue.startedAt) / 1000);
  const src = connection.assetUrl(`/api/media/${encodeURIComponent(item.id)}/${encodeURIComponent(item.assetKey)}`);
  return <Cue key={cue.id} item={item} src={src} elapsedSeconds={elapsedSeconds} />;
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
