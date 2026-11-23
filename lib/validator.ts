import type {
  AspectRatio,
  AssetNodeData,
  CanvasNode,
  NmcProject,
  ScriptNodeData,
  SegmentNodeData,
  ValidationIssue,
  ValidationReport,
} from "./types.ts";
import { resolutionFor } from "./presets.ts";

export function getPrimaryScript(project: NmcProject): ScriptNodeData | null {
  const n = project.nodes.find((node) => node.kind === "script");
  return n && n.data.kind === "script" ? n.data : null;
}

export function getBoundAssets(project: NmcProject, segmentNodeId: string): CanvasNode[] {
  const incomingIds = new Set(
    project.edges.filter((e) => e.target === segmentNodeId).map((e) => e.source),
  );
  return project.nodes.filter((n) => n.kind === "asset" && incomingIds.has(n.id));
}

export function getOrderedSegments(project: NmcProject): CanvasNode[] {
  const assembly = project.nodes.find((n) => n.kind === "assembly");
  const connected = assembly
    ? new Set(project.edges.filter((e) => e.target === assembly.id).map((e) => e.source))
    : null;
  const segs = project.nodes.filter(
    (n) => n.kind === "segment" && (!connected || connected.size === 0 || connected.has(n.id)),
  );
  return [...segs].sort((a, b) => {
    const codeA = a.data.kind === "segment" ? a.data.code : "";
    const codeB = b.data.kind === "segment" ? b.data.code : "";
    if (codeA && codeB && codeA !== codeB) return codeA.localeCompare(codeB, undefined, { numeric: true });
    return a.y - b.y || a.x - b.x;
  });
}

export function getConnectedAudio(project: NmcProject): CanvasNode[] {
  const assembly = project.nodes.find((n) => n.kind === "assembly");
  if (!assembly) return project.nodes.filter((n) => n.kind === "audio");
  const incomingIds = new Set(
    project.edges.filter((e) => e.target === assembly.id).map((e) => e.source),
  );
  return project.nodes.filter((n) => n.kind === "audio" && incomingIds.has(n.id));
}

export function getAdoptedMedia(seg: SegmentNodeData) {
  if (!seg.candidates.length) return null;
  return seg.candidates.find((c) => c.id === seg.adoptedId) ?? seg.candidates[seg.candidates.length - 1];
}

export function estimateDialogueSeconds(dialogue: string): number {
  const words = dialogue.trim().split(/\s+/).filter(Boolean).length;
  if (!words) return 0;
  // ~2.4 spoken Indonesian words per second + 1.0s natural breathing buffer.
  return Math.round((words / 2.4 + 1.0) * 10) / 10;
}

export function composeSegmentPrompt(project: NmcProject, segmentNode: CanvasNode): string {
  if (segmentNode.data.kind !== "segment") return "";
  const seg = segmentNode.data;
  const script = getPrimaryScript(project);
  const boundAssets = getBoundAssets(project, segmentNode.id);

  const lines: string[] = [];
  if (script?.visualStyle) lines.push(`Visual style: ${script.visualStyle}.`);
  lines.push(
    `Segment ${seg.code} (${seg.durationSec}s, ${script?.aspectRatio ?? "16:9"}), framing ${seg.shotSize}, angle ${seg.cameraAngle}, camera ${seg.cameraMotion}.`,
  );
  if (boundAssets.length) {
    lines.push("Reference assets:");
    for (const a of boundAssets) {
      const d = a.data as AssetNodeData;
      lines.push(`- ${d.tag} (${d.category}): ${d.lockPrompt || a.title}`);
    }
  }
  if (seg.continuityLock.trim()) lines.push(`Continuity locks: ${seg.continuityLock.trim()}`);
  if (seg.timelineText.trim()) lines.push(`Timeline:\n${seg.timelineText.trim()}`);
  if (seg.dialogue.trim()) lines.push(`Spoken dialogue (preserve verbatim): "${seg.dialogue.trim()}"`);
  lines.push("No baked subtitles, no watermark, no random screen text.");
  return lines.join("\n");
}

