import type { Logger } from "@saarathi/shared";

export interface RecordingLogger extends Logger {
  readonly lines: string[];
  /** Every line at any level, joined. Cheap way to assert "she was told why". */
  text(): string;
}

/**
 * A logger that keeps what it was told instead of printing it. Refusals are
 * logged rather than thrown, so a few rules are only observable here.
 */
export function testLogger(): RecordingLogger {
  const lines: string[] = [];
  const push = (level: string) => (msg: string) => void lines.push(`${level} ${msg}`);
  return {
    lines,
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    text: () => lines.join("\n"),
  };
}
