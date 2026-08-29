import type { Server } from "socket.io";
import {
  CORE_ID,
  type ClientToServerEvents,
  type Logger,
  type ServerToClientEvents,
  type TriggerVia,
} from "@saarathi/shared";
import type { Kernel } from "./kernel.js";

export type SaarathiServer = Server<ClientToServerEvents, ServerToClientEvents>;

const room = (moduleId: string) => `m:${moduleId}`;

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
export function attachSync(io: SaarathiServer, kernel: Kernel, log: Logger): void {
  kernel.onPatch((module, state) => {
    if (module === CORE_ID) io.emit("patch", { module, state });
    else io.to(room(module)).emit("patch", { module, state });
  });

  kernel.onEffect((effect) => {
    if (effect.module === CORE_ID) io.emit("effect", effect);
    else io.to(room(effect.module)).emit("effect", effect);
  });

  io.on("connection", (socket) => {
    // Subscribe to everything until told otherwise, so a client that never
    // sends hello still works.
    for (const id of kernel.registry.ids()) void socket.join(room(id));
    socket.emit("snapshot", kernel.snapshot());

    // Which of her surfaces this is. It changes nothing about what is allowed
    // -- every one of them is her -- it only makes the wheel's history say
    // where a spin came from, which is the difference between "she spun it"
    // and "her deck spun it" when she reads it back.
    let via: TriggerVia = "control";

    socket.on("hello", (hello) => {
      const wanted = hello?.modules;
      for (const id of kernel.registry.ids()) {
        const subscribe = !wanted || wanted.includes(id);
        void (subscribe ? socket.join(room(id)) : socket.leave(room(id)));
      }
      via = hello?.surface === "deck" ? "deck" : "control";
      // Overlays in OBS should not be paying to receive the chat log they never
      // render, and neither should her phone on mobile data.
      socket.emit("snapshot", kernel.snapshot(wanted));
      log.info(`client connected: ${hello?.surface ?? "unknown"} [${wanted?.join(", ") ?? "all"}]`);
    });

    socket.on("invoke", (request, ack) => {
      void kernel
        .invoke(request.action, { args: request.args ?? [], via })
        .then((result) => ack?.(result))
        .catch((err) => {
          log.error(`invoke ${request?.action} threw`, err);
          ack?.({ ok: false, reason: "That did not work. Check the log." });
        });
    });

    socket.on("mockChat", (input) => kernel.sendMockChat(input));
  });
}
