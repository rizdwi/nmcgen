// Pure Toonflow multi-agent pipeline helpers (ingestion -> event graph -> assets -> script -> storyboard -> supervision).
import type {
  AssetCategory,
  AssetNodeData,
  CameraAngle,
  CameraMotion,
  CanvasNode,
  NmcProject,
  ScriptBeat,
  ScriptNodeData,
  SegmentNodeData,
  ShotSize,
  ToonflowChapter,
  ToonflowEventNode,
  ToonflowSceneBlock,
  ToonflowSupervisionIssue,
  ToonflowSupervisionReport,
} from "./types.ts";
import { createDefaultNode, uid } from "./presets.ts";
import { autoArrangeNodes } from "./validator.ts";

const VALID_SHOTS: ShotSize[] = ["WS", "MS", "MCU", "CU", "ECU"];
const VALID_ANGLES: CameraAngle[] = ["Front", "Side 90", "Rear 3/4", "High", "Low"];
const VALID_MOTIONS: CameraMotion[] = ["Push-In", "Pull-Out", "Static", "Pan Right", "Pan Left"];

export function storyArcStages(count: number): string[] {
  const n = Math.max(3, Math.min(12, Math.round(count || 5)));
  if (n === 3) return ["Intro / Perkenalan", "Konflik & Klimaks", "Ending / Resolusi"];
  if (n === 4) return ["Intro / Perkenalan", "Masalah 1 (Pemicu)", "Klimaks", "Ending / Resolusi"];
  if (n === 5) {
    return [
      "Intro / Perkenalan",
      "Masalah 1 (Pemicu)",
      "Masalah 2 (Eskalasi)",
      "Klimaks",
      "Ending / Resolusi",
    ];
  }
  const mid = Array.from({ length: n - 3 }, (_, i) => `Masalah ${i + 1}`);
  return ["Intro / Perkenalan", ...mid, "Klimaks", "Ending / Resolusi"];
}

