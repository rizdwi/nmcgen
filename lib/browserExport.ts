"use client";
// Browser-only WebM preview exporter (Canvas + MediaRecorder) for Web/Vercel fallback.
import type { AudioNodeData, NmcProject, SegmentNodeData } from "./types";
import { resolutionFor } from "./presets";
import { getAdoptedMedia, getConnectedAudio, getOrderedSegments, getPrimaryScript } from "./validator";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Gagal memuat gambar segmen."));
    img.src = src;
  });
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  zoom: number,
  panX = 0,
) {
  const ir = img.width / Math.max(1, img.height);
  const cr = w / h;
  let dw = w * zoom;
  let dh = h * zoom;
  if (ir > cr) {
    dh = h * zoom;
    dw = dh * ir;
  } else {
    dw = w * zoom;
    dh = dw / ir;
  }
  const dx = (w - dw) / 2 + panX;
  const dy = (h - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
}

function drawSubtitle(ctx: CanvasRenderingContext2D, text: string, w: number, h: number) {
  if (!text.trim()) return;
  const fontSize = Math.round(h * 0.042);
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const maxWidth = w * 0.84;
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);

  const lineHeight = fontSize * 1.28;
  const bottomY = h - Math.round(h * 0.075);
  lines.forEach((line, i) => {
    const y = bottomY - (lines.length - 1 - i) * lineHeight;
    ctx.lineWidth = Math.max(3, Math.round(fontSize * 0.14));
    ctx.strokeStyle = "rgba(10, 12, 16, 0.92)";
    ctx.strokeText(line, w / 2, y);
    ctx.fillStyle = "#f4f1ea";
    ctx.fillText(line, w / 2, y);
  });
}

function startProceduralAmbientTrack(
  volume: number,
  totalSec: number,
): { stream: MediaStream; stop: () => void } | null {
  if (typeof AudioContext === "undefined") return null;
  try {
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const sampleRate = audioCtx.sampleRate;
    const bufLen = Math.max(sampleRate * 2, Math.floor(sampleRate * Math.min(totalSec + 1, 8)));
    const noiseBuf = audioCtx.createBuffer(1, bufLen, sampleRate);
    const ch = noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < bufLen; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.03 * white) / 1.03;
      ch[i] = last * 2.2;
    }
    const src = audioCtx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;

    const filter = audioCtx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 900;

    const gain = audioCtx.createGain();
    gain.gain.value = Math.max(0.03, Math.min(0.35, volume || 0.14));

    src.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    src.start();

    return {
      stream: dest.stream,
      stop: () => {
        try {
          src.stop();
          void audioCtx.close();
        } catch {
          // Ignore already-closed AudioContext
        }
      },
    };
  } catch {
    return null;
  }
}

