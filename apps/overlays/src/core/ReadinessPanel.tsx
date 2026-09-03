import type { CoreState } from "@saarathi/shared";
import { streamReadiness } from "./readiness.js";

export function ReadinessPanel({ core }: { core: CoreState }) {
  const readiness = streamReadiness(core);

  return (
    <section
      className="readiness"
      data-ready={readiness.ready}
      data-testid="readiness"
      aria-labelledby="readiness-heading"
    >
      <div className="readiness-head">
        <div>
          <p className="kicker">Stream check</p>
          <h2 id="readiness-heading">{readiness.headline}</h2>
        </div>
        <span className="readiness-mark" aria-hidden="true">
          {readiness.ready ? "OK" : readiness.checks.filter((check) => check.state === "fix").length}
        </span>
      </div>

      <ul className="readiness-list">
        {readiness.checks.map((check) => (
          <li key={check.id} data-state={check.state} data-testid={`readiness-${check.id}`}>
            <span className="readiness-dot" aria-hidden="true" />
            <div>
              <strong>{check.title}</strong>
              <p>{check.detail}</p>
            </div>
            {check.state !== "ready" && check.fixAt ? (
              <a className="readiness-fix" href={check.fixAt}>
                Fix
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
