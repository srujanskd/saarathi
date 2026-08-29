import { io, type Socket } from "socket.io-client";
import {
  CORE_ID,
  type ClientToServerEvents,
  type CoreState,
  type InvokeResult,
  type ServerToClientEvents,
} from "@saarathi/shared";

/**
 * The tray, as a client of its own server.
 *
 * A global hotkey has to reach an action, and the only way into an action is
 * `invoke`. The shell could have imported the kernel and called it directly --
 * it is the parent process, after all -- but the server is a child precisely
 * so that it can crash without taking the tray with it, and a second code path
 * into an action is the thing the module contract exists to prevent. So the
 * shell connects over the socket like her phone does, and a hotkey and a
 * finger arrive at the same line of the same file.
 *
 * It subscribes to no modules. The grid is core state, and a shell that
 * renders nothing has no business receiving a wheel.
 */

export interface ServerClientOptions {
  readonly port: number;
  /** The grid changed, or the first snapshot arrived. */
  onCore(core: CoreState): void;
  /** Connected or not, for the log. Nothing in the menu reads this: the
   * server's own phase already says whether it is up, and two lines that
   * disagree about it would be worse than one. */
  onState(connected: boolean): void;
  log(line: string): void;
}

export class ServerClient {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

  constructor(private readonly options: ServerClientOptions) {}

  start(): void {
    if (this.socket) return;
    // 127.0.0.1 and not the LAN address: this client is inside the machine the
    // server runs on, by definition. It is the one place in the product where
    // naming the loopback is not the rule-3 mistake, because there is no
    // configuration under which the tray and its own child are apart.
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
      `http://127.0.0.1:${this.options.port}`,
      {
        transports: ["websocket"],
        // The server is a child we restart from a menu item, so the gap
        // between "gone" and "back" is normal rather than exceptional.
        reconnectionDelay: 500,
        reconnectionDelayMax: 5_000,
      },
    );
    this.socket = socket;

    socket.on("connect", () => {
      socket.emit("hello", { surface: "hotkey", modules: [] });
      this.options.onState(true);
      this.options.log("[tray] hotkeys connected\n");
    });
    socket.on("disconnect", () => this.options.onState(false));
    socket.on("snapshot", (snapshot) => this.options.onCore(snapshot.core));
    socket.on("patch", (patch) => {
      if (patch.module === CORE_ID) this.options.onCore(patch.state as CoreState);
    });
  }

  /**
   * Press a button. The refusal is logged and goes nowhere else: a hotkey has
   * no screen, and the alternative -- a desktop notification for every
   * cooldown -- is a popup over her stream.
   */
  invoke(action: string, args: string[]): void {
    const socket = this.socket;
    if (!socket?.connected) {
      this.options.log(`[tray] hotkey ${action} ignored, server not connected\n`);
      return;
    }
    socket.emit("invoke", { action, args }, (result: InvokeResult) => {
      if (!result.ok) this.options.log(`[tray] hotkey ${action} refused: ${result.reason}\n`);
    });
  }

  stop(): void {
    this.socket?.close();
    this.socket = null;
  }
}
