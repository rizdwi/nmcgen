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

  const hasScript = Boolean(sd?.scriptText?.trim());
  const allAssetsApproved = assets.length > 0 && assets.every((a) => a.approved);
  const step = frames.length > 0 ? "storyboard" : assets.length > 0 ? "assets" : "script";

  return {
    step,
    idea: sd?.premise ?? "",
    aspectRatio: sd?.aspectRatio ?? "16:9",
    visualStyle: sd?.visualStyle?.trim() || DEFAULT_VISUAL_STYLE,
    scriptText: sd?.scriptText ?? "",
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

// ============================================================================
// STEP 1: IDEA -> SCRIPT (Natural, genre-faithful, vivid visual script)
// ============================================================================

export function buildGenerateScriptPrompt(params: {
  projectName: string;
  idea: string;
  visualStyle: string;
  aspectRatio: AspectRatio;
}): { system: string; prompt: string } {
  return {
    system:
      "Kamu adalah penulis skenario cerita visual berbahasa Indonesia yang tajam, natural, dan disiplin mengikuti ide pengguna. Tulis naskah yang runtut dari awal sampai selesai, visualnya jelas bisa digambar menjadi storyboard per-frame, dan JANGAN melenceng dari genre atau ide yang diminta pengguna.",
    prompt: [
      `Tulis naskah cerita lengkap berbahasa Indonesia untuk proyek berjudul "${params.projectName}".`,
      `Ide cerita pengguna:\n${params.idea.trim()}`,
      `Gaya visual rencana: ${params.visualStyle}`,
      `Rasio frame: ${params.aspectRatio}`,
      "",
      "Aturan penulisan naskah:",
      "1. Ikuti genre, suasana, tokoh, dan premis pengguna apa adanya (JANGAN mengubah cerita ringan menjadi horor/taruhan nyawa, dan JANGAN menambahkan tokoh atau benda aneh yang tidak diminta).",
      "2. Bagi naskah menjadi 3 sampai 5 ADEGAN bernomor yang jelas (misal: ADEGAN 1 — [LOKASI SPESIFIK, WAKTU]).",
      "3. Saat pertama kali tokoh, lokasi, atau benda penting muncul, sebutkan ciri visual konkretnya secara singkat (misal umur, pakaian & warna khas, bentuk lokasi) supaya tahap ekstraksi aset nanti akurat dan konsisten.",
      "4. Tulis aksi visual yang konkret, mudah dibayangkan dalam gambar frame demi frame, dan saling bersambung logis dari awal sampai akhir yang tuntas.",
      "5. Sertakan dialog singkat yang natural bila cocok dengan ceritanya (maks 1-2 kalimat per ucapan).",
      "6. Balas langsung dengan teks naskah yang rapi tanpa kata pengantar atau penutup.",
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
      "Kamu adalah editor skenario berbahasa Indonesia. Revisi naskah sesuai instruksi pengguna dengan tetap menjaga struktur adegan yang rapi dan konsistensi tokoh serta lokasi.",
    prompt: [
      `Judul proyek: ${params.projectName}`,
      params.idea.trim() ? `Ide awal: ${params.idea.trim()}` : "",
      `Instruksi revisi dari pengguna:\n${params.instruction.trim()}`,
      `Naskah saat ini:\n${params.currentScript.trim()}`,
      "",
      "Balas langsung dengan naskah lengkap hasil revisi tanpa kata pengantar.",
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
// STEP 3: PER-FRAME STORYBOARD WITH CONTINUE (Anchored to Script + ACC Assets)
// ============================================================================

export function buildNextFramePrompt(params: {
  projectName: string;
  scriptText: string;
  visualStyle: string;
  aspectRatio: AspectRatio;
  approvedAssets: StoryAsset[];
  previousFrames: StoryFrame[];
  userDirection?: string;
}): { system: string; prompt: string } {
  const nextIndex = params.previousFrames.length + 1;
  const assetCatalog = params.approvedAssets
    .map(
      (a) =>
        `- id="${a.id}" | nama="${a.name}" | jenis=${a.category} | peran="${a.roleInScript}" | visual="${a.visualDesc}"`,
    )
    .join("\n");

  const prevSummary = params.previousFrames.length
    ? params.previousFrames
        .map((f) => {
          const names = f.assetIds
            .map((id) => params.approvedAssets.find((a) => a.id === id)?.name)
            .filter(Boolean)
            .join(", ");
          return `Frame ${f.index} [${f.shotSize}/${f.cameraAngle}] "${f.title}" | Aset:[${names || "-"}] | Naskah: "${f.scriptExcerpt || "-"}" | Aksi: ${f.sceneSummary}${f.dialogue ? ` | Dialog: "${f.dialogue}"` : ""}`;
        })
        .join("\n")
    : "(Belum ada frame sebelumnya — ini adalah Frame 1 pembuka cerita dari awal naskah.)";

  const lastFrame = params.previousFrames[params.previousFrames.length - 1];

  return {
    system:
      "Kamu adalah Storyboard Director ahli yang bekerja per-frame (satu gambar = satu momen visual konkret) berdasarkan naskah dan daftar aset yang sudah di-ACC. Jangan pernah mengarang karakter/lokasi di luar daftar aset ACC, dan ikuti alur naskah secara berurutan tanpa melompat atau mengulang. Balas HANYA 1 JSON object valid tanpa markdown.",
    prompt: [
      `Susun rancangan untuk FRAME ${nextIndex} dari storyboard "${params.projectName}" (${params.aspectRatio}).`,
      "",
      'Format JSON object wajib: {"title":"judul singkat frame (bahasa Indonesia)","scriptExcerpt":"kutipan singkat bagian naskah yang sedang divisualkan di frame ini","sceneSummary":"1-2 kalimat bahasa Indonesia tentang SATU momen aksi visual konkret di frame ini","dialogue":"dialog/narasi singkat dari naskah di momen ini (kosongkan jika tanpa dialog)","shotSize":"WS|MS|MCU|CU|ECU","cameraAngle":"Front|Side 90|Rear 3/4|High|Low","assetIds":["id-aset-acc-yang-fisiknya-tampil"],"sameLocationAsPrev":true,"visualPrompt":"Concise vivid pure English description (45-80 words) of THIS SINGLE FRAME: subject pose, facial expression, specific physical action, foreground/background environment, and lighting/mood. NO Indonesian words, NO @ symbols, NO dialogue quotes, NO text on image.","storyFinished":false}',
      "",
      "Aturan KETAT:",
      `1. Ini adalah Frame ${nextIndex}. ${nextIndex === 1 ? "Mulailah tepat dari pembukaan Adegan 1 naskah (perkenalan latar/tokoh sesuai naskah)." : "Lanjutkan TEPAT dari momen setelah Frame " + (nextIndex - 1) + " mengikuti urutan naskah — JANGAN mengulang momen yang sudah digambar dan JANGAN melompat jauh ke bagian akhir."}`,
      "2. SATU frame = SATU momen beku yang jelas dan mudah digambar AI (bukan 3 aksi berbeda dalam 1 frame).",
      "3. Field assetIds WAJIB hanya berisi `id` yang persis ada di DAFTAR ASET ACC di bawah, dan HANYA aset yang FISIKNYA TERLIHAT DI LAYAR pada frame ini (jika karakter hanya disebut namanya, JANGAN masukkan id-nya; jika shot close-up wajah tanpa memperlihatkan ruang luas, fokus ke karakter/prop saja).",
      lastFrame
        ? `4. Variasikan komposisi kamera dari Frame sebelumnya (Frame ${lastFrame.index} memakai ${lastFrame.shotSize} / ${lastFrame.cameraAngle} — pilih kombinasi shotSize atau cameraAngle yang berbeda agar sinematis!).`
        : "4. Pilih komposisi kamera pembuka yang kuat dan jelas (biasanya WS atau MS).",
      "5. Set sameLocationAsPrev = true HANYA jika Frame ini masih berada di ruangan/lokasi yang sama & bersambung langsung dengan Frame sebelumnya; set false jika pindah tempat atau ini Frame 1.",
      "6. Set storyFinished = true HANYA jika Frame ini benar-benar menutup akhir cerita di naskah.",
      "7. Field visualPrompt WAJIB 100% bahasa Inggris murni (45-80 kata), konsisten dengan ciri fisik aset ACC yang tampil, TANPA menyebut nama gaya seni (gaya ditambahkan otomatis) dan TANPA kata Indonesia / simbol @.",
      params.userDirection?.trim()
        ? `\nARAHAN KHUSUS PENGGUNA UNTUK FRAME ${nextIndex} (WAJIB DIIKUTI):\n${params.userDirection.trim()}`
        : "",
      "",
      `DAFTAR ASET ACC (gunakan HANYA id dari daftar ini):\n${assetCatalog || "(Belum ada aset ACC)"}`,
      "",
      `FRAME YANG SUDAH DIBUAT SEBELUMNYA:\n${prevSummary}`,
      "",
      `NASKAH LENGKAP:\n${params.scriptText.trim().slice(0, 8000)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function parseNextFrameResponse(
  raw: string,
  approvedAssets: StoryAsset[],
  previousFrames: StoryFrame[],
): { frame: StoryFrame; storyFinished: boolean } {
  const slice = extractJsonSlice(raw, "{");
  if (!slice) throw new Error("Respons AI untuk frame storyboard tidak berbentuk JSON object.");
  const obj = JSON.parse(slice) as Record<string, unknown>;

  const nextIndex = previousFrames.length + 1;
  const lastFrame = previousFrames[previousFrames.length - 1];

  const fallbackShots: ShotSize[] = ["WS", "MS", "MCU", "CU", "MS"];
  const fallbackAngles: CameraAngle[] = ["Front", "Side 90", "Rear 3/4", "Low", "High"];

  const shotSize: ShotSize = VALID_SHOT_SIZES.includes(obj.shotSize as ShotSize)
    ? (obj.shotSize as ShotSize)
    : fallbackShots[(nextIndex - 1) % fallbackShots.length];

  let cameraAngle: CameraAngle = VALID_CAMERA_ANGLES.includes(obj.cameraAngle as CameraAngle)
    ? (obj.cameraAngle as CameraAngle)
    : fallbackAngles[(nextIndex - 1) % fallbackAngles.length];

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

  const sameLocationAsPrev = nextIndex > 1 && Boolean(obj.sameLocationAsPrev);
  const frame: StoryFrame = {
    id: uid(),
    index: nextIndex,
    title: String(obj.title || `Frame ${nextIndex}`).trim(),
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
  const lines: string[] = [
    `# Storyboard: ${project.name}`,
    "",
    `- Rasio: ${sb.aspectRatio}`,
    `- Gaya Visual: ${sb.visualStyle}`,
    `- Total Aset ACC: ${sb.assets.filter((a) => a.approved).length}/${sb.assets.length}`,
    `- Total Frame: ${sb.frames.length}`,
    "",
    "## 1. Ide Cerita",
    sb.idea || "(Belum diisi)",
    "",
    "## 2. Naskah",
    sb.scriptText || "(Belum diisi)",
    "",
    "## 3. Aset & Karakter (ACC)",
  ];

  for (const a of sb.assets) {
    lines.push(
      `- **${a.name}** (${ASSET_CATEGORY_LABEL[a.category]}${a.approved ? " · ACC" : ""}) — ${a.roleInScript}`,
      `  - Visual (EN): ${a.visualDesc}`,
    );
  }

  lines.push("", "## 4. Storyboard Per-Frame");
  for (const f of sb.frames) {
    const cast = f.assetIds
      .map((id) => sb.assets.find((a) => a.id === id)?.name)
      .filter(Boolean)
      .join(", ");
    lines.push(
      "",
      `### Frame ${String(f.index).padStart(2, "0")}: ${f.title}`,
      `- Kamera: ${SHOT_SIZE_META[f.shotSize].label} · ${CAMERA_ANGLE_META[f.cameraAngle].label}`,
      `- Aset Tampil: ${cast || "-"}`,
      f.scriptExcerpt ? `- Bagian Naskah: ${f.scriptExcerpt}` : "",
      `- Aksi: ${f.sceneSummary}`,
      f.dialogue ? `- Dialog: "${f.dialogue}"` : "",
      `- Prompt Visual (EN): ${f.visualPrompt}`,
    );
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

  sb.frames.forEach((f) => {
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
