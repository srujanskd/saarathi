import type {
  Author,
  Charge,
  CommandSpec,
  GainsLedger,
  InvokeResult,
  TriggerVia,
} from "@saarathi/shared";
import { GAINS } from "@saarathi/shared";

/**
 * Thrown by ctx.refuse(). The kernel turns it into a refusal the control page
 * can show, and releases whatever the gate charged for the trigger.
 */
export class ActionRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ActionRefused";
  }
}

export interface ParsedCommand {
  command: string;
  args: string[];
}

/** "!spin" and "!challenges burpees". Returns null for ordinary chat. */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("!") || trimmed.length < 2) return null;
  const [command, ...args] = trimmed.slice(1).split(/\s+/);
  if (!command) return null;
  return { command: command.toLowerCase(), args };
}

function permitted(allow: CommandSpec["allow"], author: Author): boolean {
  switch (allow ?? "everyone") {
    case "streamer":
      return Boolean(author.isStreamer);
    case "mods":
      return Boolean(author.isMod || author.isStreamer);
    case "members":
      return Boolean(author.isMember || author.isMod || author.isStreamer);
    default:
      return true;
  }
}

/**
 * Whether a command may run. Pure, so the rules that decide who gets to spend
 * what and how often are testable without a socket, a clock or a ledger.
 */
export function decideCommand(params: {
  spec: CommandSpec;
  author: Author;
  now: number;
  lastUsedAt: number | undefined;
  balance: number;
}): InvokeResult {
  const { spec, author, now, lastUsedAt, balance } = params;

  if (!permitted(spec.allow, author)) {
    return { ok: false, reason: `!${spec.name} is for ${spec.allow} only` };
  }

  if (spec.cooldownMs && lastUsedAt !== undefined) {
    const readyAt = lastUsedAt + spec.cooldownMs;
    if (now < readyAt) {
      const retryInMs = readyAt - now;
      return {
        ok: false,
        reason: `!${spec.name} is cooling down for another ${Math.ceil(retryInMs / 1000)}s`,
        retryInMs,
      };
    }
  }

  if (spec.cost && balance < spec.cost) {
    return {
      ok: false,
      reason: `!${spec.name} costs ${spec.cost} ${GAINS.plural}; you have ${balance}`,
    };
  }

  return { ok: true };
}

/**
 * Which trigger a chat command turns into once it has been paid for.
 *
 * A priced command is not "chat" downstream. The viewer spent something, and
 * modules owe a paid trigger more than a free one -- the wheel makes one wait
 * its turn behind a busy spin rather than turning it away, because gains taken
 * for a spin that never happened is the one failure here that costs somebody
 * something real. Provenance is the gate's to report because the gate is what
 * took the payment.
 */
export function triggerVia(spec: CommandSpec): TriggerVia {
  return spec.cost ? "gains" : "chat";
}

export type GateResult =
  | {
      ok: true;
      via: TriggerVia;
      /**
       * What was actually taken, for a module that accepts the trigger and then
       * holds it. `release` covers the ordinary case -- the action refuses and
       * the core undoes the charge itself -- but a module that queues a paid
       * trigger has said yes, so nothing will be released and the refund
       * becomes its own. Absent when nothing was charged.
       */
      charge?: Charge;
      release(): void;
    }
  | Exclude<InvokeResult, { ok: true }>;

/** One remembered stamp per viewer per binding. */
interface Stamp {
  /** When the command ran, which is what the cooldown is measured from. */
  at: number;
  /** And when it stops refusing, which is what makes a stamp sweepable. */
  readyAt: number;
}

/**
 * How many stamps may accumulate before expired ones are swept.
 *
 * A cooldown is per viewer, so the gate remembers one entry per viewer per
 * binding and a long stream would otherwise grow it forever. The sweep is
 * amortized onto the next stamp rather than timed, because a gate that owned a
 * clock would be a gate that has to be started and stopped.
 */
const SWEEP_ABOVE = 500;

/**
 * The single enforcement point for permission, cooldown and price. Charging
 * happens before dispatch rather than after, so two commands in the same tick
 * cannot both pass the check; a refusal downstream calls release() to undo it.
 *
 * A cooldown belongs to one viewer on one binding, not to the binding alone: a
 * balance is per viewer, and so is patience. Keying it per binding meant the
 * first person to type !gains locked the whole chat out of it, which is the
 * same insight !spin already acted on when it replaced its cooldown with a
 * price. A paid event or a deck button invoking the same action is still not
 * rate-limited at all -- she paid for it, or she pressed it herself.
 */
export class CommandGate {
  private readonly lastUsed = new Map<string, Stamp>();

  constructor(private readonly gains: GainsLedger) {}

  consume(key: string, spec: CommandSpec, author: Author, now: number): GateResult {
    // The binding and the viewer both, because one viewer's cooldown is not
    // anybody else's. A null byte cannot occur in either half.
    const seat = `${key}\u0000${author.id}`;
    const previous = this.lastUsed.get(seat);

    const decision = decideCommand({
      spec,
      author,
      now,
      lastUsedAt: previous?.at,
      balance: spec.cost ? this.gains.balance(author.id) : 0,
    });
    if (!decision.ok) return decision;

    const restore = () => {
      if (previous === undefined) this.lastUsed.delete(seat);
      else this.lastUsed.set(seat, previous);
    };

    if (spec.cooldownMs) {
      if (this.lastUsed.size > SWEEP_ABOVE) this.sweep(now);
      this.lastUsed.set(seat, { at: now, readyAt: now + spec.cooldownMs });
    }

    let charged = false;
    if (spec.cost) {
      charged = this.gains.spend(author.id, spec.cost, `!${spec.name}`);
      if (!charged) {
        restore();
        return { ok: false, reason: `Not enough ${GAINS.plural} for !${spec.name}` };
      }
    }

    return {
      ok: true,
      via: triggerVia(spec),
      charge: charged && spec.cost ? { userId: author.id, amount: spec.cost } : undefined,
      release: () => {
        restore();
        if (charged && spec.cost) this.gains.grant(author.id, spec.cost, `refund !${spec.name}`);
      },
    };
  }

  /**
   * How many stamps are being held. Here so the sweep is testable: it is
   * invisible by design otherwise, and a rate limiter that quietly grows for
   * the length of a stream is exactly the bug nobody notices.
   */
  get remembered(): number {
    return this.lastUsed.size;
  }

  /** A stamp that has stopped refusing cannot refuse again, so it is dropped. */
  private sweep(now: number): void {
    for (const [seat, stamp] of this.lastUsed) {
      if (stamp.readyAt <= now) this.lastUsed.delete(seat);
    }
  }
}