export async function renderBrowserWebm(
  project: NmcProject,
  onProgress?: (pct: number, label: string) => void,
): Promise<{ blob: Blob; durationSec: number; resolution: string }> {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("Browser ini tidak mendukung MediaRecorder untuk ekspor WebM.");
  }
  const script = getPrimaryScript(project);
  const ratio = script?.aspectRatio ?? "16:9";
  const { width, height } = resolutionFor(ratio);
  const segs = getOrderedSegments(project);
  if (!segs.length) throw new Error("Tidak ada segmen yang terhubung ke Timeline.");

  const assembly = project.nodes.find((n) => n.kind === "assembly");
  const burnSub = assembly?.data.kind === "assembly" ? assembly.data.burnSubtitles : true;
  const connectedAudio = getConnectedAudio(project);
  const ambientNode = connectedAudio.find(
    (a) => a.data.kind === "audio" && (a.data as AudioNodeData).sourceMode === "ambient-rain",
  );
  const fps = 24;

  const prepared: {
    seg: SegmentNodeData;
    title: string;
    img: HTMLImageElement | null;
  }[] = [];

  for (const node of segs) {
    const seg = node.data as SegmentNodeData;
    const media = getAdoptedMedia(seg);
    let img: HTMLImageElement | null = null;
    if (media && media.kind === "image") {
      try {
        img = await loadImage(media.dataUrl);
      } catch {
        img = null;
      }
    }
    prepared.push({ seg, title: node.title, img });
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Gagal membuat konteks Canvas 2D.");

  const totalSec = prepared.reduce((acc, item) => acc + Math.max(1, item.seg.durationSec), 0);
  const videoStream = canvas.captureStream(fps);
  const ambientTrack = ambientNode
    ? startProceduralAmbientTrack((ambientNode.data as AudioNodeData).volume, totalSec)
    : null;
  const combinedStream = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...(ambientTrack ? ambientTrack.stream.getAudioTracks() : []),
  ]);

  const mime = ambientTrack
    ? MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
        ? "video/webm;codecs=vp8,opus"
        : "video/webm"
    : MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";
  const recorder = new MediaRecorder(combinedStream, { mimeType: mime, videoBitsPerSecond: 3_500_000 });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data.size > 0) chunks.push(ev.data);
  };

  const done = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      ambientTrack?.stop();
      resolve(new Blob(chunks, { type: mime }));
    };
    recorder.onerror = () => {
      ambientTrack?.stop();
      reject(new Error("Gagal merekam video WebM di browser."));
    };
  });

  recorder.start();

  let elapsed = 0;
  for (let i = 0; i < prepared.length; i++) {
    const { seg, title, img } = prepared[i];
    const dur = Math.max(1, seg.durationSec);
    const totalFrames = Math.round(dur * fps);
    onProgress?.(Math.round((elapsed / totalSec) * 100), `Merender ${seg.code} (${i + 1}/${prepared.length})`);

    for (let f = 0; f < totalFrames; f++) {
      const t = totalFrames > 1 ? f / (totalFrames - 1) : 0;
      ctx.fillStyle = "#0d0f12";
      ctx.fillRect(0, 0, width, height);

      if (img) {
        const zoom =
          seg.cameraMotion === "Pull-Out"
            ? 1.08 - 0.08 * t
            : seg.cameraMotion === "Push-In"
              ? 1.0 + 0.08 * t
              : 1.04;
        const panX =
          seg.cameraMotion === "Pan Right"
            ? -24 * t + 12
            : seg.cameraMotion === "Pan Left"
              ? 24 * t - 12
              : 0;
        drawCover(ctx, img, width, height, zoom, panX);
      } else {
        // Honest visual slate card when segment has no image yet
        ctx.fillStyle = "#15181e";
        ctx.fillRect(48, 48, width - 96, height - 96);
        ctx.strokeStyle = "#464f60";
        ctx.lineWidth = 2;
        ctx.strokeRect(48, 48, width - 96, height - 96);
        ctx.fillStyle = "#f2ae54";
        ctx.font = `700 ${Math.round(height * 0.045)}px system-ui, sans-serif`;
        ctx.textAlign = "left";
        ctx.fillText(`${seg.code} · ${title}`, 84, Math.round(height * 0.24));
        ctx.fillStyle = "#f1ede6";
        ctx.font = `500 ${Math.round(height * 0.028)}px system-ui, sans-serif`;
        ctx.fillText(`Shot: ${seg.shotSize} | Angle: ${seg.cameraAngle} | Gerak: ${seg.cameraMotion}`, 84, Math.round(height * 0.32));
        ctx.fillStyle = "#a5adbc";
        const snippet = (seg.timelineText || "Belum ada gambar/klip media terpasang.").slice(0, 120);
        ctx.fillText(snippet, 84, Math.round(height * 0.42));
      }

      // Smooth fade-in on first 0.35s and fade-out on last 0.45s of final segment.
      const fadeInAlpha = f < 8 ? 1 - f / 8 : 0;
      const fadeOutAlpha = i === prepared.length - 1 && f > totalFrames - 12 ? (f - (totalFrames - 12)) / 12 : 0;
      const dim = Math.max(fadeInAlpha, fadeOutAlpha);
      if (dim > 0.01) {
        ctx.fillStyle = `rgba(8, 10, 14, ${Math.min(1, dim).toFixed(3)})`;
        ctx.fillRect(0, 0, width, height);
      }

      if (burnSub && seg.dialogue.trim()) {
        drawSubtitle(ctx, seg.dialogue, width, height);
      }

      await new Promise((r) => setTimeout(r, Math.round(1000 / fps)));
    }
    elapsed += dur;
  }

  recorder.stop();
  onProgress?.(100, "Menyusun berkas WebM...");
  const blob = await done;
  return { blob, durationSec: totalSec, resolution: `${width}x${height}` };
}
