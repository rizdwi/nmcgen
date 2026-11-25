// Core 3-step Storyboard engine: Idea -> Script -> Script-Grounded Assets (ACC) -> Per-Frame Storyboard (Continue).
import type {
  AspectRatio,
  AssetCategory,
  AssetNodeData,
  CameraAngle,
  ImageAspect,
  NmcProject,
  ScriptNodeData,
  SegmentNodeData,
  ShotSize,
  StoryAsset,
  StoryboardData,
  StoryFrame,
  StorySegment,
} from "./types.ts";
import { DEFAULT_VISUAL_STYLE, uid } from "./presets.ts";
import { buildZip, type ZipEntryInput } from "./zip.ts";

export const VALID_SHOT_SIZES: ShotSize[] = ["WS", "MS", "MCU", "CU", "ECU"];
export const VALID_CAMERA_ANGLES: CameraAngle[] = ["Front", "Side 90", "Rear 3/4", "High", "Low"];

export const SHOT_SIZE_META: Record<ShotSize, { label: string; en: string }> = {
  WS: { label: "Jauh (Wide)", en: "wide establishing shot" },
  MS: { label: "Sedang (Medium)", en: "medium shot" },
  MCU: { label: "Sedang Dekat (MCU)", en: "medium close-up shot" },
  CU: { label: "Dekat (Close-Up)", en: "close-up shot" },
  ECU: { label: "Sangat Dekat (ECU)", en: "extreme close-up shot" },
};

export const CAMERA_ANGLE_META: Record<CameraAngle, { label: string; en: string }> = {
  Front: { label: "Sejajar Mata", en: "eye-level angle" },
  "Side 90": { label: "Samping (Side)", en: "side profile angle" },
  "Rear 3/4": { label: "Belakang / Bahu (OTS)", en: "over-the-shoulder rear three-quarter angle" },
  High: { label: "Dari Atas (High)", en: "high-angle shot looking slightly down" },
  Low: { label: "Dari Bawah (Low)", en: "low-angle shot looking slightly up" },
};

export const ASSET_CATEGORY_LABEL: Record<AssetCategory, string> = {
  character: "Karakter",
  location: "Lokasi",
  prop: "Properti",
};

export function assetAspectFor(category: AssetCategory, projectRatio: AspectRatio): ImageAspect {
  if (category === "character") return "3:4";
  if (category === "prop") return "1:1";
  return projectRatio;
}

export function getSelectedAssetImage(asset: StoryAsset): string | null {
  if (!asset.candidates.length) return null;
  const hit = asset.candidates.find((c) => c.id === asset.selectedCandidateId);
  return (hit ?? asset.candidates[asset.candidates.length - 1]).dataUrl || null;
}

export function getSelectedFrameImage(frame: StoryFrame): string | null {
  if (!frame.candidates.length) return null;
  const hit = frame.candidates.find((c) => c.id === frame.selectedCandidateId);
  return (hit ?? frame.candidates[frame.candidates.length - 1]).dataUrl || null;
}

/**
 * Keeps at most `maxCount` image candidates (default 3) while ALWAYS preserving `selectedId`,
 * preventing old draft versions from bloating IndexedDB / Supabase JSON payloads.
 */
export function trimCandidates<T extends { id: string }>(
  candidates: T[],
  selectedId?: string,
  maxCount = 3,
): T[] {
  if (candidates.length <= maxCount) return candidates;
  const limit = Math.max(1, maxCount);
  const recent = candidates.slice(-limit);
  if (!selectedId || recent.some((c) => c.id === selectedId)) {
    return recent;
  }
  const chosen = candidates.find((c) => c.id === selectedId);
  if (!chosen) return recent;
  return [chosen, ...candidates.slice(-(limit - 1))];
}

export function createEmptyStoryboard(options: {
  idea?: string;
  aspectRatio?: AspectRatio;
  visualStyle?: string;
} = {}): StoryboardData {
  return {
    step: "script",
    idea: options.idea ?? "",
    aspectRatio: options.aspectRatio ?? "16:9",
    visualStyle: options.visualStyle?.trim() || DEFAULT_VISUAL_STYLE,
    scriptText: "",
    segments: [],
    scriptApproved: false,
    assets: [],
    assetsApproved: false,
    frames: [],
    storyFinished: false,
  };
}

export function createStoryboardProject(
  name = "Proyek Baru",
  options: {
    idea?: string;
    aspectRatio?: AspectRatio;
    visualStyle?: string;
  } = {},
): NmcProject {
  return {
    schemaVersion: 2,
    id: uid(),
    name: name.trim() || "Proyek Baru",
    updatedAt: Date.now(),
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    storyboard: createEmptyStoryboard(options),
  };
}

/**
 * Ensures any project (including legacy schemaVersion 1 canvas projects) has a clean StoryboardData object.
 */
