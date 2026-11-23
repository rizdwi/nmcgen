// Builds an offline Hybrid ZIP bundle (project.json, naskah.md, manifest.json, SRT/ASS, media, and Python scripts).
import type { AssemblyNodeData, AssetNodeData, AudioNodeData, NmcProject, SegmentNodeData } from "./types.ts";
import { resolutionFor } from "./presets.ts";
import {
  buildAss,
  buildSrt,
  composeSegmentPrompt,
  getAdoptedMedia,
  getConnectedAudio,
  getOrderedSegments,
  getPrimaryScript,
} from "./validator.ts";
import { buildZip, type ZipEntryInput } from "./zip.ts";

function decodeDataUrl(dataUrl: string): { ext: string; bytes: Uint8Array } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext =
    mime.includes("jpeg") || mime.includes("jpg")
      ? "jpg"
      : mime.includes("webp")
        ? "webp"
        : mime.includes("mp4")
          ? "mp4"
          : mime.includes("webm")
            ? "webm"
            : mime.includes("mpeg") || mime.includes("mp3")
              ? "mp3"
              : mime.includes("wav")
                ? "wav"
                : "png";
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { ext, bytes };
}

export function buildMarkdownSpec(project: NmcProject): string {
  const script = getPrimaryScript(project);
  const assets = project.nodes.filter((n) => n.kind === "asset");
  const segs = getOrderedSegments(project);

  const lines: string[] = [
    `# ${project.name}`,
    "",
    `- Rasio: ${script?.aspectRatio ?? "16:9"}`,
    `- Batas segmen: ${script?.maxSegmentSec ?? 15} detik`,
    `- Gaya visual: ${script?.visualStyle ?? "-"}`,
    "",
    "## 1. Naskah & Premis",
    script?.premise || "(Belum diisi)",
    "",
    script?.scriptText || "",
    "",
    "## 2. Aset & Continuity Lock",
  ];

  for (const a of assets) {
    const d = a.data as AssetNodeData;
    lines.push(`- **${d.tag}** (${d.category}): ${d.lockPrompt || "-"}`);
  }

  lines.push("", "## 3. Segmen & Prompt Produksi");
  for (const s of segs) {
    lines.push("", `### ${s.title}`, "```text", composeSegmentPrompt(project, s), "```");
  }

  return lines.join("\n") + "\n";
}

const OFFLINE_FFMPEG_BAT = `@echo off
echo === nmcGen Offline FFmpeg Renderer ===
where python >nul 2>nul || (echo Python 3.10+ tidak ditemukan di PATH. & pause & exit /b 1)
where ffmpeg >nul 2>nul || (echo FFmpeg tidak ditemukan di PATH. & pause & exit /b 1)
python render_ffmpeg.py --manifest manifest.json --out output_final.mp4
echo.
pause
`;

const OFFLINE_CAPCUT_BAT = `@echo off
echo === nmcGen Offline CapCut Draft Builder (pyCapCut) ===
set "DRAFTS=%LOCALAPPDATA%\\CapCut\\User Data\\Projects\\com.lveditor.draft"
python -c "import pycapcut" 2>nul || (
  echo Memasang pycapcut==0.0.4...
  pip install pycapcut==0.0.4
)
python build_capcut_draft.py --manifest manifest.json --drafts-dir "%DRAFTS%" --name "nmcGen_Draft"
echo.
echo Buka CapCut Desktop untuk melihat draft dan klik Export.
pause
`;

export function buildOfflineBundleZip(
  project: NmcProject,
  renderPySource: string,
  capcutPySource: string,
): Uint8Array {
  const script = getPrimaryScript(project);
  const ratio = script?.aspectRatio ?? "16:9";
  const { width, height } = resolutionFor(ratio);
  const asmNode = project.nodes.find((n) => n.kind === "assembly");
  const asm = asmNode?.data.kind === "assembly" ? (asmNode.data as AssemblyNodeData) : null;
  const segs = getOrderedSegments(project);
  const audios = getConnectedAudio(project);

  const entries: ZipEntryInput[] = [];
  const manifestSegments: Record<string, unknown>[] = [];
  const manifestAudio: Record<string, unknown>[] = [];

  segs.forEach((node, idx) => {
    const seg = node.data as SegmentNodeData;
    const adopted = getAdoptedMedia(seg);
    let relPath = "";
    let kind: "image" | "video" | "slate" = "slate";
    if (adopted) {
      const decoded = decodeDataUrl(adopted.dataUrl);
      if (decoded) {
        relPath = `media/seg_${String(idx + 1).padStart(2, "0")}.${decoded.ext}`;
        kind = adopted.kind;
        entries.push({ name: relPath, data: decoded.bytes });
      }
    }
    manifestSegments.push({
      code: seg.code,
      title: node.title,
      duration_sec: seg.durationSec,
      shot_size: seg.shotSize,
      camera_angle: seg.cameraAngle,
      motion: seg.cameraMotion,
      dialogue: seg.dialogue,
      kind,
      path: relPath,
    });
  });

  audios.forEach((node, idx) => {
    const aud = node.data as AudioNodeData;
    if (aud.sourceMode === "ambient-rain") {
      manifestAudio.push({ mode: "ambient-rain", volume: aud.volume, start_sec: aud.startSec });
    } else if (aud.audioDataUrl) {
      const decoded = decodeDataUrl(aud.audioDataUrl);
      if (decoded) {
        const relPath = `media/audio_${idx + 1}.${decoded.ext}`;
        entries.push({ name: relPath, data: decoded.bytes });
        manifestAudio.push({ mode: "file", path: relPath, volume: aud.volume, start_sec: aud.startSec });
      }
    }
  });

  const srt = buildSrt(project);
  const ass = buildAss(project, ratio);
  const manifest = {
    project_name: project.name,
    width,
    height,
    fps: asm?.fps ?? 24,
    target_lufs: asm?.targetLufs ?? -14,
    burn_subtitles: asm?.burnSubtitles ?? true,
    fade_out_sec: asm?.fadeOutSec ?? 0.8,
    srt_file: "captions.srt",
    ass_file: "subtitles.ass",
    segments: manifestSegments,
    audio_tracks: manifestAudio,
  };

  const readme = [
    `nmcGen Offline Production Bundle: ${project.name}`,
    "",
    "1. Render MP4 otomatis (FFmpeg):",
    "   Jalankan run_ffmpeg.bat (Windows) atau:",
    "   python render_ffmpeg.py --manifest manifest.json --out output_final.mp4",
    "",
    "2. Buat Draft CapCut otomatis (pyCapCut):",
    "   Jalankan run_capcut.bat (Windows) atau:",
    '   python build_capcut_draft.py --manifest manifest.json --drafts-dir "<CapCut Drafts>" --name "nmcGen_Draft"',
    "   Setelah selesai, buka CapCut Desktop dan klik Export secara manual.",
  ].join("\n");

  entries.push(
    { name: "project.json", data: JSON.stringify(project, null, 2) },
    { name: "naskah.md", data: buildMarkdownSpec(project) },
    { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
    { name: "captions.srt", data: srt },
    { name: "subtitles.ass", data: ass },
    { name: "render_ffmpeg.py", data: renderPySource },
    { name: "build_capcut_draft.py", data: capcutPySource },
    { name: "run_ffmpeg.bat", data: OFFLINE_FFMPEG_BAT },
    { name: "run_capcut.bat", data: OFFLINE_CAPCUT_BAT },
    { name: "README.txt", data: readme },
  );

  return buildZip(entries);
}
