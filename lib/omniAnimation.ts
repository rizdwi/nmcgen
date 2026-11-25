// Storyboard-to-Animation engine for Antigravity, Gemini, Google Flow/Vids, and Gemini Omni 1.2 Flash Interactions API.
import type {
  AspectRatio,
  NmcProject,
  OmniAnimationMode,
  OmniResolution,
  StoryFrame,
  StorySegment,
} from "./types.ts";
import {
  CAMERA_ANGLE_META,
  ensureStoryboard,
  getSelectedAssetImage,
  getSelectedFrameImage,
  getStoryboardSegments,
  reindexStoryboardFrames,
  SHOT_SIZE_META,
} from "./storyboard.ts";
import { buildZip, type ZipEntryInput } from "./zip.ts";

export const OMNI_MODEL_ID = "gemini-omni-1.2-flash";
export const OMNI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const OMNI_FILES_PREFIX = "https://generativelanguage.googleapis.com/v1beta/files/";

export const ANIMATION_APP_LINKS = {
  gemini: "https://gemini.google.com/app",
  googleFlow: "https://labs.google/fx/tools/flow",
  googleVids: "https://workspace.google.com/products/vids/",
  aiStudio: "https://aistudio.google.com/apikey",
} as const;

export const OMNI_RESOLUTIONS: Array<{ value: OmniResolution; label: string; hint: string }> = [
  { value: "360p", label: "360p (Draft Cepat)", hint: "Paling cepat & hemat untuk cek gerak" },
  { value: "720p", label: "720p (Standar)", hint: "Default Omni 1.2 (~$0.07/detik)" },
  { value: "1080p", label: "1080p (Full HD)", hint: "Upscale tajam 1920×1080 / 1080×1920" },
  { value: "4k", label: "4K (Ultra HD)", hint: "Kualitas tertinggi, proses lebih lama" },
];

export interface OmniInputImage {
  label: string;
  fileName: string;
  dataUrl: string;
}

export interface OmniClipPlan {
  id: string;
  label: string;
  mode: OmniAnimationMode;
  segmentId?: string;
  segmentIndex: number;
  frameIds: string[];
  durationSec: number;
  resolution: OmniResolution;
  aspectRatio: AspectRatio;
  images: OmniInputImage[];
  prompt: string;
  summary: string;
}

export function clampOmniDuration(seconds: number | undefined, mode: OmniAnimationMode | "extend"): number {
  const maxSec = mode === "transition" || mode === "extend" ? 10 : 15;
  const fallback = mode === "transition" ? 6 : mode === "segment" ? 12 : 6;
  const v = Math.round(Number(seconds) || fallback);
  return Math.max(3, Math.min(maxSec, v));
}

export function validateGoogleFileUri(uri: string): { ok: true; fileName: string; normalizedUrl: string } | { ok: false; error: string } {
  const trimmed = String(uri || "").trim();
  const m = trimmed.match(
    /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/(files\/[A-Za-z0-9._-]+)(?::download(?:\?alt=media)?)?$/,
  );
  if (!m) {
    return {
      ok: false,
      error: "URI berkas tidak valid (harus berasal dari Google Gemini Files API).",
    };
  }
  const fileName = m[1];
  return {
    ok: true,
    fileName,
    normalizedUrl: `https://generativelanguage.googleapis.com/v1beta/${fileName}`,
  };
}

export function parseDataUrlBase64(dataUrl: string): { mimeType: string; data: string; ext: string } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!m) return null;
  const mimeType = m[1].trim().toLowerCase();
  const data = m[2].replace(/\s+/g, "");
  const ext = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
  return { mimeType, data, ext };
}

function cleanLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function buildSegmentTimestampPrompt(params: {
  segment: StorySegment;
  frames: StoryFrame[];
  durationSec: number;
  visualStyle: string;
  imageCount: number;
}): string {
  const { segment, frames, durationSec, visualStyle, imageCount } = params;
  const count = Math.max(1, frames.length);
  const lines: string[] = [];

  if (imageCount === 1) {
    lines.push(
      `Use the attached image as the starting frame and visual reference. Animate this ${durationSec}-second cinematic scene in the exact style (${visualStyle}), keeping character likeness, wardrobe, lighting, and location completely consistent.`,
    );
  } else if (imageCount === 2) {
    lines.push(
      `Use the first image as the starting frame and the second image as the final frame, smoothly animating this ${durationSec}-second sequence in the exact style (${visualStyle}) while keeping character faces, clothing, and setting consistent.`,
    );
  } else {
    lines.push(
      `Use the ${imageCount} attached images in order as storyboard keyframes and character/environment visual references for this cohesive ${durationSec}-second sequence in the exact style (${visualStyle}). Preserve exact character faces, outfits, props, and lighting smoothly across every beat without jarring jump cuts.`,
    );
  }

  lines.push(`Scene: ${segment.title}${segment.locationHint ? ` (${segment.locationHint})` : ""}.`);

  const beatLines: string[] = [];
  for (let i = 0; i < count; i++) {
    const f = frames[i];
    const t0 = Math.floor((i * durationSec) / count);
    const t1 = i === count - 1 ? durationSec : Math.max(t0 + 1, Math.floor(((i + 1) * durationSec) / count));
    const shot = SHOT_SIZE_META[f.shotSize]?.en || "medium shot";
    const angle = CAMERA_ANGLE_META[f.cameraAngle]?.en || "eye-level angle";
    const visual = cleanLine(f.visualPrompt || f.sceneSummary || f.title);
    const dlg = f.dialogue.trim() ? ` Spoken Indonesian dialogue with natural lip-sync: "${cleanLine(f.dialogue)}".` : "";
    beatLines.push(`[${t0}-${t1}s] ${shot}, ${angle}. ${visual}.${dlg}`);
  }
  lines.push(...beatLines);

  const hasDialogue = frames.some((f) => Boolean(f.dialogue.trim()));
  lines.push(
    hasDialogue
      ? "Audio: Clear natural Indonesian voice acting matching lip movement, gentle matching ambient soundscape, subtle warm cinematic score, no on-screen text or subtitles."
      : "Audio: Natural atmospheric sound effects matching the environment and movement, subtle cinematic background score, no spoken dialogue, no on-screen text.",
  );

  return lines.join(" ");
}

function buildTransitionPrompt(params: {
  fromFrame: StoryFrame;
  toFrame: StoryFrame;
  durationSec: number;
  visualStyle: string;
}): string {
  const { fromFrame, toFrame, durationSec, visualStyle } = params;
  const fromDesc = cleanLine(fromFrame.visualPrompt || fromFrame.sceneSummary || fromFrame.title);
  const toDesc = cleanLine(toFrame.visualPrompt || toFrame.sceneSummary || toFrame.title);
  const toShot = SHOT_SIZE_META[toFrame.shotSize]?.en || "medium shot";
  const toAngle = CAMERA_ANGLE_META[toFrame.cameraAngle]?.en || "eye-level angle";
  const dialogue = cleanLine(fromFrame.dialogue || toFrame.dialogue);

  const parts = [
    `Use the first image as the starting frame and the second image as the final frame.`,
    `In a single continuous ${durationSec}-second shot with smooth natural camera movement and no unwanted jump cuts, transition seamlessly from "${fromFrame.title}" (${fromDesc}) into "${toFrame.title}" (${toShot}, ${toAngle}: ${toDesc}).`,
    `Maintain exact character identity, clothing, lighting, and ${visualStyle} aesthetic throughout.`,
    dialogue
      ? `Audio: Natural Indonesian dialogue "${dialogue}" with accurate lip-sync and realistic ambient sound, no on-screen text.`
      : `Audio: Realistic ambient environmental sound and subtle cinematic score, no dialogue, no on-screen text.`,
  ];
  return parts.join(" ");
}

