import type { ProviderKind } from "./types.ts";

export interface RawProviderModel {
  id: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

export interface DiscoveredModels {
  textModels: string[];
  imageModels: string[];
  totalCount: number;
  fetchedAt: number;
}

const EXCLUDED_MODEL_RE =
  /(embed|embedding|aqa|tts|transcribe|whisper|lyria|veo|omni|genie|decision|moderation|realtime|audio|rerank|babbage|davinci|robotics|computer-use|deep-research|learnlm|text-moderation|text-search|code-search)/i;

const GEMINI_IMAGE_RE = /(nano-banana|imagen|-image\b|image-generation|image-preview|image-lite)/i;
const OPENAI_IMAGE_RE = /(gpt-image|dall-e|flux|sdxl|stable-diffusion|ideogram|recraft|imagen|[-/]image\b|^image-)/i;

export function normalizeModelId(id: string): string {
  return id.trim().replace(/^models\//i, "");
}

export function isImagenModel(modelId: string): boolean {
  return /^imagen[-_]/i.test(normalizeModelId(modelId));
}

export function detectProviderKindFromKey(rawKey: string): ProviderKind | null {
  const key = rawKey.trim();
  if (!key) return null;
  if (/^AIza[0-9A-Za-z\-_]{16,}$/.test(key)) return "Gemini";
  if (/^sk-ant-[0-9A-Za-z\-_]{16,}$/.test(key)) return "Anthropic";
  if (/^sk-(?:proj-|live-|svcacct-)?[0-9A-Za-z\-_]{16,}$/.test(key)) return "OpenAI";
  return null;
}

function versionTuple(id: string): number {
  const m = id.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  return Number(m[1]) * 100 + Number(m[2] || 0);
}

function scoreGeminiText(id: string): number {
  const low = id.toLowerCase();
  if (low === "gemini-4-hydrogen") return 1000;
  if (low === "gemini-4-argon") return 960;
  if (low === "gemini-4-neon") return 940;
  if (low === "gemini-4-carbon") return 920;
  if (low === "gemini-3.5-flash-lite") return 880;
  if (low === "gemini-3.1-flash-lite") return 860;
  if (low.startsWith("gemini-4")) return 900 - (low.includes("preview") ? 10 : 0);
  if (low.startsWith("gemini-3")) return 800 + versionTuple(low) - (low.includes("preview") ? 10 : 0);
  if (low.startsWith("gemma-4")) return 720;
  if (low.startsWith("gemini-2.5")) return 500 - (low.includes("preview") ? 15 : 0);
  if (low.startsWith("gemini-2.0")) return 400 - (low.includes("exp") ? 15 : 0);
  if (low.startsWith("gemini-1.5")) return 300;
  return 200 + versionTuple(low);
}

function scoreGeminiImage(id: string): number {
  const low = id.toLowerCase();
  if (low === "gemini-nano-banana-2.1") return 1000;
  if (low === "gemini-3.1-flash-lite-image") return 960;
  if (low === "gemini-3-pro-image") return 940;
  if (low.includes("nano-banana")) return 920 + versionTuple(low);
  if (low.startsWith("gemini-4") && low.includes("image")) return 910;
  if (low.startsWith("gemini-3") && low.includes("image")) return 890 + versionTuple(low);
  if (low.startsWith("imagen-4")) return 820 - (low.includes("ultra") ? 5 : 0) + (low.includes("fast") ? 10 : 0);
  if (low.startsWith("imagen-3")) return 760 + (low.includes("fast") ? 10 : 0);
  if (low.startsWith("imagen")) return 720 + versionTuple(low);
  if (low.includes("image")) return 650 + versionTuple(low);
  return 500;
}

function scoreOpenAiText(id: string): number {
  const low = id.toLowerCase();
  if (low === "gpt-4.1-mini") return 980;
  if (low === "gpt-4.1") return 970;
  if (low === "gpt-4o-mini") return 950;
  if (low === "gpt-4o") return 940;
  if (low.startsWith("gpt-5")) return 960 - (low.includes("nano") ? 5 : 0);
  if (low.startsWith("gpt-4.1")) return 930;
  if (low.startsWith("gpt-4o")) return 900;
  if (low.startsWith("o4-mini") || low.startsWith("o3-mini")) return 860;
  if (low.startsWith("gpt-4")) return 820;
  return 500 + versionTuple(low);
}

function scoreOpenAiImage(id: string): number {
  const low = id.toLowerCase();
  if (low === "gpt-image-1.5") return 1000;
  if (low === "gpt-image-1") return 980;
  if (low === "gpt-image-1-mini") return 950;
  if (low.startsWith("gpt-image")) return 940;
  if (low === "dall-e-3") return 880;
  if (low === "dall-e-2") return 800;
  if (low.includes("flux")) return 860;
  return 700 + versionTuple(low);
}

function scoreAnthropicText(id: string): number {
  const low = id.toLowerCase();
  if (low.includes("sonnet-4")) return 980 + versionTuple(low);
  if (low.includes("haiku-4")) return 940 + versionTuple(low);
  if (low.includes("opus-4")) return 900 + versionTuple(low);
  if (low.includes("sonnet")) return 850;
  if (low.includes("haiku")) return 820;
  return 700 + versionTuple(low);
}

export function classifyAndRankModels(
  kind: ProviderKind,
  rawModels: RawProviderModel[],
): DiscoveredModels {
  const textSet = new Set<string>();
  const imageSet = new Set<string>();
  const seen = new Set<string>();

  for (const item of rawModels) {
    const id = normalizeModelId(item.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);

    if (EXCLUDED_MODEL_RE.test(id)) continue;

    if (kind === "Gemini") {
      const methods = item.supportedGenerationMethods ?? [];
      const hasMethods = methods.length > 0;
      const canGenerate = !hasMethods || methods.includes("generateContent");
      const canPredict = !hasMethods || methods.includes("predict");

      if (GEMINI_IMAGE_RE.test(id)) {
        if ((isImagenModel(id) && canPredict) || (!isImagenModel(id) && canGenerate)) {
          imageSet.add(id);
        }
        continue;
      }

      if (canGenerate && (/^gemini|^gemma/i.test(id) || !hasMethods)) {
        textSet.add(id);
      }
      continue;
    }

    if (kind === "Anthropic") {
      if (/^claude/i.test(id) || id.length > 0) {
        textSet.add(id);
      }
      continue;
    }

    // OpenAI and OpenAICompatible
    if (OPENAI_IMAGE_RE.test(id)) {
      imageSet.add(id);
      continue;
    }
    if (kind === "OpenAI") {
      if (/^(gpt-|o1|o3|o4|chatgpt-)/i.test(id) && !/instruct|search|transcribe|tts|audio/i.test(id)) {
        textSet.add(id);
      }
    } else {
      textSet.add(id);
    }
  }

  const textModels = [...textSet].sort((a, b) => {
    if (kind === "Gemini") return scoreGeminiText(b) - scoreGeminiText(a) || a.localeCompare(b);
    if (kind === "Anthropic") return scoreAnthropicText(b) - scoreAnthropicText(a) || a.localeCompare(b);
    return scoreOpenAiText(b) - scoreOpenAiText(a) || a.localeCompare(b);
  });

  const imageModels = [...imageSet].sort((a, b) => {
    if (kind === "Gemini") return scoreGeminiImage(b) - scoreGeminiImage(a) || a.localeCompare(b);
    return scoreOpenAiImage(b) - scoreOpenAiImage(a) || a.localeCompare(b);
  });

  return {
    textModels,
    imageModels,
    totalCount: seen.size,
    fetchedAt: Date.now(),
  };
}

export function buildCandidateChain(options: {
  autoModel?: boolean;
  preferred?: string;
  discovered?: string[];
  fallbackDefaults?: string[];
}): string[] {
  const auto = options.autoModel !== false;
  const preferred = normalizeModelId(options.preferred || "");
  const cleanPreferred = preferred && preferred.toLowerCase() !== "auto" ? preferred : "";
  const discovered = (options.discovered ?? []).map(normalizeModelId).filter(Boolean);
  const defaults = (options.fallbackDefaults ?? []).map(normalizeModelId).filter(Boolean);

  const ordered: string[] = [];
  const pushUnique = (list: string[]) => {
    for (const item of list) {
      if (item && !ordered.includes(item)) ordered.push(item);
    }
  };

  if (!auto && cleanPreferred) {
    // Manual override comes first, followed by live discovered models as fallback if it hits limit.
    pushUnique([cleanPreferred]);
    pushUnique(discovered);
    pushUnique(defaults);
  } else if (discovered.length > 0) {
    // Auto mode with live discovered models: trust live available models in ranked order.
    if (cleanPreferred && discovered.includes(cleanPreferred)) {
      pushUnique([cleanPreferred]);
    }
    pushUnique(discovered);
  } else {
    // Discovery unavailable (e.g. custom proxy without /models): use preferred then defaults.
    if (cleanPreferred) pushUnique([cleanPreferred]);
    pushUnique(defaults);
  }

  return ordered;
}

export function isAuthFailure(status: number, message: string): boolean {
  if (status === 401) return true;
  return /(api[_\s-]?key[_\s-]?invalid|api key not valid|invalid api key|incorrect api key|invalid x-api-key|authentication failed|unauthorized)/i.test(
    message,
  );
}

export function shouldSwitchModel(status: number, message: string): boolean {
  if (isAuthFailure(status, message)) return false;
  if (status === 429 || status === 404 || status === 403 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  if (status === 400) {
    return /(not supported|modality|response.?modalit|unknown model|invalid model|model.*not found|does not support|deprecated|not available|aspect.?ratio|size.*not supported)/i.test(
      message,
    );
  }
  return /(quota|rate.?limit|resource.?exhausted|limit exceeded|too many requests|overloaded|capacity|unavailable|model.*not found)/i.test(
    message,
  );
}

export function openAiImageSizeForModel(modelId: string, aspectRatio: "9:16" | "16:9"): string {
  const low = normalizeModelId(modelId).toLowerCase();
  if (low.startsWith("dall-e-2")) return "1024x1024";
  if (low.startsWith("dall-e-3")) return aspectRatio === "9:16" ? "1024x1792" : "1792x1024";
  return aspectRatio === "9:16" ? "1024x1536" : "1536x1024";
}
