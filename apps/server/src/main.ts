import { createReadStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import { Server } from "socket.io";
import {
  SERVER_PORT,
  MAX_MEDIA_BYTES,
  MEDIA_TYPES,
  type InvokeRequest,
  type Logger,
  type MockChatInput,
} from "@saarathi/shared";
import type { ChatAdapter } from "./chat/adapter.js";
import { MockChatAdapter } from "./chat/mock.js";
import { oauthClient } from "./chat/youtube-oauth.js";
import { YouTubeAdapter } from "./chat/youtube.js";
import { createKernel } from "./core/kernel.js";
import { Access, isLoopback, isLoopbackHost, isLoopbackOrigin } from "./core/access.js";
import { obsConfigPath } from "./core/obs-config.js";
import { ObsWebSocketAdapter } from "./core/obs.js";
import { JsonStore, defaultStorePath } from "./core/store.js";
import { attachSync, type SaarathiServer } from "./core/sync.js";
import { chatlog } from "./modules/chatlog/index.js";
import { gains } from "./modules/gains/index.js";
import { goals } from "./modules/goals/index.js";
import { moderation } from "./modules/moderation/index.js";
import { createMedia } from "./modules/media/index.js";
import { DiskMediaFiles } from "./modules/media/files.js";
import { wheel } from "./modules/wheel/index.js";

/**
 * Composition root. The only file that reads process.env: it picks a store, an
 * OBS adapter and the chat adapters, hands them to the kernel, and serves the
 * built overlay pages if they exist. No decisions live here.
 */

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

app.addContentTypeParser(
  Object.keys(MEDIA_TYPES),
  { parseAs: "buffer", bodyLimit: MAX_MEDIA_BYTES },
  (_request, body, done) => done(null, body),
);

const log: Logger = {
  info: (msg, extra) => (extra ? app.log.info({ extra }, msg) : app.log.info(msg)),
  warn: (msg, extra) => (extra ? app.log.warn({ extra }, msg) : app.log.warn(msg)),
  error: (msg, extra) => (extra ? app.log.error({ extra }, msg) : app.log.error(msg)),
};

const stateFile = process.env.STATE_FILE ?? defaultStorePath();
const store = new JsonStore(stateFile, log);
const access = new Access({ store });
const media = createMedia({ files: new DiskMediaFiles(join(dirname(stateFile), "media")) });

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
    // The app's own OAuth credential, compiled in and overridable from the
    // environment for a dev run. Read here because this is the only file that
    // reads the environment, and null in a build with none -- which reports
    // that it has no sign-in rather than failing a call that could not work.
    client: oauthClient(),
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
  modules: [wheel, goals, gains, moderation, chatlog, media.module],
  chat,
  store,
  obs: new ObsWebSocketAdapter({
    store,
    log,
    configPath: obsConfig || null,
    overlayToken: () => access.local().overlayToken,
  }),
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

// Static pages are public. What they can read or do is not. The local route is
// the bootstrapping seam for the tray, its floating deck and a browser on the
// server machine; no LAN client can use it and it deliberately sends no CORS
// header a hostile web page could use to read a loopback response.
app.get("/api/access/local", async (request, reply) => {
  if (!isLoopback(request.ip) || !isLoopbackHost(request.headers.host)) {
    return reply.code(403).send({ reason: "Only this PC can do that" });
  }
  // Vite serves the dev page on another local port. A literal loopback origin
  // may read this so `pnpm dev` still works; a LAN or DNS-rebound origin may
  // send the GET but the browser cannot read the capability it returns.
  const origin = request.headers.origin;
  if (origin && isLoopbackOrigin(origin)) {
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Vary", "Origin");
  }
  const query = request.query as { pairing?: unknown };
  if (query.pairing === "fresh") return access.localPairing(true);
  return query.pairing === "1" ? access.localPairing() : access.local();
});

const allowApiOrigin = (origin: string | undefined, reply: { header(name: string, value: string): unknown }) => {
  if (origin) reply.header("Access-Control-Allow-Origin", origin);
  reply.header("Vary", "Origin");
};

// Runs before body parsing, so a file rejected by the size limit still gives a
// separately hosted control page a readable HTTP error instead of looking like
// a network failure. The loopback bootstrap route is deliberately excluded.
app.addHook("onRequest", async (request, reply) => {
  const path = request.url.split("?", 1)[0];
  if (path?.startsWith("/api/media") || path === "/api/overlays" || path === "/api/access/pair" || path === "/api/access/reset") {
    allowApiOrigin(request.headers.origin, reply);
  }
});

app.options("/api/access/*", async (request, reply) => {
  allowApiOrigin(request.headers.origin, reply);
  reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  return reply.code(204).send();
});

for (const path of ["/api/media", "/api/media/*"]) {
  app.options(path, async (request, reply) => {
    allowApiOrigin(request.headers.origin, reply);
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    reply.header("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS");
    return reply.code(204).send();
  });
}

app.post("/api/access/pair", async (request, reply) => {
  allowApiOrigin(request.headers.origin, reply);
  const body = request.body as { code?: unknown } | null;
  const result = access.pair(body?.code, request.ip);
  if (!result.ok) return reply.code(result.limited ? 429 : 401).send({ reason: result.reason });
  return result.access;
});

app.post("/api/media", async (request, reply) => {
  allowApiOrigin(request.headers.origin, reply);
  if (!allows(request.headers.authorization, "control")) {
    return reply.code(401).send({ reason: "Pair this device with Saarathi" });
  }
  if (!Buffer.isBuffer(request.body)) {
    return reply.code(415).send({ reason: "Choose a supported media file" });
  }
  const query = request.query as Record<string, unknown>;
  const result = media.add({
    label: query.label,
    mime: request.headers["content-type"]?.split(";", 1)[0],
    volume: query.volume,
    data: request.body,
  });
  if (!result.ok) return reply.code(400).send({ reason: result.reason });
  return reply.code(201).send({ ok: true, item: result.value });
});

app.delete("/api/media/:id", async (request, reply) => {
  allowApiOrigin(request.headers.origin, reply);
  if (!allows(request.headers.authorization, "control")) {
    return reply.code(401).send({ reason: "Pair this device with Saarathi" });
  }
  const result = media.remove((request.params as { id: string }).id);
  if (!result.ok) return reply.code(404).send({ reason: result.reason });
  return { ok: true };
});

app.get("/api/media/:id/:key", async (request, reply) => {
  const { id, key } = request.params as { id: string; key: string };
  const asset = media.asset(id, key);
  if (!asset) return reply.code(404).send({ reason: "That clip is gone" });
  reply.header("Accept-Ranges", "bytes");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.type(asset.item.mime);

  const range = request.headers.range;
  if (!range) {
    reply.header("Content-Length", asset.item.bytes);
    return reply.send(createReadStream(asset.path));
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) return reply.code(416).header("Content-Range", `bytes */${asset.item.bytes}`).send();
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), asset.item.bytes - 1) : asset.item.bytes - 1;
  if (start >= asset.item.bytes || end < start) {
    return reply.code(416).header("Content-Range", `bytes */${asset.item.bytes}`).send();
  }
  reply.code(206);
  reply.header("Content-Range", `bytes ${start}-${end}/${asset.item.bytes}`);
  reply.header("Content-Length", end - start + 1);
  return reply.send(createReadStream(asset.path, { start, end }));
});