function buildSinglePanelPrompt(params: {
  frame: StoryFrame;
  durationSec: number;
  visualStyle: string;
}): string {
  const { frame, durationSec, visualStyle } = params;
  const shot = SHOT_SIZE_META[frame.shotSize]?.en || "medium shot";
  const angle = CAMERA_ANGLE_META[frame.cameraAngle]?.en || "eye-level angle";
  const desc = cleanLine(frame.visualPrompt || frame.sceneSummary || frame.title);
  const dialogue = cleanLine(frame.dialogue);

  const parts = [
    `Use this image as the starting frame. In a single unbroken ${durationSec}-second continuous shot (${shot}, ${angle}) with gentle cinematic camera motion and natural physics, animate: ${desc}.`,
    `Preserve exact character appearance, wardrobe, and ${visualStyle} look.`,
    dialogue
      ? `Audio: Natural Indonesian spoken line "${dialogue}" with clear lip-sync and matching ambient sounds, no on-screen text.`
      : `Audio: Subtle atmospheric ambient sound effects matching the scene, no spoken dialogue, no on-screen text.`,
  ];
  return parts.join(" ");
}

/**
 * Builds an ordered list of Omni 1.2 Flash animation clip plans directly from the project's
 * Per-Segment 4-7 Panel storyboard.
 */
