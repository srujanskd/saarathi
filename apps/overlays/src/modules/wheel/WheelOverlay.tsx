import { useEffect, useMemo, useRef, useState } from "react";
import { WHEEL_ID, type WheelState } from "@saarathi/shared";
import { useModuleState, type Connection } from "../../lib/connection.js";
import {
  CENTRE,
  HOLD_MS,
  HUB_RADIUS,
  RADIUS,
  TURNS,
  VIEWBOX,
  elapsedOf,
  labelFontSize,
  phaseOf,
  segments,
  targetRotation,
  wedgeColour,
  type Phase,
} from "./geometry.js";
import "./wheel.css";

/** Fast out of the gate, long settle. Nothing here animates anything but
 * `transform`, so the compositor does the whole spin without a repaint. */
const EASE = "cubic-bezier(0.12, 0.72, 0.16, 1)";

/** Shared so an idle overlay does not hand `useMemo` a new array every render. */
const NO_WHEEL: string[] = [];

export function WheelOverlay({ connection }: { connection: Connection }) {
  const state = useModuleState<WheelState>(connection, WHEEL_ID);
  const spin = state?.spin ?? null;

  // The spin carries the wheel it was drawn from, so nothing here reads the
  // current challenge list: she can save a new one mid-spin, and `spin.index`
  // only means anything against the list the server picked from. The fallback
  // is reachable by exactly one spin -- one persisted before this field
  // existed, which `spinBlockedFor` already treats as finished.
  const wheel = spin?.wheel ?? state?.challenges ?? NO_WHEEL;

  const wheelRef = useRef<HTMLDivElement>(null);
  const wedges = useMemo(() => segments(wheel), [wheel]);

  const key = spin ? `${spin.startedAt}:${spin.index}` : null;

  // Phase is worked out during the render the spin arrives on, not in an
  // effect afterwards. An effect would commit one frame of "hidden" first, and
  // "hidden" renders no wheel -- so the ref below would still be empty when
  // the animation effect ran, and the wheel would sit there not turning.
  const [phase, setPhase] = useState<Phase>(() => phaseOf(spin, connection.serverNow()));
  const [phaseKey, setPhaseKey] = useState(key);
  if (phaseKey !== key) {
    setPhaseKey(key);
    setPhase(phaseOf(spin, connection.serverNow()));
  }

  // Only the handovers between phases. Where it starts is decided above.
  // Deliberately keyed on the spin alone: re-running these timers because the
  // connection object was recreated would restart a hold that is already
  // partly spent. (react-hooks/exhaustive-deps would flag this.)
  useEffect(() => {
    if (!spin) return;
    const elapsed = elapsedOf(spin, connection.serverNow());
    const total = spin.durationMs + HOLD_MS;
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (elapsed < spin.durationMs) {
      timers.push(setTimeout(() => setPhase("landed"), spin.durationMs - elapsed));
    }
    if (elapsed < total) {
      timers.push(setTimeout(() => setPhase("hidden"), total - elapsed));
    }
    return () => timers.forEach(clearTimeout);
  }, [key]);

  // Same reasoning: the animation belongs to one spin, and `wheel` is fixed for
  // that spin's whole life, so the spin is the only honest dependency.
  // (react-hooks/exhaustive-deps would flag this too.)
  useEffect(() => {
    const element = wheelRef.current;
    if (!element || !spin || spin.wheel.length === 0) return;

    const to = targetRotation(spin.index, spin.wheel.length);
    const elapsed = elapsedOf(spin, connection.serverNow());

    // Connected after it landed -- an OBS source reloading, or her phone waking
    // up. There is nothing to animate; sit on the answer.
    if (elapsed >= spin.durationMs) {
      element.style.transform = `rotate(${to}deg)`;
      return;
    }

    element.style.transform = "";
    const animation = element.animate(
      [{ transform: `rotate(${to - TURNS * 360}deg)` }, { transform: `rotate(${to}deg)` }],
      { duration: spin.durationMs, easing: EASE, fill: "both" },
    );
    // Connected mid-spin: start the animation where the server already is.
    animation.currentTime = elapsed;
    // Hand the final angle to an inline style and drop the animation, so a
    // landed wheel is a static composited layer and not a filling animation
    // the browser keeps on its books for the rest of the stream.
    animation.onfinish = () => {
      element.style.transform = `rotate(${to}deg)`;
      animation.cancel();
    };

    return () => animation.cancel();
  }, [key]);

  if (!spin || phase === "hidden" || wedges.length === 0) {
    return <div className="stage" data-phase="hidden" data-testid="stage" />;
  }

  return (
    <div className="stage" data-phase={phase} data-testid="stage">
      <div className="wheel-frame">
        <div className="wheel" ref={wheelRef} data-testid="wheel">
          <svg viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`} aria-hidden="true">
            {wedges.map((wedge) => (
              <path
                key={`wedge-${wedge.index}`}
                d={wedge.path}
                fill={wedgeColour(wedge.index, wedges.length)}
                className="wedge"
                data-winner={wedge.index === spin.index}
              />
            ))}
            {wedges.map((wedge) => (
              <text
                key={`label-${wedge.index}`}
                className="wedge-label"
                data-winner={wedge.index === spin.index}
                x={wedge.labelX}
                y={0}
                fontSize={labelFontSize(wedges.length)}
                textAnchor={wedge.labelAnchor}
                dominantBaseline="middle"
                transform={wedge.labelTransform}
              >
                {wedge.label}
              </text>
            ))}
            <circle cx={CENTRE} cy={CENTRE} r={RADIUS} className="rim" />
            <circle cx={CENTRE} cy={CENTRE} r={HUB_RADIUS} className="hub" />
          </svg>
        </div>
        <div className="pointer" aria-hidden="true" />
      </div>

      <div className="result" data-testid="result">
        <p className="result-label">{spin.label}</p>
        <p className="result-by">{spin.by}</p>
      </div>
    </div>
  );
}
