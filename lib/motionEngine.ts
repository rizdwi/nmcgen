// Deterministic image-to-video motion, transition, Canvas2D rendering, and local CDP export pack for nmcGen.
import type { AspectRatio, NmcProject, StoryFrame, StorySegment } from "./types.ts";
import {
  ensureStoryboard,
  getSelectedFrameImage,
  getStoryboardSegments,
  reindexStoryboardFrames,
} from "./storyboard.ts";
import { parseDataUrlBase64 } from "./omniAnimation.ts";
import { buildZip, type ZipEntryInput } from "./zip.ts";

export type MotionPreset =
  | "auto"
  | "zoom-in"
  | "zoom-out"
  | "pan-left"
  | "pan-right"
  | "pan-up"
  | "pan-down"
  | "tilt-drift"
  | "static";

export type ResolvedMotion = Exclude<MotionPreset, "auto">;

export type TransitionPreset =
  | "auto"
  | "crossfade"
  | "slide-left"
  | "slide-up"
  | "zoom-cut"
  | "wipe-right"
  | "cut";

export type ResolvedTransition = Exclude<TransitionPreset, "auto">;
export type MotionFitMode = "cover" | "contain-blur";
export type MotionAudioMode = "synth" | "bgm" | "none";

export interface MotionRenderOptions {
  segmentId?: string | null;
  secPerPanel: number;
  transitionSec: number;
  motionPreset: MotionPreset;
  motionAmount: number;
  transitionPreset: TransitionPreset;
  fitMode: MotionFitMode;
  showBadge: boolean;
  showSubtitles: boolean;
  showProgress: boolean;
  fps?: number;
  audioMode?: MotionAudioMode;
  audioVolume?: number;
}

export interface MotionSlide {
  index: number;
  frameId: string;
  segmentId: string;
  segmentIndex: number;
  panelNumber: number;
  imageUrl: string;
  fileName: string;
  title: string;
  tag: string;
  caption: string;
  duration: number;
  start: number;
  end: number;
  fit: MotionFitMode;
  motion: ResolvedMotion;
  motionAmount: number;
  transition: ResolvedTransition;
  transitionSec: number;
}

export interface MotionTimeline {
  width: number;
  height: number;
  fps: number;
  aspectRatio: AspectRatio;
  slides: MotionSlide[];
  totalDuration: number;
}

export interface MotionSample {
  inTransition: boolean;
  transType: ResolvedTransition | "none";
  transT: number;
  from: { slide: MotionSlide; progress: number } | null;
  to: { slide: MotionSlide; progress: number };
  primary: MotionSlide;
  primaryProgress: number;
}

export interface MotionTransform {
  scale: number;
  tx: number;
  ty: number;
  rotRad: number;
}

export interface FitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MOTION_PRESET_OPTIONS: Array<{ value: MotionPreset; label: string }> = [
  { value: "auto", label: "Otomatis (Ikuti Shot)" },
  { value: "zoom-in", label: "Zoom In (Push-In)" },
  { value: "zoom-out", label: "Zoom Out (Pull-Out)" },
  { value: "pan-right", label: "Pan Kanan" },
  { value: "pan-left", label: "Pan Kiri" },
  { value: "pan-up", label: "Pan Naik" },
  { value: "pan-down", label: "Pan Turun" },
  { value: "tilt-drift", label: "Tilt Drift Sinematik" },
  { value: "static", label: "Statis" },
];

export const TRANSITION_PRESET_OPTIONS: Array<{ value: TransitionPreset; label: string }> = [
  { value: "auto", label: "Otomatis (Halus + Ganti Segmen)" },
  { value: "crossfade", label: "Crossfade Halus" },
  { value: "slide-left", label: "Slide Kiri" },
  { value: "slide-up", label: "Slide Naik" },
  { value: "wipe-right", label: "Wipe Garis Aksen" },
  { value: "zoom-cut", label: "Zoom Cut" },
  { value: "cut", label: "Potong Langsung (Cut)" },
];

