"use client";
// Client-side image helpers:
// 1. Strict <512x512 downscaling for Cloudflare Workers AI FLUX.2 Klein 4B references.
// 2. Storage-efficient compression (<=1280px JPEG) so multi-segment projects stay fast in IndexedDB & Supabase.
// 3. Publication-grade horizontal Storyboard Strip Sheet (.jpg) renderer per Segment.
import type { AspectRatio } from "./types";

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Gagal membaca gambar referensi."));
    img.src = src;
  });
}

/**
 * Downscales any image dataUrl so both width and height are strictly <= maxSide (default 480 < 512),
 * satisfying Cloudflare Workers AI FLUX.2's strict "< 512x512" input_image requirement.
 */
export async function downscaleImageForFlux2(dataUrl: string, maxSide = 480): Promise<string> {
  if (!dataUrl || typeof document === "undefined") return dataUrl;
  try {
    const img = await loadHtmlImage(dataUrl);
    const origW = img.naturalWidth || img.width;
    const origH = img.naturalHeight || img.height;
    if (!origW || !origH) return dataUrl;

    const scale = Math.min(1, maxSide / Math.max(origW, origH));
    // Round to even dimensions to keep encoders crisp.
    const w = Math.max(64, Math.floor((origW * scale) / 2) * 2);
    const h = Math.max(64, Math.floor((origH * scale) / 2) * 2);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    return dataUrl;
  }
}

export async function prepareFlux2References(dataUrls: string[], maxCount = 3): Promise<string[]> {
  const unique = dataUrls.filter(Boolean).slice(0, maxCount);
  return Promise.all(unique.map((url) => downscaleImageForFlux2(url, 480)));
}

/**
 * Compresses generated/uploaded images to crisp <=1280px JPEG (~90-180KB) so multi-segment
 * projects (15-25 panels + assets) sync reliably with Supabase and Cloudflare Workers.
 */
