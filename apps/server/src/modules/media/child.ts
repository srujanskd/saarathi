import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A folder of its own for one run, removed however the run ends. */
export async function inTempDirectory<T>(prefix: string, run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export interface ChildRun {
  /** Written whole to stdin. Viewer text travels here, never as an argument or through a shell. */
  input: string;
  signal: AbortSignal;
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Keep stdout, up to this many characters; past it the child is killed. Absent ignores stdout. */
  maxOutput?: number;
}

/**
 * Run one program with no shell and resolve with its stdout once it exits 0.
 * Anything else rejects: a spawn error, an abort, the timeout, a non-zero exit
 * or too much output. Settles on `close`, after the child's handles are shut,
 * so a caller can remove the files it wrote straight away -- Windows will not
 * delete a file a dying process still holds.
 */
export function runChild(command: string, args: string[], run: ChildRun): Promise<string> {
  return new Promise((resolve, reject) => {
    const max = run.maxOutput;
    const capture = max !== undefined;
    const child = spawn(command, args, {
      cwd: run.cwd, env: run.env, windowsHide: true, signal: run.signal, timeout: run.timeoutMs,
      stdio: ["pipe", capture ? "pipe" : "ignore", "ignore"],
    });
    let out = "";
    let overflow = false;
    let failure: Error | undefined;
    if (max !== undefined) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        out += chunk;
        if (out.length > max) {
          overflow = true;
          child.kill();
        }
      });
    }
    child.on("error", (error) => { failure = error; });
    child.on("close", (code) => {
      if (failure) reject(failure);
      else if (overflow) reject(new Error("Too much output"));
      else if (code !== 0) reject(new Error(`Exited with ${code}`));
      else resolve(out);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(run.input);
  });
}
