import type { SpeechStyle, SpeechVoiceId, SpeechMood } from "@saarathi/shared";

/** How a style sounds, as offsets from each voice's normal delivery. */
export interface Delivery {
  azureVoice: "kn-IN-GaganNeural" | "kn-IN-SapnaNeural";
  /** Percent faster (+) or slower (-). */
  rate: number;
  /** Percent higher (+) or lower (-). Azure only: SAPI and `say` ignore pitch. */
  pitch: number;
  /** A hint for the built-in Windows voice, which picks whatever installed voice matches. */
  gender: "Male" | "Female";
}

const VOICES: Record<SpeechVoiceId, Delivery> = {
  // The announcer is the voice she already had, so a message with no style and
  // the announcer at neutral sound exactly the same on Azure.
  announcer: { azureVoice: "kn-IN-GaganNeural", rate: -15, pitch: -12, gender: "Male" },
  buddy: { azureVoice: "kn-IN-GaganNeural", rate: 5, pitch: 0, gender: "Male" },
  warm: { azureVoice: "kn-IN-SapnaNeural", rate: -5, pitch: -2, gender: "Female" },
  bright: { azureVoice: "kn-IN-SapnaNeural", rate: 8, pitch: 6, gender: "Female" },
};

const MOODS: Record<SpeechMood, { rate: number; pitch: number }> = {
  neutral: { rate: 0, pitch: 0 },
  excited: { rate: 12, pitch: 8 },
  calm: { rate: -10, pitch: -4 },
  heartfelt: { rate: -12, pitch: -6 },
};

export const DEFAULT_STYLE: SpeechStyle = { voice: "announcer", mood: "neutral" };

export function delivery(style: SpeechStyle): Delivery {
  const voice = VOICES[style.voice];
  const mood = MOODS[style.mood];
  // Bounded so a sum of offsets can never turn into a chipmunk or a drone.
  const clamp = (value: number) => Math.max(-30, Math.min(30, value));
  return { ...voice, rate: clamp(voice.rate + mood.rate), pitch: clamp(voice.pitch + mood.pitch) };
}

/** SAPI's Rate runs -10..10, each step roughly 10% faster or slower. */
export function sapiRate(rate: number): number {
  return Math.max(-10, Math.min(10, Math.round(rate / 10)));
}

/** macOS `say` takes words per minute, around 175 by default. */
export function sayWordsPerMinute(rate: number): number {
  return Math.round(175 * (1 + rate / 100));
}
