import type { ImageAspect, ProviderKind, ProviderProfile } from "@/lib/types";
import { getCloudflareAiBinding, type WorkersAiBinding } from "@/lib/cfEnv";
import {
  buildCandidateChain,
  classifyAndRankModels,
  CLOUDFLARE_FREE_IMAGE_MODELS,
  CLOUDFLARE_FAST_TEXT_MODELS,
  GEMINI_FAST_TEXT_MODELS,
  CLOUDFLARE_FREE_TEXT_MODELS,
  cloudflareImageDims,
  detectBase64ImageMime,
  extractWorkersAiText,
  isAuthFailure,
  isCloudflareFluxSchnellModel,
  isCloudflareMultipartImageModel,
  isImagenModel,
  openAiImageSizeForModel,
  parseCloudflareRestCredentials,
  shouldSwitchModel,
  type DiscoveredModels,
  type RawProviderModel,
} from "@/lib/modelRouter";

export const maxDuration = 300;

type Body = {
  profile: ProviderProfile;
  key?: string;
  op: "test" | "discover" | "text" | "image";
  system?: string;
  prompt?: string;
  aspectRatio?: ImageAspect;
  referenceImages?: string[];
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const joinUrl = (base: string, tail: string) => base.replace(/\/+$/, "") + tail;

const DEFAULT_FALLBACK_TEXT: Record<ProviderKind, string[]> = {
  CloudflareAI: CLOUDFLARE_FREE_TEXT_MODELS,
  Gemini: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-4-argon", "gemini-4-hydrogen"],
  OpenAI: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
  Anthropic: ["claude-sonnet-4-5", "claude-haiku-4-5"],
  OpenAICompatible: [],
};

const DEFAULT_FALLBACK_IMAGE: Record<ProviderKind, string[]> = {
  CloudflareAI: CLOUDFLARE_FREE_IMAGE_MODELS,
  Gemini: ["gemini-nano-banana-2.1", "gemini-3.1-flash-lite-image", "gemini-3-pro-image"],
  OpenAI: ["gpt-image-1", "gpt-image-1-mini", "dall-e-3", "dall-e-2"],
  Anthropic: [],
  OpenAICompatible: [],
};

class HttpErr extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function parseErr(status: number, statusText: string, raw: string): HttpErr {
  try {
    const j = JSON.parse(raw);
    const e = j?.error;
    const cfErr = Array.isArray(j?.errors) ? j.errors[0]?.message : undefined;
    const msg =
      (typeof e === "string" ? e : e?.message) ||
      cfErr ||
      j?.message ||
      raw.slice(0, 260) ||
      statusText;
    return new HttpErr(status, msg);
  } catch {
    return new HttpErr(status, raw.slice(0, 260) || statusText);
  }
}

function toWorkersAiHttpErr(err: unknown): HttpErr {
  if (err instanceof HttpErr) return err;
  const msg = err instanceof Error ? err.message : String(err || "Workers AI error");
  if (/401|unauthorized|authentication|invalid.*token/i.test(msg)) return new HttpErr(401, msg);
  if (/429|quota|rate.?limit|daily free allocation|neurons|capacity|3040/i.test(msg)) return new HttpErr(429, msg);
  if (/403|workers paid|forbidden|partner|terms/i.test(msg)) return new HttpErr(403, msg);
  if (/404|not found|no such model/i.test(msg)) return new HttpErr(404, msg);
  if (/400|invalid|schema|multipart|5006/i.test(msg)) return new HttpErr(400, msg);
  return new HttpErr(502, msg);
}

async function fetchJson(url: string, init: RequestInit, timeoutSecs: number) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(Math.max(15, timeoutSecs) * 1000) });
  const raw = await res.text();
  if (!res.ok) throw parseErr(res.status, res.statusText, raw);
  return { status: res.status, json: raw ? JSON.parse(raw) : {} };
}