export function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function easeInOutCubic(t: number): number {
  const u = clamp(t, 0, 1);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

export function fullHdDimsForAspect(aspect: AspectRatio): { width: number; height: number } {
  return aspect === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

export function pickAutoMotion(frame: StoryFrame, index: number): ResolvedMotion {
  if (frame.shotSize === "WS") {
    return index % 2 === 0 ? "pan-right" : "zoom-in";
  }
  if (frame.shotSize === "CU" || frame.shotSize === "ECU") {
    return index % 2 === 0 ? "zoom-out" : "tilt-drift";
  }
  const cycle: ResolvedMotion[] = ["zoom-in", "pan-left", "zoom-out", "pan-right", "tilt-drift"];
  return cycle[index % cycle.length];
}

export function pickAutoTransition(
  prevFrame: StoryFrame | null,
  curFrame: StoryFrame,
  index: number,
): ResolvedTransition {
  if (!prevFrame || index === 0) return "cut";
  const sameSegment = Boolean(prevFrame.segmentId && prevFrame.segmentId === curFrame.segmentId);
  if (sameSegment && curFrame.sameLocationAsPrev) {
    return "crossfade";
  }
  if (sameSegment) {
    return index % 2 === 0 ? "crossfade" : "zoom-cut";
  }
  const sceneCuts: ResolvedTransition[] = ["slide-left", "wipe-right", "zoom-cut", "slide-up"];
  return sceneCuts[index % sceneCuts.length];
}

export function buildMotionTimeline(project: NmcProject, opts: MotionRenderOptions): MotionTimeline {
  const sb = ensureStoryboard(project);
  const segments: StorySegment[] = getStoryboardSegments(sb);
  const ordered = reindexStoryboardFrames(sb.frames, segments);
  const filtered = ordered.filter((f) => {
    if (!getSelectedFrameImage(f)) return false;
    if (opts.segmentId && f.segmentId !== opts.segmentId) return false;
    return true;
  });

  const { width, height } = fullHdDimsForAspect(sb.aspectRatio);
  const fps = opts.fps ?? 30;
  const dur = clamp(Number(opts.secPerPanel) || 3.5, 1.2, 12.0);
  const rawTrans = clamp(Number(opts.transitionSec) || 0.55, 0, dur * 0.45);
  const motionAmt = clamp(Number(opts.motionAmount) || 0.11, 0, 0.3);

  const slides: MotionSlide[] = [];
  let cursor = 0;

  for (let i = 0; i < filtered.length; i++) {
    const frame = filtered[i];
    const prev = i > 0 ? filtered[i - 1] : null;
    const imgUrl = getSelectedFrameImage(frame) || "";
    const dec = parseDataUrlBase64(imgUrl);
    const segIdx = Math.max(1, segments.findIndex((s) => s.id === frame.segmentId) + 1);
    const pNum = frame.panelNumber ?? i + 1;

    const motion: ResolvedMotion =
      opts.motionPreset === "auto" ? pickAutoMotion(frame, i) : opts.motionPreset;
    const transition: ResolvedTransition =
      i === 0
        ? "cut"
        : opts.transitionPreset === "auto"
          ? pickAutoTransition(prev, frame, i)
          : opts.transitionPreset;

    const transSec = i === 0 || transition === "cut" ? 0 : Math.min(rawTrans, dur * 0.45);
    const start = i === 0 ? 0 : cursor - transSec;
    const end = start + dur;
    cursor = end;

    slides.push({
      index: i,
      frameId: frame.id,
      segmentId: frame.segmentId || `seg-${segIdx}`,
      segmentIndex: segIdx,
      panelNumber: pNum,
      imageUrl: imgUrl,
      fileName: `images/panel_${String(i + 1).padStart(3, "0")}.${dec?.ext || "jpg"}`,
      title: frame.title || `Panel ${pNum}`,
      tag: `SEGMEN ${String(segIdx).padStart(2, "0")} · PANEL ${pNum}${frame.title ? `: ${frame.title.toUpperCase()}` : ""}`,
      caption: (frame.dialogue || "").trim(),
      duration: dur,
      start,
      end,
      fit: opts.fitMode,
      motion,
      motionAmount: motionAmt,
      transition,
      transitionSec: transSec,
    });
  }

  return {
    width,
    height,
    fps,
    aspectRatio: sb.aspectRatio,
    slides,
    totalDuration: cursor,
  };
}

export function sampleMotionTimeline(timeline: MotionTimeline, tRaw: number): MotionSample | null {
  if (timeline.slides.length === 0) return null;
  const t = clamp(tRaw, 0, timeline.totalDuration);
  const slides = timeline.slides;

  for (let i = slides.length - 1; i >= 0; i--) {
    const cur = slides[i];
    if (t >= cur.start) {
      const localProgress = clamp((t - cur.start) / cur.duration, 0, 1);
      if (i > 0 && cur.transitionSec > 0 && t < cur.start + cur.transitionSec) {
        const prev = slides[i - 1];
        const prevProgress = clamp((t - prev.start) / prev.duration, 0, 1);
        const transT = easeInOutCubic((t - cur.start) / cur.transitionSec);
        return {
          inTransition: true,
          transType: cur.transition,
          transT,
          from: { slide: prev, progress: prevProgress },
          to: { slide: cur, progress: localProgress },
          primary: transT < 0.5 ? prev : cur,
          primaryProgress: transT < 0.5 ? prevProgress : localProgress,
        };
      }
      return {
        inTransition: false,
        transType: "none",
        transT: 1,
        from: null,
        to: { slide: cur, progress: localProgress },
        primary: cur,
        primaryProgress: localProgress,
      };
    }
  }

  return {
    inTransition: false,
    transType: "none",
    transT: 1,
    from: null,
    to: { slide: slides[0], progress: 0 },
    primary: slides[0],
    primaryProgress: 0,
  };
}

export function computeMotionTransform(
  motion: ResolvedMotion,
  amount: number,
  progress: number,
): MotionTransform {
  const u = clamp(progress, 0, 1);
  const a = clamp(amount, 0, 0.35);

  switch (motion) {
    case "zoom-in":
      return { scale: lerp(1.0, 1.0 + a, u), tx: 0, ty: 0, rotRad: 0 };
    case "zoom-out":
      return { scale: lerp(1.0 + a, 1.0, u), tx: 0, ty: 0, rotRad: 0 };
    case "pan-left":
      return { scale: 1.0 + a, tx: lerp(a * 0.42, -a * 0.42, u), ty: 0, rotRad: 0 };
    case "pan-right":
      return { scale: 1.0 + a, tx: lerp(-a * 0.42, a * 0.42, u), ty: 0, rotRad: 0 };
    case "pan-up":
      return { scale: 1.0 + a, tx: 0, ty: lerp(a * 0.42, -a * 0.42, u), rotRad: 0 };
    case "pan-down":
      return { scale: 1.0 + a, tx: 0, ty: lerp(-a * 0.42, a * 0.42, u), rotRad: 0 };
    case "tilt-drift":
      return {
        scale: lerp(1.03, 1.03 + a, u),
        tx: lerp(-a * 0.18, a * 0.18, u),
        ty: lerp(a * 0.12, -a * 0.12, u),
        rotRad: lerp(-0.016, 0.016, u),
      };
    case "static":
    default:
      return { scale: 1.0, tx: 0, ty: 0, rotRad: 0 };
  }
}

export function computeFitRect(
  imgW: number,
  imgH: number,
  canvasW: number,
  canvasH: number,
  mode: MotionFitMode = "cover",
): FitRect {
  const imgAspect = imgW / Math.max(1, imgH);
  const canvasAspect = canvasW / Math.max(1, canvasH);

  let w: number;
  let h: number;
  if (mode === "contain-blur") {
    if (imgAspect > canvasAspect) {
      w = canvasW * 0.92;
      h = w / imgAspect;
    } else {
      h = canvasH * 0.72;
      w = h * imgAspect;
    }
  } else if (imgAspect > canvasAspect) {
    h = canvasH;
    w = h * imgAspect;
  } else {
    w = canvasW;
    h = w / imgAspect;
  }

  return {
    x: (canvasW - w) * 0.5,
    y: (canvasH - h) * 0.5,
    w,
    h,
  };
}

function drawSingleSlideCanvas(
  ctx: CanvasRenderingContext2D,
  slide: MotionSlide,
  progress: number,
  img: HTMLImageElement | null,
  W: number,
  H: number,
): void {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(0, 0, W, H);
  if (!img || !img.naturalWidth || !img.naturalHeight) {
    ctx.restore();
    return;
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const motion = computeMotionTransform(slide.motion, slide.motionAmount, progress);

  if (slide.fit === "contain-blur") {
    const bgRect = computeFitRect(img.naturalWidth, img.naturalHeight, W, H, "cover");
    ctx.save();
    ctx.filter = "blur(32px) brightness(0.38)";
    ctx.translate(W * 0.5, H * 0.5);
    ctx.scale(1.14, 1.14);
    ctx.drawImage(img, bgRect.x - W * 0.5, bgRect.y - H * 0.5, bgRect.w, bgRect.h);
    ctx.restore();

    const fgRect = computeFitRect(img.naturalWidth, img.naturalHeight, W, H, "contain-blur");
    ctx.save();
    ctx.translate(W * 0.5 + motion.tx * W, H * 0.5 + motion.ty * H);
    ctx.rotate(motion.rotRad);
    ctx.scale(motion.scale, motion.scale);
    ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
    ctx.shadowBlur = Math.round(Math.min(W, H) * 0.03);
    ctx.shadowOffsetY = Math.round(Math.min(W, H) * 0.012);
    ctx.beginPath();
    ctx.roundRect(fgRect.x - W * 0.5, fgRect.y - H * 0.5, fgRect.w, fgRect.h, Math.round(Math.min(W, H) * 0.014));
    ctx.fillStyle = "#11151d";
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.clip();
    ctx.drawImage(img, fgRect.x - W * 0.5, fgRect.y - H * 0.5, fgRect.w, fgRect.h);
    ctx.restore();
  } else {
    const rect = computeFitRect(img.naturalWidth, img.naturalHeight, W, H, "cover");
    ctx.save();
    ctx.translate(W * 0.5 + motion.tx * W, H * 0.5 + motion.ty * H);
    ctx.rotate(motion.rotRad);
    ctx.scale(motion.scale, motion.scale);
    ctx.drawImage(img, rect.x - W * 0.5, rect.y - H * 0.5, rect.w, rect.h);
    ctx.restore();
  }

  ctx.restore();
}

export function drawMotionFrame(params: {
  ctx: CanvasRenderingContext2D;
  offFrom: HTMLCanvasElement;
  offTo: HTMLCanvasElement;
  imageMap: Map<string, HTMLImageElement | null>;
  timeline: MotionTimeline;
  elapsedSec: number;
  showBadge: boolean;
  showSubtitles: boolean;
  showProgress: boolean;
  accentColor?: string;
}): void {
  const { ctx, offFrom, offTo, imageMap, timeline, elapsedSec, showBadge, showSubtitles, showProgress } = params;
  const accent = params.accentColor || "#E87D35";
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;

  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(0, 0, W, H);

  const sample = sampleMotionTimeline(timeline, elapsedSec);
  if (!sample) return;

  if (!sample.inTransition || !sample.from) {
    const img = imageMap.get(sample.to.slide.frameId) ?? null;
    drawSingleSlideCanvas(ctx, sample.to.slide, sample.to.progress, img, W, H);
  } else {
    if (offFrom.width !== W || offFrom.height !== H) {
      offFrom.width = W;
      offFrom.height = H;
    }
    if (offTo.width !== W || offTo.height !== H) {
      offTo.width = W;
      offTo.height = H;
    }
    const fromCtx = offFrom.getContext("2d");
    const toCtx = offTo.getContext("2d");
    if (fromCtx && toCtx) {
      drawSingleSlideCanvas(fromCtx, sample.from.slide, sample.from.progress, imageMap.get(sample.from.slide.frameId) ?? null, W, H);
      drawSingleSlideCanvas(toCtx, sample.to.slide, sample.to.progress, imageMap.get(sample.to.slide.frameId) ?? null, W, H);
      const u = sample.transT;
      ctx.save();
      ctx.clearRect(0, 0, W, H);
      switch (sample.transType) {
        case "slide-left":
          ctx.drawImage(offFrom, -u * W, 0);
          ctx.drawImage(offTo, (1 - u) * W, 0);
          break;
        case "slide-up":
          ctx.drawImage(offFrom, 0, -u * H);
          ctx.drawImage(offTo, 0, (1 - u) * H);
          break;
        case "zoom-cut": {
          const sFrom = 1 + u * 0.12;
          ctx.save();
          ctx.globalAlpha = 1 - u;
          ctx.translate(W * 0.5, H * 0.5);
          ctx.scale(sFrom, sFrom);
          ctx.drawImage(offFrom, -W * 0.5, -H * 0.5);
          ctx.restore();

          const sTo = 1.08 - u * 0.08;
          ctx.save();
          ctx.globalAlpha = u;
          ctx.translate(W * 0.5, H * 0.5);
          ctx.scale(sTo, sTo);
          ctx.drawImage(offTo, -W * 0.5, -H * 0.5);
          ctx.restore();
          break;
        }
        case "wipe-right": {
          const splitX = u * W;
          ctx.drawImage(offFrom, 0, 0);
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, splitX, H);
          ctx.clip();
          ctx.drawImage(offTo, 0, 0);
          ctx.restore();
          ctx.fillStyle = accent;
          ctx.fillRect(splitX - Math.max(1.5, W * 0.002), 0, Math.max(3, W * 0.004), H);
          break;
        }
        case "crossfade":
        default:
          ctx.drawImage(offFrom, 0, 0);
          ctx.globalAlpha = u;
          ctx.drawImage(offTo, 0, 0);
          break;
      }
      ctx.restore();
    }
  }

  const scale = Math.min(W, H) / 1080;
  const slide = sample.primary;

  if (showBadge || showProgress) {
    const topH = Math.round(150 * scale);
    const topGrad = ctx.createLinearGradient(0, 0, 0, topH);
    topGrad.addColorStop(0, "rgba(7, 9, 13, 0.84)");
    topGrad.addColorStop(1, "rgba(7, 9, 13, 0)");
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, W, topH);
  }

  if (showProgress && timeline.totalDuration > 0) {
    const padX = Math.round(36 * scale);
    const barY = Math.round(22 * scale);
    const barW = W - padX * 2;
    const barH = Math.max(3, Math.round(4 * scale));
    ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
    ctx.beginPath();
    ctx.roundRect(padX, barY, barW, barH, barH / 2);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(padX, barY, barW * clamp(elapsedSec / timeline.totalDuration, 0, 1), barH, barH / 2);
    ctx.fill();
  }

  if (showBadge) {
    ctx.save();
    const fontSize = Math.max(13, Math.round(20 * scale));
    ctx.font = `700 ${fontSize}px "Bahnschrift", "Segoe UI", system-ui, sans-serif`;
    const text = slide.tag;
    const padX = Math.round(16 * scale);
    const bw = Math.min(W - Math.round(72 * scale), ctx.measureText(text).width + padX * 2);
    const bh = Math.round(40 * scale);
    const bx = Math.round(36 * scale);
    const by = Math.round(40 * scale);
    ctx.fillStyle = "rgba(11, 14, 20, 0.78)";
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, Math.round(8 * scale));
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.lineWidth = Math.max(1, 1.2 * scale);
    ctx.stroke();
    ctx.fillStyle = "#F4F6F9";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, bx + padX, by + bh * 0.52, bw - padX * 2);
    ctx.restore();
  }

  if (showSubtitles && slide.caption) {
    const capAlpha = clamp(
      smoothstep(0.05, 0.16, sample.primaryProgress) * (1 - smoothstep(0.88, 0.98, sample.primaryProgress)),
      0,
      1,
    );
    if (capAlpha > 0.02) {
      const botH = Math.round(300 * scale);
      const botGrad = ctx.createLinearGradient(0, H - botH, 0, H);
      botGrad.addColorStop(0, "rgba(7, 9, 13, 0)");
      botGrad.addColorStop(0.45, "rgba(7, 9, 13, 0.72)");
      botGrad.addColorStop(1, "rgba(7, 9, 13, 0.94)");
      ctx.fillStyle = botGrad;
      ctx.fillRect(0, H - botH, W, botH);

      ctx.save();
      ctx.globalAlpha = capAlpha;
      const fontSize = Math.max(16, Math.round(34 * scale));
      ctx.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
      const maxWidth = W * 0.84;
      const words = slide.caption.split(/\s+/);
      const wrapped: string[] = [];
      let line = "";
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && line) {
          wrapped.push(line);
          line = word;
        } else {
          line = test;
        }
      }
      if (line) wrapped.push(line);

      const lineH = Math.round(fontSize * 1.36);
      const totalH = wrapped.length * lineH;
      const startY = H - Math.round(68 * scale) - totalH + lineH * 0.5;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
      ctx.shadowBlur = Math.round(10 * scale);
      ctx.fillStyle = "#F4F6F9";
      wrapped.forEach((ln, li) => {
        ctx.fillText(ln, W * 0.5, startY + li * lineH);
      });
      ctx.restore();
    }
  }
}

