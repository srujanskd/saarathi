import type { GainsLedger, Logger } from "@saarathi/shared";
import type { StateStore } from "./store.js";

const NAMESPACE = "gains";

/**
 * The channel currency ledger. It is a core service rather than a module
 * because command specs declare a price and the trigger gate has to debit
 * before dispatch -- there is nowhere else that check can live.
 *
 * Deliberately only balances for now. Earning rules (per active minute, streak
 * bonuses) and the leaderboard overlay are Phase 3 and arrive as a module.
 */
export class Gains implements GainsLedger {
  private readonly balances = new Map<string, number>();

  constructor(
    private readonly store: StateStore,
    private readonly log: Logger,
  ) {
    const saved = store.read(NAMESPACE)?.balances;
    if (saved && typeof saved === "object") {
      for (const [user, amount] of Object.entries(saved as Record<string, unknown>)) {
        if (typeof amount === "number" && Number.isFinite(amount)) this.balances.set(user, amount);
      }
    }
  }

  balance(userId: string): number {
    return this.balances.get(userId) ?? 0;
  }

  grant(userId: string, amount: number, reason: string): number {
    if (amount <= 0) return this.balance(userId);
    const next = this.balance(userId) + amount;
    this.balances.set(userId, next);
    this.log.info(`gains: +${amount} to ${userId} (${reason})`);
    this.persist();
    return next;
  }

  spend(userId: string, amount: number, reason: string): boolean {
    if (amount <= 0) return true;
    const current = this.balance(userId);
    if (current < amount) return false;
    this.balances.set(userId, current - amount);
    this.log.info(`gains: -${amount} from ${userId} (${reason})`);
    this.persist();
    return true;
  }

  private persist(): void {
    this.store.write(NAMESPACE, { balances: Object.fromEntries(this.balances) });
  }
}
