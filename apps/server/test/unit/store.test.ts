import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonStore, MemoryStore, defaultStorePath } from "../../src/core/store.js";
import { testLogger } from "../helpers/logger.js";

describe("MemoryStore", () => {
  it("round-trips a namespace and keeps them apart", () => {
    const store = new MemoryStore();
    expect(store.read("wheel")).toBeUndefined();
    store.write("wheel", { challenges: ["a"] });
    store.write("gains", { balances: { u1: 1 } });
    expect(store.read("wheel")).toEqual({ challenges: ["a"] });
    expect(store.read("gains")).toEqual({ balances: { u1: 1 } });
  });

  it("replaces a namespace wholesale, it does not merge", () => {
    const store = new MemoryStore();
    store.write("wheel", { challenges: ["a"], history: [1] });
    store.write("wheel", { challenges: ["b"] });
    expect(store.read("wheel")).toEqual({ challenges: ["b"] });
  });

  it("flush is a no-op it can survive", () => {
    expect(() => new MemoryStore().flush()).not.toThrow();
  });
});

describe("JsonStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "saarathi-store-"));
    file = join(dir, "nested", "state.json");
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const read = () => JSON.parse(readFileSync(file, "utf-8"));

  it("starts empty when the file is not there yet", () => {
    const store = new JsonStore(file, testLogger());
    expect(store.read("wheel")).toBeUndefined();
  });

  it("creates the directory on the way to writing", () => {
    const store = new JsonStore(file, testLogger());
    store.write("wheel", { challenges: ["a"] });
    store.flush();
    expect(read()).toEqual({ version: 1, namespaces: { wheel: { challenges: ["a"] } } });
  });

  it("reads back what a previous process wrote", () => {
    const first = new JsonStore(file, testLogger());
    first.write("wheel", { challenges: ["20 squats"] });
    first.flush();

    const second = new JsonStore(file, testLogger());
    expect(second.read("wheel")).toEqual({ challenges: ["20 squats"] });
  });

  it("debounces writes and flushes on demand", () => {
    vi.useFakeTimers();
    const store = new JsonStore(file, testLogger());
    store.write("wheel", { challenges: ["a"] });
    store.write("wheel", { challenges: ["b"] });
    expect(() => read()).toThrow();

    vi.advanceTimersByTime(500);
    expect(read().namespaces.wheel).toEqual({ challenges: ["b"] });
  });

  it("flush cancels the pending timer, so it does not write twice", () => {
    vi.useFakeTimers();
    const store = new JsonStore(file, testLogger());
    store.write("wheel", { challenges: ["a"] });
    store.flush();
    const spy = vi.spyOn(JSON, "stringify");
    vi.advanceTimersByTime(1_000);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("leaves no temp file behind", () => {
    const store = new JsonStore(file, testLogger());
    store.write("wheel", {});
    store.flush();
    expect(() => readFileSync(`${file}.tmp`)).toThrow();
  });

  // Her real state.json predates modules. Reading it is the whole reason the
  // migration exists, so this is the test that must not be deleted.
  it("migrates the pre-module layout instead of starting her over", () => {
    const flat = join(dir, "legacy.json");
    writeFileSync(
      flat,
      JSON.stringify({
        challenges: ["20 squats", "30s plank"],
        history: [{ label: "20 squats", by: "Viewer", via: "chat", at: 1 }],
      }),
    );
    const log = testLogger();
    const store = new JsonStore(flat, log);

    expect(store.read("wheel")).toEqual({
      challenges: ["20 squats", "30s plank"],
      history: [{ label: "20 squats", by: "Viewer", via: "chat", at: 1 }],
    });
    expect(log.text()).toContain("migrated");
  });

  it("migrates a half-filled old file without inventing the missing half", () => {
    const flat = join(dir, "half.json");
    writeFileSync(flat, JSON.stringify({ challenges: ["only these"] }));
    const store = new JsonStore(flat, testLogger());
    expect(store.read("wheel")).toEqual({ challenges: ["only these"] });
  });

  it("prefers the namespaced layout when both shapes are present", () => {
    const flat = join(dir, "both.json");
    writeFileSync(
      flat,
      JSON.stringify({ challenges: ["old"], namespaces: { wheel: { challenges: ["new"] } } }),
    );
    const store = new JsonStore(flat, testLogger());
    expect(store.read("wheel")).toEqual({ challenges: ["new"] });
  });

  it("starts fresh and warns on a corrupt file rather than crashing her stream", () => {
    const flat = join(dir, "corrupt.json");
    writeFileSync(flat, "{ this is not json");
    const log = testLogger();
    const store = new JsonStore(flat, log);
    expect(store.read("wheel")).toBeUndefined();
    expect(log.text()).toContain("could not read");
  });

  it("treats an unrecognised but valid file as empty", () => {
    const flat = join(dir, "odd.json");
    writeFileSync(flat, JSON.stringify({ something: "else" }));
    const store = new JsonStore(flat, testLogger());
    expect(store.read("wheel")).toBeUndefined();
  });

  it("logs rather than throws when the path cannot be written", () => {
    const log = testLogger();
    // A file where a directory has to be: mkdir fails, and so must not escape.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    const store = new JsonStore(join(blocker, "state.json"), log);
    expect(() => {
      store.write("wheel", {});
      store.flush();
    }).not.toThrow();
    expect(log.text()).toContain("could not write");
  });
});

describe("defaultStorePath", () => {
  it("sits under data/ relative to where the server was started", () => {
    expect(defaultStorePath()).toBe(join(process.cwd(), "data", "state.json"));
  });
});