export function validateProject(project: NmcProject): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const script = getPrimaryScript(project);
  const maxSegSec = script?.maxSegmentSec ?? 15;

  const assembly = project.nodes.find((n) => n.kind === "assembly");
  const exportNode = project.nodes.find((n) => n.kind === "export");
  const allSegments = project.nodes.filter((n) => n.kind === "segment");

  if (!allSegments.length) {
    errors.push({
      id: "err_no_segments",
      severity: "error",
      code: "NO_SEGMENTS",
      message: "Belum ada node Segmen Video di kanvas.",
      action: "Tambahkan minimal satu node Segmen lalu hubungkan ke Timeline.",
    });
  }

  if (!assembly) {
    errors.push({
      id: "err_no_assembly",
      severity: "error",
      code: "NO_ASSEMBLY",
      message: "Belum ada node Timeline & Check untuk menyusun urutan video.",
      action: "Tambahkan node Timeline & Check dan hubungkan segmen ke sana.",
    });
  }

  if (!exportNode) {
    warnings.push({
      id: "warn_no_export",
      severity: "warn",
      code: "NO_EXPORT",
      message: "Belum ada node Render & CapCut di ujung alur.",
      action: "Tambahkan node Render & CapCut lalu hubungkan dari Timeline.",
    });
  } else if (assembly && !project.edges.some((e) => e.source === assembly.id && e.target === exportNode.id)) {
    warnings.push({
      id: "warn_unwired_export",
      severity: "warn",
      nodeId: exportNode.id,
      nodeTitle: exportNode.title,
      code: "EXPORT_UNWIRED",
      message: "Node Timeline belum tersambung kabel ke node Render & CapCut.",
      action: "Tarik kabel dari port kanan Timeline ke port kiri Render & CapCut.",
    });
  }

  const orderedSegments = getOrderedSegments(project);
  if (assembly && allSegments.length > 0) {
    const wiredIds = new Set(
      project.edges.filter((e) => e.target === assembly.id).map((e) => e.source),
    );
    const unwired = allSegments.filter((s) => !wiredIds.has(s.id));
    if (wiredIds.size === 0) {
      errors.push({
        id: "err_segments_unwired",
        severity: "error",
        nodeId: assembly.id,
        nodeTitle: assembly.title,
        code: "SEGMENTS_UNWIRED",
        message: "Belum ada node Segmen yang tersambung kabel ke node Timeline.",
        action: "Hubungkan port kanan setiap Segmen ke port kiri Timeline.",
      });
    } else {
      for (const s of unwired) {
        warnings.push({
          id: `warn_orphan_${s.id}`,
          severity: "warn",
          nodeId: s.id,
          nodeTitle: s.title,
          code: "SEGMENT_NOT_IN_TIMELINE",
          message: `${s.title} belum tersambung ke Timeline sehingga tidak ikut dirender.`,
          action: "Sambungkan kabelnya ke Timeline atau hapus jika tidak dipakai.",
        });
      }
    }
  }

  let missingAssetImages = 0;
  for (const node of project.nodes) {
    if (node.data.kind !== "asset") continue;
    if (!node.data.lockPrompt.trim()) {
      warnings.push({
        id: `warn_asset_lock_${node.id}`,
        severity: "warn",
        nodeId: node.id,
        nodeTitle: node.title,
        code: "EMPTY_LOCK_PROMPT",
        message: `${node.data.tag || node.title} belum memiliki teks Continuity Lock.`,
        action: "Isi deskripsi fisik/lokasi tetap agar konsisten di semua segmen.",
      });
    }
    if (!node.data.imageDataUrl) {
      missingAssetImages += 1;
      warnings.push({
        id: `warn_asset_img_${node.id}`,
        severity: "warn",
        nodeId: node.id,
        nodeTitle: node.title,
        code: "MISSING_ASSET_IMAGE",
        message: `${node.data.tag || node.title} belum memiliki gambar referensi.`,
        action: "Unggah gambar referensi atau generate lembar aset dari Inspector.",
      });
    }
  }

  let totalDurationSec = 0;
  let missingSegmentMedia = 0;

  orderedSegments.forEach((node, idx) => {
    const seg = node.data as SegmentNodeData;
    totalDurationSec += Math.max(0, seg.durationSec || 0);

    if (!Number.isFinite(seg.durationSec) || seg.durationSec < 1) {
      errors.push({
        id: `err_dur_min_${node.id}`,
        severity: "error",
        nodeId: node.id,
        nodeTitle: node.title,
        code: "INVALID_DURATION",
        message: `${node.title} memiliki durasi tidak valid (${seg.durationSec} dtk).`,
        action: "Atur durasi minimal 1 detik.",
      });
    } else if (seg.durationSec > maxSegSec) {
      warnings.push({
        id: `warn_dur_max_${node.id}`,
        severity: "warn",
        nodeId: node.id,
        nodeTitle: node.title,
        code: "EXCEEDS_SEGMENT_CAP",
        message: `${node.title} berdurasi ${seg.durationSec} dtk, melebihi batas ${maxSegSec} dtk per segmen.`,
        action: "Pecah menjadi dua segmen agar stabil saat generate video AI.",
      });
    }

    const spokenEst = estimateDialogueSeconds(seg.dialogue);
    if (spokenEst > seg.durationSec) {
      warnings.push({
        id: `warn_dialogue_fit_${node.id}`,
        severity: "warn",
        nodeId: node.id,
        nodeTitle: node.title,
        code: "DIALOGUE_TOO_LONG",
        message: `Estimasi waktu bicara (${spokenEst} dtk) melebihi durasi ${node.title} (${seg.durationSec} dtk).`,
        action: "Tambahkan durasi segmen atau pecah dialog ke segmen berikutnya.",
      });
    }

    const boundAssets = getBoundAssets(project, node.id);
    if (boundAssets.length === 0) {
      warnings.push({
        id: `warn_no_bound_assets_${node.id}`,
        severity: "warn",
        nodeId: node.id,
        nodeTitle: node.title,
        code: "NO_ASSET_REFERENCE",
        message: `${node.title} tidak terhubung ke node Aset mana pun.`,
        action: "Hubungkan kabel dari Aset karakter/lokasi ke segmen ini untuk menjaga konsistensi.",
      });
    }

    if (!getAdoptedMedia(seg)) {
      missingSegmentMedia += 1;
      warnings.push({
        id: `warn_no_media_${node.id}`,
        severity: "warn",
        nodeId: node.id,
        nodeTitle: node.title,
        code: "MISSING_SEGMENT_MEDIA",
        message: `${node.title} belum punya gambar/klip video yang diadopsi.`,
        action: "Generate keyframe lewat AI atau unggah gambar/klip lokal di Inspector.",
      });
    }

    if (idx > 0) {
      const prev = orderedSegments[idx - 1].data as SegmentNodeData;
      if (prev.shotSize === seg.shotSize && prev.cameraAngle === seg.cameraAngle) {
        warnings.push({
          id: `warn_jumpcut_${node.id}`,
          severity: "warn",
          nodeId: node.id,
          nodeTitle: node.title,
          code: "SAME_FRAMING_TRANSITION",
          message: `${node.title} memakai shot (${seg.shotSize}) dan sudut (${seg.cameraAngle}) sama persis dengan segmen sebelumnya.`,
          action: "Ubah ukuran shot atau sudut kamera agar sambungan antar-segmen terasa mulus.",
        });
      }
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    orderedSegmentIds: orderedSegments.map((n) => n.id),
    totalDurationSec: Math.round(totalDurationSec * 10) / 10,
    missingAssetImages,
    missingSegmentMedia,
  };
}

export function formatSrtTime(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function formatAssTime(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const cs = Math.min(99, Math.round((safe - Math.floor(safe)) * 100));
  return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function buildSrt(project: NmcProject): string {
  const segs = getOrderedSegments(project);
  let cursor = 0;
  const blocks: string[] = [];
  let idx = 1;
  for (const node of segs) {
    const seg = node.data as SegmentNodeData;
    const dur = Math.max(1, seg.durationSec || 1);
    const text = seg.dialogue.trim();
    if (text) {
      const start = cursor + Math.min(0.4, dur * 0.1);
      const end = Math.max(start + 0.8, cursor + dur - Math.min(0.4, dur * 0.1));
      blocks.push(`${idx}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${text}\n`);
      idx += 1;
    }
    cursor += dur;
  }
  return blocks.join("\n");
}

export function buildAss(project: NmcProject, aspect?: AspectRatio): string {
  const script = getPrimaryScript(project);
  const ratio = aspect ?? script?.aspectRatio ?? "16:9";
  const { width, height } = resolutionFor(ratio);
  const fontSize = ratio === "9:16" ? 54 : 34;
  const marginV = ratio === "9:16" ? 160 : 44;

  const lines = [
    "[Script Info]",
    `Title: ${project.name.replace(/[\r\n]/g, " ")}`,
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00121212,&H80000000,0,0,0,0,100,100,0.4,0,1,2.2,1,2,48,48,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const segs = getOrderedSegments(project);
  let cursor = 0;
  for (const node of segs) {
    const seg = node.data as SegmentNodeData;
    const dur = Math.max(1, seg.durationSec || 1);
    const text = seg.dialogue.trim().replace(/\r?\n/g, "\\N");
    if (text) {
      const start = cursor + Math.min(0.4, dur * 0.1);
      const end = Math.max(start + 0.8, cursor + dur - Math.min(0.4, dur * 0.1));
      lines.push(`Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${text}`);
    }
    cursor += dur;
  }
  return lines.join("\n") + "\n";
}

export function autoArrangeNodes(project: NmcProject): CanvasNode[] {
  // Deterministic left-to-right column layout grouped by pipeline stage.
  const colX: Record<string, number> = {
    script: 32,
    asset: 380,
    segment: 750,
    audio: 750,
    assembly: 1130,
    export: 1470,
  };
  const colY: Record<string, number> = {
    script: 120,
    asset: 36,
    segment: 36,
    assembly: 140,
    export: 140,
  };
  const stepY: Record<string, number> = {
    script: 260,
    asset: 196,
    segment: 248,
    audio: 184,
    assembly: 220,
    export: 220,
  };

  // Place segments first in column 3, then audio below segments.
  const sorted = [...project.nodes].sort((a, b) => {
    if (a.kind === "segment" && b.kind === "audio") return -1;
    if (a.kind === "audio" && b.kind === "segment") return 1;
    return a.y - b.y || a.x - b.x;
  });

  const nextPos = new Map<string, { x: number; y: number }>();
  for (const node of sorted) {
    const bucket = node.kind === "audio" ? "segment" : node.kind;
    const x = colX[node.kind];
    const y = colY[bucket];
    nextPos.set(node.id, { x, y });
    colY[bucket] = y + stepY[node.kind];
  }

  return project.nodes.map((n) => {
    const pos = nextPos.get(n.id);
    return pos ? { ...n, x: pos.x, y: pos.y } : n;
  });
}