export interface LocalCdpSpecPayload {
  projectName: string;
  width: number;
  height: number;
  fps: number;
  theme: {
    background: string;
    accent: string;
    textPrimary: string;
    textSecondary: string;
    showBadge: boolean;
    showSubtitles: boolean;
    showProgress: boolean;
  };
  audio: {
    mode: "synth" | "file" | "none";
    file: string | null;
    volume: number;
    fadeInSec: number;
    fadeOutSec: number;
  };
  slides: Array<{
    image: string;
    duration: number;
    fit: MotionFitMode;
    motion: ResolvedMotion;
    motionAmount: number;
    transition: ResolvedTransition;
    transitionSec: number;
    tag: string;
    caption: string;
  }>;
}

export function buildLocalCdpStoryboardSpec(
  project: NmcProject,
  timeline: MotionTimeline,
  opts: MotionRenderOptions,
  audioFileRel: string | null = null,
): LocalCdpSpecPayload {
  const audioMode =
    opts.audioMode === "none"
      ? "none"
      : audioFileRel
        ? "file"
        : opts.audioMode === "bgm"
          ? "synth"
          : "synth";

  return {
    projectName: project.name || "nmcgen",
    width: timeline.width,
    height: timeline.height,
    fps: timeline.fps,
    theme: {
      background: "#0A0C10",
      accent: "#E87D35",
      textPrimary: "#F4F6F9",
      textSecondary: "#B8C2D0",
      showBadge: opts.showBadge,
      showSubtitles: opts.showSubtitles,
      showProgress: opts.showProgress,
    },
    audio: {
      mode: audioMode,
      file: audioFileRel,
      volume: clamp(opts.audioVolume ?? 0.85, 0.05, 1.2),
      fadeInSec: 0.4,
      fadeOutSec: 0.8,
    },
    slides: timeline.slides.map((s) => ({
      image: s.fileName,
      duration: s.duration,
      fit: s.fit,
      motion: s.motion,
      motionAmount: s.motionAmount,
      transition: s.transition,
      transitionSec: s.transitionSec,
      tag: s.tag,
      caption: s.caption,
    })),
  };
}