function envKeyFor(p: ProviderProfile, op: Body["op"]): string | undefined {
  if (p.kind === "CloudflareAI") return process?.env?.CLOUDFLARE_API_TOKEN || undefined;
  if (p.kind === "Gemini") {
    return op === "image"
      ? process?.env?.GEMINI_IMAGE_API_KEY || process?.env?.GEMINI_API_KEY || undefined
      : process?.env?.GEMINI_API_KEY || undefined;
  }
  if (p.kind === "OpenAI") return process?.env?.OPENAI_API_KEY || undefined;
  if (p.kind === "Anthropic") return process?.env?.ANTHROPIC_API_KEY || undefined;
  return undefined;
}

function dataUrlToInlinePart(dataUrl: string) {
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!m) return null;
  return { inlineData: { mimeType: m[1], data: m[2] } };
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(base64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; ext: string } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
  const bytes = base64ToBytes(m[2]);
  return { blob: new Blob([bytes as BlobPart], { type: mime }), ext };
}

function detectBinaryImageMime(bytes: Uint8Array, headerMime?: string | null): string {
  if (headerMime && headerMime.startsWith("image/")) return headerMime.split(";")[0].trim();
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) {
    return "image/webp";
  }
  return "image/png";
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function extractWorkersAiImageDataUrl(raw: unknown): Promise<string> {
  if (raw instanceof ReadableStream) {
    const bytes = new Uint8Array(await new Response(raw).arrayBuffer());
    if (bytes.length === 0) throw new HttpErr(502, "Workers AI mengembalikan stream gambar kosong.");
    return `data:${detectBinaryImageMime(bytes)};base64,${bytesToBase64(bytes)}`;
  }
  if (raw instanceof Response) {
    const ct = raw.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return extractWorkersAiImageDataUrl(await raw.json());
    }
    const bytes = new Uint8Array(await raw.arrayBuffer());
    if (bytes.length === 0) throw new HttpErr(502, "Workers AI mengembalikan respons gambar kosong.");
    return `data:${detectBinaryImageMime(bytes, ct)};base64,${bytesToBase64(bytes)}`;
  }
  if (raw instanceof ArrayBuffer) {
    const bytes = new Uint8Array(raw);
    return `data:${detectBinaryImageMime(bytes)};base64,${bytesToBase64(bytes)}`;
  }
  if (ArrayBuffer.isView(raw)) {
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    return `data:${detectBinaryImageMime(bytes)};base64,${bytesToBase64(bytes)}`;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as { image?: unknown; result?: { image?: unknown } };
    const b64 = typeof obj.image === "string" ? obj.image : typeof obj.result?.image === "string" ? obj.result.image : "";
    if (b64) {
      return `data:${detectBase64ImageMime(b64)};base64,${b64}`;
    }
  }
  throw new HttpErr(400, "Model Workers AI tidak mengembalikan data gambar (invalid model response).");
}

function shortReason(err: HttpErr): string {
  if (err.status === 429 || /quota|rate.?limit|resource.?exhausted/i.test(err.message)) {
    return "limit/kuota";
  }
  if (err.status === 404) return "tidak tersedia";
  if (err.status === 503 || err.status === 500) return "server sibuk";
  return err.message.slice(0, 72);
}

