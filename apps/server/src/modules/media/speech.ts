import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaidEvent, PaidMessage } from "@saarathi/shared";
import { scamIn, withoutLinks } from "../../core/screen.js";

export type SpeechVoice = (text: string, signal: AbortSignal) => Promise<Buffer>;

const clean = (text: string, max: number) => Array.from(text, (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char)
  .join("").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Bounded and screened at the door, so the queue holds exactly what may go on
 * her stream. Paying does not buy a link on screen or in her voice: it is
 * swapped for a word. A message shaped like a scam is left out entirely and
 * the sender is thanked by name, which is all a real supporter loses.
 */
export function paidMessage(event: PaidEvent, id: string): PaidMessage {
  const full = clean(event.text, 1_000);
  const scam = scamIn(full);
  return {
    id,
    at: event.at,
    name: clean(withoutLinks(event.author.name, "(link)"), 40),
    amount: clean(event.amount.display, 24),
    text: scam ? "" : clean(withoutLinks(full, "(link)"), 180),
    ...(scam ? { cut: scam } : {}),
  };
}

export function paidSpeech(message: Pick<PaidMessage, "name" | "amount" | "text">, language: "en" | "kn" = "en"): string {
  if (language === "kn") return `${message.name} ಅವರಿಂದ ${message.amount}. ${message.text || "ನಿಮ್ಮ ಬೆಂಬಲಕ್ಕೆ ಧನ್ಯವಾದಗಳು!"}`;
  return `${message.name} sent ${message.amount}.${message.text ? ` ${message.text}` : " Thank you!"}`;
}

// Text travels over stdin, never through a shell or as executable PowerShell.
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice.SetOutputToWaveFile($inputData.path)
  $voice.Speak([string]$inputData.text)
} finally { $voice.Dispose() }
`;

export function systemVoice(platform: NodeJS.Platform): SpeechVoice | undefined {
  if (platform !== "win32" && platform !== "darwin") return undefined;
  return async (text, signal) => {
    const directory = await mkdtemp(join(tmpdir(), "saarathi-speech-"));
    const path = join(directory, "speech.wav");
    try {
      const windows = platform === "win32";
      await new Promise<void>((resolve, reject) => {
        const child = spawn(windows ? "powershell.exe" : "/usr/bin/say", windows
          ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64")]
          : ["-o", path, "--file-format=WAVE", "--data-format=LEI16@22050"],
        { windowsHide: true, stdio: ["pipe", "ignore", "ignore"], signal, timeout: 30_000 });
        let failure: Error | undefined;
        child.on("error", (error) => { failure = error; });
        // Wait for closed handles before removing the WAV, especially on Windows.
        child.on("close", (code) => {
          if (failure) reject(failure);
          else if (code === 0) resolve();
          else reject(new Error("Speech generation failed"));
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(windows ? JSON.stringify({ text, path }) : text);
      });
      return await readFile(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