function decodeBase64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function buildLocalMotionRenderPackZip(params: {
  project: NmcProject;
  timeline: MotionTimeline;
  options: MotionRenderOptions;
  renderScriptText: string;
}): Uint8Array {
  const { project, timeline, options, renderScriptText } = params;
  const spec = buildLocalCdpStoryboardSpec(project, timeline, options, null);
  const slug =
    project.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "nmcgen";

  const batScript = [
    "@echo off",
    "chcp 65001 >nul",
    'cd /d "%~dp0"',
    `python render_motion_cdp.py --spec storyboard.json --out "${slug}-1080p.mp4" %*`,
    "echo.",
    "pause",
    "",
  ].join("\r\n");

  const cmdScript = [
    "#!/bin/bash",
    'cd "$(dirname "$0")"',
    `python3 ./render_motion_cdp.py --spec storyboard.json --out "${slug}-1080p.mp4" "$@"`,
    'echo ""',
    'read -p "Tekan Enter untuk menutup..." _',
    "",
  ].join("\n");

  const readme = [
    `nmcGen Local MP4 Motion Render Pack (${project.name})`,
    "",
    "Cara render MP4 1080p lokal tanpa Veo/Flow:",
    "1. Ekstrak seluruh isi ZIP ini ke satu folder.",
    "2. Pastikan Python 3 (paket: websockets, numpy), Google Chrome/Edge, dan FFmpeg terpasang.",
    "3. Windows: klik dua kali render_mp4.bat",
    "   macOS/Linux: jalankan ./render_mp4.command",
    `4. Hasil video tersimpan di "${slug}-1080p.mp4" (${timeline.width}x${timeline.height}, ${timeline.fps}fps).`,
    "",
    "Opsional: tambahkan musik sendiri lewat:",
    `python render_motion_cdp.py --spec storyboard.json --audio musik.mp3 --out "${slug}-1080p.mp4"`,
    "",
  ].join("\n");

  const entries: ZipEntryInput[] = [
    { name: "storyboard.json", data: JSON.stringify(spec, null, 2) + "\n" },
    { name: "render_motion_cdp.py", data: renderScriptText },
    { name: "render_mp4.bat", data: batScript },
    { name: "render_mp4.command", data: cmdScript },
    { name: "README_RENDER.txt", data: readme },
  ];

  for (const slide of timeline.slides) {
    const dec = parseDataUrlBase64(slide.imageUrl);
    if (!dec) continue;
    const bytes = decodeBase64(dec.data);
    if (!bytes) continue;
    entries.push({ name: slide.fileName, data: bytes });
  }

  return buildZip(entries);
}

