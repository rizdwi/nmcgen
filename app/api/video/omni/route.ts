// Official Gemini Omni 1.2 Flash (gemini-omni-1.2-flash) Interactions API proxy route.
// Cloudflare Workers & Node.js compatible (pure Web Fetch API, async background polling, strict SSRF file URI guard).
import type { AspectRatio, OmniAnimationMode, OmniResolution } from "@/lib/types";
import { getCloudflareEnvVar } from "@/lib/cfEnv";
import {
  buildOmniInteractionsPayload,
  clampOmniDuration,
  extractOmniVideoFromInteraction,
  OMNI_INTERACTIONS_URL,
  OMNI_MODEL_ID,
  parseDataUrlBase64,
  validateGoogleFileUri,
} from "@/lib/omniAnimation";

export const maxDuration = 300;

type OmniRequestBody = {
  op: "create" | "edit" | "extend" | "poll" | "download";
  apiKey?: string;
  prompt?: string;
  images?: string[]; // data URLs (up to 6 reference/keyframe images)
  previousInteractionId?: string;
  interactionId?: string;
  fileUri?: string;
  mode?: OmniAnimationMode;
  durationSec?: number;
  resolution?: OmniResolution;
  aspectRatio?: AspectRatio;
};

async function resolveGeminiKey(clientKey?: string): Promise<string> {
  const clean = String(clientKey || "").trim();
  if (clean) return clean;
  return (await getCloudflareEnvVar("GEMINI_API_KEY")) || (await getCloudflareEnvVar("GOOGLE_API_KEY"));
}

function parseGoogleErr(status: number, raw: string): string {
  try {
    const j = JSON.parse(raw);
    const msg = j?.error?.message || j?.message || raw.slice(0, 280);
    if (status === 401 || status === 403) {
      return `Akses Gemini Omni 1.2 ditolak (${status}): ${msg}. Pastikan Gemini API Key aktif pada akun berbayar (Omni 1.2 Flash API memerlukan billing aktif di Google AI Studio).`;
    }
    return `Gemini Omni 1.2 API (${status}): ${msg}`;
  } catch {
    return `Gemini Omni 1.2 API (${status}): ${raw.slice(0, 240)}`;
  }
}

