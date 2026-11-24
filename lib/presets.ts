import type {
  AspectRatio,
  CanvasNode,
  NmcProject,
  NodeKind,
  PlatformPreset,
  ProviderProfile,
} from "./types.ts";

export const uid = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const DEFAULT_CLOUDFLARE_ID = "default-cloudflare-ai";
export const DEFAULT_GEMINI_ID = "default-gemini";
export const DEFAULT_OPENAI_ID = "default-openai";
export const DEFAULT_ANTHROPIC_ID = "default-anthropic";
export const DEFAULT_OLLAMA_ID = "default-ollama";

export interface VisualStylePreset {
  id: string;
  label: string;
  summary: string;
  prompt: string;
}

export const VISUAL_STYLE_PRESETS: VisualStylePreset[] = [
  {
    id: "cinematic-35mm",
    label: "Sinematik Realistis (Film 35mm)",
    summary: "Live-action realistis, depth of field dangkal, cahaya hangat alami",
    prompt:
      "Cinematic realistic live-action 35mm film, natural skin texture, shallow depth of field, warm practical lighting, subtle film grain",
  },
  {
    id: "anime-modern",
    label: "Anime Modern (Cel-Shaded)",
    summary: "Garis bersih, pencahayaan atmosferik, ekspresi dramatis",
    prompt:
      "Modern high-budget Japanese anime, crisp clean lineart, vibrant cel shading, atmospheric light rays, expressive character acting",
  },
  {
    id: "stylized-3d",
    label: "Animasi 3D Stylized",
    summary: "Render 3D halus, tekstur kain & cahaya global lembut",
    prompt:
      "Stylized 3D animated film, soft global illumination, tactile fabric and surface shading, expressive eyes, balanced cinematic framing",
  },
  {
    id: "neo-noir",
    label: "Neo-Noir Malam",
    summary: "Kontras tinggi, pantulan aspal basah, cahaya amber & bayangan dalam",
    prompt:
      "High-contrast neo-noir night cinematography, wet street reflections, moody amber and deep shadow key light, anamorphic lens",
  },
  {
    id: "webtoon-comic",
    label: "Komik / Webtoon Clean Line",
    summary: "Ilustrasi digital bersih dengan tinta tegas & rim light",
    prompt:
      "Clean digital webtoon comic illustration, crisp ink outlines, editorial color blocks with focused rim lighting",
  },
  {
    id: "documentary",
    label: "Dokumenter Natural Handheld",
    summary: "Cahaya natural tanpa polesan studio, nuansa kamera genggam",
    prompt:
      "Naturalistic documentary cinematography, authentic overcast daylight, unpolished real-world wardrobe, subtle handheld camera feel",
  },
  {
    id: "retro-90s",
    label: "Vintage Retro 90-an",
    summary: "Palet analog Kodak, halation lembut, butiran film nostalgia",
    prompt:
      "1990s analog cinema aesthetic, Kodak Portra color palette, soft highlight halation, nostalgic warm film grain",
  },
  {
    id: "watercolor-warm",
    label: "Ilustrasi Cat Air Hangat",
    summary: "Sapuan kuas organik, suasana buku cerita golden hour",
    prompt:
      "Hand-painted warm watercolor and gouache illustration, gentle organic brushwork, storybook golden-hour color palette",
  },
];

export const DEFAULT_VISUAL_STYLE = VISUAL_STYLE_PRESETS[0].prompt;

export function matchVisualStylePreset(styleText: string): string {
  const clean = styleText.trim();
  const found = VISUAL_STYLE_PRESETS.find((preset) => preset.prompt === clean);
  return found ? found.id : "custom";
}

export const defaultProfiles = (): ProviderProfile[] => [
  {
    id: DEFAULT_CLOUDFLARE_ID,
    name: "Cloudflare Workers AI",
    kind: "CloudflareAI",
    baseUrl: "https://api.cloudflare.com/client/v4",
    textModel: "",
    imageModel: "",
    timeoutSecs: 180,
    autoModel: true,
  },
  {
    id: DEFAULT_GEMINI_ID,
    name: "Gemini API",
    kind: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    textModel: "",
    imageModel: "",
    timeoutSecs: 180,
    autoModel: true,
  },
  {
    id: DEFAULT_OPENAI_ID,
    name: "OpenAI",
    kind: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    textModel: "",
    imageModel: "",
    timeoutSecs: 180,
    autoModel: true,
  },
  {
    id: DEFAULT_ANTHROPIC_ID,
    name: "Anthropic",
    kind: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    textModel: "",
    imageModel: "",
    timeoutSecs: 180,
    autoModel: true,
  },
  {
    id: DEFAULT_OLLAMA_ID,
    name: "Ollama / OpenAI Lokal",
    kind: "OpenAICompatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    textModel: "",
    imageModel: "",
    timeoutSecs: 180,
    autoModel: true,
  },
];

export const NODE_META: Record<
  NodeKind,
  {
    label: string;
    stage: string;
    stageOrder: number;
    hasInput: boolean;
    hasOutput: boolean;
    allowedTargets: NodeKind[];
    hint: string;
  }