export function buildOmniClipPlans(
  project: NmcProject,
  options: {
    mode: OmniAnimationMode;
    durationSec?: number;
    resolution?: OmniResolution;
  },
): OmniClipPlan[] {
  const sb = ensureStoryboard(project);
  const segments = getStoryboardSegments(sb);
  const ordered = reindexStoryboardFrames(sb.frames, segments);
  const resolution: OmniResolution = options.resolution ?? "720p";
  const durationSec = clampOmniDuration(options.durationSec, options.mode);

  const plans: OmniClipPlan[] = [];

  if (options.mode === "segment") {
    segments.forEach((seg) => {
      const segFrames = ordered.filter((f) => f.segmentId === seg.id);
      if (segFrames.length === 0) return;

      // Omni 1.2 Flash accepts up to 6 reference images per request.
      const images: OmniInputImage[] = [];
      segFrames.forEach((f, idx) => {
        const img = getSelectedFrameImage(f);
        if (!img || images.length >= 6) return;
        const pNum = f.panelNumber ?? idx + 1;
        const dec = parseDataUrlBase64(img);
        images.push({
          label: `S${seg.index} · Panel ${pNum}: ${f.title}`,
          fileName: `keyframes/S${String(seg.index).padStart(2, "0")}_P${String(pNum).padStart(2, "0")}.${dec?.ext || "jpg"}`,
          dataUrl: img,
        });
      });

      // If segment has <= 1 panel image and we have approved character reference images, add up to 2 character refs (<= 6 total)
      if (images.length < 6) {
        const charIds = new Set(segFrames.flatMap((f) => f.assetIds));
        const chars = sb.assets.filter((a) => a.category === "character" && charIds.has(a.id));
        for (const ch of chars) {
          if (images.length >= 6) break;
          const img = getSelectedAssetImage(ch);
          if (!img) continue;
          const dec = parseDataUrlBase64(img);
          const slug = ch.name.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "char";
          images.push({
            label: `Aset ACC: ${ch.name}`,
            fileName: `assets/${slug}.${dec?.ext || "jpg"}`,
            dataUrl: img,
          });
        }
      }

      // First + last frame mode in Omni 1.2 caps at 10s; if exactly 2 images are sent, keep duration <= 10s safely.
      const safeDuration = images.length === 2 ? Math.min(durationSec, 10) : durationSec;
      const prompt = buildSegmentTimestampPrompt({
        segment: seg,
        frames: segFrames,
        durationSec: safeDuration,
        visualStyle: sb.visualStyle,
        imageCount: images.length,
      });

      plans.push({
        id: `seg-${seg.id}`,
        label: `Segmen ${String(seg.index).padStart(2, "0")}: ${seg.title}`,
        mode: "segment",
        segmentId: seg.id,
        segmentIndex: seg.index,
        frameIds: segFrames.map((f) => f.id),
        durationSec: safeDuration,
        resolution,
        aspectRatio: sb.aspectRatio,
        images,
        prompt,
        summary: `${segFrames.length} panel berurutan · ${images.length} gambar acuan`,
      });
    });
    return plans;
  }

  if (options.mode === "transition") {
    segments.forEach((seg) => {
      const segFrames = ordered.filter((f) => f.segmentId === seg.id);
      if (segFrames.length === 0) return;

      if (segFrames.length === 1) {
        const f = segFrames[0];
        const img = getSelectedFrameImage(f);
        const dec = img ? parseDataUrlBase64(img) : null;
        plans.push({
          id: `tr-${f.id}`,
          label: `S${seg.index} · Panel ${f.panelNumber ?? 1}: ${f.title}`,
          mode: "transition",
          segmentId: seg.id,
          segmentIndex: seg.index,
          frameIds: [f.id],
          durationSec,
          resolution,
          aspectRatio: sb.aspectRatio,
          images: img
            ? [
                {
                  label: `Panel ${f.panelNumber ?? 1}: ${f.title}`,
                  fileName: `keyframes/S${String(seg.index).padStart(2, "0")}_P${String(f.panelNumber ?? 1).padStart(2, "0")}.${dec?.ext || "jpg"}`,
                  dataUrl: img,
                },
              ]
            : [],
          prompt: buildSinglePanelPrompt({ frame: f, durationSec, visualStyle: sb.visualStyle }),
          summary: "Single panel (1 keyframe)",
        });
        return;
      }

      for (let i = 0; i < segFrames.length - 1; i++) {
        const a = segFrames[i];
        const b = segFrames[i + 1];
        const pA = a.panelNumber ?? i + 1;
        const pB = b.panelNumber ?? i + 2;
        const imgA = getSelectedFrameImage(a);
        const imgB = getSelectedFrameImage(b);
        const images: OmniInputImage[] = [];
        if (imgA) {
          const dec = parseDataUrlBase64(imgA);
          images.push({
            label: `Start: Panel ${pA} (${a.title})`,
            fileName: `keyframes/S${String(seg.index).padStart(2, "0")}_P${String(pA).padStart(2, "0")}.${dec?.ext || "jpg"}`,
            dataUrl: imgA,
          });
        }
        if (imgB) {
          const dec = parseDataUrlBase64(imgB);
          images.push({
            label: `End: Panel ${pB} (${b.title})`,
            fileName: `keyframes/S${String(seg.index).padStart(2, "0")}_P${String(pB).padStart(2, "0")}.${dec?.ext || "jpg"}`,
            dataUrl: imgB,
          });
        }

        plans.push({
          id: `tr-${a.id}-${b.id}`,
          label: `S${seg.index} · Panel ${pA} → Panel ${pB}: ${a.title} → ${b.title}`,
          mode: "transition",
          segmentId: seg.id,
          segmentIndex: seg.index,
          frameIds: [a.id, b.id],
          durationSec,
          resolution,
          aspectRatio: sb.aspectRatio,
          images,
          prompt: buildTransitionPrompt({
            fromFrame: a,
            toFrame: b,
            durationSec,
            visualStyle: sb.visualStyle,
          }),
          summary: `Interpolasi First→Last Frame (${durationSec} dtk)`,
        });
      }
    });
    return plans;
  }

  // Per-Panel Image-to-Video mode
  segments.forEach((seg) => {
    const segFrames = ordered.filter((f) => f.segmentId === seg.id);
    segFrames.forEach((f, idx) => {
      const pNum = f.panelNumber ?? idx + 1;
      const img = getSelectedFrameImage(f);
      const dec = img ? parseDataUrlBase64(img) : null;
      plans.push({
        id: `panel-${f.id}`,
        label: `S${seg.index} · Panel ${pNum}: ${f.title}`,
        mode: "panel",
        segmentId: seg.id,
        segmentIndex: seg.index,
        frameIds: [f.id],
        durationSec,
        resolution,
        aspectRatio: sb.aspectRatio,
        images: img
          ? [
              {
                label: `Panel ${pNum}: ${f.title}`,
                fileName: `keyframes/S${String(seg.index).padStart(2, "0")}_P${String(pNum).padStart(2, "0")}.${dec?.ext || "jpg"}`,
                dataUrl: img,
              },
            ]
          : [],
        prompt: buildSinglePanelPrompt({ frame: f, durationSec, visualStyle: sb.visualStyle }),
        summary: `Image-to-Video (${durationSec} dtk · ${f.shotSize})`,
      });
    });
  });

  return plans;
}

