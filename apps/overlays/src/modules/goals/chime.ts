/**
 * The sound a goal makes when it lands.
 *
 * Synthesized rather than shipped as a file. Two sine notes are a few lines of
 * arithmetic, and the alternative is an audio asset with a licence to check,
 * a byte range for OBS to fetch off the server, and a second thing to go
 * missing in IRL mode when her phone is the server.
 *
 * OBS routes a browser source's audio into her mixer, so this lands on the
 * stream with a slider she already knows how to pull down.
 */

/** Loud enough to hear over music, quiet enough not to clip her mix. */
const PEAK = 0.22;

/** One note of the chime. Seconds, all of them relative to when it starts. */
export interface Voice {
  hertz: number;
  /** After the chime begins. */
  startsAt: number;
  /** How long it takes to fade to nothing. */
  seconds: number;
}

/**
 * Two notes, the second a fifth above the first and slightly behind it.
 *
 * Pure and exported for the test, because the part of a sound worth being sure
 * about is that it is short: this is playing over her voice while she is mid
 * set, and anything that rings for a second is something she will mute once
 * and never unmute.
 */
export const CHIME: Voice[] = [
  { hertz: 1046.5, startsAt: 0, seconds: 0.34 },
  { hertz: 1568, startsAt: 0.11, seconds: 0.42 },
];

/** How long the whole chime lasts, the last note's fade included. */
export function chimeSeconds(voices: readonly Voice[] = CHIME): number {
  return voices.reduce((longest, voice) => Math.max(longest, voice.startsAt + voice.seconds), 0);
}

/**
 * Plays it, once, on a context the caller owns.
 *
 * Every node is disposable: an oscillator that has stopped is rubbish the
 * moment it is done, and holding one would be a leak in a page that runs for
 * the length of her stream.
 */
export function playChime(audio: AudioContext, voices: readonly Voice[] = CHIME): void {
  const begins = audio.currentTime;
  for (const voice of voices) {
    const at = begins + voice.startsAt;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = voice.hertz;
    // Ramped rather than switched on and off: a gain that jumps is a click,
    // and a click is the part of a cheap chime everybody can hear.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(PEAK, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + voice.seconds);

    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + voice.seconds);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }
}
