import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_QUEUE, SPIN_COST, SPIN_DURATION_MS, type ChatLogState } from "@saarathi/shared";
import { REPLY_WINDOW_MS } from "../../src/core/writes.js";
import { gains } from "../../src/modules/gains/index.js";
import { wheel } from "../../src/modules/wheel/index.js";
import { chatlog } from "../../src/modules/chatlog/index.js";
import { SETTLE_MS } from "../../src/modules/wheel/rules.js";
import { harness, wheelState, type Harness } from "../helpers/kernel.js";

let live: Harness;
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await live?.stop();
  vi.useRealTimers();
});

const replies = () => (live.kernel.snapshot().modules.chatlog as ChatLogState).events
  .filter((event) => event.author.name === "Saarathi").map((event) => event.text).reverse();

async function start() {
  live = await harness({ modules: [wheel, gains, chatlog], balances: { "@Asha": SPIN_COST } });
  await live.kernel.invoke("wheel.setChallenges", { args: ["20 squats"] });
}

describe("chat mentions", () => {
  it.each(["Asha", "@Asha"])("uses one @ for balance and cooldown replies to %s", async (author) => {
    await start();
    live.chat({ author, text: "!points" });
    live.chat({ author, text: "!points" });
    await vi.advanceTimersByTimeAsync(REPLY_WINDOW_MS);
    expect(replies()).toHaveLength(2);
    expect(replies().some((line) => line.startsWith("@Asha you have"))).toBe(true);
    expect(replies().some((line) => line.startsWith("@Asha !points is cooling down"))).toBe(true);
  });

  it("uses one @ when the action refuses a bought spin", async () => {
    await start();
    await live.kernel.invoke("wheel.spin");
    for (let i = 0; i < MAX_QUEUE; i++) live.chat({ author: `Tipper${i}`, text: "tip", type: "superchat" });
    await vi.advanceTimersByTimeAsync(0);
    live.chat({ author: "@Asha", text: "!spin" });
    await vi.advanceTimersByTimeAsync(REPLY_WINDOW_MS);
    expect(replies()).toEqual(["@Asha The wheel is still spinning, and the queue is full"]);
  });
});

describe("wheel results in chat", () => {
  it.each(["points", "paid", "control", "deck"])("announces a %s spin only after it lands", async (trigger) => {
    await start();
    if (trigger === "points") live.chat({ author: "@Asha", text: "!spin" });
    else if (trigger === "paid") live.chat({ author: "@Asha", text: "tip", type: "superchat" });
    else await live.kernel.invoke("wheel.spin", { by: "Streamer", via: trigger === "deck" ? "deck" : "control" });
    await vi.advanceTimersByTimeAsync(0);
    const spin = wheelState(live.kernel).spin!;
    expect(spin).not.toBeNull();
    await vi.advanceTimersByTimeAsync(spin.durationMs - 1);
    expect(live.seen.said()).toEqual([]);
    expect(replies()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const expected = `Wheel result for ${spin.by}: 20 squats`;
    expect(live.seen.said()).toEqual([expected]);
    await vi.advanceTimersByTimeAsync(REPLY_WINDOW_MS);
    expect(replies()).toEqual([expected]);
    await vi.advanceTimersByTimeAsync(SPIN_DURATION_MS * 2);
    expect(replies()).toEqual([expected]);
  });

  it("announces queued spins in order using the challenge each spin drew", async () => {
    await start();
    live.chat({ author: "@Asha", text: "!spin" });
    live.chat({ author: "Bo", text: "tip", type: "superchat" });
    await vi.advanceTimersByTimeAsync(0);
    await live.kernel.invoke("wheel.setChallenges", { args: ["30s plank"] });
    await vi.advanceTimersByTimeAsync(SPIN_DURATION_MS * 2 + SETTLE_MS + REPLY_WINDOW_MS);
    expect(replies()).toEqual(["Wheel result for @Asha: 20 squats", "Wheel result for Bo: 30s plank"]);
  });

  it("does not announce a cleared spin or let its timer announce its replacement early", async () => {
    await start();
    await live.kernel.invoke("wheel.spin", { by: "First" });
    await vi.advanceTimersByTimeAsync(1_000);
    await live.kernel.invoke("wheel.cancel");
    await live.kernel.invoke("wheel.spin", { by: "Second" });
    await vi.advanceTimersByTimeAsync(SPIN_DURATION_MS - 1);
    expect(live.seen.said()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 + REPLY_WINDOW_MS);
    expect(replies()).toEqual(["Wheel result for Second: 20 squats"]);
  });

  it("does not announce a spin cleared before it finishes", async () => {
    await start();
    await live.kernel.invoke("wheel.spin");
    await vi.advanceTimersByTimeAsync(SPIN_DURATION_MS - 1);
    await live.kernel.invoke("wheel.cancel");
    await vi.advanceTimersByTimeAsync(1 + REPLY_WINDOW_MS);
    expect(live.seen.said()).toEqual([]);
    expect(replies()).toEqual([]);
  });

  it("does not replay an interrupted spin after a restart", async () => {
    await start();
    await live.kernel.invoke("wheel.spin");
    const store = live.store;
    await live.stop();
    live = await harness({ store });
    await vi.advanceTimersByTimeAsync(SPIN_DURATION_MS + REPLY_WINDOW_MS);
    expect(replies()).toEqual([]);
  });
});