async function fetchProviderModels(
  p: ProviderProfile,
  key?: string,
  aiBinding?: WorkersAiBinding | null,
): Promise<DiscoveredModels> {
  const rawModels: RawProviderModel[] = [];

  if (p.kind === "CloudflareAI") {
    if (aiBinding) {
      return classifyAndRankModels("CloudflareAI", [
        ...CLOUDFLARE_FREE_TEXT_MODELS.map((id) => ({ id })),
        ...CLOUDFLARE_FREE_IMAGE_MODELS.map((id) => ({ id })),
      ]);
    }
    const creds = parseCloudflareRestCredentials(p.baseUrl, key, process?.env);
    if (!creds) {
      throw new HttpErr(
        400,
        "Binding Cloudflare Workers AI belum aktif di server lokal ini. Jalankan lewat Cloudflare Worker (npm run dev:vinext atau deploy) tanpa API key, atau isi format ACCOUNT_ID:API_TOKEN di kolom API Key.",
      );
    }
    for (const task of ["Text Generation", "Text-to-Image"]) {
      try {
        const { json } = await fetchJson(
          `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/models/search?task=${encodeURIComponent(task)}&per_page=100`,
          { headers: { authorization: `Bearer ${creds.apiToken}` } },
          30,
        );
        const list = Array.isArray(json?.result) ? json.result : [];
        for (const m of list) {
          const props = Array.isArray(m?.properties) ? m.properties : [];
          const isPaid = props.some(
            (pr: { property_id?: string; value?: unknown }) =>
              pr?.property_id === "require_workers_paid" && String(pr?.value) === "true",
          );
          const isDeprecated = props.some(
            (pr: { property_id?: string; value?: unknown }) =>
              pr?.property_id === "deprecated" && String(pr?.value) === "true",
          );
          if (m?.name && !isPaid && !isDeprecated) {
            rawModels.push({ id: String(m.name) });
          }
        }
      } catch (err) {
        const e = err instanceof HttpErr ? err : new HttpErr(500, (err as Error).message);
        if (isAuthFailure(e.status, e.message)) throw e;
      }
    }
    if (rawModels.length === 0) {
      return classifyAndRankModels("CloudflareAI", [
        ...CLOUDFLARE_FREE_TEXT_MODELS.map((id) => ({ id })),
        ...CLOUDFLARE_FREE_IMAGE_MODELS.map((id) => ({ id })),
      ]);
    }
    return classifyAndRankModels("CloudflareAI", rawModels);
  }

  if (p.kind === "Gemini") {
    let pageToken = "";
    for (let page = 0; page < 2; page++) {
      const qs = pageToken
        ? `/v1beta/models?pageSize=200&pageToken=${encodeURIComponent(pageToken)}`
        : "/v1beta/models?pageSize=200";
      const { json } = await fetchJson(
        joinUrl(p.baseUrl, qs),
        { headers: { "x-goog-api-key": key ?? "" } },
        30,
      );
      const list = Array.isArray(json?.models) ? json.models : [];
      for (const m of list) {
        if (m?.name) {
          rawModels.push({
            id: String(m.name),
            displayName: m.displayName ? String(m.displayName) : undefined,
            supportedGenerationMethods: Array.isArray(m.supportedGenerationMethods)
              ? m.supportedGenerationMethods.map(String)
              : undefined,
          });
        }
      }
      pageToken = typeof json?.nextPageToken === "string" ? json.nextPageToken : "";
      if (!pageToken) break;
    }
    return classifyAndRankModels("Gemini", rawModels);
  }

  if (p.kind === "Anthropic") {
    const { json } = await fetchJson(
      joinUrl(p.baseUrl, "/v1/models"),
      { headers: { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" } },
      30,
    );
    const list = Array.isArray(json?.data) ? json.data : [];
    for (const m of list) {
      if (m?.id) rawModels.push({ id: String(m.id), displayName: m.display_name ? String(m.display_name) : undefined });
    }
    return classifyAndRankModels("Anthropic", rawModels);
  }

  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  const { json } = await fetchJson(joinUrl(p.baseUrl, "/models"), { headers }, 30);
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  for (const m of list) {
    const id = m?.id || m?.name;
    if (id) rawModels.push({ id: String(id) });
  }
  return classifyAndRankModels(p.kind, rawModels);
}

async function runCloudflareTextOnce(
  aiBinding: WorkersAiBinding | null,
  p: ProviderProfile,
  key: string | undefined,
  model: string,
  system: string,
  prompt: string,
): Promise<string> {
  const t = Math.max(p.timeoutSecs || 180, 90);
  const input = {
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ],
    max_tokens: 4096,
    temperature: 0.6,
  };

  if (aiBinding) {
    try {
      const raw = await aiBinding.run(model, input);
      const text = extractWorkersAiText(raw);
      if (!text) throw new HttpErr(502, `Model ${model} mengembalikan respons teks kosong.`);
      return text;
    } catch (err) {
      throw toWorkersAiHttpErr(err);
    }
  }

  const creds = parseCloudflareRestCredentials(p.baseUrl, key, process?.env);
  if (!creds) {
    throw new HttpErr(
      400,
      "Binding Cloudflare Workers AI tidak tersedia di mode lokal Node.js. Deploy ke Cloudflare Workers atau isi ACCOUNT_ID:API_TOKEN.",
    );
  }
  const { json } = await fetchJson(
    `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/run/${model}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${creds.apiToken}`,
      },
      body: JSON.stringify(input),
    },
    t,
  );
  const text = extractWorkersAiText(json);
  if (!text) throw new HttpErr(502, `Model ${model} mengembalikan respons teks kosong.`);
  return text;
}

