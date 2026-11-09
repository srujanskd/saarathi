import { afterEach, describe, expect, it, vi } from "vitest";
import { kannadaAnnouncerSsml, microsoftVoice } from "../../src/modules/media/microsoft-speech.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Microsoft Kannada speech", () => {
  it("escapes viewer text so it cannot change voices or load external audio", () => {
    const ssml = kannadaAnnouncerSsml('ನಮಸ್ಕಾರ <audio src="https://example.com"/> & goodbye');
    expect(ssml).toContain('voice name="kn-IN-GaganNeural"');
    expect(ssml).toContain('prosody rate="-15%" pitch="-12%"');
    expect(ssml).toContain('ನಮಸ್ಕಾರ &lt;audio src=&quot;https://example.com&quot;/&gt; &amp; goodbye');
    expect(ssml).not.toContain('<audio');
  });

  it("requests WAV from the selected region, sends the key only in a header and forbids redirects", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(Buffer.from("wav bytes")));
    const voice = microsoftVoice(request);
    const signal = new AbortController().signal;
    expect(await voice("ನಮಸ್ಕಾರ", signal, { key: "private-key", region: "centralindia" })).toEqual(Buffer.from("wav bytes"));
    expect(request).toHaveBeenCalledWith("https://centralindia.tts.speech.microsoft.com/cognitiveservices/v1", expect.objectContaining({
      method: "POST", redirect: "error", body: kannadaAnnouncerSsml("ನಮಸ್ಕಾರ"),
      headers: expect.objectContaining({ "Ocp-Apim-Subscription-Key": "private-key", "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm" }),
    }));
  });

  it.each([[401, "key"], [403, "key"], [429, "quota"], [500, "unavailable"]])("makes status %i legible and drops the response body", async (status, message) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive provider response", { status: Number(status) }));
    await expect(microsoftVoice(request)("hi", new AbortController().signal, { key: "private-key", region: "eastus" })).rejects.toThrow(String(message));
  });

  it("refuses region injection before sending a credential anywhere", async () => {
    const request = vi.fn<typeof fetch>();
    for (const region of ["eastus.example.com/", "../", "https://example.com", "eastus:443"]) {
      await expect(microsoftVoice(request)("hi", new AbortController().signal, { key: "key", region })).rejects.toThrow("key");
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("bounds the audio response before buffering it all", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(Buffer.alloc(2 * 1024 * 1024 + 1)));
    await expect(microsoftVoice(request)("hi", new AbortController().signal, { key: "private-key", region: "eastus" })).rejects.toThrow("unavailable");
  });

  it("cancels the HTTP request on Stop and times it out without leaking network details", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    const signals: AbortSignal[] = [];
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const signal = init!.signal!;
      signals.push(signal);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("private-key in network error")), { once: true }));
    });
    const controller = new AbortController();
    const stopped = microsoftVoice(request)("hi", controller.signal, { key: "private-key", region: "eastus" });
    const stoppedCheck = expect(stopped).rejects.toThrow("unavailable");
    controller.abort();
    await stoppedCheck;
    expect(signals[0]!.aborted).toBe(true);
    const timed = microsoftVoice(request)("hi", new AbortController().signal, { key: "private-key", region: "eastus" });
    const timedCheck = expect(timed).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(20_000);
    await timedCheck;
    expect(signals[1]!.aborted).toBe(true);
    expect(timeout).toHaveBeenCalledWith(20_000);
  });
});
