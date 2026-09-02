import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "@saarathi/shared";

/**
 * Durable state, namespaced per module. Modules never see this: they call
 * `setState` and the registry decides which keys are durable, so the
 * durable-or-transient question is answered once per field, at declaration.
 */
export interface StateStore {
  read(namespace: string): Record<string, unknown> | undefined;
  write(namespace: string, data: Record<string, unknown>): void;
  /** Write pending changes to disk now. */
  flush(): void;
}

interface Document {
  version: number;
  namespaces: Record<string, Record<string, unknown>>;
}

/**
 * Stamped on the document the store writes. Exported so a test that has to
 * write a state file the server will read afterwards stamps the same number
 * this does, rather than a literal that stops matching on the first bump.
 */
export const STATE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 500;

export class MemoryStore implements StateStore {
  private readonly doc: Document = { version: STATE_VERSION, namespaces: {} };

  read(namespace: string): Record<string, unknown> | undefined {
    return this.doc.namespaces[namespace];
  }

  write(namespace: string, data: Record<string, unknown>): void {
    this.doc.namespaces[namespace] = data;
  }

  flush(): void {}
}

export class JsonStore implements StateStore {
  private readonly doc: Document;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly log: Logger,
  ) {
    this.doc = this.load();
  }

  private load(): Document {
    if (!existsSync(this.file)) return { version: STATE_VERSION, namespaces: {} };
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<Document> &
        Record<string, unknown>;
      if (raw.namespaces && typeof raw.namespaces === "object") {
        return { version: STATE_VERSION, namespaces: raw.namespaces };
      }
      // Pre-module layout: challenges and history sat at the top level. Her real
      // state file is in that shape, so read it rather than starting her over.
      const namespaces: Document["namespaces"] = {};
      if (Array.isArray(raw.challenges) || Array.isArray(raw.history)) {
        namespaces.wheel = {
          ...(Array.isArray(raw.challenges) ? { challenges: raw.challenges } : {}),
          ...(Array.isArray(raw.history) ? { history: raw.history } : {}),
        };
        this.log.info(`store: migrated ${this.file} to the namespaced layout`);
      }
      return { version: STATE_VERSION, namespaces };
    } catch (err) {
      this.log.warn(`store: could not read ${this.file}, starting fresh`, err);
      return { version: STATE_VERSION, namespaces: {} };
    }
  }

  read(namespace: string): Record<string, unknown> | undefined {
    return this.doc.namespaces[namespace];
  }

  write(namespace: string, data: Record<string, unknown>): void {
    this.doc.namespaces[namespace] = data;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // Write-then-rename: a crash mid-write leaves her last good file intact.
      const tmp = `${this.file}.tmp`;
      // Hers to read and nobody else's. This file holds her OBS password, her
      // YouTube API key and -- since the bot learned to write -- a Google
      // refresh token that can post as her and ban her viewers.
      //
      // The mode goes on the temp file rather than on the finished one because
      // the rename is what publishes it: a file that is briefly
      // world-readable is readable by whatever was watching, and on a VPS with
      // other people on it that is the whole point of bothering. And the temp
      // file is removed first because `writeFileSync` applies `mode` only when
      // it *creates* the file -- one a crash left behind would otherwise be
      // opened, truncated, and keep whatever permissions it arrived with.
      rmSync(tmp, { force: true });
      writeFileSync(tmp, JSON.stringify(this.doc, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      this.log.error(`store: could not write ${this.file}`, err);
    }
  }
}

export function defaultStorePath(): string {
  return join(process.cwd(), "data", "state.json");
}