export async function POST(req: Request) {
  let body: OmniRequestBody;
  try {
    body = (await req.json()) as OmniRequestBody;
  } catch {
    return Response.json({ ok: false, error: "Payload JSON tidak valid." }, { status: 400 });
  }

  const apiKey = await resolveGeminiKey(body.apiKey);
  if (!apiKey) {
    return Response.json(
      {
        ok: false,
        error:
          "Gemini API Key belum diisi. Tempel Gemini API Key di kotak koneksi Omni 1.2 atau atur variabel GEMINI_API_KEY di server.",
      },
      { status: 400 },
    );
  }

  try {
    // 1. STREAM DOWNLOAD MP4 FROM GOOGLE FILES API (strictly allowlisted origin)
    if (body.op === "download") {
      const check = validateGoogleFileUri(body.fileUri || "");
      if (!check.ok) {
        return Response.json({ ok: false, error: check.error }, { status: 400 });
      }
      const dlUrl = `${check.normalizedUrl}:download?alt=media`;
      const res = await fetch(dlUrl, {
        method: "GET",
        headers: { "x-goog-api-key": apiKey },
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        return Response.json({ ok: false, error: parseGoogleErr(res.status, errText) }, { status: res.status });
      }
      const contentType = res.headers.get("content-type") || "video/mp4";
      return new Response(res.body, {
        status: 200,
        headers: {
          "content-type": contentType,
          "cache-control": "private, max-age=300",
        },
      });
    }

    // 2. POLL INTERACTION STATUS OR GOOGLE FILE ACTIVE READINESS
    if (body.op === "poll") {
      if (body.fileUri?.trim()) {
        const check = validateGoogleFileUri(body.fileUri);
        if (!check.ok) {
          return Response.json({ ok: false, error: check.error }, { status: 400 });
        }
        const fRes = await fetch(check.normalizedUrl, {
          method: "GET",
          headers: { "x-goog-api-key": apiKey },
        });
        const fText = await fRes.text();
        if (!fRes.ok) {
          return Response.json({ ok: false, error: parseGoogleErr(fRes.status, fText) }, { status: fRes.status });
        }
        const meta = JSON.parse(fText) as { state?: string; error?: { message?: string } };
        const state = String(meta.state || "ACTIVE").toUpperCase();
        if (state === "FAILED") {
          return Response.json({
            ok: false,
            status: "failed",
            error: meta.error?.message || "Pemrosesan berkas video di Google Files API gagal.",
          });
        }
        return Response.json({
          ok: true,
          status: state === "ACTIVE" ? "ready" : "processing",
          fileState: state,
          fileUri: check.normalizedUrl,
        });
      }

      const id = String(body.interactionId || "").trim();
      if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) {
        return Response.json({ ok: false, error: "interactionId tidak valid." }, { status: 400 });
      }

      const pollRes = await fetch(`${OMNI_INTERACTIONS_URL}/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: { "x-goog-api-key": apiKey },
      });
      const rawText = await pollRes.text();
      if (!pollRes.ok) {
        return Response.json({ ok: false, error: parseGoogleErr(pollRes.status, rawText) }, { status: pollRes.status });
      }

      const parsed = extractOmniVideoFromInteraction(JSON.parse(rawText));
      if (parsed.failed) {
        return Response.json({
          ok: false,
          interactionId: parsed.id || id,
          status: "failed",
          error: parsed.error || "Generasi video Omni 1.2 gagal.",
        });
      }

      if (parsed.videoBase64) {
        return Response.json({
          ok: true,
          interactionId: parsed.id || id,
          status: "ready",
          videoDataUrl: `data:${parsed.videoMime || "video/mp4"};base64,${parsed.videoBase64}`,
        });
      }

      if (parsed.fileUri) {
        const check = validateGoogleFileUri(parsed.fileUri);
        return Response.json({
          ok: true,
          interactionId: parsed.id || id,
          status: "processing",
          fileUri: check.ok ? check.normalizedUrl : parsed.fileUri,
        });
      }

      return Response.json({
        ok: true,
        interactionId: parsed.id || id,
        status: parsed.done ? "completed-empty" : "processing",
        rawStatus: parsed.status,
      });
    }

    // 3. CREATE / EDIT / EXTEND VIDEO VIA GEMINI OMNI 1.2 FLASH INTERACTIONS API
    const prompt = String(body.prompt || "").trim();
    if (!prompt) {
      return Response.json({ ok: false, error: "Prompt animasi tidak boleh kosong." }, { status: 400 });
    }

    const mode: OmniAnimationMode | "extend" =
      body.op === "extend" ? "extend" : body.mode || "segment";
    const durationSec = clampOmniDuration(body.durationSec, mode);
    const resolution: OmniResolution =
      body.resolution && ["360p", "720p", "1080p", "4k"].includes(body.resolution)
        ? body.resolution
        : "720p";
    const aspectRatio: AspectRatio = body.aspectRatio === "9:16" ? "9:16" : "16:9";

    const decodedImages: Array<{ mimeType: string; data: string }> = [];
    if (Array.isArray(body.images)) {
      for (const dataUrl of body.images.slice(0, 6)) {
        const dec = parseDataUrlBase64(dataUrl);
        if (dec) decodedImages.push({ mimeType: dec.mimeType, data: dec.data });
      }
    }

    const finalPrompt =
      body.op === "extend" && !/^extend/i.test(prompt)
        ? `Extend this video seamlessly: ${prompt}`
        : prompt;

    const payload = buildOmniInteractionsPayload({
      prompt: finalPrompt,
      images: decodedImages,
      durationSec,
      resolution,
      aspectRatio,
      previousInteractionId: body.op === "edit" || body.op === "extend" ? body.previousInteractionId : undefined,
      mode,
      delivery: "uri",
    });

    const createRes = await fetch(OMNI_INTERACTIONS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(payload),
    });

    const rawText = await createRes.text();
    if (!createRes.ok) {
      return Response.json(
        { ok: false, error: parseGoogleErr(createRes.status, rawText) },
        { status: createRes.status },
      );
    }

    const parsed = extractOmniVideoFromInteraction(JSON.parse(rawText));
    if (parsed.failed) {
      return Response.json({
        ok: false,
        model: OMNI_MODEL_ID,
        interactionId: parsed.id,
        error: parsed.error || "Permintaan animasi Omni 1.2 gagal.",
      });
    }

    const validFile = parsed.fileUri ? validateGoogleFileUri(parsed.fileUri) : null;

    return Response.json({
      ok: true,
      model: OMNI_MODEL_ID,
      interactionId: parsed.id,
      status: parsed.videoBase64 ? "ready" : "processing",
      fileUri: validFile && validFile.ok ? validFile.normalizedUrl : undefined,
      videoDataUrl: parsed.videoBase64
        ? `data:${parsed.videoMime || "video/mp4"};base64,${parsed.videoBase64}`
        : undefined,
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: `Koneksi Gemini Omni 1.2 bermasalah: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