export function ensureStoryboard(project: NmcProject): StoryboardData {
  if (project.storyboard) {
    return project.storyboard;
  }

  const scriptNode = project.nodes.find((n) => n.kind === "script" && n.data.kind === "script");
  const sd = scriptNode?.data.kind === "script" ? (scriptNode.data as ScriptNodeData) : null;
  const migratedScriptText = sd?.scriptText ?? "";
  const migratedSegments = migratedScriptText.trim()
    ? parseScriptIntoSegments(migratedScriptText, [], 5)
    : [];

  const legacyAssets = project.nodes.filter((n) => n.kind === "asset" && n.data.kind === "asset");
  const assetIdMap = new Map<string, string>();
  const assets: StoryAsset[] = legacyAssets.map((n) => {
    const ad = n.data as AssetNodeData;
    const newId = uid();
    assetIdMap.set(n.id, newId);
    const candId = ad.imageDataUrl ? uid() : undefined;
    return {
      id: newId,
      name: n.title || ad.tag.replace(/^@/, "") || "Aset",
      category: ad.category,
      roleInScript: ad.tag || n.title,
      visualDesc: ad.lockPrompt || n.title,
      approved: Boolean(ad.imageDataUrl),
      candidates: ad.imageDataUrl
        ? [{ id: candId!, dataUrl: ad.imageDataUrl, createdAt: project.updatedAt || Date.now() }]
        : [],
      selectedCandidateId: candId,
    };
  });

  const legacySegments = project.nodes
    .filter((n) => n.kind === "segment" && n.data.kind === "segment")
    .sort((a, b) => {
      const ca = (a.data as SegmentNodeData).code || "";
      const cb = (b.data as SegmentNodeData).code || "";
      return ca.localeCompare(cb, undefined, { numeric: true });
    });

  const defaultSegId = migratedSegments[0]?.id;
  const frames: StoryFrame[] = legacySegments.map((n, idx) => {
    const seg = n.data as SegmentNodeData;
    const wiredOldIds = project.edges.filter((e) => e.target === n.id).map((e) => e.source);
    const mappedAssetIds = wiredOldIds
      .map((oldId) => assetIdMap.get(oldId))
      .filter((x): x is string => Boolean(x));

    const imageCands = seg.candidates
      .filter((c) => c.kind === "image" && c.dataUrl)
      .map((c) => ({
        id: c.id,
        dataUrl: c.dataUrl,
        model: c.label,
        createdAt: c.createdAt,
      }));
    const selectedId =
      imageCands.find((c) => c.id === seg.adoptedId)?.id ?? imageCands[imageCands.length - 1]?.id;

    return {
      id: uid(),
      segmentId: defaultSegId,
      panelNumber: idx + 1,
      index: idx + 1,
      title: n.title.replace(/^G\d+:\s*/i, "").trim() || `Frame ${idx + 1}`,
      scriptExcerpt: "",
      sceneSummary: seg.timelineText.replace(/^\[[^\]]+\]\s*/gm, "").trim(),
      dialogue: seg.dialogue || "",
      shotSize: VALID_SHOT_SIZES.includes(seg.shotSize) ? seg.shotSize : "MS",
      cameraAngle: VALID_CAMERA_ANGLES.includes(seg.cameraAngle) ? seg.cameraAngle : "Front",
      assetIds: mappedAssetIds,
      sameLocationAsPrev: idx > 0,
      visualPrompt: seg.visualPrompt || "",
      approved: Boolean(selectedId),
      candidates: imageCands,
      selectedCandidateId: selectedId,
    };
  });

  const hasScript = Boolean(migratedScriptText.trim());
  const allAssetsApproved = assets.length > 0 && assets.every((a) => a.approved);
  const step = frames.length > 0 ? "storyboard" : assets.length > 0 ? "assets" : "script";

  return {
    step,
    idea: sd?.premise ?? "",
    aspectRatio: sd?.aspectRatio ?? "16:9",
    visualStyle: sd?.visualStyle?.trim() || DEFAULT_VISUAL_STYLE,
    scriptText: migratedScriptText,
    segments: migratedSegments,
    scriptApproved: hasScript && (assets.length > 0 || frames.length > 0),
    assets,
    assetsApproved: allAssetsApproved,
    frames,
    storyFinished: false,
  };
}

export function getStoryboardCover(project: NmcProject): string | null {
  const sb = project.storyboard;
  if (sb) {
    for (const f of sb.frames) {
      const img = getSelectedFrameImage(f);
      if (img) return img;
    }
    for (const a of sb.assets) {
      const img = getSelectedAssetImage(a);
      if (img) return img;
    }
  }
  return null;
}

export function countApprovedAssets(sb: StoryboardData): { approved: number; total: number; withImages: number } {
  const total = sb.assets.length;
  const approved = sb.assets.filter((a) => a.approved).length;
  const withImages = sb.assets.filter((a) => Boolean(getSelectedAssetImage(a))).length;
  return { approved, total, withImages };
}

function extractJsonSlice(raw: string, openChar: "[" | "{"): string | null {
  const closeChar = openChar === "[" ? "]" : "}";
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf(openChar);
  const end = cleaned.lastIndexOf(closeChar);
  if (start === -1 || end === -1 || end <= start) return null;
  return cleaned.slice(start, end + 1);
}