app.options("/api/overlays", async (request, reply) => {
  allowApiOrigin(request.headers.origin, reply);
  reply.header("Access-Control-Allow-Headers", "Authorization");
  reply.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  return reply.code(204).send();
});

app.get("/api/overlays", async (request, reply) => {
  allowApiOrigin(request.headers.origin, reply);
  if (!accessLevel(request.headers.authorization)) {
    return reply.code(401).send({ reason: "Pair this device with Saarathi" });
  }
  return {
    overlays: kernel.registry.statuses()
      .filter((module) => module.overlay)
      .map(({ id, title }) => ({ id, title })),
  };
});

/** The same snapshot a socket client gets, for eyeballing without a client. */
app.get("/api/state", async (request, reply) => {
  const level = accessLevel(request.headers.authorization);
  if (!level) {
    return reply.code(401).send({ reason: "Pair this device with Saarathi" });
  }
  return kernel.snapshot(
    level === "read" ? kernel.registry.overlayIds() : undefined,
    level,
  );
});

app.post("/api/mock-chat", async (request, reply) => {
  if (!allows(request.headers.authorization, "control")) {
    return reply.code(401).send({ reason: "Pair this device with Saarathi" });
  }
  kernel.sendMockChat(request.body as MockChatInput);
  return { ok: true };
});

app.post("/api/invoke", async (request, reply) => {
  if (!allows(request.headers.authorization, "control")) {
    return reply.code(401).send({ reason: "Pair this device with Saarathi" });
  }
  const { action, args } = request.body as InvokeRequest;
  // Explicit, not defaulted: this is the eyeballing path, and the socket is the
  // one that knows which surface it is. Anything reaching here is a person with
  // curl, so the history calls it what her control page does.
  return kernel.invoke(action, { args: args ?? [], via: "control" });
});

const io: SaarathiServer = new Server(app.server, { cors: { origin: true } });
attachSync(io, kernel, log, access);

app.post("/api/access/reset", async (request, reply) => {
  allowApiOrigin(request.headers.origin, reply);
  if (!allows(request.headers.authorization, "control")) {
    return reply.code(401).send({ reason: "Pair this device with Saarathi" });
  }
  access.rotate();
  // Let the HTTP answer reach the device that asked before invalidating every
  // open socket, including that device. Reconnect now needs the new grant.
  setImmediate(() => io.disconnectSockets(true));
  return { ok: true };
});

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

function allows(header: string | undefined, need: "read" | "control"): boolean {
  const level = accessLevel(header);
  return level === "control" || (need === "read" && level === "read");
}

function accessLevel(header: string | undefined) {
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  return access.level(token);
}
