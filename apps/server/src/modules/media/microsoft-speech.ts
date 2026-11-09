export interface MicrosoftSpeechSettings {
  key: string;
  region: string;
}

export type MicrosoftVoice = (text: string, signal: AbortSignal, settings: MicrosoftSpeechSettings) => Promise<Buffer>;

export class SpeechError extends Error {
  constructor(kind: "credentials" | "quota" | "unavailable") {
    super({
      credentials: "Microsoft speech could not sign in. Check the saved key and its region.",
      quota: "Microsoft speech quota or rate limit reached. Try again later or choose the built-in voice.",
      unavailable: "Microsoft speech is unavailable. Check the internet connection and try Test voice again.",
    }[kind]);
  }
}

export function validSpeechRegion(region: string): boolean {
  return /^[a-z][a-z0-9]{1,39}$/.test(region);
}

export function kannadaAnnouncerSsml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="kn-IN"><voice name="kn-IN-GaganNeural"><prosody rate="-15%" pitch="-12%">${escaped}</prosody></voice></speak>`;
}

/** Azure's supported REST API, with no key in URLs, logs or provider errors. */
export function microsoftVoice(request: typeof fetch = fetch): MicrosoftVoice {
  return async (text, signal, settings) => {
    if (!validSpeechRegion(settings.region) || !settings.key) throw new SpeechError("credentials");
    try {
      const response = await request(`https://${settings.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        headers: {
          "Ocp-Apim-Subscription-Key": settings.key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm",
          "User-Agent": "Saarathi",
        },
        body: kannadaAnnouncerSsml(text),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new SpeechError(response.status === 401 || response.status === 403 ? "credentials"
          : response.status === 429 ? "quota" : "unavailable");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new SpeechError("unavailable");
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          // Thirty seconds of 24 kHz PCM is 1.44 MB. Bound a malformed response
          // before buffering it, rather than trusting its Content-Length.
          if (bytes > 2 * 1024 * 1024) throw new SpeechError("unavailable");
          chunks.push(Buffer.from(part.value));
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof SpeechError) throw error;
      throw new SpeechError("unavailable");
    }
  };
}
