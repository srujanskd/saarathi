import type { Server } from "socket.io";
import {
  CORE_ID,
  type AccessLevel,
  type ClientToServerEvents,
  type Logger,
  type ServerToClientEvents,
  type Surface,
  type TriggerVia,
} from "@saarathi/shared";
import type { Kernel } from "./kernel.js";

export type SaarathiServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  { access: AccessLevel }
>;

export interface AccessGate {
  level(token: unknown): AccessLevel | null;
}

const room = (moduleId: string) => `m:${moduleId}`;
const CONTROL_ROOM = "access:control";

/**
 * Which of her surfaces this is. It changes nothing about what is allowed --
 * every one of them is her -- it only makes the wheel's history say where a
 * spin came from, which is the difference between "she spun it" and "her deck
 * spun it" when she reads it back.
 *
 * Spelled out one surface at a time rather than defaulted, so the day a fourth
 * one lands the compiler asks what it is instead of the history calling it the
 * control page.
 */
const VIA_FOR: Record<Surface, TriggerVia> = {
  overlay: "overlay",
  control: "control",
  deck: "deck",
  // Not a page. The tray shell connects as a client so a global shortcut goes
  // through this same invoke, and the history says which of her two decks it
  // was.
  hotkey: "hotkey",
};

/**
 * The only file that imports socket.io.
 *
 * The server is authoritative: a client gets a full snapshot the moment it
 * connects, so an OBS browser source reloading mid-stream or a phone waking up
 * lands in the right state without anyone replaying events at it.
 *
 * Adding a module adds no events here. If you find yourself wanting one, the
 * state you are reaching for probably belongs in a module slice.
 */
export function attachSync(io: SaarathiServer, kernel: Kernel, log: Logger, access: AccessGate): void {
  io.use((socket, next) => {
    const level = access.level(socket.handshake.auth?.token);
    if (!level) return next(new Error("Pair this device with Saarathi"));
    socket.data.access = level;
    next();
  });

  kernel.onPatch((module, state) => {
    if (module === CORE_ID) io.to(CONTROL_ROOM).emit("patch", { module, state });
    else io.to(room(module)).emit("patch", { module, state });
  });

  kernel.onEffect((effect) => {
    // Core effects include bot replies. An OBS URL has no reason to receive
    // them, even though its read capability is allowed to see core status.
    if (effect.module === CORE_ID) io.to(CONTROL_ROOM).emit("effect", effect);
    else io.to(room(effect.module)).emit("effect", effect);
  });

  io.on("connection", (socket) => {
    const canControl = socket.data.access === "control";
    if (canControl) {
      void socket.join(CONTROL_ROOM);
      // Backwards-compatible for local tools that authenticate but never say
      // hello. A read token gets nothing until it identifies as an overlay.
      for (const id of kernel.registry.ids()) void socket.join(room(id));
      socket.emit("snapshot", kernel.snapshot());
    } else {
      // Enough to establish the server clock and connection, no module slice
      // until hello proves this is an overlay and asks for an allowed one.
      socket.emit("snapshot", kernel.snapshot([], "read"));
    }

    // Until hello says otherwise. A client that never sends one is her control
    // page in every case we have.
    let via: TriggerVia = "control";

    socket.on("hello", (hello) => {
      if (!canControl && hello?.surface !== "overlay") {
        socket.disconnect(true);
        return;
      }

      const allowed = canControl ? kernel.registry.ids() : kernel.registry.overlayIds();
      const requested = hello?.modules;
      const wanted = requested
        ? requested.filter((id) => allowed.includes(id))
        : allowed;
      for (const id of kernel.registry.ids()) {
        const subscribe = wanted.includes(id);
        void (subscribe ? socket.join(room(id)) : socket.leave(room(id)));
      }
      via = canControl
        ? (hello?.surface && VIA_FOR[hello.surface]) ?? "control"
        : "overlay";
      // Overlays in OBS should not be paying to receive the chat log they never
      // render, and neither should her phone on mobile data.
      socket.emit("snapshot", kernel.snapshot(wanted, canControl ? "control" : "read"));
      log.info(`client connected: ${hello?.surface ?? "unknown"} [${wanted?.join(", ") ?? "all"}]`);
    });

    socket.on("invoke", (request, ack) => {
      if (!canControl) {
        ack?.({ ok: false, reason: "This link can only show overlays" });
        return;
      }
      void kernel
        .invoke(request.action, { args: request.args ?? [], via })
        .then((result) => ack?.(result))
        .catch((err) => {
          log.error(`invoke ${request?.action} threw`, err);
          ack?.({ ok: false, reason: "That did not work. Check the log." });
        });
    });

    socket.on("mockChat", (input) => {
      if (canControl) kernel.sendMockChat(input);
    });
  });
}
