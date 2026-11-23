import type { AspectRatio, ProviderProfile } from "@/lib/types";

export const maxDuration = 300;

type Body = {
  profile: ProviderProfile;
  key?: string;
  op: "test" | "text" | "image";
  system?: string;
  prompt?: string;
  aspectRatio?: AspectRatio;
  referenceImages?: string[];
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const joinUrl = (base: string, tail: string) => base.replace(/\/+$/, "") + tail;

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
      ? process.env.GEMINI_IMAGE_API_KEY || process.env.GEMINI_API_KEY || undefined
      : process.env.GEMINI_API_KEY || undefined;
  }
  if (p.kind === "OpenAI") return process.env.OPENAI_API_KEY || undefined;
  if (p.kind === "Anthropic") return process.env.ANTHROPIC_API_KEY || undefined;
  return undefined;
}

function dataUrlToInlinePart(dataUrl: string) {
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!m) return null;
  return { inlineData: { mimeType: m[1], data: m[2] } };
}

async function runTest(p: ProviderProfile, key?: string) {
  const [url, headers] =
    p.kind === "Gemini"
      ? [joinUrl(p.baseUrl, "/v1beta/models"), { "x-goog-api-key": key ?? "" }]
      : p.kind === "Anthropic"
        ? [joinUrl(p.baseUrl, "/v1/models"), { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" }]
        : [joinUrl(p.baseUrl, "/models"), key ? { authorization: `Bearer ${key}` } : {}];

  const { json } = await fetchJson(url, { headers: headers as HeadersInit }, 30);
  const count = (json?.models ?? json?.data ?? []).length;
  return { ok: true, text: count ? `Terhubung (${count} model tersedia)` : "Terhubung" };
}

async function runText(p: ProviderProfile, key: string | undefined, system: string, prompt: string) {
  const t = Math.max(p.timeoutSecs || 180, 120);
  if (p.kind === "Gemini") {
    const { json } = await fetchJson(
      joinUrl(p.baseUrl, `/v1beta/models/${encodeURIComponent(p.textModel)}:generateContent`),
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
    return parts.filter((x: { thought?: boolean }) => !x.thought).map((x: { text?: string }) => x.text ?? "").join("");
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
          model: p.textModel,
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
        model: p.textModel,
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

async function runImage(
  p: ProviderProfile,
  key: string | undefined,
  prompt: string,
  aspectRatio: AspectRatio,
  referenceImages: string[],
) {
  const t = Math.max(p.timeoutSecs || 180, 120);
  if (!p.imageModel) throw new HttpErr(400, "Model gambar belum diisi pada profil ini.");
  if (p.kind === "Anthropic") throw new HttpErr(400, "Anthropic tidak menyediakan generasi gambar.");

  if (p.kind === "Gemini") {
    const refParts = referenceImages
      .slice(0, 4)
      .map(dataUrlToInlinePart)
      .filter((x): x is NonNullable<typeof x> => Boolean(x));

    const { json } = await fetchJson(
      joinUrl(p.baseUrl, `/v1beta/models/${encodeURIComponent(p.imageModel)}:generateContent`),
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
    if (!part) throw new HttpErr(502, "Model tidak mengembalikan data gambar.");
    return `data:${part.inlineData.mimeType || "image/png"};base64,${part.inlineData.data}`;
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const size = aspectRatio === "9:16" ? "1024x1536" : "1536x1024";
  const { json } = await fetchJson(
    joinUrl(p.baseUrl, "/images/generations"),
    {
      method: "POST",
      headers,
      body: JSON.stringify({ model: p.imageModel, prompt, n: 1, size }),
    },
    t,
  );
  const first = json?.data?.[0];
  if (first?.b64_json) return `data:image/png;base64,${first.b64_json}`;
  if (first?.url) {
    const r = await fetch(first.url, { signal: AbortSignal.timeout(60000) });
    const buf = Buffer.from(await r.arrayBuffer());
    return `data:${r.headers.get("content-type") || "image/png"};base64,${buf.toString("base64")}`;
  }
  throw new HttpErr(502, "Respons tidak berisi gambar.");
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
    if (body.op === "test") return Response.json(await runTest(p, key));
    if (body.op === "text") {
      if (!p.textModel) return Response.json({ ok: false, error: "Model teks belum diisi." }, { status: 400 });
      const text = await runText(p, key, body.system ?? "", body.prompt ?? "");
      return Response.json({ ok: true, text });
    }
    const image = await runImage(
      p,
      key,
      body.prompt ?? "",
      body.aspectRatio ?? "16:9",
      body.referenceImages ?? [],
    );
    return Response.json({ ok: true, image });
  } catch (err) {
    if (err instanceof HttpErr) {
      return Response.json({ ok: false, status: err.status, error: err.message });
    }
    return Response.json({ ok: false, error: `Gagal memanggil provider AI: ${(err as Error).message}` });
  }
}