// Stage 1: Raw manuscript / novel ingestion, cleansing, and chapter splitting.
export function cleanSourceText(raw: string): string {
  return raw
    .replace(/\uFEFF|[\u200B-\u200D]/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => !/^(?:halaman|page)\s*\d+(?:\s*\/\s*\d+)?$/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitIntoChapters(raw: string): ToonflowChapter[] {
  const cleaned = cleanSourceText(raw);
  if (!cleaned) return [];

  const headingRe =
    /^(?:#{1,3}\s+|(?:bab|bagian|chapter|episode|ep\.?|bag\.?)\s+[0-9ivxlcdm]+(?:\s*[:.\-]\s*.*)?)$/i;
  const lines = cleaned.split("\n");
  const buckets: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (headingRe.test(line)) {
      if (current && current.lines.join("").trim()) buckets.push(current);
      current = { title: line.replace(/^#{1,3}\s+/, "").trim(), lines: [] };
    } else {
      if (!current) current = { title: "Bab 1: Materi Utama", lines: [] };
      current.lines.push(line);
    }
  }
  if (current && current.lines.join("").trim()) buckets.push(current);

  // If no explicit headings and text is long (>900 words), split by paragraphs into ~600-word chapters.
  if (buckets.length === 1) {
    const words = buckets[0].lines.join(" ").split(/\s+/).filter(Boolean);
    if (words.length > 900) {
      const paras = cleaned.split(/\n{2,}/);
      const chunked: Array<{ title: string; lines: string[] }> = [];
      let curParas: string[] = [];
      let curWords = 0;
      for (const p of paras) {
        const pw = p.split(/\s+/).filter(Boolean).length;
        if (curParas.length > 0 && curWords + pw > 650) {
          chunked.push({ title: `Bagian ${chunked.length + 1}`, lines: curParas });
          curParas = [p];
          curWords = pw;
        } else {
          curParas.push(p);
          curWords += pw;
        }
      }
      if (curParas.length) chunked.push({ title: `Bagian ${chunked.length + 1}`, lines: curParas });
      return chunked.map((b, idx) => {
        const content = b.lines.join("\n\n").trim();
        return {
          id: uid(),
          index: idx + 1,
          title: b.title,
          content,
          wordCount: content.split(/\s+/).filter(Boolean).length,
        };
      });
    }
  }

  return buckets.map((b, idx) => {
    const content = b.lines.join("\n").trim();
    return {
      id: uid(),
      index: idx + 1,
      title: b.title || `Bab ${idx + 1}`,
      content,
      wordCount: content.split(/\s+/).filter(Boolean).length,
    };
  });
}

function extractJsonSlice(raw: string, openChar: "[" | "{"): string | null {
  const closeChar = openChar === "[" ? "]" : "}";
  const cleaned = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf(openChar);
  const end = cleaned.lastIndexOf(closeChar);
  if (start === -1 || end === -1 || end <= start) return null;
  return cleaned.slice(start, end + 1);
}

// Stage 2: Event Graph / Causal Outline Agent.
export function buildEventGraphPrompt(params: {
  projectName: string;
  premise: string;
  chapterText?: string;
  targetSegments: number;
  maxSegmentSec: number;
  visualStyle: string;
}): { system: string; prompt: string } {
  const count = Math.max(3, Math.min(12, params.targetSegments || 5));
  const stages = storyArcStages(count);
  const material = (params.chapterText || "").trim().slice(0, 6000);

  return {
    system:
      "Kamu adalah Decision & Story Architect Agent ala Toonflow untuk film pendek. Tugasmu menyusun Event Graph kausal (sebab-akibat nyata) layaknya film pendek utuh, bukan potongan adegan acak. Balas HANYA JSON array valid tanpa markdown.",
    prompt: [
      `Susun Event Graph berisi TEPAT ${count} event kausal berurutan untuk episode film pendek "${params.projectName}".`,
      `Struktur babak wajib: ${stages.map((s, i) => `EV0${i + 1}="${s}"`).join(" -> ")}.`,
      "Aturan cerita film pendek yang wajib dipatuhi:",
      "1. Intro / Perkenalan: kenalkan tokoh utama (nama jelas, peran, motivasi/tujuan emosional konkret) dan latar awal. Ancaman puncak belum menyerang.",
      "2. Masalah 1 (Pemicu): peristiwa konkret yang memicu konflik dan memaksa tokoh bertindak.",
      "3. Masalah 2 (Eskalasi): upaya awal tokoh gagal, rintangan meningkat, taruhan nyawa/emosi memuncak, sekaligus muncul petunjuk kelemahan atau cara keluar.",
      "4. Klimaks: keputusan aktif dan aksi penentu tokoh utama menghadapi sumber masalah.",
      "5. Ending / Resolusi: akibat langsung klimaks, tujuan awal tokoh terjawab tuntas, perubahan suasana/emosi nyata (dilarang menggantung asal dengan teriak lalu hitam).",
      "6. Setiap event WAJIB saling tersambung sebab-akibat (effect dari EV01 menjadi cause di EV02, dst) dan memiliki lokasi/ruang berbeda atau berkembang agar visual tidak statis di satu sudut.",
      'Format JSON array: [{"code":"EV01","stage":"Intro / Perkenalan","title":"judul singkat event","summary":"kejadian konkret 1-2 kalimat","cause":"pemicu dari kondisi awal / event sebelumnya","effect":"akibat langsung yang memicu event berikutnya","conflict":"taruhan atau hambatan spesifik di event ini","emotion":"emosi dominan","location":"lokasi spesifik babak ini","characters":["@NamaTokoh"],"durationSec":8}]',
      `Durasi tiap event: 6-${params.maxSegmentSec || 8} detik.`,
      `Gaya visual: ${params.visualStyle}`,
      `Premis: ${params.premise}`,
      material ? `Materi sumber / bab novel:\n${material}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function parseEventGraphResponse(
  raw: string,
  targetSegments: number,
  maxSegmentSec: number,
): ToonflowEventNode[] {
  const slice = extractJsonSlice(raw, "[");
  if (!slice) throw new Error("Respons AI untuk Event Graph tidak berbentuk JSON array.");
  const parsed = JSON.parse(slice);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Event Graph yang dihasilkan AI kosong.");
  }
  const stages = storyArcStages(targetSegments || parsed.length);
  const cap = Math.max(4, Math.min(30, maxSegmentSec || 8));
  return parsed.map((item: Record<string, unknown>, idx: number) => {
    const rawChars = Array.isArray(item.characters) ? item.characters : [];
    const characters = rawChars
      .map((c) => String(c || "").trim())
      .filter(Boolean)
      .map((c) => (c.startsWith("@") ? c : `@${c.replace(/\s+/g, "")}`));
    return {
      id: uid(),
      code: String(item.code || `EV${String(idx + 1).padStart(2, "0")}`),
      stage: String(item.stage || stages[idx] || `Babak ${idx + 1}`),
      title: String(item.title || stages[idx] || `Event ${idx + 1}`),
      summary: String(item.summary || ""),
      cause: String(item.cause || ""),
      effect: String(item.effect || ""),
      conflict: String(item.conflict || ""),
      emotion: String(item.emotion || ""),
      location: String(item.location || ""),
      characters,
      durationSec: Math.max(4, Math.min(cap, Number(item.durationSec) || Math.min(cap, 8))),
    };
  });
}

// Stage 3: Character, Location & Prop Asset Extraction Agent.
export interface ExtractedAssetSpec {
  tag: string;
  title: string;
  category: AssetCategory;
  lockPrompt: string;
}

export function buildAssetExtractionPrompt(params: {
  projectName: string;
  visualStyle: string;
  events: ToonflowEventNode[];
}): { system: string; prompt: string } {
  const eventLines = params.events
    .map(
      (ev) =>
        `${ev.code} [${ev.stage}] ${ev.title} | Lokasi: ${ev.location} | Karakter: ${ev.characters.join(", ")} | Ringkasan: ${ev.summary}`,
    )
    .join("\n");

  return {
    system:
      "Kamu adalah Asset Director Agent ala Toonflow. Ekstrak entitas karakter utama, antagonis/makhluk, lokasi kunci, dan prop penting dari Event Graph dengan deskripsi visual bahasa Inggris yang konsisten untuk AI image generation. Balas HANYA JSON array valid.",
    prompt: [
      `Analisis Event Graph episode "${params.projectName}" berikut lalu ekstrak 3 sampai 5 aset visual paling penting (prioritaskan karakter manusia utama, antagonis/monster jika ada, 1 lokasi utama, dan 1 prop kunci bila relevan).`,
      'Format JSON array: [{"tag":"@Raka","title":"Raka (Fotografer)","category":"character","lockPrompt":"Detailed English physical appearance, age, hair, outfit colors, held gear, consistent face and silhouette"}]',
      'Nilai valid category: "character" | "location" | "prop".',
      "Tag wajib memakai awalan @ tanpa spasi dan konsisten dengan nama tokoh di Event Graph.",
      `Gaya visual: ${params.visualStyle}`,
      `Event Graph:\n${eventLines}`,
    ].join("\n"),
  };
}

export function parseExtractedAssets(raw: string): ExtractedAssetSpec[] {
  const slice = extractJsonSlice(raw, "[");
  if (!slice) throw new Error("Respons ekstraksi aset AI tidak berbentuk JSON array.");
  const parsed = JSON.parse(slice);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Daftar aset dari AI kosong.");
  }
  const validCats: AssetCategory[] = ["character", "location", "prop"];
  const seen = new Set<string>();
  const out: ExtractedAssetSpec[] = [];
  for (const item of parsed as Record<string, unknown>[]) {
    const rawTag = String(item.tag || item.title || "").trim();
    if (!rawTag) continue;
    const tag = rawTag.startsWith("@")
      ? rawTag.replace(/\s+/g, "")
      : `@${rawTag.replace(/[^a-zA-Z0-9_]/g, "")}`;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cat = validCats.includes(item.category as AssetCategory)
      ? (item.category as AssetCategory)
      : "character";
    out.push({
      tag,
      title: String(item.title || tag.slice(1)),
      category: cat,
      lockPrompt: String(item.lockPrompt || "").trim(),
    });
  }
  return out.slice(0, 6);
}

// Stage 4: Structured ScriptAgent (pulls from Event Graph + Assets, never messy raw text).
export function buildScriptAgentPrompt(params: {
  projectName: string;
  visualStyle: string;
  maxSegmentSec: number;
  events: ToonflowEventNode[];
  assets: Array<{ tag: string; category: AssetCategory; lockPrompt: string }>;
}): { system: string; prompt: string } {
  const eventLines = params.events
    .map(
      (ev) =>
        `${ev.code} [${ev.stage}] (${ev.durationSec}s) ${ev.title}\n  Lokasi: ${ev.location}\n  Karakter: ${ev.characters.join(", ")}\n  Sebab: ${ev.cause}\n  Konflik: ${ev.conflict}\n  Ringkasan: ${ev.summary}\n  Akibat: ${ev.effect}\n  Emosi: ${ev.emotion}`,
    )
    .join("\n\n");
  const assetLines = params.assets.map((a) => `- ${a.tag} (${a.category}): ${a.lockPrompt}`).join("\n");

  return {
    system:
      "Kamu adalah ScriptAgent ala Toonflow. Adaptasikan Event Graph menjadi naskah film pendek terstruktur per babak dengan dialog Indonesia natural, aksi visual konkret, monolog batin singkat, dan catatan penyutradaraan. Balas HANYA JSON array valid.",
    prompt: [
      `Adaptasikan TEPAT ${params.events.length} event berikut menjadi ${params.events.length} blok adegan skenario untuk "${params.projectName}".`,
      'Format JSON array: [{"code":"SC01","eventCode":"EV01","stage":"Intro / Perkenalan","heading":"EXT. LOKASI SPESIFIK - WAKTU","action":"deskripsi aksi visual konkret dalam bahasa Indonesia (1-2 kalimat)","dialogue":"dialog lisan natural Indonesia maks 12 kata agar pas diucapkan dalam 7-8 detik","innerThought":"monolog batin atau subteks emosi tokoh","directorNote":"arahan tempo, pencahayaan, dan suasana suara","emotion":"emosi adegan"}]',
      "Aturan ketat:",
      "1. Setiap blok wajib melanjutkan sebab-akibat dari blok sebelumnya secara organik.",
      "2. Dialog harus manusiawi, tajam, mendorong alur maju (bukan sekadar teriak tidak jelas), dan maks 12 kata per adegan.",
      "3. Sebut tag karakter (@Nama) atau nama tokoh secara konsisten sesuai daftar aset.",
      `Batas durasi per segmen: ${params.maxSegmentSec || 8} detik. Gaya visual: ${params.visualStyle}.`,
      assetLines ? `Daftar Aset Visual:\n${assetLines}` : "",
      `Event Graph:\n${eventLines}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function parseScriptAgentResponse(
  raw: string,
  events: ToonflowEventNode[],
): ToonflowSceneBlock[] {
  const slice = extractJsonSlice(raw, "[");
  if (!slice) throw new Error("Respons ScriptAgent tidak berbentuk JSON array.");
  const parsed = JSON.parse(slice);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Blok naskah ScriptAgent kosong.");
  }
  return parsed.map((item: Record<string, unknown>, idx: number) => {
    const ev = events[idx];
    return {
      id: uid(),
      eventId: ev?.id ?? "",
      code: String(item.code || `SC${String(idx + 1).padStart(2, "0")}`),
      stage: String(item.stage || ev?.stage || `Babak ${idx + 1}`),
      heading: String(item.heading || (ev?.location ? `EXT. ${ev.location.toUpperCase()}` : `ADEGAN ${idx + 1}`)),
      action: String(item.action || ev?.summary || ""),
      dialogue: String(item.dialogue || ""),
      innerThought: typeof item.innerThought === "string" ? item.innerThought : "",
      directorNote: typeof item.directorNote === "string" ? item.directorNote : "",
      emotion: String(item.emotion || ev?.emotion || ""),
    };
  });
}

export function formatScenesToScreenplay(scenes: ToonflowSceneBlock[]): string {
  return scenes
    .map((sc, idx) => {
      const lines = [
        `BABAK ${idx + 1} [${sc.stage}]`,
        sc.heading,
        sc.action,
      ];
      if (sc.dialogue.trim()) lines.push(`DIALOG: "${sc.dialogue.trim()}"`);
      if (sc.innerThought?.trim()) lines.push(`BATIN: (${sc.innerThought.trim()})`);
      if (sc.directorNote?.trim()) lines.push(`ARAHAN: ${sc.directorNote.trim()}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

// Stage 5: Storyboard ProductionAgent (converts Event Graph + Structured Script -> Cinematic Beats & Visual Prompts).
export function buildStoryboardAgentPrompt(params: {
  projectName: string;
  aspectRatio: string;
  maxSegmentSec: number;
  visualStyle: string;
  events: ToonflowEventNode[];
  scenes: ToonflowSceneBlock[];
  assets: Array<{ tag: string; category: AssetCategory; lockPrompt: string }>;
}): { system: string; prompt: string } {
  const count = Math.max(params.events.length, params.scenes.length, 5);
  const combined = Array.from({ length: count }, (_, idx) => {
    const ev = params.events[idx];
    const sc = params.scenes[idx];
    return [
      `#${idx + 1} [${sc?.stage || ev?.stage || `Babak ${idx + 1}`}] (${ev?.durationSec || params.maxSegmentSec || 8}s)`,
      sc?.heading ? `Heading: ${sc.heading}` : ev?.location ? `Lokasi: ${ev.location}` : "",
      ev?.characters?.length ? `Karakter hadir: ${ev.characters.join(", ")}` : "",
      `Aksi: ${sc?.action || ev?.summary || ""}`,
      sc?.dialogue ? `Dialog: "${sc.dialogue}"` : "",
      sc?.directorNote ? `Arahan: ${sc.directorNote}` : "",
    ]
      .filter(Boolean)
      .join(" | ");
  }).join("\n");

  const assetLines = params.assets.map((a) => `- ${a.tag} (${a.category}): ${a.lockPrompt}`).join("\n");

  return {
    system:
      "Kamu adalah ProductionAgent / Storyboard Director ala Toonflow. Ubah skenario terstruktur menjadi shot storyboard sinematik dengan variasi sudut kamera nyata dan prompt visual bahasa Inggris bebas teks/dialog untuk AI gambar. Balas HANYA JSON array valid.",
    prompt: [
      `Susun TEPAT ${count} shot storyboard (E01..E0${count}) untuk episode "${params.projectName}".`,
      'Format JSON array: [{"code":"E01","stage":"Intro / Perkenalan","durationSec":8,"summary":"aksi visual Indonesia konkret menyebut @Tag tokoh yang benar-benar muncul di adegan ini","dialogue":"dialog Indonesia singkat maks 12 kata","continuityLock":"kunci kontinuitas properti, kostum, arah pandang, dan cahaya dari shot sebelumnya","shotSize":"WS","cameraAngle":"Front","cameraMotion":"Push-In","visualPrompt":"vivid English cinematic film still describing exact shot framing, distinct setting angle, character pose and facial emotion, dramatic lighting, concrete physical props, zero text or subtitles"}]',
      "Aturan sinematografi ketat:",
      "1. Wajib bedakan shotSize, cameraAngle, dan ruang latar antar shot berturut-turut (JANGAN mengulang sudut gerbang/latar yang sama di semua shot!).",
      "2. Pada summary dan visualPrompt, HANYA masukkan karakter/monster yang memang muncul di babak tersebut (misal jika monster belum muncul di Intro, JANGAN sebut monster di E01!).",
      "3. visualPrompt wajib dalam bahasa Inggris sinematik, deskriptif secara visual, tanpa tanda kutip dialog, tanpa timecode.",
      `Nilai valid: shotSize in [WS,MS,MCU,CU,ECU], cameraAngle in [Front,Side 90,Rear 3/4,High,Low], cameraMotion in [Static,Push-In,Pull-Out,Pan Right,Pan Left].`,
      `Rasio: ${params.aspectRatio}, durasi maks: ${params.maxSegmentSec} detik, gaya: ${params.visualStyle}.`,
      assetLines ? `Aset tersedia:\n${assetLines}` : "",
      `Skenario terstruktur:\n${combined}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function parseStoryboardBeats(
  raw: string,
  events: ToonflowEventNode[],
  scenes: ToonflowSceneBlock[],
  maxSegmentSec: number,
): ScriptBeat[] {
  const slice = extractJsonSlice(raw, "[");
  if (!slice) throw new Error("Respons ProductionAgent tidak berbentuk JSON array.");
  const parsed = JSON.parse(slice);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Daftar storyboard beat kosong.");
  }
  const fallbackShots: ShotSize[] = ["WS", "MS", "MCU", "CU", "WS"];
  const fallbackAngles: CameraAngle[] = ["Front", "Side 90", "Low", "Rear 3/4", "High"];
  const fallbackMotions: CameraMotion[] = ["Push-In", "Pan Right", "Push-In", "Pull-Out", "Pull-Out"];
  const cap = Math.max(4, Math.min(30, maxSegmentSec || 8));

  const beats = parsed.map((item: Record<string, unknown>, idx: number): ScriptBeat => {
    const ev = events[idx];
    const sc = scenes[idx];
    const shotSize = VALID_SHOTS.includes(item.shotSize as ShotSize)
      ? (item.shotSize as ShotSize)
      : fallbackShots[idx % fallbackShots.length];
    const cameraAngle = VALID_ANGLES.includes(item.cameraAngle as CameraAngle)
      ? (item.cameraAngle as CameraAngle)
      : fallbackAngles[idx % fallbackAngles.length];
    const cameraMotion = VALID_MOTIONS.includes(item.cameraMotion as CameraMotion)
      ? (item.cameraMotion as CameraMotion)
      : fallbackMotions[idx % fallbackMotions.length];

    return {
      id: uid(),
      code: String(item.code || `E${String(idx + 1).padStart(2, "0")}`),
      stage: String(item.stage || sc?.stage || ev?.stage || `Babak ${idx + 1}`),
      durationSec: Math.max(4, Math.min(cap, Number(item.durationSec) || ev?.durationSec || Math.min(cap, 8))),
      summary: String(item.summary || sc?.action || ev?.summary || ""),
      dialogue: String(item.dialogue ?? sc?.dialogue ?? ""),
      continuityLock: String(item.continuityLock || ""),
      shotSize,
      cameraAngle,
      cameraMotion,
      visualPrompt: String(item.visualPrompt || ""),
    };
  });

  // Guarantee zero adjacent identical shotSize + cameraAngle pairs.
  for (let i = 1; i < beats.length; i++) {
    if (beats[i].shotSize === beats[i - 1].shotSize && beats[i].cameraAngle === beats[i - 1].cameraAngle) {
      beats[i].cameraAngle = VALID_ANGLES[(VALID_ANGLES.indexOf(beats[i].cameraAngle!) + 1) % VALID_ANGLES.length];
    }
  }
  return beats;
}

// Stage 5B: Conversational AI Frame Editing (revises one segment's camera + visual prompt from natural instruction).
export function buildConversationalEditPrompt(params: {
  segment: SegmentNodeData;
  instruction: string;
  visualStyle: string;
  boundAssetTags: string[];
}): { system: string; prompt: string } {
  return {
    system:
      "Kamu adalah Storyboard Editor Agent ala Toonflow. Revisi satu shot storyboard berdasarkan instruksi natural pengguna. Balas HANYA JSON object valid.",
    prompt: [
      "Perbarui shot storyboard berikut sesuai instruksi pengguna:",
      `Kode: ${params.segment.code} (${params.segment.storyStage || "Segmen"})`,
      `Shot saat ini: ${params.segment.shotSize} / ${params.segment.cameraAngle} / ${params.segment.cameraMotion}`,
      `Timeline saat ini: ${params.segment.timelineText}`,
      `Visual Prompt saat ini: ${params.segment.visualPrompt || "(kosong)"}`,
      `Continuity Lock saat ini: ${params.segment.continuityLock || "(kosong)"}`,
      `Aset terikat: ${params.boundAssetTags.join(", ") || "tidak ada"}`,
      `Gaya visual: ${params.visualStyle}`,
      `Instruksi revisi pengguna: "${params.instruction}"`,
      'Balas JSON object: {"shotSize":"WS|MS|MCU|CU|ECU","cameraAngle":"Front|Side 90|Rear 3/4|High|Low","cameraMotion":"Static|Push-In|Pull-Out|Pan Right|Pan Left","timelineSummary":"aksi visual Indonesia terbaru","continuityLock":"continuity lock terbaru","visualPrompt":"updated vivid English cinematic film still prompt matching the instruction, no text or subtitles"}',
    ].join("\n"),
  };
}

export function parseConversationalEditResponse(
  raw: string,
  current: SegmentNodeData,
): Partial<SegmentNodeData> {
  const slice = extractJsonSlice(raw, "{");
  if (!slice) throw new Error("Respons revisi AI tidak berbentuk JSON object.");
  const item = JSON.parse(slice) as Record<string, unknown>;
  const nextShot = VALID_SHOTS.includes(item.shotSize as ShotSize)
    ? (item.shotSize as ShotSize)
    : current.shotSize;
  const nextAngle = VALID_ANGLES.includes(item.cameraAngle as CameraAngle)
    ? (item.cameraAngle as CameraAngle)
    : current.cameraAngle;
  const nextMotion = VALID_MOTIONS.includes(item.cameraMotion as CameraMotion)
    ? (item.cameraMotion as CameraMotion)
    : current.cameraMotion;
  const summary = typeof item.timelineSummary === "string" ? item.timelineSummary.trim() : "";
  const dur = Math.max(1, current.durationSec || 8);
  return {
    shotSize: nextShot,
    cameraAngle: nextAngle,
    cameraMotion: nextMotion,
    timelineText: summary ? `[0:00-0:${String(dur).padStart(2, "0")}] ${summary}` : current.timelineText,
    continuityLock:
      typeof item.continuityLock === "string" && item.continuityLock.trim()
        ? item.continuityLock.trim()
        : current.continuityLock,
    visualPrompt:
      typeof item.visualPrompt === "string" && item.visualPrompt.trim()
        ? item.visualPrompt.trim()
        : current.visualPrompt,
  };
}

// Stage 6: Supervision Agent (audits story arc, motivation, causality, continuity, and dialogue pacing).
export function buildSupervisionPrompt(params: {
  projectName: string;
  premise: string;
  events: ToonflowEventNode[];
  segments: Array<{
    code: string;
    storyStage?: string;
    durationSec: number;
    shotSize: string;
    cameraAngle: string;
    timelineText: string;
    dialogue: string;
    continuityLock: string;
    visualPrompt?: string;
    boundAssets: string[];
  }>;
}): { system: string; prompt: string } {
  const segLines = params.segments
    .map(
      (s) =>
        `${s.code} [${s.storyStage || "-"}] (${s.durationSec}s, ${s.shotSize}/${s.cameraAngle}) Aset:[${s.boundAssets.join(",")}]\n  Aksi: ${s.timelineText}\n  Dialog: "${s.dialogue}"\n  Lock: ${s.continuityLock}\n  Visual: ${s.visualPrompt || "-"}`,
    )
    .join("\n\n");

  const evLines = params.events
    .map((e) => `${e.code} [${e.stage}] ${e.title}: ${e.cause} -> ${e.summary} -> ${e.effect}`)
    .join("\n");

  return {
    system:
      "Kamu adalah SupervisionAgent (Quality Control Sutradara) ala Toonflow. Evaluasi secara kritis apakah episode memiliki cerita inti yang utuh (Intro -> Masalah 1 -> Masalah 2 -> Klimaks -> Ending), sebab-akibat logis, variasi visual nyata, dan dialog yang pas durasi. Balas HANYA JSON object valid.",
    prompt: [
      `Audit episode "${params.projectName}" berikut secara jujur dan kritis:`,
      `Premis: ${params.premise}`,
      evLines ? `Event Graph:\n${evLines}` : "",
      `Segmen Storyboard:\n${segLines}`,
      'Balas JSON object: {"score":85,"verdict":"siap|perlu-revisi","summary":"ringkasan evaluasi 1-2 kalimat dalam bahasa Indonesia","strengths":["kekuatan konkret 1","kekuatan 2"],"issues":[{"segmentCode":"G03","category":"alur|karakter|kontinuitas|visual|dialog","severity":"high|medium","problem":"masalah spesifik","fix":"saran perbaikan konkret"}]}',
      "Berikan skor < 75 dan verdict 'perlu-revisi' jika cerita menggantung tanpa penyelesaian, lompatan adegan tidak logis, atau sudut visual monoton di lokasi yang sama terus-menerus.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export function parseSupervisionResponse(raw: string): ToonflowSupervisionReport {
  const slice = extractJsonSlice(raw, "{");
  if (!slice) throw new Error("Respons SupervisionAgent tidak berbentuk JSON object.");
  const obj = JSON.parse(slice) as Record<string, unknown>;
  const score = Math.max(0, Math.min(100, Math.round(Number(obj.score) || 70)));
  const validCats = new Set(["alur", "karakter", "kontinuitas", "visual", "dialog"]);
  const rawIssues = Array.isArray(obj.issues) ? obj.issues : [];
  const issues: ToonflowSupervisionIssue[] = rawIssues
    .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"))
    .map((it) => ({
      segmentCode: typeof it.segmentCode === "string" && it.segmentCode.trim() ? it.segmentCode.trim() : undefined,
      category: validCats.has(String(it.category))
        ? (String(it.category) as ToonflowSupervisionIssue["category"])
        : "alur",
      severity: (it.severity === "high" ? "high" : "medium") as ToonflowSupervisionIssue["severity"],
      problem: String(it.problem || ""),
      fix: String(it.fix || ""),
    }))
    .filter((it) => it.problem.length > 0);

  const hasHigh = issues.some((i) => i.severity === "high");
  const verdict = obj.verdict === "siap" && score >= 75 && !hasHigh ? "siap" : "perlu-revisi";
  const strengths = Array.isArray(obj.strengths) ? obj.strengths.map(String).filter(Boolean) : [];

  return {
    checkedAt: Date.now(),
    score,
    verdict,
    summary: String(obj.summary || "Audit selesai."),
    strengths,
    issues,
  };
}

// Canvas mutators (pure functions returning updated NmcProject for clean React state commits).
export function applyExtractedAssetsToProject(
  project: NmcProject,
  specs: ExtractedAssetSpec[],
): { project: NmcProject; addedCount: number; updatedCount: number } {
  const scriptNode = project.nodes.find((n) => n.kind === "script");
  const existingAssets = project.nodes.filter((n) => n.kind === "asset");
  const byTag = new Map<string, CanvasNode>();
  for (const a of existingAssets) {
    if (a.data.kind === "asset") byTag.set(a.data.tag.toLowerCase(), a);
  }

  let nodes = [...project.nodes];
  const edges = [...project.edges];
  let addedCount = 0;
  let updatedCount = 0;
  let assetIndex = existingAssets.length;

  for (const spec of specs) {
    const existing = byTag.get(spec.tag.toLowerCase());
    if (existing) {
      nodes = nodes.map((n) =>
        n.id === existing.id && n.data.kind === "asset"
          ? {
              ...n,
              title: spec.title || n.title,
              data: {
                ...n.data,
                category: spec.category,
                lockPrompt: spec.lockPrompt || n.data.lockPrompt,
              },
            }
          : n,
      );
      updatedCount++;
    } else {
      assetIndex++;
      const created = createDefaultNode("asset", 380, 36 + (assetIndex - 1) * 196, assetIndex);
      created.title = spec.title;
      if (created.data.kind === "asset") {
        created.data = {
          ...created.data,
          tag: spec.tag,
          category: spec.category,
          lockPrompt: spec.lockPrompt,
        };
      }
      nodes.push(created);
      if (scriptNode) {
        edges.push({ id: uid(), source: scriptNode.id, target: created.id });
      }
      addedCount++;
    }
  }

  const next: NmcProject = { ...project, nodes, edges };
  return {
    project: { ...next, nodes: autoArrangeNodes(next) },
    addedCount,
    updatedCount,
  };
}

export function rebuildSegmentsFromBeats(
  project: NmcProject,
  beats: ScriptBeat[],
  options: { replaceExisting?: boolean } = {},
): NmcProject {
  if (!beats.length) return project;
  const scriptNode = project.nodes.find((n) => n.kind === "script");
  const sd = scriptNode?.data.kind === "script" ? (scriptNode.data as ScriptNodeData) : null;
  const maxDur = Math.max(4, sd?.maxSegmentSec || 8);

  const replace = options.replaceExisting !== false;
  const oldSegIds = new Set(
    replace ? project.nodes.filter((n) => n.kind === "segment").map((n) => n.id) : [],
  );

  let nodes = project.nodes.filter((n) => !oldSegIds.has(n.id));
  const edges = project.edges.filter((e) => !oldSegIds.has(e.source) && !oldSegIds.has(e.target));

  let asmNode = nodes.find((n) => n.kind === "assembly");
  if (!asmNode) {
    asmNode = createDefaultNode("assembly", 1130, 140, 1);
    nodes.push(asmNode);
  }
  const assets = nodes.filter((n) => n.kind === "asset");
  const startOffset = replace ? 0 : nodes.filter((n) => n.kind === "segment").length;

  const fallbackShots: ShotSize[] = ["WS", "MS", "MCU", "CU", "WS"];
  const fallbackAngles: CameraAngle[] = ["Front", "Side 90", "Low", "Rear 3/4", "High"];
  const fallbackMotions: CameraMotion[] = ["Push-In", "Pan Right", "Push-In", "Pull-Out", "Pull-Out"];

  beats.forEach((beat, idx) => {
    const segNum = startOffset + idx + 1;
    const code = `G${String(segNum).padStart(2, "0")}`;
    const dur = Math.max(1, Math.min(maxDur, beat.durationSec || 8));
    const stage = beat.stage?.trim() || "";
    const node = createDefaultNode("segment", 750, 36 + idx * 248, segNum);
    node.title = stage ? `${code}: ${stage}` : `Segmen ${code}`;
    node.data = {
      ...(node.data as SegmentNodeData),
      code,
      storyStage: stage || undefined,
      durationSec: dur,
      shotSize: beat.shotSize ?? fallbackShots[idx % fallbackShots.length],
      cameraAngle: beat.cameraAngle ?? fallbackAngles[idx % fallbackAngles.length],
      cameraMotion: beat.cameraMotion ?? fallbackMotions[idx % fallbackMotions.length],
      timelineText: `[0:00-0:${String(dur).padStart(2, "0")}] ${beat.summary}`,
      dialogue: beat.dialogue.trim(),
      continuityLock: (beat.continuityLock || "").trim(),
      visualPrompt: beat.visualPrompt?.trim() || undefined,
    };
    nodes.push(node);

    // Selective asset wiring: match @tag or asset name mentioned in this beat/event.
    const ev = sd?.eventGraph?.[idx];
    const corpus = [
      beat.summary,
      beat.dialogue,
      beat.continuityLock || "",
      beat.visualPrompt || "",
      ev?.location || "",
      ...(ev?.characters || []),
    ]
      .join(" ")
      .toLowerCase();

    const matched = assets.filter((a) => {
      if (a.data.kind !== "asset") return false;
      const d = a.data as AssetNodeData;
      const tag = d.tag.toLowerCase();
      const plain = tag.replace(/^@/, "");
      const titleWord = a.title.toLowerCase().split(/[\s(]+/)[0] || "";
      return (
        (tag && corpus.includes(tag)) ||
        (plain.length >= 3 && corpus.includes(plain)) ||
        (titleWord.length >= 3 && corpus.includes(titleWord))
      );
    });
    const toWire = matched.length > 0 ? matched : assets.filter((a) => a.data.kind === "asset" && a.data.category === "location");
    for (const a of toWire) {
      edges.push({ id: uid(), source: a.id, target: node.id });
    }
    edges.push({ id: uid(), source: node.id, target: asmNode!.id });
  });

  const next: NmcProject = { ...project, nodes, edges };
  return { ...next, nodes: autoArrangeNodes(next) };
}