async function runCloudflareImageOnce(
  aiBinding: WorkersAiBinding | null,
  p: ProviderProfile,
  key: string | undefined,
  model: string,
  prompt: string,
  aspectRatio: ImageAspect,
  referenceImages: string[],
): Promise<string> {
  const t = Math.max(p.timeoutSecs || 180, 90);
  const cleanPrompt = prompt.trim().slice(0, 2048);

  if (isCloudflareMultipartImageModel(model)) {
    const { width, height } = cloudflareImageDims(aspectRatio);
    const form = new FormData();
    form.append("prompt", cleanPrompt);
    form.append("width", String(width));
    form.append("height", String(height));
    referenceImages.slice(0, 4).forEach((dataUrl, idx) => {
      const decoded = dataUrlToBlob(dataUrl);
      if (decoded) {
        form.append(`input_image_${idx}`, decoded.blob, `ref_${idx}.${decoded.ext}`);
      }
    });

    if (aiBinding) {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const attemptForm = new FormData();
          attemptForm.append("prompt", cleanPrompt);
          attemptForm.append("width", String(width));
          attemptForm.append("height", String(height));
          referenceImages.slice(0, 4).forEach((dataUrl, idx) => {
            const decoded = dataUrlToBlob(dataUrl);
            if (decoded) {
              attemptForm.append(`input_image_${idx}`, decoded.blob, `ref_${idx}.${decoded.ext}`);
            }
          });
          const formRes = new Response(attemptForm);
          const contentType = formRes.headers.get("content-type") || "multipart/form-data";
          const raw = await aiBinding.run(model, {
            multipart: { body: formRes.body, contentType },
          });
          return await extractWorkersAiImageDataUrl(raw);
        } catch (err) {
          lastErr = err;
          const he = toWorkersAiHttpErr(err);
          if (attempt === 0 && (he.status === 429 || he.status >= 500)) {
            await new Promise((r) => setTimeout(r, 1200));
            continue;
          }
          throw he;
        }
      }
      throw toWorkersAiHttpErr(lastErr);
    }

    const creds = parseCloudflareRestCredentials(p.baseUrl, key, process?.env);
    if (!creds) {
      throw new HttpErr(
        400,
        "Binding Cloudflare Workers AI tidak tersedia di mode lokal Node.js. Deploy ke Cloudflare Workers atau isi ACCOUNT_ID:API_TOKEN.",
      );
    }
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/run/${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${creds.apiToken}` },
      body: form,
      signal: AbortSignal.timeout(t * 1000),
    });
    if (!res.ok) throw parseErr(res.status, res.statusText, await res.text());
    return await extractWorkersAiImageDataUrl(res);
  }

  // flux-1-schnell rejects extra properties (additionalProperties: false).
  const payload = isCloudflareFluxSchnellModel(model)
    ? { prompt: cleanPrompt, steps: 4 }
    : { prompt: cleanPrompt, ...cloudflareImageDims(aspectRatio), num_steps: 20 };

  if (aiBinding) {
    try {
      const raw = await aiBinding.run(model, payload);
      return await extractWorkersAiImageDataUrl(raw);
    } catch (err) {
      throw toWorkersAiHttpErr(err);
    }
  }

  const creds = parseCloudflareRestCredentials(p.baseUrl, key, process?.env);
  if (!creds) {
    throw new HttpErr(
      400,
      "Binding Cloudflare Workers AI tidak tersedia di mode lokal Node.js. Deploy ke Cloudflare Workers atau isi ACCOUNT_ID:API_TOKEN.",
    );
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/run/${model}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${creds.apiToken}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(t * 1000),
  });
  if (!res.ok) throw parseErr(res.status, res.statusText, await res.text());
  return await extractWorkersAiImageDataUrl(res);
}

async function runTextOnce(
  p: ProviderProfile,
  key: string | undefined,
  model: string,
  system: string,
  prompt: string,
  aiBinding: WorkersAiBinding | null,
): Promise<string> {
  if (p.kind === "CloudflareAI") {
    return runCloudflareTextOnce(aiBinding, p, key, model, system, prompt);
  }
  const t = Math.max(p.timeoutSecs || 180, 90);
  if (p.kind === "Gemini") {
    const { json } = await fetchJson(
      joinUrl(p.baseUrl, `/v1beta/models/${encodeURIComponent(model)}:generateContent`),
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key ?? "" },
        body: JSON.stringify({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 4096, temperature: 0.6 },
        }),
      },
      t,
    );
    const parts = json?.candidates?.[0]?.content?.parts ?? [];
    return parts
      .filter((x: { thought?: boolean }) => !x.thought)
      .map((x: { text?: string }) => x.text ?? "")
      .join("");
  }

  if (p.kind === "Anthropic") {
    const { json } = await fetchJson(
      joinUrl(p.baseUrl, "/v1/messages"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system,
          messages: [{ role: "user", content: prompt }],
        }),
      },
      t,
    );
    return (json?.content ?? [])
      .filter((c: { type?: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("");
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const { json } = await fetchJson(
    joinUrl(p.baseUrl, "/chat/completions"),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: prompt },
        ],
      }),
    },
    t,
  );
  return json?.choices?.[0]?.message?.content ?? "";
}

async function runImageOnce(
  p: ProviderProfile,
  key: string | undefined,
  model: string,
  prompt: string,
  aspectRatio: ImageAspect,
  referenceImages: string[],
  aiBinding: WorkersAiBinding | null,
): Promise<string> {
  if (p.kind === "CloudflareAI") {
    return runCloudflareImageOnce(aiBinding, p, key, model, prompt, aspectRatio, referenceImages);
  }
  const t = Math.max(p.timeoutSecs || 180, 90);

  if (p.kind === "Gemini") {
    if (isImagenModel(model)) {
      const { json } = await fetchJson(
        joinUrl(p.baseUrl, `/v1beta/models/${encodeURIComponent(model)}:predict`),
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key ?? "" },
          body: JSON.stringify({
            instances: [{ prompt }],
            parameters: { sampleCount: 1, aspectRatio },
          }),
        },
        t,
      );
      const pred = json?.predictions?.[0];
      if (!pred?.bytesBase64Encoded) {
        throw new HttpErr(400, "Model Imagen tidak mengembalikan data gambar (does not support response).");
      }
      return `data:${pred.mimeType || "image/png"};base64,${pred.bytesBase64Encoded}`;
    }

    const refParts = referenceImages
      .slice(0, 4)
      .map(dataUrlToInlinePart)
      .filter((x): x is NonNullable<typeof x> => Boolean(x));

    const { json } = await fetchJson(
      joinUrl(p.baseUrl, `/v1beta/models/${encodeURIComponent(model)}:generateContent`),
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key ?? "" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [...refParts, { text: prompt }] }],
          generationConfig: {
            responseModalities: ["IMAGE", "TEXT"],
            imageConfig: { aspectRatio },
          },
        }),
      },
      t,
    );
    const part = (json?.candidates?.[0]?.content?.parts ?? []).find(
      (x: { inlineData?: { mimeType?: string; data?: string } }) => x.inlineData?.data,
    );
    if (!part) {
      throw new HttpErr(400, "Model tidak mengembalikan data gambar (responseModalities IMAGE tidak didukung).");
    }
    return `data:${part.inlineData.mimeType || "image/png"};base64,${part.inlineData.data}`;
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const size = openAiImageSizeForModel(model, aspectRatio);
  const { json } = await fetchJson(
    joinUrl(p.baseUrl, "/images/generations"),
    {
      method: "POST",
      headers,
      body: JSON.stringify({ model, prompt, n: 1, size }),
    },
    t,
  );
  const first = json?.data?.[0];
  if (first?.b64_json) return `data:image/png;base64,${first.b64_json}`;
  if (first?.url) {
    const r = await fetch(first.url, { signal: AbortSignal.timeout(60000) });
    const bytes = new Uint8Array(await r.arrayBuffer());
    return `data:${r.headers.get("content-type") || "image/png"};base64,${bytesToBase64(bytes)}`;
  }
  throw new HttpErr(400, "Model tidak mengembalikan gambar (invalid model response).");
}

async function runTextWithFallback(
  p: ProviderProfile,
  key: string | undefined,
  system: string,
  prompt: string,
  aiBinding: WorkersAiBinding | null,
) {
  let discovered: DiscoveredModels | undefined;
  let liveFetched = false;
  let knownText = p.discoveredTextModels ?? [];

  if (knownText.length === 0) {
    try {
      discovered = await fetchProviderModels(p, key, aiBinding);
      liveFetched = true;
      knownText = discovered.textModels;
    } catch (err) {
      const e = err instanceof HttpErr ? err : new HttpErr(500, (err as Error).message);
      if (isAuthFailure(e.status, e.message)) throw e;
    }
  }

  const tried = new Set<string>();
  const fallbackNotes: string[] = [];
  const errState: { last: HttpErr | null } = { last: null };

  const tryChain = async (candidates: string[], targetProfile = p, targetKey = key, maxAttempts = 4) => {
    let attempts = 0;
    for (const model of candidates) {
      if (tried.has(model) || attempts >= maxAttempts) continue;
      tried.add(model);
      attempts++;
      try {
        const text = await runTextOnce(targetProfile, targetKey, model, system, prompt, aiBinding);
        return { text, usedModel: model, fallbackNotes, discovered };
      } catch (err) {
        const e = err instanceof HttpErr ? err : new HttpErr(500, (err as Error).message);
        errState.last = e;
        if (!shouldSwitchModel(e.status, e.message)) throw e;
        fallbackNotes.push(`${model} (${shortReason(e)})`);
      }
    }
    return null;
  };

  const initial = buildCandidateChain({
    autoModel: p.autoModel,
    preferred: p.textModel,
    discovered: knownText,
    fallbackDefaults: DEFAULT_FALLBACK_TEXT[p.kind],
    fastFirst:
        p.kind === "CloudflareAI"
          ? CLOUDFLARE_FAST_TEXT_MODELS
          : p.kind === "Gemini"
            ? GEMINI_FAST_TEXT_MODELS
            : [],
  });
  if (initial.length === 0) {
    throw new HttpErr(400, "Tidak ditemukan model teks yang tersedia untuk profil provider ini.");
  }

  const hit1 = await tryChain(initial);
  if (hit1) return hit1;

  if (!liveFetched) {
    try {
      discovered = await fetchProviderModels(p, key, aiBinding);
      const refreshed = buildCandidateChain({
        autoModel: true,
        discovered: discovered.textModels,
        fastFirst:
        p.kind === "CloudflareAI"
          ? CLOUDFLARE_FAST_TEXT_MODELS
          : p.kind === "Gemini"
            ? GEMINI_FAST_TEXT_MODELS
            : [],
      });
      const hit2 = await tryChain(refreshed);
      if (hit2) return hit2;
    } catch (err) {
      const e = err instanceof HttpErr ? err : new HttpErr(500, (err as Error).message);
      if (isAuthFailure(e.status, e.message)) throw e;
    }
  }

  // Last-resort safety net: if an external provider (e.g. Gemini) hit limit, fall back to native Workers AI binding.
  if (p.kind !== "CloudflareAI" && aiBinding) {
    const cfProfile: ProviderProfile = {
      id: "default-cloudflare-ai",
      name: "Cloudflare Workers AI",
      kind: "CloudflareAI",
      baseUrl: "https://api.cloudflare.com/client/v4",
      textModel: "",
      imageModel: "",
      timeoutSecs: p.timeoutSecs || 180,
      autoModel: true,
    };
    const cfHit = await tryChain(CLOUDFLARE_FREE_TEXT_MODELS, cfProfile, undefined);
    if (cfHit) return cfHit;
  }

  const summary = fallbackNotes.length
    ? `Semua model teks gagal atau terkena limit (${fallbackNotes.join(", ")}).`
    : errState.last?.message || "Gagal memanggil model teks.";
  throw new HttpErr(errState.last?.status ?? 502, summary);
}

async function runImageWithFallback(
  p: ProviderProfile,
  key: string | undefined,
  prompt: string,
  aspectRatio: ImageAspect,
  referenceImages: string[],
  aiBinding: WorkersAiBinding | null,
) {
  if (p.kind === "Anthropic") {
    throw new HttpErr(
      400,
      "Anthropic tidak menyediakan generasi gambar. Gunakan Cloudflare Workers AI, Gemini, atau OpenAI.",
    );
  }

  let discovered: DiscoveredModels | undefined;
  let liveFetched = false;
  let knownImages = p.discoveredImageModels ?? [];

  if (knownImages.length === 0) {
    try {
      discovered = await fetchProviderModels(p, key, aiBinding);
      liveFetched = true;
      knownImages = discovered.imageModels;
    } catch (err) {
      const e = err instanceof HttpErr ? err : new HttpErr(500, (err as Error).message);
      if (isAuthFailure(e.status, e.message)) throw e;
    }
  }

  const tried = new Set<string>();
  const fallbackNotes: string[] = [];
  const errState: { last: HttpErr | null } = { last: null };

  const tryChain = async (candidates: string[], targetProfile = p, targetKey = key, maxAttempts = 8) => {
    let attempts = 0;
    for (const model of candidates) {
      if (tried.has(model) || attempts >= maxAttempts) continue;
      tried.add(model);
      attempts++;
      try {
        const image = await runImageOnce(
          targetProfile,
          targetKey,
          model,
          prompt,
          aspectRatio,
          referenceImages,
          aiBinding,
        );
        return { image, usedModel: model, fallbackNotes, discovered };
      } catch (err) {
        const e = err instanceof HttpErr ? err : new HttpErr(500, (err as Error).message);
        errState.last = e;
        if (!shouldSwitchModel(e.status, e.message)) throw e;
        fallbackNotes.push(`${model} (${shortReason(e)})`);
      }
    }
    return null;
  };

  let initial = buildCandidateChain({
    autoModel: p.autoModel,
    preferred: p.imageModel,
    discovered: knownImages,
    fallbackDefaults: liveFetched ? [] : DEFAULT_FALLBACK_IMAGE[p.kind],
  });

  // When reference images are supplied on Cloudflare, put FLUX.2 multi-reference models first.
  if (p.kind === "CloudflareAI" && referenceImages.length > 0) {
    const flux2 = initial.filter((m) => isCloudflareMultipartImageModel(m));
    const rest = initial.filter((m) => !isCloudflareMultipartImageModel(m));
    initial = [...flux2, ...rest];
  }

  if (initial.length === 0) {
    throw new HttpErr(
      400,
      "Provider terhubung, tetapi tidak ditemukan model generate gambar yang tersedia pada akun ini.",
    );
  }

  const hit1 = await tryChain(initial);
  if (hit1) return hit1;

  if (!liveFetched) {
    try {
      discovered = await fetchProviderModels(p, key, aiBinding);
      const refreshed = buildCandidateChain({
        autoModel: true,
        discovered: discovered.imageModels,
      });
      const hit2 = await tryChain(refreshed);
      if (hit2) return hit2;
    } catch (err) {
      const e = err instanceof HttpErr ? err : new HttpErr(500, (err as Error).message);
      if (isAuthFailure(e.status, e.message)) throw e;
    }
  }

  if (p.kind !== "CloudflareAI" && aiBinding) {
    const cfProfile: ProviderProfile = {
      id: "default-cloudflare-ai",
      name: "Cloudflare Workers AI",
      kind: "CloudflareAI",
      baseUrl: "https://api.cloudflare.com/client/v4",
      textModel: "",
      imageModel: "",
      timeoutSecs: p.timeoutSecs || 180,
      autoModel: true,
    };
    const cfHit = await tryChain(CLOUDFLARE_FREE_IMAGE_MODELS, cfProfile, undefined);
    if (cfHit) return cfHit;
  }

  const summary = fallbackNotes.length
    ? `Semua model gambar yang tersedia terkena limit atau gagal (${fallbackNotes.join(", ")}).`
    : errState.last?.message || "Gagal membuat gambar.";
  throw new HttpErr(errState.last?.status ?? 502, summary);
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Body JSON tidak valid." }, { status: 400 });
  }

  const rawProfile = body.profile;
  if (!rawProfile?.kind) {
    return Response.json({ ok: false, error: "Profil provider AI tidak lengkap." }, { status: 400 });
  }
  const p: ProviderProfile =
    rawProfile.kind === "CloudflareAI" && !rawProfile.baseUrl
      ? { ...rawProfile, baseUrl: "https://api.cloudflare.com/client/v4" }
      : rawProfile;

  if (!p.baseUrl) {
    return Response.json({ ok: false, error: "Profil provider AI tidak lengkap." }, { status: 400 });
  }
  try {
    const parsed = new URL(p.baseUrl);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname))) {
      return Response.json(
        { ok: false, error: "HTTP tanpa TLS hanya diizinkan untuk alamat localhost / 127.0.0.1." },
        { status: 400 },
      );
    }
  } catch {
    return Response.json({ ok: false, error: "Base URL tidak valid." }, { status: 400 });
  }

  const aiBinding = await getCloudflareAiBinding();
  const key = body.key || envKeyFor(p, body.op);
  try {
    if (body.op === "test" || body.op === "discover") {
      const discovered = await fetchProviderModels(p, key, aiBinding);
      const viaBinding = p.kind === "CloudflareAI" && Boolean(aiBinding);
      const textMsg = viaBinding
        ? `Terhubung langsung via binding Cloudflare Workers AI (tanpa API key): ${discovered.textModels.length} model teks dan ${discovered.imageModels.length} model gambar siap dipakai.`
        : discovered.textModels.length > 0 || discovered.imageModels.length > 0
          ? `Terhubung: ${discovered.textModels.length} model teks dan ${discovered.imageModels.length} model gambar terdeteksi. Fallback otomatis aktif.`
          : `Terhubung (${discovered.totalCount} model terdeteksi).`;
      return Response.json({ ok: true, text: textMsg, discovered });
    }
    if (body.op === "text") {
      const out = await runTextWithFallback(p, key, body.system ?? "", body.prompt ?? "", aiBinding);
      return Response.json({ ok: true, ...out });
    }
    const out = await runImageWithFallback(
      p,
      key,
      body.prompt ?? "",
      body.aspectRatio ?? "16:9",
      body.referenceImages ?? [],
      aiBinding,
    );
    return Response.json({ ok: true, ...out });
  } catch (err) {
    if (err instanceof HttpErr) {
      return Response.json({ ok: false, status: err.status, error: err.message });
    }
    return Response.json({ ok: false, error: `Gagal memanggil provider AI: ${(err as Error).message}` });
  }
}
