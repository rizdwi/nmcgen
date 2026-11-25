"use client";
// Client-side image helpers for Cloudflare FLUX.2 (all input_image_N MUST be < 512x512).

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