> = {
  script: {
    label: "Naskah & Beat",
    stage: "01 Naskah",
    stageOrder: 1,
    hasInput: false,
    hasOutput: true,
    allowedTargets: ["asset", "segment"],
    hint: "Premis, gaya visual, naskah AI, dan beat",
  },
  asset: {
    label: "Aset & Lock",
    stage: "02 Aset",
    stageOrder: 2,
    hasInput: true,
    hasOutput: true,
    allowedTargets: ["segment"],
    hint: "Karakter 4-view, lokasi kosong, atau prop",
  },
  segment: {
    label: "Segmen Video",
    stage: "03 Segmen",
    stageOrder: 3,
    hasInput: true,
    hasOutput: true,
    allowedTargets: ["assembly"],
    hint: "Prompt mandiri, Google Flow, kamera, media",
  },
  audio: {
    label: "Audio / BGM",
    stage: "03 Audio",
    stageOrder: 3,
    hasInput: false,
    hasOutput: true,
    allowedTargets: ["assembly"],
    hint: "VO, musik latar, atau ambient hujan",
  },
  assembly: {
    label: "Timeline & Check",
    stage: "04 Rakit",
    stageOrder: 4,
    hasInput: true,
    hasOutput: true,
    allowedTargets: ["export"],
    hint: "Validasi kontinuitas, SRT/ASS, loudness",
  },
  export: {
    label: "Render & Flow",
    stage: "05 Ekspor",
    stageOrder: 5,
    hasInput: true,
    hasOutput: false,
    allowedTargets: [],
    hint: "FFmpeg lokal, Draft CapCut, atau Google Flow",
  },
};

export function canConnect(sourceKind: NodeKind, targetKind: NodeKind): boolean {
  return NODE_META[sourceKind].allowedTargets.includes(targetKind);
}

export function resolutionFor(aspect: AspectRatio): { width: number; height: number } {
  return aspect === "9:16" ? { width: 1080, height: 1920 } : { width: 1280, height: 720 };
}

export function createDefaultNode(kind: NodeKind, x: number, y: number, index = 1): CanvasNode {
  const id = uid();
  switch (kind) {
    case "script":
      return {
        id,
        kind,
        title: "Naskah Utama",
        x,
        y,
        data: {
          kind: "script",
          premise: "",
          scriptText: "",
          aspectRatio: "16:9",
          maxSegmentSec: 8,
          targetSegments: 5,
          visualStyle: DEFAULT_VISUAL_STYLE,
          beats: [],
        },
      };
    case "asset":
      return {
        id,
        kind,
        title: `Aset ${index}`,
        x,
        y,
        data: {
          kind: "asset",
          tag: `@Aset${index}`,
          category: "character",
          lockPrompt: "",
        },
      };
    case "segment":
      return {
        id,
        kind,
        title: `Segmen G0${index}`,
        x,
        y,
        data: {
          kind: "segment",
          code: `G0${index}`,
          durationSec: 6,
          shotSize: "MS",
          cameraAngle: "Front",
          cameraMotion: "Push-In",
          timelineText: "",
          dialogue: "",
          continuityLock: "",
          candidates: [],
        },
      };
    case "audio":
      return {
        id,
        kind,
        title: "Audio Ambient",
        x,
        y,
        data: {
          kind: "audio",
          role: "ambient",
          volume: 0.14,
          startSec: 0,
          sourceMode: "ambient-rain",
        },
      };
    case "assembly":
      return {
        id,
        kind,
        title: "Timeline & Check",
        x,
        y,
        data: {
          kind: "assembly",
          fps: 24,
          targetLufs: -14,
          burnSubtitles: true,
          fadeOutSec: 1.0,
        },
      };
    case "export":
      return {
        id,
        kind,
        title: "Output Hybrid",
        x,
        y,
        data: {
          kind: "export",
          platform: "google-flow",
          capcutDraftsDir: "",
        },
      };
  }
}

export function createEmptyProject(name = "Proyek Baru"): NmcProject {
  return {
    schemaVersion: 1,
    id: uid(),
    name,
    updatedAt: Date.now(),
    viewport: { x: 48, y: 48, zoom: 0.92 },
    nodes: [],
    edges: [],
  };
}

export function createStarterProject(
  name = "Proyek Baru",
  options: {
    aspectRatio?: AspectRatio;
    visualStyle?: string;
    premise?: string;
    maxSegmentSec?: number;
    platform?: PlatformPreset;
  } = {},
): NmcProject {
  const scriptNode = createDefaultNode("script", 40, 120, 1);
  if (scriptNode.data.kind === "script") {
    scriptNode.data = {
      ...scriptNode.data,
      aspectRatio: options.aspectRatio ?? "16:9",
      visualStyle: options.visualStyle?.trim() || DEFAULT_VISUAL_STYLE,
      premise: options.premise ?? "",
      maxSegmentSec: options.maxSegmentSec ?? 8,
    };
  }
  const asmNode = createDefaultNode("assembly", 780, 120, 1);
  const expNode = createDefaultNode("export", 1120, 120, 1);
  if (expNode.data.kind === "export") {
    expNode.data = {
      ...expNode.data,
      platform:
        options.platform ??
        ((options.maxSegmentSec ?? 8) === 8
          ? "google-flow"
          : options.aspectRatio === "9:16"
            ? "reels"
            : "youtube"),
    };
  }

  return {
    schemaVersion: 1,
    id: uid(),
    name: name.trim() || "Proyek Baru",
    updatedAt: Date.now(),
    viewport: { x: 36, y: 40, zoom: 0.88 },
    nodes: [scriptNode, asmNode, expNode],
    edges: [{ id: uid(), source: asmNode.id, target: expNode.id }],
  };
}