function cleanPromptSnippet(text: string): string {
  return text
    .replace(/^\[[^\]]+\]\s*/gm, "")
    .replace(/@([A-Za-z0-9_]+)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function clampTargetPanels(n: number | undefined): number {
  const v = Math.round(Number(n) || 5);
  return Math.max(4, Math.min(7, v));
}

export function parseScriptIntoSegments(
  scriptText: string,
  existing: StorySegment[] = [],
  defaultPanels = 5,
): StorySegment[] {
  const raw = scriptText.replace(/\r\n?/g, "\n").trim();
  if (!raw) return [];

  const headingRe =
    /^(?:#{1,3}\s*)?(?:\*\*)?(?:SEGMEN|SEGMENT|ADEGAN|SCENE|BABAK)\s*(\d+)\s*(?:[—\-–:]\s*(.*))?(?:\*\*)?$/i;
  const lines = raw.split("\n");
  const buckets: Array<{ headerRest: string; bodyLines: string[] }> = [];
  let cur: { headerRest: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(headingRe);
    if (m) {
      if (cur && (cur.bodyLines.join("").trim() || cur.headerRest)) buckets.push(cur);
      const rest = (m[2] || "").replace(/\*+$/g, "").trim();
      cur = { headerRest: rest, bodyLines: [] };
    } else {
      if (!cur) cur = { headerRest: "", bodyLines: [] };
      cur.bodyLines.push(line);
    }
  }
  if (cur && (cur.bodyLines.join("").trim() || cur.headerRest)) buckets.push(cur);

  // If user pasted plain paragraphs without headings, split by double newline into segments (up to 6).
  if (buckets.length <= 1) {
    const paras = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    if (paras.length >= 2 && !headingRe.test(lines[0]?.trim() || "")) {
      return paras.slice(0, 8).map((p, idx) => {
        const prev = existing[idx];
        const firstSentence = p.split(/[.!?\n]/)[0]?.trim().slice(0, 56) || `Segmen ${idx + 1}`;
        return {
          id: prev?.id || uid(),
          index: idx + 1,
          title: prev?.title || firstSentence,
          locationHint: prev?.locationHint || "",
          scriptContent: p,
          targetPanels: clampTargetPanels(prev?.targetPanels ?? defaultPanels),
        };
      });
    }
  }

  return buckets.map((b, idx) => {
    const prev = existing[idx];
    const rest = b.headerRest;
    let title = rest || `Segmen ${idx + 1}`;
    let locationHint = "";
    const splitParts = rest.split(/\s*[|·]\s*/);
    if (splitParts.length >= 2) {
      title = splitParts[0].trim();
      locationHint = splitParts.slice(1).join(" · ").trim();
    } else if (/^(?:EXT\.|INT\.)/i.test(rest)) {
      locationHint = rest;
      title = rest.replace(/^(?:EXT\.|INT\.)\s*/i, "").split(/\s+[-—]\s+/)[0]?.trim() || `Segmen ${idx + 1}`;
    }
    return {
      id: prev?.id || uid(),
      index: idx + 1,
      title: title || `Segmen ${idx + 1}`,
      locationHint,
      scriptContent: b.bodyLines.join("\n").trim(),
      targetPanels: clampTargetPanels(prev?.targetPanels ?? defaultPanels),
    };
  });
}

export function formatSegmentsToScript(segments: StorySegment[]): string {
  return segments
    .map((seg, idx) => {
      const headerTail = seg.locationHint.trim()
        ? `${seg.title.trim() || `Segmen ${idx + 1}`} | ${seg.locationHint.trim()}`
        : seg.title.trim() || `Segmen ${idx + 1}`;
      return `SEGMEN ${idx + 1} — ${headerTail}\n${seg.scriptContent.trim()}`;
    })
    .join("\n\n")
    .trim();
}

export function getStoryboardSegments(sb: StoryboardData): StorySegment[] {
  if (sb.segments && sb.segments.length > 0) {
    return sb.segments.map((s, idx) => ({
      ...s,
      index: idx + 1,
      targetPanels: clampTargetPanels(s.targetPanels),
    }));
  }
  const parsed = parseScriptIntoSegments(sb.scriptText, [], 5);
  if (parsed.length > 0) return parsed;
  return [
    {
      id: "seg-default-1",
      index: 1,
      title: "Segmen 1",
      locationHint: "",
      scriptContent: sb.scriptText || sb.idea || "",
      targetPanels: 5,
    },
  ];
}

export function getSegmentFrames(sb: StoryboardData, segmentId: string, segIndexZeroBased: number): StoryFrame[] {
  const direct = sb.frames.filter((f) => f.segmentId === segmentId);
  if (direct.length > 0) return direct;
  // Backward compatibility: legacy frames without segmentId attach to Segment 1.
  if (segIndexZeroBased === 0) {
    return sb.frames.filter((f) => !f.segmentId);
  }
  return [];
}

/**
 * Orders frames cleanly by Segment order, assigns per-segment `panelNumber` (1..K)
 * and global `index` (1..N), and guarantees Frame 1 has `sameLocationAsPrev = false`.
 */
export function reindexStoryboardFrames(frames: StoryFrame[], segments: StorySegment[]): StoryFrame[] {
  if (frames.length === 0) return [];
  if (segments.length === 0) {
    return frames.map((f, idx) => ({
      ...f,
      index: idx + 1,
      panelNumber: idx + 1,
      sameLocationAsPrev: idx === 0 ? false : f.sameLocationAsPrev,
    }));
  }

  const ordered: StoryFrame[] = [];
  const used = new Set<string>();

  segments.forEach((seg, segIdx) => {
    const segFrames = frames.filter((f) =>
      f.segmentId ? f.segmentId === seg.id : segIdx === 0,
    );
    segFrames.forEach((f, pIdx) => {
      used.add(f.id);
      ordered.push({
        ...f,
        segmentId: seg.id,
        panelNumber: pIdx + 1,
      });
    });
  });

  // Preserve any orphan frames (e.g. if user deleted a segment) by attaching them cleanly at the end
  for (const f of frames) {
    if (!used.has(f.id)) {
      ordered.push({
        ...f,
        segmentId: f.segmentId ?? segments[segments.length - 1]?.id,
      });
    }
  }

  return ordered.map((f, idx) => ({
    ...f,
    index: idx + 1,
    sameLocationAsPrev: idx === 0 ? false : f.sameLocationAsPrev,
  }));
}

// ============================================================================
// STEP 1: IDEA -> SCRIPT (Divided into Segments, each ready for 4-7 Panels)
// ============================================================================

export function buildGenerateScriptPrompt(params: {
  projectName: string;
  idea: string;
  visualStyle: string;
  aspectRatio: AspectRatio;
}): { system: string; prompt: string } {
  return {
    system:
      "Kamu adalah penulis skenario cerita visual berbahasa Indonesia yang tajam, natural, dan disiplin mengikuti ide pengguna. Bagi naskah menjadi beberapa SEGMEN terstruktur dimana tiap segmen memiliki rentetan aksi halus (cukup untuk 4-7 panel storyboard berurutan agar cerita mengalir mulus tanpa lompat-lompat). JANGAN melenceng dari genre atau ide pengguna.",
    prompt: [
      `Tulis naskah cerita lengkap berbahasa Indonesia untuk proyek berjudul "${params.projectName}".`,
      `Ide cerita pengguna:\n${params.idea.trim()}`,
      `Gaya visual rencana: ${params.visualStyle}`,
      `Rasio frame: ${params.aspectRatio}`,
      "",
      "Aturan penulisan naskah:",
      "1. Ikuti genre, suasana, tokoh, dan premis pengguna apa adanya (JANGAN mengubah cerita ringan/bahagia menjadi horor, dan JANGAN menambahkan tokoh atau benda aneh yang tidak diminta).",
      "2. Bagi naskah menjadi 3 sampai 4 SEGMEN bernomor dengan format header persis seperti ini:",
      "   SEGMEN 1 — Judul Singkat Segmen | EXT./INT. LOKASI SPESIFIK - WAKTU",
      "3. Di dalam SETIAP SEGMEN, tulis rentetan aksi visual langkah-demi-langkah (4 sampai 6 momen kecil berurutan: misal tiba -> menyusuri jalan -> berhenti melihat benda -> reaksi/berinteraksi -> melangkah lanjut) supaya nanti bisa dipecah menjadi 4-7 panel storyboard tanpa terasa melompat.",
      "4. Saat pertama kali tokoh, lokasi, atau benda penting muncul, sebutkan ciri visual konkretnya secara singkat (umur, pakaian & warna khas, bentuk lokasi/benda) supaya ekstraksi aset konsisten.",
      "5. Sertakan dialog singkat yang natural bila cocok dengan ceritanya.",
      "6. Balas langsung dengan teks naskah berformat SEGMEN 1..N tanpa kata pengantar atau penutup.",
    ].join("\n"),
  };
}

export function buildReviseScriptPrompt(params: {
  projectName: string;
  idea: string;
  currentScript: string;
  instruction: string;
}): { system: string; prompt: string } {
  return {
    system:
      "Kamu adalah editor skenario berbahasa Indonesia. Revisi naskah sesuai instruksi pengguna dengan tetap mempertahankan pembagian SEGMEN 1..N (header: 'SEGMEN N — Judul | LOKASI - WAKTU') dan rentetan aksi halus per segmen agar siap dipecah jadi 4-7 panel storyboard.",
    prompt: [
      `Judul proyek: ${params.projectName}`,
      params.idea.trim() ? `Ide awal: ${params.idea.trim()}` : "",
      `Instruksi revisi dari pengguna:\n${params.instruction.trim()}`,
      `Naskah saat ini:\n${params.currentScript.trim()}`,
      "",
      "Pertahankan struktur header SEGMEN 1 — Judul | LOKASI - WAKTU dan balas langsung dengan naskah lengkap hasil revisi tanpa kata pengantar.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

// ============================================================================
// STEP 2: SCRIPT -> ASSETS & CHARACTERS (Strict grounding, zero hallucination)
// ============================================================================

export function buildExtractAssetsFromScriptPrompt(params: {
  projectName: string;
  scriptText: string;
  visualStyle: string;
}): { system: string; prompt: string } {
  return {
    system:
      "Kamu adalah Art Director & Continuity Supervisor. Tugasmu mengekstrak daftar lengkap Karakter, Lokasi, dan Properti penting LANGSUNG dari naskah. DILARANG mengarang tokoh, lokasi, atau benda yang tidak ada di naskah. Balas HANYA JSON array valid tanpa markdown.",
    prompt: [
      `Baca keseluruhan naskah "${params.projectName}" berikut secara teliti, lalu ekstrak SEMUA aset visual yang benar-benar dibutuhkan untuk menggambar seluruh naskah ini.`,
      "",
      'Format JSON array wajib: [{"name":"Nama Jelas","category":"character|location|prop","roleInScript":"Penjelasan singkat bahasa Indonesia + muncul di adegan mana sesuai naskah","visualDesc":"Concise pure English visual description strictly matching every physical/clothing/architectural detail stated in the script"}]',
      "",
      "Aturan KETAT anti-melenceng:",
      "1. HANYA ekstrak karakter, lokasi, dan properti kunci yang FISIKNYA MUNCUL di naskah. DILARANG menambah karakter/monster/lokasi baru yang tidak tertulis di naskah!",
      "2. Ikuti detail naskah secara persis: umur, gender, etnis/latar budaya, rambut, warna & jenis pakaian, arsitektur ruangan, dan warna/bentuk properti. Jika naskah tidak menyebut detail kecil (misal warna celana), pilih detail paling wajar sesuai konteks naskah agar konsisten.",
      "3. Field roleInScript WAJIB bahasa Indonesia dan menyebutkan muncul di adegan mana (misal: 'Tokoh utama (Adegan 1-4): barista muda yang ramah...').",
      "4. Field visualDesc WAJIB bahasa Inggris murni (25-55 kata), HANYA mendeskripsikan ciri fisik tetap (wajah, rambut, pakaian untuk character; bentuk & elemen ruang untuk location; bentuk & bahan benda untuk prop). JANGAN tulis nama gaya seni, JANGAN tulis sudut kamera, JANGAN tulis dialog, JANGAN tulis simbol @.",
      "5. Jumlah aset ideal: semua karakter utama/pendukung yang tampil + lokasi utama yang tampil + maksimal 1-2 properti paling krusial jika memang penting di naskah (total biasanya 3 sampai 7 aset).",
      "",
      `Gaya visual proyek (untuk konteks saja, tidak perlu ditulis ulang di visualDesc): ${params.visualStyle}`,
      "",
      `NASKAH LENGKAP:\n${params.scriptText.trim().slice(0, 9000)}`,
    ].join("\n"),
  };
}

export function parseExtractedStoryAssets(raw: string): StoryAsset[] {
  const slice = extractJsonSlice(raw, "[");
  if (!slice) throw new Error("Respons AI untuk daftar aset tidak berbentuk JSON array.");
  const parsed = JSON.parse(slice);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("AI tidak menemukan aset pada naskah. Coba lengkapi detail tokoh/lokasi di naskah.");
  }

  const validCats: AssetCategory[] = ["character", "location", "prop"];
  const seen = new Set<string>();
  const out: StoryAsset[] = [];

  for (const item of parsed as Record<string, unknown>[]) {
    const name = String(item.name || item.title || "").replace(/^@/, "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const category = validCats.includes(item.category as AssetCategory)
      ? (item.category as AssetCategory)
      : "character";
    const roleInScript = String(item.roleInScript || item.role || "").trim();
    const visualDesc = cleanPromptSnippet(String(item.visualDesc || item.lockPrompt || name));

    out.push({
      id: uid(),
      name,
      category,
      roleInScript: roleInScript || `Tampil di naskah (${ASSET_CATEGORY_LABEL[category]})`,
      visualDesc,
      approved: false,
      candidates: [],
    });
  }

  if (out.length === 0) {
    throw new Error("Daftar aset hasil ekstraksi kosong.");
  }
  return out.slice(0, 10);
}

/**
 * Clean, style-faithful English image prompt for generating an Asset reference with FLUX.2 Klein 4B.
 * Strictly obeys visualStyle (never forces "Photorealistic" onto anime/3D/comic/watercolor styles).
 */
export function buildAssetImagePrompt(asset: Pick<StoryAsset, "name" | "category" | "visualDesc">, visualStyle: string): string {
  const style = (visualStyle || DEFAULT_VISUAL_STYLE).trim();
  const desc = cleanPromptSnippet(asset.visualDesc || asset.name);

  if (asset.category === "character") {
    return `${style}. Clean character reference portrait of one single subject standing naturally, three-quarter to full body view, clear face looking toward camera, centered on a plain solid neutral light-grey studio background. Subject: ${desc}. Exact outfit and features, single character only, no split panels, no multiple angles, no cropped head, no text, no watermark.`;
  }
  if (asset.category === "location") {
    return `${style}. Wide establishing background illustration of an empty location with NO people, NO characters, NO silhouettes. Setting: ${desc}. Clear foreground, midground, and background depth, consistent lighting and atmosphere, single clean frame, no text, no watermark.`;
  }
  return `${style}. Single isolated object reference centered on a plain neutral grey background, no hands, no people. Object: ${desc}. Crisp clear details, single item only, no split grid, no text, no watermark.`;
}

// ============================================================================
// STEP 3: PER-SEGMENT STORYBOARD (4-7 SMOOTH PANELS PER SEGMENT + CONTINUE)
// ============================================================================

export function buildNextFramePrompt(params: {
  projectName: string;
  scriptText: string;
  visualStyle: string;
  aspectRatio: AspectRatio;
  approvedAssets: StoryAsset[];
  previousFrames: StoryFrame[];
  activeSegment?: StorySegment;
  segmentFrames?: StoryFrame[];
  totalSegments?: number;
  userDirection?: string;
}): { system: string; prompt: string } {
  const seg = params.activeSegment;
  const segFrames = params.segmentFrames ?? params.previousFrames;
  const targetPanels = clampTargetPanels(seg?.targetPanels ?? 5);
  const panelNum = segFrames.length + 1;
  const globalIndex = params.previousFrames.length + 1;

  const assetCatalog = params.approvedAssets
    .map(
      (a) =>
        `- id="${a.id}" | nama="${a.name}" | jenis=${a.category} | peran="${a.roleInScript}" | visual="${a.visualDesc}"`,
    )
    .join("\n");

  const prevInSegSummary = segFrames.length
    ? segFrames
        .map((f, i) => {
          const names = f.assetIds
            .map((id) => params.approvedAssets.find((a) => a.id === id)?.name)
            .filter(Boolean)
            .join(", ");
          return `Panel ${f.panelNumber ?? i + 1}/${targetPanels} [${f.shotSize}/${f.cameraAngle}] "${f.title}" | Aset:[${names || "-"}] | Aksi: ${f.sceneSummary}${f.dialogue ? ` | Dialog: "${f.dialogue}"` : ""}`;
        })
        .join("\n")
    : seg
      ? `(Belum ada panel di Segmen ${seg.index} — ini adalah Panel 1/${targetPanels} pembuka Segmen ${seg.index}.)`
      : "(Belum ada frame sebelumnya — ini adalah Frame 1 pembuka cerita.)";

  const lastGlobal = params.previousFrames[params.previousFrames.length - 1];
  const lastInSeg = segFrames[segFrames.length - 1];
  const prevRefFrame = lastInSeg ?? lastGlobal;

  const pacingGuide = seg
    ? panelNum === 1
      ? `Panel 1 dari ${targetPanels}: BUKA Segmen ${seg.index} secara tenang (establishing ruang/kedatangan/awal gerakan tokoh). JANGAN langsung melompat ke puncak/akhir segmen!`
      : panelNum < targetPanels
        ? `Panel ${panelNum} dari ${targetPanels}: LANJUTKAN micro-gerakan TEPAT 1 langkah setelah Panel ${panelNum - 1} (misal melangkah masuk -> melihat detail/benda -> reaksi ekspresi -> berinteraksi). JANGAN melompat ke akhir segmen karena masih ada ${targetPanels - panelNum} panel lagi setelah ini!`
        : `Panel ${panelNum} dari ${targetPanels} (PANEL PENUTUP SEGMEN ${seg.index}): Selesaikan aksi terakhir Segmen ${seg.index} dengan mulus dan jembatani transisi menuju segmen berikutnya.`
    : globalIndex === 1
      ? "Mulailah tepat dari pembukaan cerita sesuai naskah."
      : `Lanjutkan TEPAT 1 langkah setelah Frame ${globalIndex - 1} tanpa melompat.`;

  const isLastSegment = seg && params.totalSegments ? seg.index >= params.totalSegments : false;

  return {
    system:
      "Kamu adalah Storyboard Director profesional ala film & komik sinematik. Tugasmu memecah SATU SEGMEN naskah menjadi 4-7 PANEL storyboard berurutan yang mengalir halus langkah-demi-langkah (seperti: tiba -> menyusuri jalan -> berhenti melihat benda -> berinteraksi -> melangkah pergi) agar cerita TIDAK LOMPAT-LOMPAT. Gunakan HANYA aset dari daftar ACC. Balas HANYA 1 JSON object valid tanpa markdown.",
    prompt: [
      seg
        ? `Susun rancangan untuk PANEL ${panelNum} dari ${targetPanels} pada SEGMEN ${seg.index} ("${seg.title}") untuk proyek "${params.projectName}" (${params.aspectRatio}).`
        : `Susun rancangan untuk FRAME ${globalIndex} dari storyboard "${params.projectName}" (${params.aspectRatio}).`,
      "",
      'Format JSON object wajib: {"title":"judul sangat singkat 2-4 kata untuk label panel (mis. Tiba di Gerbang, Menyusuri Jalan, Membaca Surat)","scriptExcerpt":"bagian singkat naskah segmen yang sedang divisualkan","sceneSummary":"1-2 kalimat bahasa Indonesia tentang SATU micro-momen aksi visual konkret di panel ini","dialogue":"dialog/narasi singkat jika ada di momen ini (kosongkan jika panel visual murni)","shotSize":"WS|MS|MCU|CU|ECU","cameraAngle":"Front|Side 90|Rear 3/4|High|Low","assetIds":["id-aset-acc-yang-fisiknya-tampil"],"sameLocationAsPrev":true,"visualPrompt":"Concise vivid pure English description (45-80 words) of THIS SINGLE PANEL: subject pose, facial expression, specific micro-action, foreground/background environment, and lighting/mood. NO Indonesian words, NO @ symbols, NO dialogue quotes, NO text on image.","segmentFinished":false,"storyFinished":false}',
      "",
      "Aturan KETAT Anti-Lompat:",
      `1. Pacing Panel: ${pacingGuide}`,
      "2. SATU panel = SATU micro-momen tunggal yang nyambung langsung dari posisi/pose panel sebelumnya (bukan merangkum seluruh adegan dalam 1 gambar).",
      "3. Field title WAJIB sangat singkat & jelas (2–4 kata seperti caption papan storyboard: 'Tiba di Pelabuhan', 'Menyusuri Jalan', 'Membaca Surat', 'Bertanya Arah', 'Menuju Fajar').",
      "4. Field assetIds WAJIB hanya berisi `id` yang persis ada di DAFTAR ASET ACC di bawah, dan HANYA aset yang FISIKNYA TERLIHAT DI KAMERA pada panel ini.",
      prevRefFrame
        ? `5. Variasikan framing kamera dari panel sebelumnya (panel sebelumnya memakai ${prevRefFrame.shotSize} / ${prevRefFrame.cameraAngle} — pilih shotSize atau cameraAngle berbeda agar transisi terasa hidup seperti film!).`
        : "5. Pilih komposisi pembuka yang kuat (biasanya WS atau MS).",
      `6. Set sameLocationAsPrev = ${panelNum > 1 ? "true (kecuali benar-benar pindah ruangan/tempat di tengah segmen)" : "false jika lokasi segmen ini berbeda dari segmen sebelumnya, atau true jika masih 1 tempat"}.`,
      `7. Set segmentFinished = ${panelNum >= targetPanels ? "true" : "false"} (true jika panel ini menutup Segmen ${seg?.index ?? 1}). Set storyFinished = ${isLastSegment && panelNum >= targetPanels ? "true" : "false"} (true HANYA jika ini penutup akhir seluruh cerita).`,
      "8. Field visualPrompt WAJIB 100% bahasa Inggris murni (45-80 kata), konsisten dengan ciri fisik aset ACC yang tampil, TANPA nama gaya seni dan TANPA teks Indonesia / simbol @.",
      params.userDirection?.trim()
        ? `\nARAHAN KHUSUS PENGGUNA UNTUK PANEL ${panelNum} (WAJIB DIIKUTI):\n${params.userDirection.trim()}`
        : "",
      "",
      `DAFTAR ASET ACC (gunakan HANYA id dari daftar ini):\n${assetCatalog || "(Belum ada aset ACC)"}`,
      "",
      seg
        ? `FOKUS NASKAH SEGMEN ${seg.index} (${seg.title}${seg.locationHint ? ` | ${seg.locationHint}` : ""}):\n${seg.scriptContent}`
        : "",
      "",
      `PANEL YANG SUDAH DIBUAT DI SEGMEN INI:\n${prevInSegSummary}`,
      "",
      `KONTEKS NASKAH KESELURUHAN (untuk menjaga kesinambungan):\n${params.scriptText.trim().slice(0, 6000)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function parseNextFrameResponse(
  raw: string,
  approvedAssets: StoryAsset[],
  previousFrames: StoryFrame[],
  options?: {
    activeSegment?: StorySegment;
    segmentFrames?: StoryFrame[];
  },
): { frame: StoryFrame; segmentFinished: boolean; storyFinished: boolean } {
  const slice = extractJsonSlice(raw, "{");
  if (!slice) throw new Error("Respons AI untuk panel storyboard tidak berbentuk JSON object.");
  const obj = JSON.parse(slice) as Record<string, unknown>;

  const seg = options?.activeSegment;
  const segFrames = options?.segmentFrames ?? previousFrames;
  const targetPanels = clampTargetPanels(seg?.targetPanels ?? 5);
  const panelNumber = segFrames.length + 1;
  const nextIndex = previousFrames.length + 1;
  const lastFrame = segFrames[segFrames.length - 1] ?? previousFrames[previousFrames.length - 1];

  const fallbackShots: ShotSize[] = ["WS", "MS", "CU", "MCU", "WS", "MS", "CU"];
  const fallbackAngles: CameraAngle[] = ["Front", "Side 90", "Rear 3/4", "Low", "High"];

  const shotSize: ShotSize = VALID_SHOT_SIZES.includes(obj.shotSize as ShotSize)
    ? (obj.shotSize as ShotSize)
    : fallbackShots[(panelNumber - 1) % fallbackShots.length];

  let cameraAngle: CameraAngle = VALID_CAMERA_ANGLES.includes(obj.cameraAngle as CameraAngle)
    ? (obj.cameraAngle as CameraAngle)
    : fallbackAngles[(panelNumber - 1) % fallbackAngles.length];

  if (lastFrame && lastFrame.shotSize === shotSize && lastFrame.cameraAngle === cameraAngle) {
    cameraAngle = VALID_CAMERA_ANGLES[(VALID_CAMERA_ANGLES.indexOf(cameraAngle) + 1) % VALID_CAMERA_ANGLES.length];
  }

  // Strictly resolve assetIds ONLY against approvedAssets (by exact id OR fallback case-insensitive name match).
  const byId = new Map(approvedAssets.map((a) => [a.id, a.id]));
  const byName = new Map(approvedAssets.map((a) => [a.name.toLowerCase(), a.id]));
  const rawIds = Array.isArray(obj.assetIds) ? obj.assetIds : [];
  const assetIds: string[] = [];
  for (const item of rawIds) {
    const val = String(item || "").trim();
    if (!val) continue;
    const hit = byId.get(val) ?? byName.get(val.replace(/^@/, "").toLowerCase());
    if (hit && !assetIds.includes(hit)) assetIds.push(hit);
  }

  // Inside a segment, Panel 2..K defaults to continuous lighting/location unless explicitly false
  const sameLocationAsPrev =
    nextIndex > 1 && (panelNumber > 1 ? obj.sameLocationAsPrev !== false : Boolean(obj.sameLocationAsPrev));

  const frame: StoryFrame = {
    id: uid(),
    segmentId: seg?.id,
    panelNumber,
    index: nextIndex,
    title: String(obj.title || `Panel ${panelNumber}`).trim(),
    scriptExcerpt: String(obj.scriptExcerpt || "").trim(),
    sceneSummary: String(obj.sceneSummary || obj.summary || "").trim(),
    dialogue: String(obj.dialogue || "").trim(),
    shotSize,
    cameraAngle,
    assetIds,
    sameLocationAsPrev,
    visualPrompt: cleanPromptSnippet(String(obj.visualPrompt || "")),
    approved: false,
    candidates: [],
  };

  return {
    frame,
    segmentFinished: Boolean(obj.segmentFinished) || (Boolean(seg) && panelNumber >= targetPanels),
    storyFinished: Boolean(obj.storyFinished),
  };
}

export interface ResolvedFrameReference {
  kind: "asset" | "previous-frame";
  label: string;
  roleDesc: string;
  dataUrl: string;
}

/**
 * Selects up to 3 reference images tailored for FLUX.2 Klein 4B:
 * - Priority 1: Visible Characters (up to 2) -> locked face & outfit
 * - Priority 2: Visible Location (for WS/MS) or Prop -> locked setting/object
 * - Priority 3: Previous Frame image (ONLY if sameLocationAsPrev is enabled and a slot remains) -> lighting/color continuity
 */
export function selectFrameReferences(
  frame: StoryFrame,
  assets: StoryAsset[],
  previousFrame?: StoryFrame | null,
): ResolvedFrameReference[] {
  const assetMap = new Map(assets.map((a) => [a.id, a]));
  const selectedAssets = frame.assetIds
    .map((id) => assetMap.get(id))
    .filter((a): a is StoryAsset => Boolean(a));

  const isTightShot = frame.shotSize === "CU" || frame.shotSize === "ECU";

  const chars = selectedAssets.filter((a) => a.category === "character" && Boolean(getSelectedAssetImage(a)));
  const props = selectedAssets.filter((a) => a.category === "prop" && Boolean(getSelectedAssetImage(a)));
  const locs = selectedAssets.filter((a) => a.category === "location" && Boolean(getSelectedAssetImage(a)));

  const refs: ResolvedFrameReference[] = [];
  const pushAsset = (a: StoryAsset) => {
    const url = getSelectedAssetImage(a);
    if (!url || refs.length >= 3) return;
    refs.push({
      kind: "asset",
      label: a.name,
      roleDesc: a.category === "character"
        ? `character ${a.name} (${a.visualDesc.slice(0, 140)})`
        : a.category === "location"
          ? `environment/location ${a.name}`
          : `object ${a.name}`,
      dataUrl: url,
    });
  };

  // Up to 2 primary characters first
  for (const c of chars.slice(0, 2)) pushAsset(c);

  // If tight shot, prioritize prop over wide location; otherwise include location first
  if (isTightShot) {
    for (const p of props.slice(0, 1)) pushAsset(p);
  } else {
    for (const l of locs.slice(0, 1)) pushAsset(l);
    if (refs.length < 3) {
      for (const p of props.slice(0, 1)) pushAsset(p);
    }
  }

  // Optional previous-frame visual continuity when still in the same location
  if (frame.sameLocationAsPrev && previousFrame && refs.length < 3) {
    const prevUrl = getSelectedFrameImage(previousFrame);
    if (prevUrl) {
      refs.push({
        kind: "previous-frame",
        label: `Frame ${previousFrame.index}`,
        roleDesc: `the previous shot's lighting, color palette, and set continuity`,
        dataUrl: prevUrl,
      });
    }
  }

  return refs;
}

/**
 * Builds the exact pure-English FLUX.2 Klein 4B prompt using official 0-based `image 0`, `image 1`, `image 2` indices,
 * strictly obeying visualStyle with zero Indonesian leakage and zero hardcoded "Photorealistic".
 */
export function composeStoryboardFramePrompt(
  frame: StoryFrame,
  sb: Pick<StoryboardData, "visualStyle" | "assets">,
  previousFrame?: StoryFrame | null,
): { prompt: string; refs: ResolvedFrameReference[] } {
  const style = (sb.visualStyle || DEFAULT_VISUAL_STYLE).trim();
  const refs = selectFrameReferences(frame, sb.assets, previousFrame);
  const shotLabel = SHOT_SIZE_META[frame.shotSize]?.en || "medium shot";
  const angleLabel = CAMERA_ANGLE_META[frame.cameraAngle]?.en || "eye-level angle";
  const sceneCore = cleanPromptSnippet(frame.visualPrompt || frame.sceneSummary || frame.title);

  const parts: string[] = [`${style}.`, `${shotLabel}, ${angleLabel}.`];
  if (sceneCore) {
    parts.push(sceneCore.endsWith(".") ? sceneCore : `${sceneCore}.`);
  }

  if (refs.length > 0) {
    // Official Cloudflare FLUX.2 indexing is 0-based: image 0, image 1, image 2!
    const refClauses = refs.map((r, idx) => `image ${idx} shows ${r.roleDesc}`);
    parts.push(
      `Reference alignment: ${refClauses.join("; ")}. Keep the exact face, hair, age, and clothing of any referenced character while composing this new shot angle naturally inside the scene.`,
    );
  } else if (frame.assetIds.length > 0) {
    const fallbackDescs = frame.assetIds
      .map((id) => sb.assets.find((a) => a.id === id))
      .filter((a): a is StoryAsset => Boolean(a))
      .map((a) => `${a.name}: ${cleanPromptSnippet(a.visualDesc)}`);
    if (fallbackDescs.length > 0) {
      parts.push(`Subjects & setting: ${fallbackDescs.join("; ")}.`);
    }
  }

  parts.push("Single cohesive storyboard frame, consistent art style, no text, no speech bubbles, no subtitles, no split panels, no watermark.");

  return {
    prompt: parts.join(" ").replace(/\s+/g, " ").trim(),
    refs,
  };
}

// ============================================================================
// QUICK VISUAL EDIT (FLUX.2 image-to-image editing with image 0)
// ============================================================================

export function buildQuickEditPrompt(params: {
  mode: "asset" | "frame";
  label: string;
  currentVisualDesc: string;
  instruction: string;
  visualStyle: string;
}): { system: string; prompt: string } {
  return {
    system:
      "Kamu adalah Prompt Editor untuk model FLUX.2 image editing. Ubah instruksi revisi bahasa Indonesia menjadi 1 prompt edit bahasa Inggris yang singkat, tepat sasaran, dan merujuk langsung pada `image 0` (gambar saat ini). Balas HANYA JSON object valid.",
    prompt: [
      `Mode: ${params.mode === "asset" ? "Edit gambar referensi aset" : "Edit gambar frame storyboard"} (${params.label}).`,
      `Gaya visual wajib dipertahankan: ${params.visualStyle}`,
      `Deskripsi visual saat ini: ${params.currentVisualDesc}`,
      `Instruksi revisi pengguna: "${params.instruction.trim()}"`,
      'Balas JSON object: {"editPrompt":"Pure English FLUX.2 edit prompt referencing image 0 (e.g. Edit image 0: keep the same character, pose, and art style, but change...)","updatedVisualDesc":"Updated pure English visual description incorporating the change"}',
    ].join("\n"),
  };
}

export function parseQuickEditResponse(
  raw: string,
  fallbackStyle: string,
  fallbackInstruction: string,
): { editPrompt: string; updatedVisualDesc: string } {
  const slice = extractJsonSlice(raw, "{");
  if (!slice) {
    return {
      editPrompt: `${fallbackStyle}. Edit image 0: ${cleanPromptSnippet(fallbackInstruction)}. Keep consistent art style and subject identity, single clean frame, no text, no watermark.`,
      updatedVisualDesc: "",
    };
  }
  const obj = JSON.parse(slice) as Record<string, unknown>;
  const editPrompt = cleanPromptSnippet(String(obj.editPrompt || ""));
  const updatedVisualDesc = cleanPromptSnippet(String(obj.updatedVisualDesc || ""));
  return {
    editPrompt:
      editPrompt ||
      `${fallbackStyle}. Edit image 0: ${cleanPromptSnippet(fallbackInstruction)}. Keep consistent art style, single clean frame, no text, no watermark.`,
    updatedVisualDesc,
  };
}

export function buildSyncAssetVisualPrompt(asset: Pick<StoryAsset, "name" | "category" | "roleInScript">): {
  system: string;
  prompt: string;
} {
  return {
    system:
      "You translate Indonesian character/location/prop notes into a concise 25-45 word pure English visual description for image generation. Reply ONLY with the plain English description, no quotes, no markdown.",
    prompt: `Category: ${asset.category}\nName: ${asset.name}\nIndonesian description: ${asset.roleInScript || asset.name}\nWrite a clear, concrete physical/visual description in pure English without mentioning art style or camera angles.`,
  };
}

export function buildSyncFrameVisualPrompt(params: {
  sceneSummary: string;
  shotSize: ShotSize;
  cameraAngle: CameraAngle;
  selectedAssets: StoryAsset[];
}): { system: string; prompt: string } {
  const cast = params.selectedAssets
    .map((a) => `- ${a.name} (${a.category}): ${a.visualDesc}`)
    .join("\n");
  return {
    system:
      "You write a concise 45-75 word pure English storyboard frame visual description from Indonesian scene notes. Reply ONLY with the plain English scene description, no quotes, no @ symbols, no art style keywords.",
    prompt: [
      `Shot: ${SHOT_SIZE_META[params.shotSize].en}, ${CAMERA_ANGLE_META[params.cameraAngle].en}`,
      `Indonesian scene action: ${params.sceneSummary}`,
      cast ? `Visible assets:\n${cast}` : "",
      "Write ONLY one clean English paragraph describing the exact pose, expression, action, environment, and lighting for this single frame.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

// ============================================================================
// OPTIONAL STORYBOARD EXPORT (Markdown + ZIP)
// ============================================================================

export function buildStoryboardMarkdown(project: NmcProject): string {
  const sb = ensureStoryboard(project);
  const segments = getStoryboardSegments(sb);
  const lines: string[] = [
    `# Storyboard: ${project.name}`,
    "",
    `- Rasio: ${sb.aspectRatio}`,
    `- Gaya Visual: ${sb.visualStyle}`,
    `- Total Segmen: ${segments.length}`,
    `- Total Aset ACC: ${sb.assets.filter((a) => a.approved).length}/${sb.assets.length}`,
    `- Total Panel: ${sb.frames.length}`,
    "",
    "## 1. Ide Cerita",
    sb.idea || "(Belum diisi)",
    "",
    "## 2. Naskah Per-Segmen",
    sb.scriptText || formatSegmentsToScript(segments) || "(Belum diisi)",
    "",
    "## 3. Aset & Karakter (ACC)",
  ];

  for (const a of sb.assets) {
    lines.push(
      `- **${a.name}** (${ASSET_CATEGORY_LABEL[a.category]}${a.approved ? " · ACC" : ""}) — ${a.roleInScript}`,
      `  - Visual (EN): ${a.visualDesc}`,
    );
  }

  lines.push("", "## 4. Storyboard Per-Segmen");
  const writtenIds = new Set<string>();
  const appendFrame = (f: StoryFrame, panelNum: number) => {
    writtenIds.add(f.id);
    const cast = f.assetIds
      .map((id) => sb.assets.find((a) => a.id === id)?.name)
      .filter(Boolean)
      .join(", ");
    lines.push(
      "",
      `#### Panel ${panelNum} — Frame ${String(f.index).padStart(2, "0")}: ${f.title}`,
      `- Kamera: ${SHOT_SIZE_META[f.shotSize].label} · ${CAMERA_ANGLE_META[f.cameraAngle].label}`,
      `- Aset Tampil: ${cast || "-"}`,
      f.scriptExcerpt ? `- Bagian Naskah: ${f.scriptExcerpt}` : "",
      `- Aksi: ${f.sceneSummary}`,
      f.dialogue ? `- Dialog: "${f.dialogue}"` : "",
      `- Prompt Visual (EN): ${f.visualPrompt}`,
    );
  };

  segments.forEach((seg, segIdx) => {
    const segFrames = getSegmentFrames(sb, seg.id, segIdx);
    lines.push(
      "",
      `### Segmen ${String(seg.index).padStart(2, "0")}: ${seg.title}${seg.locationHint ? ` (${seg.locationHint})` : ""} — ${segFrames.length}/${seg.targetPanels} Panel`,
    );
    if (segFrames.length === 0) {
      lines.push("- *(Belum ada panel di segmen ini)*");
    } else {
      segFrames.forEach((f, pIdx) => appendFrame(f, f.panelNumber ?? pIdx + 1));
    }
  });

  for (const f of sb.frames) {
    if (!writtenIds.has(f.id)) {
      appendFrame(f, f.panelNumber ?? f.index);
    }
  }

  return lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n") + "\n";
}

function decodeBase64DataUrl(dataUrl: string): { ext: string; bytes: Uint8Array } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { ext, bytes };
}

export function buildStoryboardZip(project: NmcProject): Uint8Array {
  const sb = ensureStoryboard(project);
  const segments = getStoryboardSegments(sb);
  const entries: ZipEntryInput[] = [
    { name: "storyboard.md", data: buildStoryboardMarkdown(project) },
    { name: "project.json", data: JSON.stringify(project, null, 2) },
  ];

  sb.assets.forEach((a, idx) => {
    const img = getSelectedAssetImage(a);
    if (!img) return;
    const dec = decodeBase64DataUrl(img);
    if (!dec) return;
    const slug = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `aset_${idx + 1}`;
    entries.push({ name: `assets/${String(idx + 1).padStart(2, "0")}_${slug}.${dec.ext}`, data: dec.bytes });
  });

  const addedIds = new Set<string>();
  segments.forEach((seg, segIdx) => {
    const segFrames = getSegmentFrames(sb, seg.id, segIdx);
    segFrames.forEach((f, pIdx) => {
      addedIds.add(f.id);
      const img = getSelectedFrameImage(f);
      if (!img) return;
      const dec = decodeBase64DataUrl(img);
      if (!dec) return;
      const pNum = f.panelNumber ?? pIdx + 1;
      entries.push({
        name: `frames/segmen_${String(seg.index).padStart(2, "0")}_panel_${String(pNum).padStart(2, "0")}.${dec.ext}`,
        data: dec.bytes,
      });
    });
  });

  sb.frames.forEach((f) => {
    if (addedIds.has(f.id)) return;
    const img = getSelectedFrameImage(f);
    if (!img) return;
    const dec = decodeBase64DataUrl(img);
    if (!dec) return;
    entries.push({
      name: `frames/frame_${String(f.index).padStart(2, "0")}.${dec.ext}`,
      data: dec.bytes,
    });
  });

  return buildZip(entries);
}
