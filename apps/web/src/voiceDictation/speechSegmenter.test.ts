import { describe, expect, it } from "vite-plus/test";

import { createResampler, SPEECH_SAMPLE_RATE } from "./micCapture";
import { SpeechSegmenter } from "./speechSegmenter";

const tone = (seconds: number, amplitude = 0.2) =>
  Float32Array.from(
    { length: Math.round(seconds * SPEECH_SAMPLE_RATE) },
    (_, index) => amplitude * Math.sin((2 * Math.PI * 220 * index) / SPEECH_SAMPLE_RATE),
  );
const silence = (seconds: number) => tone(seconds, 0.001);

function segmenterWith(...parts: Float32Array[]) {
  const segmenter = new SpeechSegmenter();
  for (const part of parts) segmenter.append(part);
  return segmenter;
}

describe("SpeechSegmenter", () => {
  it("finds no speech or phrase in silence", () => {
    const segmenter = segmenterWith(silence(6));
    expect(segmenter.hasSpeech()).toBe(false);
    expect(segmenter.findCommitPoint()).toBeNull();
  });

  it("cuts a finished phrase in the middle of the pause after it", () => {
    const segmenter = segmenterWith(tone(3.2), silence(0.8), tone(0.5));
    const cut = segmenter.findCommitPoint();
    expect(cut).not.toBeNull();
    expect(Math.abs((cut ?? 0) / SPEECH_SAMPLE_RATE - 3.6)).toBeLessThan(0.05);
  });

  it("keeps listening when the pause is still happening at the newest audio", () => {
    expect(segmenterWith(tone(3.2), silence(0.25)).findCommitPoint()).toBeNull();
  });

  it("drains a long backlog at a pause Whisper can still read whole", () => {
    const phrase = () => [tone(4), silence(0.8)];
    const segmenter = segmenterWith(...Array.from({ length: 8 }, phrase).flat());
    // Pauses are centred at 4.4, 9.2, 14.0 and 18.8 s, and so on; 14.0 is the last under 18 s.
    const cut = segmenter.findCommitPoint() ?? Infinity;
    expect(Math.abs(cut / SPEECH_SAMPLE_RATE - 14)).toBeLessThan(0.05);
  });

  it("forces a cut at the quietest point when nobody pauses", () => {
    const loud = tone(20);
    loud.fill(0.002, 15 * SPEECH_SAMPLE_RATE, 15 * SPEECH_SAMPLE_RATE + 320);
    const cut = segmenterWith(loud).findCommitPoint() ?? 0;
    expect(cut / SPEECH_SAMPLE_RATE).toBeGreaterThan(14.9);
    expect(cut / SPEECH_SAMPLE_RATE).toBeLessThan(15.1);
  });

  it("keeps the rest of the buffer analyzable after a cut", () => {
    const segmenter = segmenterWith(tone(3.2), silence(0.8), tone(1));
    segmenter.take(segmenter.findCommitPoint() ?? 0);
    expect(segmenter.durationSamples / SPEECH_SAMPLE_RATE).toBeCloseTo(1.4, 1);
    expect(segmenter.hasSpeech()).toBe(true);
  });
});

describe("createResampler", () => {
  it("downsamples across chunk boundaries without losing samples or level", () => {
    const resample = createResampler(48_000);
    const chunk = new Float32Array(4096).fill(0.5);
    let total = 0;
    let last = 0;
    for (let index = 0; index < 30; index += 1) {
      const output = resample(chunk);
      total += output.length;
      last = output.at(-1) ?? last;
    }
    expect(Math.abs(total - (30 * 4096) / 3)).toBeLessThanOrEqual(1);
    expect(last).toBeCloseTo(0.5, 5);
  });
});
