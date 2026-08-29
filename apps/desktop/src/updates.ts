import type { UpdateState } from "./tray-menu.js";

/**
 * Auto-update, the reason the whole thing is packaged rather than zipped. She
 * never fetches a build: electron-updater polls the GitHub release, downloads
 * in the background, and installs when the app next quits.
 *
 * Pre-releases stay out of her hands, which is electron-updater's default and
 * is why a hyphenated tag exists at all.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface AutoUpdater {
  autoDownload: boolean;
  logger: unknown;
  on(event: string, listener: (payload?: unknown) => void): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdatesOptions {
  onState(state: UpdateState): void;
  log(line: string): void;
}

export class Updates {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly updater: AutoUpdater,
    private readonly options: UpdatesOptions,
  ) {}

  start(): void {
    const { onState, log } = this.options;
    this.updater.autoDownload = true;
    this.updater.on("checking-for-update", () => onState({ phase: "checking" }));
    this.updater.on("update-not-available", () => onState({ phase: "unavailable" }));
    this.updater.on("update-available", () => onState({ phase: "downloading" }));
    this.updater.on("update-downloaded", () => onState({ phase: "ready" }));
    this.updater.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`update error: ${message}\n`);
      // Her machine being offline is the common case, and it is not something
      // she has to read a sentence about every six hours -- the menu says it,
      // nothing interrupts her.
      onState({ phase: "error", detail: message.slice(0, 80) });
    });

    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  async check(): Promise<void> {
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.options.log(`update check failed: ${String(error)}\n`);
    }
  }

  install(): void {
    this.updater.quitAndInstall();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