/**
 * Builds the exact verified JSON request body for Google's Gemini Omni 1.2 Flash Interactions API
 * (`POST https://generativelanguage.googleapis.com/v1beta/interactions`).
 */
export function buildOmniInteractionsPayload(params: {
  prompt: string;
  images?: Array<{ mimeType: string; data: string }>;
  durationSec: number;
  resolution: OmniResolution;
  aspectRatio: AspectRatio;
  previousInteractionId?: string;
  mode?: OmniAnimationMode | "extend";
  delivery?: "uri" | "inline";
}): Record<string, unknown> {
  const safeDuration = clampOmniDuration(params.durationSec, params.mode ?? "segment");
  const cleanPrompt = params.prompt.trim();

  let input: unknown;
  if (params.images && params.images.length > 0) {
    const parts: Array<Record<string, string>> = params.images.slice(0, 6).map((img) => ({
      type: "image",
      mime_type: img.mimeType,
      data: img.data,
    }));
    parts.push({ type: "text", text: cleanPrompt });
    input = parts;
  } else {
    input = cleanPrompt;
  }

  const payload: Record<string, unknown> = {
    model: OMNI_MODEL_ID,
    input,
    response_format: {
      type: "video",
      delivery: params.delivery ?? "uri",
      duration: `${safeDuration}s`,
      resolution: params.resolution,
      aspect_ratio: params.aspectRatio,
    },
    background: true,
    store: true,
  };

  if (params.previousInteractionId?.trim()) {
    payload.previous_interaction_id = params.previousInteractionId.trim();
  }

  return payload;
}

export interface ParsedOmniInteraction {
  id: string;
  status: string;
  done: boolean;
  failed: boolean;
  videoBase64?: string;
  videoMime?: string;
  fileUri?: string;
  error?: string;
}

/**
 * Robustly extracts status, inline base64 MP4, or Files API URI from a Gemini Interactions API response
 * (supports both REST `steps[].content[]` and `outputs[]` / `output_video` shapes).
 */
export function extractOmniVideoFromInteraction(raw: unknown): ParsedOmniInteraction {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = String(obj.id || obj.name || "").trim();
  const status = String(obj.status || "unknown").toLowerCase();
  const errObj = obj.error as Record<string, unknown> | string | undefined;
  const errFromSteps = (() => {
    if (!Array.isArray(obj.steps)) return undefined;
    for (const step of obj.steps) {
      if (!step || typeof step !== "object") continue;
      const s = step as Record<string, unknown>;
      const se = s.error as Record<string, unknown> | string | undefined;
      if (typeof se === "string" && se.trim()) return se;
      if (se && typeof se === "object") {
        const m = se.message || se.reason;
        if (typeof m === "string" && m.trim()) return m;
      }
      for (const key of ["failureReason", "failure_reason", "reason"]) {
        const v = s[key];
        if (typeof v === "string" && v.trim()) return v;
      }
    }
    return undefined;
  })();
  const topReason = [obj.failureReason, obj.failure_reason, obj.reason].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  const errorMsg =
    typeof errObj === "string"
      ? errObj
      : errObj && typeof errObj === "object"
        ? String(errObj.message || JSON.stringify(errObj))
        : (errFromSteps ?? topReason);

  let videoBase64: string | undefined;
  let videoMime: string | undefined;
  let fileUri: string | undefined;

  const inspectContentItem = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    const part = item as Record<string, unknown>;
    const pType = String(part.type || "").toLowerCase();
    const mime = String(part.mime_type || part.mimeType || "").toLowerCase();
    if (pType === "video" || mime.startsWith("video/")) {
      if (!fileUri && typeof part.uri === "string" && part.uri.trim()) {
        fileUri = part.uri.trim();
      }
      if (!videoBase64 && typeof part.data === "string" && part.data.trim()) {
        videoBase64 = part.data.trim();
        videoMime = mime || "video/mp4";
      }
    }
  };

  // Official REST structure: steps[] -> { type: "model_output", content: [{ type: "video", uri | data }] }
  if (Array.isArray(obj.steps)) {
    for (const step of obj.steps) {
      if (!step || typeof step !== "object") continue;
      const s = step as Record<string, unknown>;
      if (Array.isArray(s.content)) {
        for (const item of s.content) inspectContentItem(item);
      }
    }
  }

  // Alternate / SDK-serialized outputs[] or output_video
  if (Array.isArray(obj.outputs)) {
    for (const item of obj.outputs) inspectContentItem(item);
  }
  if (obj.output_video && typeof obj.output_video === "object") {
    inspectContentItem({ type: "video", ...(obj.output_video as Record<string, unknown>) });
  }

  const failed = status === "failed" || status === "cancelled" || status === "canceled" || Boolean(errorMsg);
  const done = status === "completed" || status === "succeeded" || Boolean(videoBase64 || fileUri);

  return {
    id,
    status,
    done,
    failed,
    videoBase64,
    videoMime: videoMime || "video/mp4",
    fileUri,
    // Jangan pernah menelan alasan kegagalan: tanpa ini UI hanya bisa
    // menampilkan "Generasi video Omni 1.2 gagal." tanpa penyebab.
    error: errorMsg ?? (failed ? `Status interaksi Omni 1.2: ${status || "tidak diketahui"}` : undefined),
  };
}

