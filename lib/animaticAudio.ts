// Client-side Cinema Animatic effects: live Canvas atmosphere overlays + procedural Web Audio 0-credit soundtracks.
// All Web Audio soundtracks connect cleanly to both speakers and MediaStreamAudioDestinationNode for WebM export!

export type AnimaticAtmosphere = "none" | "rain" | "golden" | "mist" | "snow";
export type AnimaticScorePreset = "none" | "rain_piano" | "morning_warm" | "cinematic_pad";

export const ANIMATIC_ATMOSPHERES: Array<{ value: AnimaticAtmosphere; label: string }> = [
  { value: "none", label: "Polos" },
  { value: "rain", label: "Hujan Anime" },
  { value: "golden", label: "Cahaya Emas" },
  { value: "mist", label: "Kabut Senja" },
  { value: "snow", label: "Salju Halus" },
];

export const ANIMATIC_SCORES: Array<{ value: AnimaticScorePreset; label: string; hint: string }> = [
  { value: "rain_piano", label: "Hujan & Piano Senja (0 Kredit)", hint: "Suara hujan lembut + piano anime senja" },
  { value: "morning_warm", label: "Pagi Hangat Akustik (0 Kredit)", hint: "Arpeggio hangat + semilir angin pagi" },
  { value: "cinematic_pad", label: "Sinematik Emosional (0 Kredit)", hint: "String pad sinematik tenang" },
  { value: "none", label: "Tanpa Musik Bawaan", hint: "Hening atau pakai MP3/WAV unggahan sendiri" },
];

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface ParticleSpec {
  x0: number;
  y0: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  phase: number;
}

const RAIN_PARTICLES: ParticleSpec[] = (() => {
  const rng = seededRandom(202611);
  return Array.from({ length: 96 }, () => {
    const depth = 0.55 + rng() * 0.95;
    return {
      x0: rng(),
      y0: rng(),
      vx: -0.055 * depth,
      vy: 0.95 * depth,
      size: 16 + rng() * 24 * depth,
      alpha: 0.16 + rng() * 0.28,
      phase: rng() * Math.PI * 2,
    };
  });
})();

const GOLDEN_PARTICLES: ParticleSpec[] = (() => {
  const rng = seededRandom(88421);
  return Array.from({ length: 48 }, () => ({
    x0: rng(),
    y0: rng(),
    vx: (rng() - 0.5) * 0.025,
    vy: -(0.022 + rng() * 0.045),
    size: 2.2 + rng() * 6.5,
    alpha: 0.22 + rng() * 0.45,
    phase: rng() * Math.PI * 2,
  }));
})();

const SNOW_PARTICLES: ParticleSpec[] = (() => {
  const rng = seededRandom(55109);
  return Array.from({ length: 72 }, () => ({
    x0: rng(),
    y0: rng(),
    vx: (rng() - 0.5) * 0.035,
    vy: 0.08 + rng() * 0.14,
    size: 1.5 + rng() * 3.8,
    alpha: 0.35 + rng() * 0.5,
    phase: rng() * Math.PI * 2,
  }));
})();

function wrap01(v: number): number {
  const r = v % 1;
  return r < 0 ? r + 1 : r;
}

/**
 * Renders subtle live animated cinema atmosphere particles onto a 2D canvas frame.
 */
