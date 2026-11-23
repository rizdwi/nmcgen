import type {
  AspectRatio,
  CanvasNode,
  NmcProject,
  NodeKind,
  ProviderProfile,
} from "./types.ts";

export const uid = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const DEFAULT_GEMINI_ID = "default-gemini";
export const DEFAULT_OPENAI_ID = "default-openai";
export const DEFAULT_ANTHROPIC_ID = "default-anthropic";
export const DEFAULT_OLLAMA_ID = "default-ollama";

export const defaultProfiles = (): ProviderProfile[] => [
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
    hint: "Ide, rasio, dan daftar beat berdurasi",
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
    hint: "Prompt mandiri, kamera, media kandidat/adopsi",
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
    label: "Render & CapCut",
    stage: "05 Ekspor",
    stageOrder: 5,
    hasInput: true,
    hasOutput: false,
    allowedTargets: [],
    hint: "FFmpeg lokal, Draft CapCut, atau Bundle Web",
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
          maxSegmentSec: 15,
          visualStyle: "Film drama Indonesia kontemporer, pencahayaan hangat realistis",
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
          platform: "youtube",
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

export function createSampleProject(): NmcProject {
  const nScript = "node_script_1";
  const nRaka = "node_asset_raka";
  const nDina = "node_asset_dina";
  const nCafe = "node_asset_cafe";
  const nSeg1 = "node_seg_1";
  const nSeg2 = "node_seg_2";
  const nAudio = "node_audio_1";
  const nAsm = "node_asm_1";
  const nExp = "node_exp_1";

  return {
    schemaVersion: 1,
    id: uid(),
    name: "Contoh: Raka & Dina di Warung Kopi",
    updatedAt: Date.now(),
    viewport: { x: 36, y: 40, zoom: 0.78 },
    nodes: [
      {
        id: nScript,
        kind: "script",
        title: "Naskah: Warung Kopi Malam",
        x: 30,
        y: 160,
        data: {
          kind: "script",
          premise:
            "Raka mau mengakui kesalahannya ke Dina di warung kopi malam, tapi akhirnya hanya menaruh kunci motor di meja lalu pergi.",
          scriptText:
            "INT. WARUNG KOPI - MALAM\nLampu gantung kuning hangat. Hujan rintik di balik jendela kaca kanan.\nRaka (kiri) dan Dina (kanan) duduk berhadapan. Raka menunduk melihat cangkirnya, lalu mengangkat wajah.\nRAKA: Din, soal kemarin... aku yang salah.\nDina diam menatap dingin lalu memalingkan wajah ke jendela.\nRaka meletakkan kunci motor perak di tengah meja, berdiri, dan berjalan keluar pintu kaca.",
          aspectRatio: "16:9",
          maxSegmentSec: 15,
          visualStyle:
            "Film drama Indonesia realistis, pencahayaan lampu gantung amber hangat, kontras malam hujan",
          beats: [
            {
              id: "b1",
              code: "E01",
              durationSec: 4,
              summary: "Raka & Dina duduk berhadapan dalam diam.",
              dialogue: "",
            },
            {
              id: "b2",
              code: "E02",
              durationSec: 4,
              summary: "Raka mengangkat wajah dan mengakui kesalahannya.",
              dialogue: "Din, soal kemarin... aku yang salah.",
            },
            {
              id: "b3",
              code: "E03",
              durationSec: 3,
              summary: "Dina diam dan memalingkan wajah ke jendela hujan.",
              dialogue: "",
            },
            {
              id: "b4",
              code: "E04",
              durationSec: 4,
              summary: "Tangan Raka menaruh kunci motor perak di tengah meja.",
              dialogue: "",
            },
            {
              id: "b5",
              code: "E05",
              durationSec: 7,
              summary: "Raka berdiri dan keluar lewat pintu kaca, Dina tetap duduk.",
              dialogue: "",
            },
          ],
        },
      },
      {
        id: nRaka,
        kind: "asset",
        title: "Karakter @Raka",
        x: 380,
        y: 24,
        data: {
          kind: "asset",
          tag: "@Raka",
          category: "character",
          lockPrompt:
            "Pria Indonesia 24 tahun, rambut hitam pendek rapi, jaket denim indigo gelap, kaus abu tua, celana gelap.",
        },
      },
      {
        id: nDina,
        kind: "asset",
        title: "Karakter @Dina",
        x: 380,
        y: 214,
        data: {
          kind: "asset",
          tag: "@Dina",
          category: "character",
          lockPrompt:
            "Wanita Indonesia 23 tahun, rambut cokelat tua sebahu diselipkan di satu telinga, sweter rajut krem hangat.",
        },
      },
      {
        id: nCafe,
        kind: "asset",
        title: "Lokasi @WarungKopi",
        x: 380,
        y: 404,
        data: {
          kind: "asset",
          tag: "@WarungKopi",
          category: "location",
          lockPrompt:
            "Warung kopi malam kosong, meja kayu tengah dengan 2 cangkir keramik gelap, lampu gantung amber, jendela hujan kanan, pintu kaca belakang kanan.",
        },
      },
      {
        id: nSeg1,
        kind: "segment",
        title: "Segmen G01: Pengakuan",
        x: 750,
        y: 48,
        data: {
          kind: "segment",
          code: "G01",
          durationSec: 11,
          shotSize: "MS",
          cameraAngle: "Front",
          cameraMotion: "Push-In",
          timelineText:
            "[0:00-0:04] Medium two-shot, Raka menunduk melihat cangkir.\n[0:04-0:08] Raka menatap Dina dan mengucapkan pengakuan.\n[0:08-0:11] Dina diam dan menoleh ke jendela kanan.",
          dialogue: "Din, soal kemarin... aku yang salah.",
          continuityLock:
            "Raka di sisi kiri meja, Dina di sisi kanan, 2 cangkir kopi utuh, cahaya kuning dari atas.",
          candidates: [],
        },
      },
      {
        id: nSeg2,
        kind: "segment",
        title: "Segmen G02: Kunci & Pergi",
        x: 750,
        y: 300,
        data: {
          kind: "segment",
          code: "G02",
          durationSec: 11,
          shotSize: "CU",
          cameraAngle: "Side 90",
          cameraMotion: "Pull-Out",
          timelineText:
            "[0:00-0:04] Close-up meja kayu, tangan kanan Raka menaruh kunci motor perak di tengah meja.\n[0:04-0:11] Sudut samping medium-wide, Raka berdiri menuju pintu kaca belakang sementara Dina tetap duduk.",
          dialogue: "",
          continuityLock:
            "Posisi awal tetap (Raka kiri, Dina kanan menoleh jendela). Kunci motor perak diletakkan di tengah meja.",
          candidates: [],
        },
      },
      {
        id: nAudio,
        kind: "audio",
        title: "Ambient Hujan Malam",
        x: 750,
        y: 545,
        data: {
          kind: "audio",
          role: "ambient",
          volume: 0.12,
          startSec: 0,
          sourceMode: "ambient-rain",
        },
      },
      {
        id: nAsm,
        kind: "assembly",
        title: "Timeline & Validator",
        x: 1130,
        y: 190,
        data: {
          kind: "assembly",
          fps: 24,
          targetLufs: -14,
          burnSubtitles: true,
          fadeOutSec: 1.0,
        },
      },
      {
        id: nExp,
        kind: "export",
        title: "Render MP4 / CapCut",
        x: 1470,
        y: 190,
        data: {
          kind: "export",
          platform: "youtube",
          capcutDraftsDir: "",
        },
      },
    ],
    edges: [
      { id: "e_s_raka", source: nScript, target: nRaka },
      { id: "e_s_dina", source: nScript, target: nDina },
      { id: "e_s_cafe", source: nScript, target: nCafe },
      { id: "e_raka_s1", source: nRaka, target: nSeg1 },
      { id: "e_dina_s1", source: nDina, target: nSeg1 },
      { id: "e_cafe_s1", source: nCafe, target: nSeg1 },
      { id: "e_raka_s2", source: nRaka, target: nSeg2 },
      { id: "e_dina_s2", source: nDina, target: nSeg2 },
      { id: "e_cafe_s2", source: nCafe, target: nSeg2 },
      { id: "e_s1_asm", source: nSeg1, target: nAsm },
      { id: "e_s2_asm", source: nSeg2, target: nAsm },
      { id: "e_aud_asm", source: nAudio, target: nAsm },
      { id: "e_asm_exp", source: nAsm, target: nExp },
    ],
  };
}
