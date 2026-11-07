// Short beeps for hands-free voice, so it can be used without looking at T3 Code (say, in a game).

export type VoiceCue = "start" | "stop" | "nothing-heard" | "enabled" | "disabled";

const TONES: Record<VoiceCue, ReadonlyArray<{ readonly hz: number; readonly ms: number }>> = {
  start: [{ hz: 880, ms: 120 }],
  stop: [{ hz: 440, ms: 120 }],
  "nothing-heard": [{ hz: 300, ms: 250 }],
  enabled: [
    { hz: 440, ms: 100 },
    { hz: 880, ms: 100 },
  ],
  disabled: [
    { hz: 880, ms: 100 },
    { hz: 440, ms: 100 },
  ],
};

const VOLUME = 0.15;
let context: AudioContext | null = null;

export function playVoiceCue(cue: VoiceCue): void {
  if (typeof AudioContext === "undefined") return;
  context ??= new AudioContext();
  void context.resume();
  let at = context.currentTime;
  for (const tone of TONES[cue]) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = tone.hz;
    const end = at + tone.ms / 1000;
    // Short fades, so the tone starts and ends without a click.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(VOLUME, at + 0.005);
    gain.gain.setValueAtTime(VOLUME, end - 0.01);
    gain.gain.linearRampToValueAtTime(0, end);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(end);
    at = end;
  }
}