export function drawAnimaticAtmosphere(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  elapsedSec: number,
  preset: AnimaticAtmosphere,
): void {
  if (preset === "none") return;
  ctx.save();

  if (preset === "rain") {
    ctx.lineCap = "round";
    for (const p of RAIN_PARTICLES) {
      const x = wrap01(p.x0 + p.vx * elapsedSec) * w;
      const y = wrap01(p.y0 + p.vy * elapsedSec) * h;
      const len = (p.size / 540) * h;
      ctx.strokeStyle = `rgba(196, 222, 255, ${p.alpha.toFixed(3)})`;
      ctx.lineWidth = Math.max(1, h / 540);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - len * 0.15, y + len);
      ctx.stroke();
    }
    // Soft cool rain atmospheric depth gradient at very top
    const topGrad = ctx.createLinearGradient(0, 0, 0, h * 0.26);
    topGrad.addColorStop(0, "rgba(14, 24, 44, 0.22)");
    topGrad.addColorStop(1, "rgba(14, 24, 44, 0)");
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, w, h * 0.26);
  } else if (preset === "golden") {
    for (const p of GOLDEN_PARTICLES) {
      const x = wrap01(p.x0 + p.vx * elapsedSec + Math.sin(elapsedSec * 0.8 + p.phase) * 0.012) * w;
      const y = wrap01(p.y0 + p.vy * elapsedSec) * h;
      const pulse = 0.6 + 0.4 * Math.sin(elapsedSec * 1.9 + p.phase);
      const r = (p.size / 540) * h;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 2.2);
      grad.addColorStop(0, `rgba(255, 226, 152, ${(p.alpha * pulse).toFixed(3)})`);
      grad.addColorStop(1, "rgba(255, 198, 96, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    // Gentle warm sunlight corner glow
    const sunGrad = ctx.createRadialGradient(w * 0.85, h * 0.12, 0, w * 0.85, h * 0.12, w * 0.55);
    sunGrad.addColorStop(0, "rgba(255, 206, 120, 0.14)");
    sunGrad.addColorStop(1, "rgba(255, 206, 120, 0)");
    ctx.fillStyle = sunGrad;
    ctx.fillRect(0, 0, w, h);
  } else if (preset === "mist") {
    for (let layer = 0; layer < 4; layer++) {
      const drift = wrap01(elapsedSec * (0.018 + layer * 0.007) + layer * 0.27);
      const cx = (drift * 1.4 - 0.2) * w;
      const cy = h * (0.68 + (layer % 2) * 0.16);
      const rx = w * (0.48 + layer * 0.08);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
      grad.addColorStop(0, "rgba(218, 228, 245, 0.14)");
      grad.addColorStop(1, "rgba(218, 228, 245, 0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, h * 0.35, w, h * 0.65);
    }
  } else if (preset === "snow") {
    for (const p of SNOW_PARTICLES) {
      const x = wrap01(p.x0 + p.vx * elapsedSec + Math.sin(elapsedSec * 1.3 + p.phase) * 0.018) * w;
      const y = wrap01(p.y0 + p.vy * elapsedSec) * h;
      const r = (p.size / 540) * h;
      ctx.fillStyle = `rgba(242, 248, 255, ${p.alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

export interface BuiltInScoreController {
  setVolume: (vol: number) => void;
  stop: () => void;
}

/**
 * Generates a 100% browser-synthesized 0-credit cinema soundtrack (rain + piano / warm morning / cinematic pad)
 * routed cleanly to speakers and optional MediaRecorder audio destination.
 */
export function startBuiltInAnimaticScore(
  audioCtx: AudioContext,
  destinations: AudioNode[],
  preset: AnimaticScorePreset,
  totalDurSec: number,
  initialVolume = 0.55,
): BuiltInScoreController {
  if (preset === "none" || totalDurSec <= 0) {
    return { setVolume: () => {}, stop: () => {} };
  }

  const now = audioCtx.currentTime;
  const safeVol = Math.max(0.02, Math.min(1, initialVolume));
  const fadeGain = audioCtx.createGain();
  fadeGain.gain.setValueAtTime(0.0001, now);
  fadeGain.gain.linearRampToValueAtTime(1, now + 0.75);
  const fadeOutStart = Math.max(now + 0.8, now + totalDurSec - 1.25);
  fadeGain.gain.setValueAtTime(1, fadeOutStart);
  fadeGain.gain.linearRampToValueAtTime(0.0001, now + totalDurSec + 0.05);

  const volGain = audioCtx.createGain();
  volGain.gain.setValueAtTime(safeVol, now);
  fadeGain.connect(volGain);

  const master = fadeGain;
  for (const dest of destinations) {
    volGain.connect(dest);
  }

  const stoppables: Array<{ stop: () => void }> = [];

  // 1. Optional gentle stereo rain/breeze noise loop
  if (preset === "rain_piano" || preset === "morning_warm") {
    const sr = audioCtx.sampleRate;
    const loopSec = 4;
    const len = sr * loopSec;
    const noiseBuf = audioCtx.createBuffer(2, len, sr);
    const rng = seededRandom(preset === "rain_piano" ? 1337 : 9001);
    for (let ch = 0; ch < 2; ch++) {
      const data = noiseBuf.getChannelData(ch);
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = rng() * 2 - 1;
        b0 = 0.96 * b0 + w * 0.055;
        b1 = 0.84 * b1 + w * 0.14;
        b2 = 0.58 * b2 + w * 0.22;
        data[i] = (b0 * 0.45 + b1 * 0.35 + b2 * 0.15) * (preset === "rain_piano" ? 0.24 : 0.09);
      }
    }
    const noiseSrc = audioCtx.createBufferSource();
    noiseSrc.buffer = noiseBuf;
    noiseSrc.loop = true;

    const hp = audioCtx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = preset === "rain_piano" ? 280 : 420;

    const lp = audioCtx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = preset === "rain_piano" ? 2400 : 1200;

    const ambGain = audioCtx.createGain();
    ambGain.gain.value = preset === "rain_piano" ? 0.58 : 0.32;

    noiseSrc.connect(hp);
    hp.connect(lp);
    lp.connect(ambGain);
    ambGain.connect(master);
    noiseSrc.start(now);
    noiseSrc.stop(now + totalDurSec + 0.15);
    stoppables.push(noiseSrc);
  }

  // 2. Chord progression synth (electric piano / acoustic chime / warm string pad)
  const chords =
    preset === "rain_piano"
      ? [
          [174.61, 220.0, 261.63, 329.63, 440.0], // Fmaj7
          [164.81, 246.94, 293.66, 392.0, 493.88], // Em7
          [146.83, 220.0, 261.63, 349.23, 440.0], // Dm7
          [130.81, 196.0, 246.94, 329.63, 392.0], // Cmaj7
        ]
      : preset === "morning_warm"
        ? [
            [130.81, 196.0, 246.94, 329.63, 392.0], // Cmaj7
            [196.0, 246.94, 293.66, 369.99, 493.88], // Gmaj7
            [220.0, 261.63, 329.63, 392.0, 523.25], // Am7
            [174.61, 220.0, 261.63, 329.63, 440.0], // Fmaj7
          ]
        : [
            [146.83, 220.0, 261.63, 329.63], // Dm9
            [116.54, 174.61, 220.0, 293.66], // Bbmaj7
            [174.61, 220.0, 261.63, 349.23], // Fmaj7
            [130.81, 174.61, 196.0, 261.63], // Csus4
          ];

  const barSec = preset === "cinematic_pad" ? 4.5 : 4.0;
  const barCount = Math.ceil(totalDurSec / barSec);

  const toneLp = audioCtx.createBiquadFilter();
  toneLp.type = "lowpass";
  toneLp.frequency.value = preset === "cinematic_pad" ? 950 : 2100;
  toneLp.connect(master);

  for (let b = 0; b < barCount; b++) {
    const chord = chords[b % chords.length];
    const barStart = now + b * barSec;
    if (barStart >= now + totalDurSec) break;

    chord.forEach((freq, ni) => {
      const stagger = preset === "cinematic_pad" ? ni * 0.08 : ni * 0.42;
      const t0 = barStart + stagger;
      if (t0 >= now + totalDurSec) return;
      const dur = Math.min(barSec - 0.15, now + totalDurSec - t0 + 0.1);
      if (dur <= 0.08) return;

      const osc = audioCtx.createOscillator();
      osc.type = preset === "cinematic_pad" ? "sawtooth" : ni === 0 ? "sine" : "triangle";
      osc.frequency.setValueAtTime(freq, t0);

      const g = audioCtx.createGain();
      const peak = preset === "cinematic_pad" ? 0.055 : ni === 0 ? 0.11 : 0.075;
      const attack = preset === "cinematic_pad" ? 0.85 : 0.04;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + Math.min(attack, dur * 0.4));
      g.gain.exponentialRampToValueAtTime(0.0004, t0 + dur);

      osc.connect(g);
      g.connect(toneLp);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
      stoppables.push(osc);
    });
  }

  return {
    setVolume: (vol: number) => {
      const clamped = Math.max(0.02, Math.min(1, vol));
      volGain.gain.setTargetAtTime(clamped, audioCtx.currentTime, 0.06);
    },
    stop: () => {
      for (const s of stoppables) {
        try {
          s.stop();
        } catch {
          // already stopped
        }
      }
      try {
        master.disconnect();
        volGain.disconnect();
      } catch {
        // ignore
      }
    },
  };
}
