import type { CardProps } from "./types.js";

/**
 * Every module's card until it has one of its own: its title, and a button per
 * action the server says it accepts. A new game is usable on her phone the
 * moment the server declares it, which is what keeps the module contract the
 * thing you extend rather than this file.
 */
export function GenericCard({ connection, status }: CardProps) {
  return (
    <section className="card">
      <h2>{status.title}</h2>
      {status.actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className="btn"
          onClick={() => void connection.invoke({ action: action.id })}
        >
          {action.label}
        </button>
      ))}
    </section>
  );
}
