import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { Server } from "socket.io";
import {
  SERVER_PORT,
  type InvokeRequest,
  type Logger,
  type MockChatInput,
} from "@saarathi/shared";
import type { ChatAdapter } from "./chat/adapter.js";
import { MockChatAdapter } from "./chat/mock.js";
import { YouTubeAdapter } from "./chat/youtube.js";
import { createKernel } from "./core/kernel.js";
import { obsConfigPath } from "./core/obs-config.js";
import { ObsWebSocketAdapter } from "./core/obs.js";
import { JsonStore, defaultStorePath } from "./core/store.js";
import { attachSync, type SaarathiServer } from "./core/sync.js";
import { chatlog } from "./modules/chatlog/index.js";
import { gains } from "./modules/gains/index.js";
import { goals } from "./modules/goals/index.js";
import { wheel } from "./modules/wheel/index.js";

/**
 * Composition root. The only file that reads process.env: it picks a store, an
 * OBS adapter and the chat adapters, hands them to the kernel, and serves the
 * built overlay pages if they exist. No decisions live here.
 */

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

const log: Logger = {
  info: (msg, extra) => (extra ? app.log.info({ extra }, msg) : app.log.info(msg)),
  warn: (msg, extra) => (extra ? app.log.warn({ extra }, msg) : app.log.warn(msg)),
  error: (msg, extra) => (extra ? app.log.error({ extra }, msg) : app.log.error(msg)),
};

const store = new JsonStore(process.env.STATE_FILE ?? defaultStorePath(), log);

// Mock chat is always on. Every chat-driven feature has to be drivable without
// a live stream, or nobody can test it.
const chat: ChatAdapter[] = [new MockChatAdapter()];

// Unconditional, unlike everything else here: she sets her channel and her API
// key up from her phone, and an adapter that only exists when an env var is set
// is an adapter she can never switch on. The three env vars are seeds for a dev
// run now, used only while she has saved nothing.
chat.push(
  new YouTubeAdapter({
    store,
    log,
    seed: {
      channelId: process.env.YT_CHANNEL_ID,
      liveId: process.env.YT_LIVE_ID,
      apiKey: process.env.YT_API_KEY,
    },
  }),
);

// OBS keeps its own WebSocket port and password in a file next to its config,
// and reading it is what spares her copying a generated password out of a
// dialog. It is a hint, never a requirement: OBS_CONFIG can point somewhere
// else or be blank to switch autodetect off entirely, which is what the tests
// do so no test run ever finds a real OBS on the machine running it.
const obsConfig =
  process.env.OBS_CONFIG ?? obsConfigPath(process.platform, process.env) ?? "";

const kernel = createKernel({
  modules: [wheel, goals, gains, chatlog],
  chat,
  store,
  obs: new ObsWebSocketAdapter({ store, log, configPath: obsConfig || null }),
  log,
});

// In production the server also serves the overlay and control pages, so OBS
// and her phone only ever need one address. The path is overridable because the
// Electron build will not put the pages two directories up from this file, and
// because a test needs to be able to prove both branches below.
const overlaysDist =
  process.env.OVERLAYS_DIST ?? join(import.meta.dirname, "../../overlays/dist");
if (existsSync(overlaysDist)) {
  const fastifyStatic = (await import("@fastify/static")).default;
  await app.register(fastifyStatic, { root: overlaysDist });
} else {
  app.get("/", async () => ({
    ok: true,
    hint: "Overlay pages are not built yet. Run `pnpm build`, or use the Vite dev server.",
  }));
}

app.get("/health", async () => ({ ok: true }));

/** The same snapshot a socket client gets, for eyeballing without a client. */
app.get("/api/state", async () => kernel.snapshot());

app.post("/api/mock-chat", async (request) => {
  kernel.sendMockChat(request.body as MockChatInput);
  return { ok: true };
});

app.post("/api/invoke", async (request) => {
  const { action, args } = request.body as InvokeRequest;
  // Explicit, not defaulted: this is the eyeballing path, and the socket is the
  // one that knows which surface it is. Anything reaching here is a person with
  // curl, so the history calls it what her control page does.
  return kernel.invoke(action, { args: args ?? [], via: "control" });
});

const io: SaarathiServer = new Server(app.server, { cors: { origin: true } });
attachSync(io, kernel, log);

await kernel.start();

// 0.0.0.0 so her phone on the same Wi-Fi can reach it, and so the same build
// runs unchanged on a VPS the day IRL mode happens. PORT exists so a test can
// boot a second server without fighting the one she has running; she never
// sets it, and the default is the only port anything documents.
await app.listen({ port: Number(process.env.PORT) || SERVER_PORT, host: "0.0.0.0" });

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void (async () => {
    await io.close();
    // kernel.stop flushes the store, so anything that skips this path loses
    // whatever the debounce was still holding.
    await kernel.stop();
    await app.close();
    process.exit(0);
  })();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);

// Windows has no signal worth the name: a parent that wants this process gone
// terminates it, and the pending write dies with it. So a parent that spawned
// us with an IPC channel -- the e2e harness today, the Electron tray tomorrow
// -- asks over that instead, and gets the same clean stop on every platform.
process.on("message", (message: unknown) => {
  if (typeof message === "object" && message !== null && "type" in message) {
    if ((message as { type?: unknown }).type === "shutdown") shutdown();
  }
});
