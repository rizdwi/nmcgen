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
import { createDefaultNode, resolutionFor } from "./presets.ts";

export function getPrimaryScript(project: NmcProject): ScriptNodeData | null {
  const n = project.nodes.find((node) => node.kind === "script");
  return n && n.data.kind === "script" ? n.data : null;
}

export function getProjectCover(project: NmcProject): string | null {
  for (const segNode of getOrderedSegments(project)) {
    if (segNode.data.kind !== "segment") continue;
    const adopted = getAdoptedMedia(segNode.data);
    if (adopted && adopted.kind === "image" && adopted.dataUrl) {
      return adopted.dataUrl;
    }
  }
  for (const node of project.nodes) {
    if (node.data.kind === "asset" && node.data.imageDataUrl) {
      return node.data.imageDataUrl;
    }
  }
  return null;
}

export function updateProjectMeta(
  project: NmcProject,
  patch: {
    name: string;
    premise?: string;
    aspectRatio?: AspectRatio;
    visualStyle?: string;
    maxSegmentSec?: number;
  },
): NmcProject {
  const cleanName = patch.name.trim() || project.name || "Proyek Baru";
  const hasScript = project.nodes.some((n) => n.kind === "script");
  let nextNodes = project.nodes;

  if (hasScript) {
    let updatedFirst = false;
    nextNodes = project.nodes.map((node) => {
      if (!updatedFirst && node.kind === "script" && node.data.kind === "script") {
        updatedFirst = true;
        return {
          ...node,
          data: {
            ...node.data,
            premise: patch.premise !== undefined ? patch.premise : node.data.premise,
            aspectRatio: patch.aspectRatio ?? node.data.aspectRatio,
            visualStyle: patch.visualStyle !== undefined ? patch.visualStyle : node.data.visualStyle,
            maxSegmentSec: patch.maxSegmentSec ?? node.data.maxSegmentSec,
          },
        };
      }
      if (node.kind === "export" && node.data.kind === "export" && patch.maxSegmentSec === 8) {
        return {
          ...node,
          data: { ...node.data, platform: "google-flow" },
        };
      }
      return node;
    });
  } else if (patch.premise?.trim() || patch.visualStyle?.trim() || patch.aspectRatio || patch.maxSegmentSec) {
    const created = createDefaultNode("script", 40, 80, 1);
    if (created.data.kind === "script") {
      created.data = {
        ...created.data,
        premise: patch.premise ?? "",
        aspectRatio: patch.aspectRatio ?? "16:9",
        visualStyle: patch.visualStyle ?? created.data.visualStyle,
        maxSegmentSec: patch.maxSegmentSec ?? created.data.maxSegmentSec,
      };
    }
    nextNodes = [created, ...project.nodes];
  }

  return {
    ...project,
    name: cleanName,
    updatedAt: Date.now(),
    nodes: nextNodes,
  };
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
  const stageTag = seg.storyStage ? ` [${seg.storyStage}]` : "";
  lines.push(
    `Segment ${seg.code}${stageTag} (${seg.durationSec}s, ${script?.aspectRatio ?? "16:9"}), framing ${seg.shotSize}, angle ${seg.cameraAngle}, camera ${seg.cameraMotion}.`,
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

function isInteriorLocationConflict(sceneText: string, locationLock: string): boolean {
  const lowScene = sceneText.toLowerCase();
  const lowLoc = locationLock.toLowerCase();
  const sceneIsExt =
    /\bext\.|exterior|outdoor|outside|street|trotoar|jalanan|pelataran|halaman|alun-alun|sunrise|fajar|gerbang luar|depan gerbang/i.test(
      lowScene,
    ) && !/\bint\.|inside|interior|di dalam|dalam gudang|lorong masuk/i.test(lowScene);
  const locIsInt = /\binterior\b|inside|di dalam|ruang dalam|wooden crates|indoor/i.test(lowLoc);
  return sceneIsExt && locIsInt;
}

export function selectSegmentReferenceAssets(project: NmcProject, segmentNode: CanvasNode): CanvasNode[] {
  if (segmentNode.data.kind !== "segment") return [];
  const seg = segmentNode.data;
  const boundAssets = getBoundAssets(project, segmentNode.id);
  const isTightShot = seg.shotSize === "CU" || seg.shotSize === "ECU" || seg.shotSize === "MCU";
  const sceneText = `${seg.timelineText} ${seg.visualPrompt || ""}`;

  const prioritized = [...boundAssets].sort((a, b) => {
    const catA = (a.data as AssetNodeData).category;
    const catB = (b.data as AssetNodeData).category;
    const rank = (c: AssetNodeData["category"]) => (c === "character" ? 0 : c === "prop" ? 1 : 2);
    return rank(catA) - rank(catB);
  });

  const filtered = prioritized.filter((a) => {
    const d = a.data as AssetNodeData;
    if (!d.imageDataUrl) return false;
    if (d.category === "location") {
      if (isTightShot) return false;
      if (isInteriorLocationConflict(sceneText, d.lockPrompt || a.title)) return false;
    }
    return true;
  });

  // Cap to 2 primary refs so FLUX.2 stays fast, faithful to faces/outfits, and free to compose new camera angles.
  return filtered.slice(0, 2);
}

export function selectSegmentReferenceImages(project: NmcProject, segmentNode: CanvasNode): string[] {
  return selectSegmentReferenceAssets(project, segmentNode).map(
    (a) => (a.data as AssetNodeData).imageDataUrl as string,
  );
}

function resolveTagsForImagePrompt(text: string, assets: CanvasNode[]): string {
  let out = text;
  for (const a of assets) {
    if (a.data.kind !== "asset") continue;
    const d = a.data as AssetNodeData;
    const cleanName = a.title.split("(")[0].trim() || d.tag.replace(/^@/, "");
    const escaped = d.tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), cleanName);
  }
  return out.replace(/@([A-Za-z0-9_]+)/g, "$1");
}

