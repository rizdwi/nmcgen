import type { AspectRatio, ProviderKind, ProviderProfile } from "@/lib/types";
import {
  buildCandidateChain,
  classifyAndRankModels,
  isAuthFailure,
  isImagenModel,
  openAiImageSizeForModel,
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
  aspectRatio?: AspectRatio;
  referenceImages?: string[];
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const joinUrl = (base: string, tail: string) => base.replace(/\/+$/, "") + tail;

const DEFAULT_FALLBACK_TEXT: Record<ProviderKind, string[]> = {
  Gemini: ["gemini-4-hydrogen", "gemini-4-argon", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
  OpenAI: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
  Anthropic: ["claude-sonnet-4-5", "claude-haiku-4-5"],
  OpenAICompatible: [],
};

const DEFAULT_FALLBACK_IMAGE: Record<ProviderKind, string[]> = {
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
    const msg = (typeof e === "string" ? e : e?.message) || j?.message || raw.slice(0, 260) || statusText;
    return new HttpErr(status, msg);
  } catch {
    return new HttpErr(status, raw.slice(0, 260) || statusText);
  }
}

async function fetchJson(url: string, init: RequestInit, timeoutSecs: number) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(Math.max(15, timeoutSecs) * 1000) });
  const raw = await res.text();
  if (!res.ok) throw parseErr(res.status, res.statusText, raw);
  return { status: res.status, json: raw ? JSON.parse(raw) : {} };
}

function envKeyFor(p: ProviderProfile, op: Body["op"]): string | undefined {
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

function shortReason(err: HttpErr): string {
  if (err.status === 429 || /quota|rate.?limit|resource.?exhausted/i.test(err.message)) {
    return "limit/kuota";
  }
  if (err.status === 404) return "tidak tersedia";
  if (err.status === 503 || err.status === 500) return "server sibuk";
  return err.message.slice(0, 72);
}

async function fetchProviderModels(p: ProviderProfile, key?: string): Promise<DiscoveredModels> {
  const rawModels: RawProviderModel[] = [];

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

async function runTextOnce(
  p: ProviderProfile,
  key: string | undefined,
  model: string,
  system: string,
  prompt: string,
): Promise<string> {
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
  aspectRatio: AspectRatio,
  referenceImages: string[],
): Promise<string> {
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
) {
  let discovered: DiscoveredModels | undefined;
  let liveFetched = false;
  let knownText = p.discoveredTextModels ?? [];

  if (knownText.length === 0) {
    try {
      discovered = await fetchProviderModels(p, key);
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

  const tryChain = async (candidates: string[]) => {
    for (const model of candidates) {
      if (tried.has(model) || tried.size >= 6) continue;
      tried.add(model);
      try {
        const text = await runTextOnce(p, key, model, system, prompt);
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
  });
  if (initial.length === 0) {
    throw new HttpErr(400, "Tidak ditemukan model teks yang tersedia untuk API key ini.");
  }

  const hit1 = await tryChain(initial);
  if (hit1) return hit1;

  if (!liveFetched) {
    try {
      discovered = await fetchProviderModels(p, key);
      const refreshed = buildCandidateChain({
        autoModel: true,
        discovered: discovered.textModels,
      });
      const hit2 = await tryChain(refreshed);
      if (hit2) return hit2;
    } catch (err) {
      const e = err instanceof HttpErr ? err : new HttpErr(500, (err as Error).message);
      if (isAuthFailure(e.status, e.message)) throw e;
    }
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
  aspectRatio: AspectRatio,
  referenceImages: string[],
) {
  if (p.kind === "Anthropic") {
    throw new HttpErr(400, "Anthropic tidak menyediakan generasi gambar. Gunakan API key Gemini atau OpenAI.");
  }

  let discovered: DiscoveredModels | undefined;
  let liveFetched = false;
  let knownImages = p.discoveredImageModels ?? [];

  if (knownImages.length === 0) {
    try {
      discovered = await fetchProviderModels(p, key);
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

  const tryChain = async (candidates: string[]) => {
    for (const model of candidates) {
      if (tried.has(model) || tried.size >= 8) continue;
      tried.add(model);
      try {
        const image = await runImageOnce(p, key, model, prompt, aspectRatio, referenceImages);
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

  const initial = buildCandidateChain({
    autoModel: p.autoModel,
    preferred: p.imageModel,
    discovered: knownImages,
    fallbackDefaults: liveFetched ? [] : DEFAULT_FALLBACK_IMAGE[p.kind],
  });

  if (initial.length === 0) {
    throw new HttpErr(
      400,
      "API key terhubung, tetapi tidak ditemukan model generate gambar yang tersedia pada akun ini.",
    );
  }

  const hit1 = await tryChain(initial);
  if (hit1) return hit1;

  if (!liveFetched) {
    try {
      discovered = await fetchProviderModels(p, key);
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

  const p = body.profile;
  if (!p?.baseUrl) {
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

  const key = body.key || envKeyFor(p, body.op);
  try {
    if (body.op === "test" || body.op === "discover") {
      const discovered = await fetchProviderModels(p, key);
      const textMsg =
        discovered.textModels.length > 0 || discovered.imageModels.length > 0
          ? `Terhubung: ${discovered.textModels.length} model teks dan ${discovered.imageModels.length} model gambar terdeteksi. Fallback otomatis aktif.`
          : `Terhubung (${discovered.totalCount} model terdeteksi).`;
      return Response.json({ ok: true, text: textMsg, discovered });
    }
    if (body.op === "text") {
      const out = await runTextWithFallback(p, key, body.system ?? "", body.prompt ?? "");
      return Response.json({ ok: true, ...out });
    }
    const out = await runImageWithFallback(
      p,
      key,
      body.prompt ?? "",
      body.aspectRatio ?? "16:9",
      body.referenceImages ?? [],
    );
    return Response.json({ ok: true, ...out });
  } catch (err) {
    if (err instanceof HttpErr) {
      return Response.json({ ok: false, status: err.status, error: err.message });
    }
    return Response.json({ ok: false, error: `Gagal memanggil provider AI: ${(err as Error).message}` });
  }
}
