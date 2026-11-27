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

const SEGMENT_HEADING_RE =
  /^(?:#{1,3}\s*)?(?:\*\*)?(?:SEGMEN|SEGMENT|ADEGAN|SCENE|BABAK)\s*(\d+)\s*(?:[—\-–:]\s*(.*))?(?:\*\*)?$/i;

const STORY_SPINE_LINE_RE =
  /^(?:#{1,3}\s*)?(?:\*\*)?(?:BENANG\s*MERAH|PREMIS(?:\s*UTUH)?|LOGLINE|RINGKASAN\s*CERITA|STORY\s*SPINE)(?:\*\*)?\s*:\s*(.*)$/i;

/**
 * Extracts an optional `BENANG MERAH: ...` header block placed before `SEGMEN 1`
 * so the unified story spine is stored cleanly without polluting Segment 1.
 */
export function extractStorySpineFromScript(rawScript: string): {
  storySpine: string;
  cleanScript: string;
} {
  const raw = rawScript.replace(/\r\n?/g, "\n").trim();
  if (!raw) return { storySpine: "", cleanScript: "" };

  const lines = raw.split("\n");
  const firstHeadingIdx = lines.findIndex((ln) => SEGMENT_HEADING_RE.test(ln.trim()));
  const searchEnd = firstHeadingIdx === -1 ? Math.min(lines.length, 8) : firstHeadingIdx;

  const spineLines: string[] = [];
  let capturing = false;
  let capturedEndIdx = -1;

  for (let i = 0; i < searchEnd; i++) {
    const trimmed = lines[i].trim();
    const m = trimmed.match(STORY_SPINE_LINE_RE);
    if (m) {
      capturing = true;
      const tail = (m[1] || "").replace(/^\*+|\*+$/g, "").trim();
      if (tail) spineLines.push(tail);
      capturedEndIdx = i;
      continue;
    }
    if (capturing) {
      if (!trimmed) {
        capturedEndIdx = i;
        break;
      }
      spineLines.push(trimmed.replace(/^\*+|\*+$/g, "").trim());
      capturedEndIdx = i;
    }
  }

  const storySpine = spineLines.join(" ").replace(/\s+/g, " ").trim();
  if (!storySpine) {
    return { storySpine: "", cleanScript: raw };
  }

  const remaining =
    firstHeadingIdx !== -1
      ? lines.slice(firstHeadingIdx).join("\n").trim()
      : lines.slice(capturedEndIdx + 1).join("\n").trim();

  return { storySpine, cleanScript: remaining || raw };
}

export interface StoryCoherenceAudit {
  ok: boolean;
  warnings: string[];
}

/**
 * Deterministic check to catch fragmented, aimless, or shot-list-only scripts before generating assets/panels.
 */
export function auditStoryCoherence(
  sb: Pick<StoryboardData, "scriptText" | "segments" | "storySpine" | "frames">,
): StoryCoherenceAudit {
  const warnings: string[] = [];
  const text = (sb.scriptText || "").trim();
  if (!text) return { ok: true, warnings: [] };

  const segs = sb.segments && sb.segments.length > 0 ? sb.segments : parseScriptIntoSegments(text, [], 5);
  const { storySpine: inlineSpine } = extractStorySpineFromScript(text);
  const hasSpine = Boolean((sb.storySpine || inlineSpine).trim());

  if (!hasSpine) {
    warnings.push(
      "Benang Merah cerita belum terkunci. Isi ringkasan 1 kalimat (Tokoh & Tujuan → Konflik → Akhir) atau klik Perkuat Benang Merah.",
    );
  }
  if (segs.length < 3) {
    warnings.push(
      `Baru ada ${segs.length} segmen — minimal 3–4 segmen (Setup → Konflik → Titik Balik → Resolusi) agar alur cerita terasa utuh.`,
    );
  }

  // Detect camera-shot-list scripts ("1. Wide shot... 2. Close-up...") which lack narrative substance
  const shotListHits = text.match(/\b(wide\s+shot|close[\s-]?up|medium\s+shot|kamera\s+fokus|kamera\s+memperlihatkan)\b/gi) ?? [];
  if (shotListHits.length >= 3) {
    warnings.push(
      "Naskah terlalu banyak berisi instruksi kamera teknis ('Wide shot / Close-up') alih-alih alur cerita sebab–akibat.",
    );
  }

  // Detect nearly silent scripts lacking dialogue or inner voiceover
  const quoteMatches = text.match(/["“][^"”\n]{4,}["”]/g) ?? [];
  if (quoteMatches.length < Math.max(2, Math.floor(segs.length * 0.75))) {
    warnings.push(
      "Dialog/narasi terlalu sedikit — penonton berisiko bingung memahami tujuan tokoh dan makna adegan.",
    );
  }

  return { ok: warnings.length === 0, warnings };
}

export function parseScriptIntoSegments(
  scriptText: string,
  existing: StorySegment[] = [],
  defaultPanels = 5,
): StorySegment[] {
  const { cleanScript } = extractStorySpineFromScript(scriptText);
  const raw = cleanScript.replace(/\r\n?/g, "\n").trim();
  if (!raw) return [];

  const lines = raw.split("\n");
  const hasExplicitHeading = lines.some((ln) => SEGMENT_HEADING_RE.test(ln.trim()));
  const buckets: Array<{ headerRest: string; bodyLines: string[] }> = [];
  let cur: { headerRest: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(SEGMENT_HEADING_RE);
    if (m) {
      if (cur && (cur.bodyLines.join("").trim() || cur.headerRest)) buckets.push(cur);
      const rest = (m[2] || "").replace(/\*+$/g, "").trim();
      cur = { headerRest: rest, bodyLines: [] };
    } else {
      // If explicit SEGMEN/ADEGAN headings exist, ignore any preamble lines before SEGMEN 1
      if (!cur) {
        if (hasExplicitHeading) continue;
        cur = { headerRest: "", bodyLines: [] };
      }
      cur.bodyLines.push(line);
    }
  }
  if (cur && (cur.bodyLines.join("").trim() || cur.headerRest)) buckets.push(cur);

  // If user pasted plain paragraphs without headings, split by double newline into segments (up to 8).
  if (buckets.length <= 1) {
    const paras = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    if (paras.length >= 2 && !SEGMENT_HEADING_RE.test(lines[0]?.trim() || "")) {
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
      "Kamu adalah penulis skenario cerita visual berbahasa Indonesia kelas film pendek. Tugas utamamu menciptakan SATU KESATUAN CERITA UTUH dengan benang merah sebab–akibat yang sangat jelas (Siapa tokohnya → Apa tujuannya → Apa hambatannya → Apa titik balik & jawaban akhirnya) sehingga penonton langsung paham alurnya dari awal sampai selesai. DILARANG menulis daftar instruksi kamera teknis yang kosong tanpa cerita, dan DILARANG mengakhiri cerita menggantung tanpa resolusi.",
    prompt: [
      `Tulis naskah cerita lengkap berbahasa Indonesia untuk proyek berjudul "${params.projectName}".`,
      `Ide cerita pengguna:\n${params.idea.trim()}`,
      `Gaya visual rencana: ${params.visualStyle}`,
      `Rasio frame: ${params.aspectRatio}`,
      "",
      "Aturan WAJIB Benang Merah & Kesatuan Cerita:",
      "1. Bila ide pengguna masih singkat (misal 3–8 kata), kembangkan menjadi SATU cerita utuh yang membumi, jelas tujuannya, dan memuaskan — tetap 100% setia pada genre/suasana ide pengguna (JANGAN mengubah cerita hangat/drama menjadi horor/monster yang tidak diminta).",
      "2. Baris PALING ATAS (sebelum SEGMEN 1) WAJIB menulis 1 kalimat ringkas dengan format persis:",
      "   BENANG MERAH: [Siapa tokoh utama & misinya] menghadapi [hambatan utama], lalu menemukan [titik balik bermakna] yang berujung pada [resolusi/jawaban jelas di akhir].",
      "3. Bagi cerita menjadi 4 SEGMEN sebab–akibat yang saling menyambung erat (akhir Segmen N langsung memicu awal Segmen N+1) dengan format header persis:",
      "   SEGMEN 1 — Judul Singkat | EXT./INT. LOKASI SPESIFIK - WAKTU",
      "   - SEGMEN 1 (Setup & Misi): Perkenalkan siapa tokohnya, sedang apa, KENAPA ia berada di situ (tujuan/taruhan konkretnya), dan pemicu awal yang menggerakkan cerita.",
      "   - SEGMEN 2 (Hambatan & Petunjuk): Akibat langsung dari Segmen 1 — tokoh menghadapi rintangan nyata atau menemukan petunjuk penting yang memperjelas misteri/misi.",
      "   - SEGMEN 3 (Titik Balik & Klimaks): Tokoh mengambil keputusan/aksi penentu dan menemukan inti kebenaran/jawaban atas misinya (bukan sekadar melamun atau melihat benda tanpa arti!).",
      "   - SEGMEN 4 (Resolusi & Payoff): Akibat nyata dari klimaks; pertanyaan penonton terjawab tuntas, tujuan tokoh tercapai/berubah secara emosional, dan cerita ditutup dengan memuaskan.",
      "4. Tulis isi setiap segmen dalam 4–5 kalimat narasi aksi visual yang mengalir berurutan (agar mulus dipecah menjadi 4–7 panel storyboard). DILARANG menulis istilah kamera/teknis seperti 'Wide shot', 'Close-up', 'Kamera fokus', atau 'rim lighting' di dalam naskah!",
      "5. SETIAP SEGMEN WAJIB memiliki minimal 1–2 baris dialog lisan atau monolog batin singkat dalam tanda kutip (\"...\") yang natural dan memberi konteks jelas ke penonton tentang tujuan, perasaan, atau penemuan tokoh.",
      "6. Saat pertama kali tokoh, lokasi, atau benda penting muncul, sebutkan ciri visual konkretnya (umur, pakaian & warna khas, bentuk benda, waktu/cuaca yang konsisten).",
      "7. Balas langsung mulai dari baris BENANG MERAH: dilanjutkan SEGMEN 1 sampai SEGMEN 4 tanpa kata pengantar atau penutup.",
    ].join("\n"),
  };
}

export function buildReviseScriptPrompt(params: {
  projectName: string;
  idea: string;
  storySpine?: string;
  currentScript: string;
  instruction: string;
}): { system: string; prompt: string } {
  return {
    system:
      "Kamu adalah Story Doctor & editor skenario berbahasa Indonesia. Revisi naskah sesuai instruksi pengguna agar memiliki BENANG MERAH yang sangat jelas, alur sebab–akibat yang utuh dari SEGMEN 1 sampai penutup, dialog bermakna di tiap segmen, dan bebas dari istilah teknis kamera.",
    prompt: [
      `Judul proyek: ${params.projectName}`,
      params.idea.trim() ? `Ide awal: ${params.idea.trim()}` : "",
      params.storySpine?.trim() ? `Benang merah saat ini: ${params.storySpine.trim()}` : "",
      `Instruksi revisi dari pengguna:\n${params.instruction.trim()}`,
      `Naskah saat ini:\n${params.currentScript.trim()}`,
      "",
      "Aturan revisi:",
      "1. Awali baris pertama dengan `BENANG MERAH: ...` (1 kalimat utuh: Tokoh & Tujuan → Hambatan → Titik Balik → Resolusi).",
      "2. Gunakan struktur 3–4 segmen sebab–akibat dengan header persis `SEGMEN N — Judul | EXT./INT. LOKASI - WAKTU`, di mana akhir tiap segmen langsung menyambung ke segmen berikutnya.",
      "3. Hapus istilah teknis kamera ('Wide shot', 'Close-up', 'Kamera fokus') dan ganti dengan aksi cerita konkret + 1–2 dialog/monolog batin bermakna dalam tanda kutip di setiap segmen.",
      "4. Balas langsung mulai dari `BENANG MERAH:` lalu `SEGMEN 1..N` tanpa kata pengantar.",
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
      "Kamu adalah Art Director & Continuity Supervisor. Tugasmu mengekstrak daftar lengkap Karakter, Lokasi, dan Properti penting LANGSUNG dari naskah dengan pencahayaan/waktu yang 100% konsisten dan pemisahan tegas antara lokasi kosong dan properti kunci. DILARANG mengarang tokoh, lokasi, atau benda yang tidak ada di naskah. Balas HANYA JSON array valid tanpa markdown.",
    prompt: [
      `Baca keseluruhan naskah "${params.projectName}" berikut secara teliti, lalu ekstrak SEMUA aset visual yang benar-benar dibutuhkan untuk menggambar seluruh naskah ini.`,
      "",
      'Format JSON array wajib: [{"name":"Nama Jelas","category":"character|location|prop","roleInScript":"Penjelasan singkat bahasa Indonesia + muncul di adegan mana sesuai naskah","visualDesc":"Concise pure English visual description strictly matching every physical/clothing/architectural/time-of-day detail stated in the script"}]',
      "",
      "Aturan KETAT anti-melenceng & anti-bentrok visual:",
      "1. HANYA ekstrak karakter, lokasi, dan properti kunci yang FISIKNYA MUNCUL di naskah. DILARANG menambah karakter/monster/lokasi baru yang tidak tertulis di naskah!",
      "2. Ikuti detail naskah secara persis: umur, gender, etnis/latar budaya, rambut, warna & jenis pakaian, arsitektur ruangan, dan warna/bentuk properti. Untuk karakter, pastikan proporsi tubuh normal & ciri wajah/rambut/pakaian jelas dan konsisten.",
      "3. KHUSUS ASET LOKASI (`location`): WAJIB menyertakan waktu hari & cuaca persis sesuai naskah (misal: night heavy rain, dawn mist, warm sunset — JANGAN menggambar lokasi siang terang jika adegannya malam!). DAN DILARANG memasukkan properti kunci bergerak/api/benda yang sudah dibuatkan kartu `prop` terpisah agar warna & bentuk tidak bentrok!",
      "4. Field roleInScript WAJIB bahasa Indonesia dan menyebutkan muncul di segmen/adegan mana (misal: 'Tokoh utama (Segmen 1-4): pendaki muda yang mencari adiknya...').",
      "5. Field visualDesc WAJIB bahasa Inggris murni (25-55 kata), HANYA mendeskripsikan ciri fisik tetap (wajah, rambut, pakaian untuk character; bentuk ruang, waktu hari & cuaca untuk location; bentuk, bahan & warna tepat untuk prop). JANGAN tulis nama gaya seni, JANGAN tulis sudut kamera, JANGAN tulis dialog, JANGAN tulis simbol @.",
      "6. Jumlah aset ideal: semua karakter utama/pendukung yang tampil + lokasi utama yang tampil + maksimal 1-2 properti paling krusial jika memang penting di naskah (total biasanya 3 sampai 7 aset).",
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
    return `${style}. Clean character reference sheet portrait of one single person standing upright with natural well-proportioned body anatomy, three-quarter to full body view, clear face looking toward camera, centered on a plain solid neutral light-grey studio background. Subject: ${desc}. Exact outfit, hairstyle, and features, single character only, no split panels, no multiple angles, no cropped head, no text, no watermark.`;
  }
  if (asset.category === "location") {
    return `${style}. Wide establishing background illustration of an empty location with NO people, NO characters, NO silhouettes, and NO temporary movable props. Setting: ${desc}. Strictly match the exact time of day, weather, and lighting atmosphere described, clear foreground, midground, and background depth, single clean frame, no text, no watermark.`;
  }
  return `${style}. Single isolated object reference centered on a plain neutral grey background, no hands, no people. Object: ${desc}. Crisp clear details and exact colors, single item only, no split grid, no text, no watermark.`;
}

// ============================================================================
// STEP 3: PER-SEGMENT STORYBOARD (4-7 SMOOTH PANELS PER SEGMENT + CONTINUE)
// ============================================================================

export function buildNextFramePrompt(params: {
  projectName: string;
  scriptText: string;
  storySpine?: string;
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
  const effectiveSpine = (
    params.storySpine || extractStorySpineFromScript(params.scriptText).storySpine
  ).trim();

  const assetCatalog = params.approvedAssets
    .map(
      (a) =>
        `- id="${a.id}" | nama="${a.name}" | jenis=${a.category} | peran="${a.roleInScript}" | visual="${a.visualDesc}"`,
    )
    .join("\n");

  // Summarize closing beats of previous segments so Segment 2/3/4 bridges cause->effect without jump cuts
  const earlierSegFrames = seg
    ? params.previousFrames.filter((f) => f.segmentId && f.segmentId !== seg.id)
    : [];
  const prevSegmentsRecap = earlierSegFrames.length
    ? earlierSegFrames
        .slice(-3)
        .map((f) => {
          const dlg = f.dialogue.trim() ? ` | Dialog: "${f.dialogue.trim()}"` : "";
          return `- Frame #${f.index} "${f.title}": ${f.sceneSummary}${dlg}`;
        })
        .join("\n")
    : "";

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
      ? seg.index > 1 && lastGlobal
        ? `Panel 1 dari ${targetPanels}: BUKA Segmen ${seg.index} dengan MENYAMBUNG LANGSUNG secara sebab–akibat dari akhir segmen sebelumnya ("${lastGlobal.title}"). Tunjukkan pergeseran situasi/aksi baru yang jelas (JANGAN mengulang pose atau ekspresi panel terakhir segmen lalu, dan JANGAN langsung melompat ke akhir segmen!).`
        : `Panel 1 dari ${targetPanels}: BUKA Segmen ${seg.index} dengan memperkenalkan tokoh, latar, serta konteks/misi cerita secara jelas. JANGAN langsung melompat ke puncak/akhir segmen!`
      : panelNum < targetPanels
        ? `Panel ${panelNum} dari ${targetPanels}: MAJU 1 LANGKAH SEBAB–AKIBAT yang nyata setelah Panel ${panelNum - 1} ("${lastInSeg?.title ?? ""}") — hadirkan perkembangan aksi, penemuan, atau reaksi emosi baru (DILARANG mengulang pose/komposisi serupa!). JANGAN melompat ke akhir segmen karena masih ada ${targetPanels - panelNum} panel lagi setelah ini!`
        : `Panel ${panelNum} dari ${targetPanels} (PANEL PENUTUP SEGMEN ${seg.index}): Selesaikan titik penting Segmen ${seg.index} dengan jelas dan berikan jembatan sebab–akibat yang kuat menuju segmen berikutnya (atau penutup resolusi utuh jika ini segmen terakhir).`
    : globalIndex === 1
      ? "Mulailah tepat dari pembukaan cerita sesuai naskah."
      : `Lanjutkan TEPAT 1 langkah sebab–akibat setelah Frame ${globalIndex - 1} tanpa melompat atau mengulang pose.`;

  const isLastSegment = seg && params.totalSegments ? seg.index >= params.totalSegments : false;
  const segDialogueCount = segFrames.filter((f) => Boolean(f.dialogue.trim())).length;
  const dialogueGuide =
    segDialogueCount < 2 && (panelNum === 1 || panelNum === Math.ceil(targetPanels / 2) || panelNum >= targetPanels)
      ? "WAJIB isi field `dialogue` dengan 1 kalimat pendek natural bahasa Indonesia (5–16 kata: dialog lisan tokoh atau monolog batin singkat) yang memperjelas konteks, tujuan, atau reaksi tokoh agar penonton paham benang merah cerita!"
      : "Isi field `dialogue` dengan dialog lisan / monolog batin singkat jika momen ini penting untuk pemahaman penonton (pastikan minimal 2–3 panel per segmen memiliki dialog/narasi bermakna).";

  return {
    system:
      "Kamu adalah Storyboard Director & Narrative Continuity Supervisor profesional. Tugasmu memecah SATU SEGMEN naskah menjadi 4-7 PANEL storyboard berurutan yang MENJAGA BENANG MERAH CERITA UTUH secara sebab–akibat — setiap panel wajib memajukan cerita secara visual & emosional (TIDAK lompat-lompat dan TIDAK mengulang pose/aksi statis). Gunakan HANYA aset dari daftar ACC. Balas HANYA 1 JSON object valid tanpa markdown.",
    prompt: [
      seg
        ? `Susun rancangan untuk PANEL ${panelNum} dari ${targetPanels} pada SEGMEN ${seg.index} ("${seg.title}") untuk proyek "${params.projectName}" (${params.aspectRatio}).`
        : `Susun rancangan untuk FRAME ${globalIndex} dari storyboard "${params.projectName}" (${params.aspectRatio}).`,
      effectiveSpine ? `\nBENANG MERAH CERITA UTUH (WAJIB TERJAGA DI TIAP PANEL):\n${effectiveSpine}` : "",
      "",
      'Format JSON object wajib: {"title":"judul sangat singkat 2-4 kata untuk label panel (mis. Tiba di Gerbang, Menemukan Jejak, Keputusan Berani)","scriptExcerpt":"bagian singkat naskah segmen yang sedang divisualkan","sceneSummary":"1-2 kalimat bahasa Indonesia tentang SATU perkembangan aksi sebab–akibat konkret di panel ini","dialogue":"dialog lisan atau monolog batin singkat bahasa Indonesia yang memperjelas alur cerita ke penonton","shotSize":"WS|MS|MCU|CU|ECU","cameraAngle":"Front|Side 90|Rear 3/4|High|Low","assetIds":["id-aset-acc-yang-fisiknya-tampil"],"sameLocationAsPrev":true,"visualPrompt":"Concise vivid pure English description (50-85 words) of THIS SINGLE PANEL: clear fresh pose, natural body proportions, facial expression, specific story action, exact time-of-day/weather lighting matching the segment, and foreground/background environment. NO Indonesian words, NO @ symbols, NO dialogue quotes, NO text on image.","segmentFinished":false,"storyFinished":false}',
      "",
      "Aturan KETAT Benang Merah & Anti-Lompat:",
      `1. Pacing & Sebab–Akibat: ${pacingGuide}`,
      "2. SATU panel = SATU perkembangan cerita konkret yang nyata berbeda dari panel sebelumnya (DILARANG membuat 2 panel berturut-turut dengan pose/ekspresi/sudut hampir identik seperti sekadar menunduk lalu mendongak tanpa progres cerita!).",
      `3. Kejelasan bagi Penonton (Dialog/Narasi): ${dialogueGuide}`,
      "4. Field title WAJIB sangat singkat & jelas (2–4 kata seperti caption papan storyboard: 'Mencari Jejak Adik', 'Menemukan Lentera', 'Menerobos Hujan', 'Akhirnya Bertemu').",
      "5. Field assetIds WAJIB hanya berisi `id` yang persis ada di DAFTAR ASET ACC di bawah, dan HANYA aset yang BENAR-BENAR TERLIHAT DI KAMERA pada panel ini (jika panel ini pure POV / close-up benda / pemandangan kosong tanpa tokoh, JANGAN masukkan id karakter!).",
      prevRefFrame
        ? `6. Variasikan framing & sudut kamera secara nyata dari panel sebelumnya (panel sebelumnya memakai ${prevRefFrame.shotSize} / ${prevRefFrame.cameraAngle} — pilih kombinasi shotSize & cameraAngle yang segar dan sesuai emosi momen ini!).`
        : "6. Pilih komposisi pembuka yang kuat (biasanya WS atau MS).",
      `7. Set sameLocationAsPrev = ${panelNum > 1 ? "true jika masih di lokasi/ruang yang sama dengan panel sebelumnya, atau false jika kamera berpindah ke ruang baru / pure insert POV berbeda" : "false jika lokasi atau suasana segmen ini berganti dari segmen sebelumnya, atau true hanya jika persis di tempat & momen yang sama"}.`,
      `8. Set segmentFinished = ${panelNum >= targetPanels ? "true" : "false"} (true jika panel ini menutup Segmen ${seg?.index ?? 1}). Set storyFinished = ${isLastSegment && panelNum >= targetPanels ? "true" : "false"} (true HANYA jika ini penutup akhir seluruh cerita).`,
      `9. Field visualPrompt WAJIB 100% bahasa Inggris murni (50-85 kata), wajib menjaga waktu hari, cuaca, warna pencahayaan (${seg?.locationHint || "sesuai naskah"}), dan proporsi tubuh karakter yang konsisten. TANPA nama gaya seni, TANPA teks Indonesia / simbol @.`,
      params.userDirection?.trim()
        ? `\nARAHAN KHUSUS PENGGUNA UNTUK PANEL ${panelNum} (WAJIB DIIKUTI):\n${params.userDirection.trim()}`
        : "",
      "",
      `DAFTAR ASET ACC (gunakan HANYA id dari daftar ini):\n${assetCatalog || "(Belum ada aset ACC)"}`,
      "",
      seg
        ? `FOKUS NASKAH SEGMEN ${seg.index} (${seg.title}${seg.locationHint ? ` | ${seg.locationHint}` : ""}):\n${seg.scriptContent}`
        : "",
      prevSegmentsRecap ? `\nAKHIR SEGMEN SEBELUMNYA (sambungkan sebab–akibat dari sini):\n${prevSegmentsRecap}` : "",
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

function isExtremeShotScaleJump(prevShot: ShotSize, curShot: ShotSize): boolean {
  const prevTight = prevShot === "CU" || prevShot === "ECU";
  const curTight = curShot === "CU" || curShot === "ECU";
  return (prevShot === "WS" && curTight) || (prevTight && curShot === "WS");
}

/**
 * Selects up to 3 reference images tailored for FLUX.2 Klein 4B:
 * - Priority 1: Visible Characters (up to 2) -> locked face & outfit
 * - Priority 2: Visible Location (for WS/MS) or Prop -> locked setting/object
 * - Priority 3: Previous Frame image -> ONLY when safe from character ghosting and extreme shot-scale cloning
 *   (skip if previous frame had characters that are absent in this shot, or across WS <-> CU/ECU jumps!)
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

  // Optional previous-frame visual continuity ONLY when safe from FLUX.2 composition cloning & character ghosting
  if (frame.sameLocationAsPrev && previousFrame && refs.length < 3) {
    const prevHasChar = previousFrame.assetIds.some((id) => assetMap.get(id)?.category === "character");
    const curHasChar = selectedAssets.some((a) => a.category === "character");
    const ghostingRisk = prevHasChar && !curHasChar;
    const shotJumpRisk = isExtremeShotScaleJump(previousFrame.shotSize, frame.shotSize);

    if (!ghostingRisk && !shotJumpRisk) {
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
    const hasPrevRef = refs.some((r) => r.kind === "previous-frame");
    parts.push(
      `Reference alignment: ${refClauses.join("; ")}. Keep the exact face, hair, age, natural body proportions, and clothing of any referenced character while composing a fresh camera angle and pose matching this shot.${
        hasPrevRef
          ? " Use the previous shot reference ONLY for lighting, color palette, and environment continuity—never copy its layout or pose."
          : ""
      }`,
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
    ...(sb.storySpine?.trim() ? ["", "### Benang Merah Cerita", sb.storySpine.trim()] : []),
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