// Pure visual prompt for still-image models: resolves @Tags, excludes dialogue/timecodes, maps reference images explicitly.
export function composeSegmentImagePrompt(project: NmcProject, segmentNode: CanvasNode): string {
  if (segmentNode.data.kind !== "segment") return "";
  const seg = segmentNode.data;
  const script = getPrimaryScript(project);
  const allAssets = project.nodes.filter((n) => n.kind === "asset");
  const boundAssets = getBoundAssets(project, segmentNode.id);
  const refAssets = selectSegmentReferenceAssets(project, segmentNode);

  const rawAction = (seg.visualPrompt?.trim() || seg.timelineText)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[[^\]]+\]\s*/, "").trim())
    .filter(Boolean)
    .join(" ");
  const actionText = resolveTagsForImagePrompt(rawAction, allAssets);

  const parts: string[] = [
    `Single full-bleed cinematic movie frame, ${FLOW_SHOT_LABELS[seg.shotSize]}, ${FLOW_ANGLE_LABELS[seg.cameraAngle]}.`,
  ];
  if (actionText) parts.push(`${actionText}.`);
  if (script?.visualStyle) parts.push(`Visual style: ${script.visualStyle}.`);

  if (refAssets.length > 0) {
    const refMap = refAssets
      .map((a, idx) => {
        const d = a.data as AssetNodeData;
        const name = a.title.split("(")[0].trim() || d.tag.replace(/^@/, "");
        return `Reference image ${idx + 1} is ${name} (${d.lockPrompt || a.title})`;
      })
      .join(". ");
    parts.push(`${refMap}. Keep exact face, age, hair, and clothing from the reference images while placing them naturally inside this new scene and camera angle.`);
  } else if (boundAssets.length > 0) {
    const desc = boundAssets
      .map((a) => {
        const d = a.data as AssetNodeData;
        const name = a.title.split("(")[0].trim() || d.tag.replace(/^@/, "");
        return `${name}: ${d.lockPrompt || a.title}`;
      })
      .join("; ");
    parts.push(`Subjects: ${desc}.`);
  }

  if (seg.continuityLock.trim()) {
    parts.push(`Continuity: ${resolveTagsForImagePrompt(seg.continuityLock.trim(), allAssets)}.`);
  }
  parts.push("Photorealistic single film still, no text, no subtitles, no split panels, no watermark.");
  return parts.join(" ");
}

