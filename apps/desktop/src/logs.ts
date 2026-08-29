import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from "node:fs";
import { join } from "node:path";

/**
 * Everything the server printed, on disk, because "Open logs folder" is the
 * only answer she has when something is wrong and there is no terminal to
 * look at. It is also the only thing worth attaching when she tells me it
 * broke.
 */

const MAX_BYTES = 2_000_000;

export class ServerLog {
  private stream: WriteStream | null = null;

  constructor(private readonly dir: string) {}

  get file(): string {
    return join(this.dir, "server.log");
  }

  /** Rotates one generation deep. Two files is enough to see the crash and
   * the run before it, and unbounded logs on her machine are our problem. */
  open(): void {
    mkdirSync(this.dir, { recursive: true });
    try {
      if (statSync(this.file).size > MAX_BYTES) renameSync(this.file, `${this.file}.1`);
    } catch {
      // No log yet, which is the common case on a first run.
    }
    this.stream = createWriteStream(this.file, { flags: "a" });
    this.write(`\n--- ${new Date().toISOString()} started ---\n`);
  }

  write(text: string): void {
    this.stream?.write(text);
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}
