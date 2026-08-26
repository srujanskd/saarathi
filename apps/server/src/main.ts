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
import { nullObs } from "./core/obs.js";
import { JsonStore, defaultStorePath } from "./core/store.js";
import { attachSync, type SaarathiServer } from "./core/sync.js";
import { chatlog } from "./modules/chatlog/index.js";
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

const channelId = process.env.YT_CHANNEL_ID;
const liveId = process.env.YT_LIVE_ID;
if (channelId || liveId) {
  chat.push(new YouTubeAdapter({ channelId, liveId }));
} else {
  log.info("No YT_CHANNEL_ID or YT_LIVE_ID set — running on mock chat only");
}

const kernel = createKernel({
  modules: [wheel, chatlog],
  chat,
  store,
  obs: nullObs(log),
  log,
});

// In production the server also serves the overlay pages, so OBS and her phone
// only ever need one address.
const overlaysDist = join(import.meta.dirname, "../../overlays/dist");
if (existsSync(overlaysDist)) {
  const fastifyStatic = (await import("@fastify/static")).default;
  await app.register(fastifyStatic, { root: overlaysDist });
} else {
  app.get("/", async () => ({
    ok: true,
    hint: "Overlay pages are not built yet. Run `npm run build`, or use the Vite dev server.",
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
  return kernel.invoke(action, { args: args ?? [] });
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
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await io.close();
      await kernel.stop();
      await app.close();
      process.exit(0);
    })();
  });
}