const FLOW_SHOT_LABELS: Record<SegmentNodeData["shotSize"], string> = {
  WS: "Wide establishing shot",
  MS: "Medium shot",
  MCU: "Medium close-up",
  CU: "Close-up",
  ECU: "Extreme close-up",
};

const FLOW_ANGLE_LABELS: Record<SegmentNodeData["cameraAngle"], string> = {
  Front: "eye-level frontal angle",
  "Side 90": "90-degree side profile angle",
  "Rear 3/4": "rear three-quarter over-the-shoulder angle",
  High: "high-angle perspective looking slightly down",
  Low: "low-angle perspective looking slightly up",
};

const FLOW_MOTION_LABELS: Record<SegmentNodeData["cameraMotion"], string> = {
  Static: "locked tripod camera, subtle natural subject motion",
  "Push-In": "smooth slow dolly push-in",
  "Pull-Out": "smooth slow dolly pull-out",
  "Pan Right": "steady smooth pan right",
  "Pan Left": "steady smooth pan left",
};

export function composeGoogleFlowPrompt(project: NmcProject, segmentNode: CanvasNode): string {
  if (segmentNode.data.kind !== "segment") return "";
  const seg = segmentNode.data;
  const script = getPrimaryScript(project);
  const boundAssets = getBoundAssets(project, segmentNode.id);
  const adopted = getAdoptedMedia(seg);
  const mode =
    adopted?.kind === "image"
      ? "Frames-to-Video (gunakan gambar frame teradopsi sebagai First Frame)"
      : boundAssets.length > 0
        ? "Ingredients-to-Video (unggah gambar aset terikat ke Ingredients)"
        : "Text-to-Video";

  const actionLine = seg.timelineText
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[[^\]]+\]\s*/, "").trim())
    .filter(Boolean)
    .join(" ");

  const parts: string[] = [
    `[Google Flow | ${seg.code} | ${script?.aspectRatio ?? "16:9"} | ${seg.durationSec}s${seg.durationSec > 8 ? " -> potong 8s lalu Extend di Scenebuilder" : ""}]`,
    `Mode Flow: ${mode}`,
  ];

  if (boundAssets.length > 0) {
    const tags = boundAssets.map((a) => (a.data as AssetNodeData).tag).join(", ");
    parts.push(`Ingredients: ${tags}`);
  }

  const promptSegments: string[] = [
    `${FLOW_SHOT_LABELS[seg.shotSize]}, ${FLOW_ANGLE_LABELS[seg.cameraAngle]}, ${FLOW_MOTION_LABELS[seg.cameraMotion]}.`,
  ];
  if (script?.visualStyle) promptSegments.push(`Style: ${script.visualStyle}.`);
  if (boundAssets.length > 0) {
    const locks = boundAssets
      .map((a) => {
        const d = a.data as AssetNodeData;
        return `${d.tag}: ${d.lockPrompt || a.title}`;
      })
      .join("; ");
    promptSegments.push(`Subjects & setting: ${locks}.`);
  }
  if (seg.continuityLock.trim()) promptSegments.push(`Continuity: ${seg.continuityLock.trim()}.`);
  if (actionLine) promptSegments.push(`Action: ${actionLine}`);
  if (seg.dialogue.trim()) {
    promptSegments.push(`Spoken Indonesian dialogue with synchronized lip motion: "${seg.dialogue.trim()}".`);
  }
  promptSegments.push("Clean cinematic frame, no on-screen subtitles, no watermarks.");

  parts.push(`Prompt Veo / Flow:\n${promptSegments.join(" ")}`);
  return parts.join("\n");
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
