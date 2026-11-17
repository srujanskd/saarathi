import { useEffect, useRef, useState, type CSSProperties } from "react";
import { MEDIA_ID, type AlertPosition, type AlertTheme, type MediaItem, type MediaState, type PaidMessage } from "@saarathi/shared";
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

  const message = cue?.sample ?? (cue?.paidId ? state?.paid.find((candidate) => candidate.id === cue.paidId) : undefined);

  if (!cue || (!item && !message) || remaining <= 0) return null;
  const elapsedSeconds = Math.max(0, (connection.serverNow() - cue.startedAt) / 1000);
  return (
    <>
      {item ? <Cue key={cue.id} item={item} elapsedSeconds={elapsedSeconds}
        src={connection.assetUrl(`/api/media/${encodeURIComponent(item.id)}/${encodeURIComponent(item.assetKey)}`)} /> : null}
      {message && state ? <PaidAlert key={`alert-${cue.id}`} message={message} remainingMs={remaining}
        theme={state.alertTheme} position={state.alertPosition} /> : null}
    </>
  );
}

const ALERT_FADE_MS = 400;
/** The rung the shine starts at, and the one the burst does. */
const SHINE_FROM = 4;
const BURST_FROM = 6;
const SPARKS = 16;

/**
 * Evenly round the ellipse with a fixed wobble rather than at random, so a
 * reload draws the same burst rather than a new one. Worked out once: the
 * same sixteen for every alert.
 */
const SPARK_PATHS = Array.from({ length: SPARKS }, (_, index) => {
  const angle = (2 * Math.PI * index) / SPARKS + ((index % 3) - 1) * 0.12;
  return {
    "--cx": Math.cos(angle).toFixed(3),
    "--cy": Math.sin(angle).toFixed(3),
    // The bar points the way it flies.
    "--angle": `${Math.round((angle * 180) / Math.PI) + 90}deg`,
    "--reach": `${6 + (index % 4) * 2.5}vh`,
    "--spark-delay": `${(index % 5) * 40}ms`,
  } as CSSProperties;
});

/**
 * Who paid, how much, and what they said. Rendered from the queue entry, so a
 * browser source that OBS reloads mid-alert comes back to the same card with
 * the time it has left; the exit is scheduled off that, not off a timer here.
 *
 * The rung sets the size, the colour, how hard it lands and whether it shines
 * or bursts. Every one of those runs once, on transform and opacity, so a
 * reload mid-alert replays the entrance and nothing is left running after.
 */
function PaidAlert({ message, remainingMs, theme, position }: {
  message: PaidMessage;
  remainingMs: number;
  theme: AlertTheme;
  position: AlertPosition;
}) {
  const tier = message.tier ?? 1;
  const style = {
    "--alert-out": `${Math.max(0, remainingMs - ALERT_FADE_MS)}ms`,
    "--tier": tier,
  } as CSSProperties;
  return (
    <div className="paid-stage" data-position={position}>
      <div className="paid-alert-wrap" data-tier={message.tier ?? "none"} style={style}>
        <div className="paid-alert" data-theme={theme} data-testid="paid-alert">
          <p className="paid-alert-top">
            <span className="paid-alert-name">{message.name}</span>
            <span className="paid-alert-amount">{message.amount}</span>
          </p>
          {message.text ? <p className="paid-alert-text">{message.text}</p> : null}
          {tier >= SHINE_FROM ? <span className="paid-alert-shine" aria-hidden /> : null}
        </div>
        {tier >= BURST_FROM ? (
          <div className="paid-alert-burst" aria-hidden data-testid="paid-alert-burst">
            {SPARK_PATHS.map((spark, index) => <span key={index} style={spark} />)}
          </div>
        ) : null}
      </div>
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