/**
 * Generates a ready-to-paste Master Prompt for Antigravity or Gemini chat to animate the entire storyboard.
 */
export function buildAntigravityGeminiHandoff(project: NmcProject, plans: OmniClipPlan[]): string {
  const sb = ensureStoryboard(project);
  const segments = getStoryboardSegments(sb);
  const totalSec = plans.reduce((s, p) => s + p.durationSec, 0);

  const lines: string[] = [
    `# Permintaan Animasi Storyboard (Antigravity / Gemini / Omni 1.2 Flash)`,
    "",
    `Tolong animasikan seluruh storyboard proyek **"${project.name}"** menjadi video sinematik lengkap dengan audio & dialog yang tersinkronisasi.`,
    "",
    `- **Gaya Visual Wajib:** ${sb.visualStyle}`,
    `- **Rasio:** ${sb.aspectRatio} · **Total Segmen:** ${segments.length} · **Total Klip Rencana:** ${plans.length} (~${totalSec} detik)`,
    `- **Target Model Video:** \`${OMNI_MODEL_ID}\` (Gemini Omni 1.2 Flash — mendukung 3–15 dtk/klip, interpolasi First→Last Frame 3–10 dtk, dan hingga 6 gambar acuan per klip)`,
    "",
    `## Instruksi Kerja`,
    `1. Gunakan file keyframe pada folder \`keyframes/\` (dan acuan karakter ACC pada \`assets/\`) dari paket ZIP terlampir agar wajah, pakaian, dan pencahayaan tetap 100% konsisten.`,
    `2. Animasikan setiap klip di bawah secara berurutan menggunakan \`${OMNI_MODEL_ID}\` (atau FFmpeg + TTS + gerak kamera sinematik jika berjalan lokal di Antigravity).`,
    `3. Gabungkan seluruh klip menjadi satu video MP4 utuh beresolusi 1080p dengan transisi halus dan audio seimbang.`,
    "",
    `## Daftar Klip & Prompt Siap Jalan`,
  ];

  plans.forEach((plan, idx) => {
    lines.push(
      "",
      `### Klip ${String(idx + 1).padStart(2, "0")} — ${plan.label} (${plan.durationSec} dtk · ${plan.resolution})`,
      `- **Gambar Input (${plan.images.length}):** ${plan.images.map((im) => `\`${im.fileName}\``).join(", ") || "(Text-to-Video)"}`,
      `- **Prompt Omni 1.2 Flash:**`,
      "```text",
      plan.prompt,
      "```",
    );
  });

  return lines.join("\n") + "\n";
}