// Pick best browser MediaRecorder MIME type (prefers native H.264 MP4 on modern Chrome/Edge, else VP9 WebM).
export function pickBrowserVideoMime(): { mimeType: string; ext: "mp4" | "webm" } {
  if (typeof MediaRecorder === "undefined") {
    return { mimeType: "video/webm", ext: "webm" };
  }
  const candidates: Array<{ mimeType: string; ext: "mp4" | "webm" }> = [
    { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", ext: "mp4" },
    { mimeType: "video/mp4;codecs=avc1,mp4a.40.2", ext: "mp4" },
    { mimeType: "video/mp4", ext: "mp4" },
    { mimeType: "video/webm;codecs=vp9,opus", ext: "webm" },
    { mimeType: "video/webm;codecs=vp8,opus", ext: "webm" },
    { mimeType: "video/webm", ext: "webm" },
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mimeType)) return c;
  }
  return { mimeType: "video/webm", ext: "webm" };
}

// Synthesize subtle studio ambient pad + transition ticks in Web Audio API for browser playback & recording.
export function scheduleBrowserAmbientAudio(
  audioCtx: AudioContext,
  destination: AudioNode,
  timeline: MotionTimeline,
  volume = 0.5,
): () => void {
  const now = audioCtx.currentTime;
  const dur = Math.max(0.5, timeline.totalDuration);
  const master = audioCtx.createGain();
  const vol = clamp(volume, 0.05, 1.0) * 0.24;
  master.gain.setValueAtTime(0.0001, now);
  master.gain.linearRampToValueAtTime(vol, now + Math.min(0.4, dur * 0.2));
  master.gain.setValueAtTime(vol, Math.max(now + 0.4, now + dur - 0.75));
  master.gain.linearRampToValueAtTime(0.0001, now + dur);
  master.connect(destination);

  const oscs: OscillatorNode[] = [];
  const notes: Array<[number, number]> = [
    [110.0, 0.45],
    [164.81, 0.3],
    [220.0, 0.22],
    [277.18, 0.1],
  ];
  for (const [freq, gainVal] of notes) {
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now);
    g.gain.setValueAtTime(gainVal, now);
    osc.connect(g);
    g.connect(master);
    osc.start(now);
    osc.stop(now + dur + 0.05);
    oscs.push(osc);
  }

  for (let i = 1; i < timeline.slides.length; i++) {
    const tAt = now + timeline.slides[i].start;
    const tickOsc = audioCtx.createOscillator();
    const tickGain = audioCtx.createGain();
    tickOsc.type = "sine";
    tickOsc.frequency.setValueAtTime(1320, tAt);
    tickGain.gain.setValueAtTime(0.0001, tAt);
    tickGain.gain.linearRampToValueAtTime(vol * 0.45, tAt + 0.008);
    tickGain.gain.exponentialRampToValueAtTime(0.0001, tAt + 0.08);
    tickOsc.connect(tickGain);
    tickGain.connect(destination);
    tickOsc.start(tAt);
    tickOsc.stop(tAt + 0.1);
    oscs.push(tickOsc);
  }

  return () => {
    for (const o of oscs) {
      try {
        o.stop();
        o.disconnect();
      } catch {
        // already stopped
      }
    }
    try {
      master.disconnect();
    } catch {
      // ignore
    }
  };
}