export async function compressImageForStorage(
  dataUrl: string,
  options: { maxSide?: number; quality?: number } = {},
): Promise<string> {
  if (!dataUrl || typeof document === "undefined") return dataUrl;
  const maxSide = options.maxSide ?? 1280;
  const quality = options.quality ?? 0.84;
  try {
    const img = await loadHtmlImage(dataUrl);
    const origW = img.naturalWidth || img.width;
    const origH = img.naturalHeight || img.height;
    if (!origW || !origH) return dataUrl;

    const scale = Math.min(1, maxSide / Math.max(origW, origH));
    const w = Math.max(64, Math.round(origW * scale));
    const h = Math.max(64, Math.round(origH * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.fillStyle = "#111318";
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);

    const compressed = canvas.toDataURL("image/jpeg", quality);
    // Keep compressed version if it resized down OR genuinely saved bytes
    if (scale < 1 || compressed.length < dataUrl.length) {
      return compressed;
    }
    return dataUrl;
  } catch {
    return dataUrl;
  }
}

export interface StripExportPanel {
  panelNumber: number;
  title: string;
  imageDataUrl: string | null;
}

/**
 * Renders one Segment's 4-7 panels into a crisp, high-resolution horizontal Storyboard Strip Sheet JPEG
 * matching the classic paper-sheet layout (ink panel borders, thin vertical dividers, uppercase PANEL N captions).
 */
export async function renderSegmentStripImageBlob(params: {
  segmentIndex: number;
  segmentTitle: string;
  locationHint?: string;
  aspectRatio: AspectRatio;
  panels: StripExportPanel[];
}): Promise<Blob> {
  const { segmentIndex, segmentTitle, locationHint, aspectRatio, panels } = params;
  const count = Math.max(1, panels.length);

  const cellW = aspectRatio === "9:16" ? 340 : 440;
  const cellH = aspectRatio === "9:16" ? 510 : 260;
  const marginX = 64;
  const gapX = 42;
  const headerH = 92;
  const captionH = 74;
  const bottomPad = 24;

  const width = marginX * 2 + count * cellW + (count - 1) * gapX;
  const height = headerH + cellH + captionH + bottomPad;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D tidak tersedia di browser ini.");

  // Warm ivory storyboard paper background
  ctx.fillStyle = "#f4f0e7";
  ctx.fillRect(0, 0, width, height);

  // Header bar text & subtle bottom rule
  const segLabel = `SEGMEN ${String(segmentIndex).padStart(2, "0")} — ${(segmentTitle || `Segmen ${segmentIndex}`).toUpperCase()}`;
  const metaLabel = `${count} PANEL BERURUTAN${locationHint ? `  ·  ${locationHint.toUpperCase()}` : ""}  ·  NMCGEN STORYBOARD`;

  ctx.fillStyle = "#1c1f26";
  ctx.font = "700 22px system-ui, -apple-system, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(segLabel, marginX, 38);

  ctx.fillStyle = "#6c665c";
  ctx.font = "600 14px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(metaLabel, width - marginX, 38);

  ctx.strokeStyle = "#d6d0c4";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(marginX, 66);
  ctx.lineTo(width - marginX, 66);
  ctx.stroke();

  // Preload panel images in parallel
  const loadedImgs = await Promise.all(
    panels.map(async (p) => {
      if (!p.imageDataUrl) return null;
      try {
        return await loadHtmlImage(p.imageDataUrl);
      } catch {
        return null;
      }
    }),
  );

  const topY = headerH;
  for (let i = 0; i < count; i++) {
    const p = panels[i];
    const im = loadedImgs[i];
    const x = marginX + i * (cellW + gapX);

    // Subtle sheet drop shadow
    ctx.fillStyle = "#d8d3c8";
    ctx.fillRect(x + 4, topY + 5, cellW, cellH);

    // Panel image (cover crop) or clean dark placeholder
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, topY, cellW, cellH);
    ctx.clip();

    if (im && im.naturalWidth > 0 && im.naturalHeight > 0) {
      const scale = Math.max(cellW / im.naturalWidth, cellH / im.naturalHeight);
      const dw = im.naturalWidth * scale;
      const dh = im.naturalHeight * scale;
      const dx = x + (cellW - dw) / 2;
      const dy = topY + (cellH - dh) / 2;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(im, dx, dy, dw, dh);
    } else {
      ctx.fillStyle = "#181b22";
      ctx.fillRect(x, topY, cellW, cellH);
      ctx.fillStyle = "#9ba3b0";
      ctx.font = "600 16px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`PANEL ${p.panelNumber} (Belum digambar)`, x + cellW / 2, topY + cellH / 2);
    }
    ctx.restore();

    // Crisp dark ink border
    ctx.strokeStyle = "#1c1f26";
    ctx.lineWidth = 3.5;
    ctx.strokeRect(x, topY, cellW, cellH);

    // Signature thin vertical hairline divider between adjacent panels
    if (i < count - 1) {
      const dx = x + cellW + gapX / 2;
      ctx.strokeStyle = "rgba(28, 31, 38, 0.28)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(dx, topY - 12);
      ctx.lineTo(dx, topY + cellH + 54);
      ctx.stroke();
    }

    // Centered uppercase caption beneath panel (fit cleanly inside cellW)
    const rawCaption = `PANEL ${p.panelNumber}: ${(p.title || `Panel ${p.panelNumber}`).toUpperCase()}`;
    ctx.fillStyle = "#1c1f26";
    let fontSize = 16;
    ctx.font = `800 ${fontSize}px system-ui, -apple-system, sans-serif`;
    while (ctx.measureText(rawCaption).width > cellW - 8 && fontSize > 11) {
      fontSize -= 1;
      ctx.font = `800 ${fontSize}px system-ui, -apple-system, sans-serif`;
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(rawCaption, x + cellW / 2, topY + cellH + 22);
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Gagal mengekspor gambar papan strip."));
      },
      "image/jpeg",
      0.94,
    );
  });
}