export function buildOmniPromptsMarkdown(project: NmcProject, plans: OmniClipPlan[]): string {
  const sb = ensureStoryboard(project);
  const lines: string[] = [
    `# Prompt Animasi Gemini Omni 1.2 Flash — ${project.name}`,
    "",
    `- Model: \`${OMNI_MODEL_ID}\` (Google Flow / Google Vids / Gemini App / Interactions API)`,
    `- Rasio: \`${sb.aspectRatio}\` · Gaya Visual: ${sb.visualStyle}`,
    `- Catatan: Lampirkan gambar keyframe sesuai urutan di bawah — prompt sudah memakai natural-language binding resmi Omni 1.2 Flash (tanpa tag usang).`,
    "",
  ];

  plans.forEach((plan, idx) => {
    lines.push(
      `## ${String(idx + 1).padStart(2, "0")}. ${plan.label}`,
      `- Mode: **${plan.mode}** · Durasi: **${plan.durationSec}s** · Resolusi: **${plan.resolution}**`,
      `- Urutan Gambar Lampiran: ${plan.images.map((im, i) => `${i + 1}. \`${im.fileName}\``).join(" | ") || "(Belum ada gambar)"}`,
      "",
      "```text",
      plan.prompt,
      "```",
      "",
    );
  });

  return lines.join("\n");
}

/**
 * Generates a JSON batch file directly compatible with Google's official `gemini-omni-flash-api`
 * `generate_video.py --batch omni_batch_jobs.json` CLI runner.
 */
export function buildOmniBatchJobsJson(project: NmcProject, plans: OmniClipPlan[]): string {
  const slug =
    project.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || "storyboard";

  const jobs = plans.map((plan, idx) => {
    const base: Record<string, unknown> = {
      prompt: plan.prompt,
      duration: plan.durationSec,
      resolution: plan.resolution,
      aspect_ratio: plan.aspectRatio,
      output: `renders/${slug}_clip_${String(idx + 1).padStart(2, "0")}.mp4`,
    };
    if (plan.mode === "transition" && plan.images.length >= 2) {
      base.first_frame = plan.images[0].fileName;
      base.last_frame = plan.images[1].fileName;
    } else if (plan.images.length === 1) {
      base.first_frame = plan.images[0].fileName;
    } else if (plan.images.length > 1) {
      base.image = plan.images.map((im) => im.fileName);
    }
    return base;
  });

  return JSON.stringify(jobs, null, 2) + "\n";
}

function decodeBase64Bytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Packages the full Antigravity / Gemini / Omni 1.2 Flash animation kit into a zero-dependency ZIP.
 */
export function buildOmniAnimationPackZip(project: NmcProject, plans: OmniClipPlan[]): Uint8Array {
  const sb = ensureStoryboard(project);
  const entries: ZipEntryInput[] = [
    { name: "ANTIGRAVITY_ANIMATE_PROMPT.md", data: buildAntigravityGeminiHandoff(project, plans) },
    { name: "OMNI_1.2_PROMPTS.md", data: buildOmniPromptsMarkdown(project, plans) },
    { name: "omni_batch_jobs.json", data: buildOmniBatchJobsJson(project, plans) },
  ];

  const addedPaths = new Set<string>();
  for (const plan of plans) {
    for (const im of plan.images) {
      if (addedPaths.has(im.fileName)) continue;
      const dec = parseDataUrlBase64(im.dataUrl);
      if (!dec) continue;
      const bytes = decodeBase64Bytes(dec.data);
      if (!bytes) continue;
      addedPaths.add(im.fileName);
      entries.push({ name: im.fileName, data: bytes });
    }
  }

  sb.assets.forEach((a, idx) => {
    const img = getSelectedAssetImage(a);
    if (!img) return;
    const dec = parseDataUrlBase64(img);
    if (!dec) return;
    const bytes = decodeBase64Bytes(dec.data);
    if (!bytes) return;
    const slug = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `aset_${idx + 1}`;
    const path = `assets/${String(idx + 1).padStart(2, "0")}_${slug}.${dec.ext}`;
    if (addedPaths.has(path)) return;
    addedPaths.add(path);
    entries.push({ name: path, data: bytes });
  });

  return buildZip(entries);
}
