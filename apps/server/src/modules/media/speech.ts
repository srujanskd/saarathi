import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaidEvent, PaidMessage, SpeechStyle } from "@saarathi/shared";
import { scamIn, withoutLinks } from "../../core/screen.js";
import { delivery, sapiRate, sayWordsPerMinute } from "./delivery.js";
import { inTempDirectory, runChild } from "./child.js";

/** No style means the machine's own default voice at its own speed. */
export type SpeechVoice = (text: string, signal: AbortSignal, style?: SpeechStyle) => Promise<Buffer>;

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
// A gender is a hint: SAPI keeps its default when no installed voice matches.
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($inputData.gender -eq 'Male') { $voice.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Male) }
  elseif ($inputData.gender -eq 'Female') { $voice.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female) }
  if ($null -ne $inputData.rate) { $voice.Rate = [int]$inputData.rate }
  $voice.SetOutputToWaveFile($inputData.path)
  $voice.Speak([string]$inputData.text)
} finally { $voice.Dispose() }
`;

export function systemVoice(platform: NodeJS.Platform): SpeechVoice | undefined {
  if (platform !== "win32" && platform !== "darwin") return undefined;
  const windows = platform === "win32";
  return (text, signal, style) => {
    // Unstyled leaves the machine's own voice and speed alone: no rate is sent at all.
    const sound = style ? delivery(style) : undefined;
    return inTempDirectory("saarathi-speech-", async (directory) => {
      const path = join(directory, "speech.wav");
      await runChild(windows ? "powershell.exe" : "/usr/bin/say", windows
        ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64")]
        : ["-o", path, "--file-format=WAVE", "--data-format=LEI16@22050",
          ...(sound ? ["-r", String(sayWordsPerMinute(sound.rate))] : [])], {
        input: windows
          ? JSON.stringify({ text, path, ...(sound ? { rate: sapiRate(sound.rate), gender: sound.gender } : {}) })
          : text,
        signal,
        timeoutMs: 30_000,
      });
      return readFile(path);
    });
  };
}
