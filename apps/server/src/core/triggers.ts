import type {
  Author,
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

/** "!spin" and "!spend 500 spin". Returns null for ordinary chat. */
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
  | { ok: true; via: TriggerVia; release(): void }
  | Exclude<InvokeResult, { ok: true }>;

/**
 * The single enforcement point for permission, cooldown and price. Charging
 * happens before dispatch rather than after, so two commands in the same tick
 * cannot both pass the check; a refusal downstream calls release() to undo it.
 *
 * A cooldown belongs to the command binding, not the action. That is why a paid
 * event or a deck button invoking the same action is not rate-limited by it --
 * she paid for it, or she pressed it herself.
 */
export class CommandGate {
  private readonly lastUsed = new Map<string, number>();

  constructor(private readonly gains: GainsLedger) {}

  consume(key: string, spec: CommandSpec, author: Author, now: number): GateResult {
    const decision = decideCommand({
      spec,
      author,
      now,
      lastUsedAt: this.lastUsed.get(key),
      balance: spec.cost ? this.gains.balance(author.id) : 0,
    });
    if (!decision.ok) return decision;

    const previous = this.lastUsed.get(key);
    if (spec.cooldownMs) this.lastUsed.set(key, now);

    let charged = false;
    if (spec.cost) {
      charged = this.gains.spend(author.id, spec.cost, `!${spec.name}`);
      if (!charged) {
        if (previous === undefined) this.lastUsed.delete(key);
        else this.lastUsed.set(key, previous);
        return { ok: false, reason: `Not enough ${GAINS.plural} for !${spec.name}` };
      }
    }

    return {
      ok: true,
      via: triggerVia(spec),
      release: () => {
        if (previous === undefined) this.lastUsed.delete(key);
        else this.lastUsed.set(key, previous);
        if (charged && spec.cost) this.gains.grant(author.id, spec.cost, `refund !${spec.name}`);
      },
    };
  }
}
