import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AssemblyNodeData, AudioNodeData, NmcProject, RuntimeStatus, SegmentNodeData } from "./types";
import { resolutionFor } from "./presets";
import {
  buildAss,
  buildSrt,
  getAdoptedMedia,
  getConnectedAudio,
  getOrderedSegments,
  getPrimaryScript,
} from "./validator";

const execFileAsync = promisify(execFile);

export const WORK_ROOT = path.resolve(process.cwd(), ".nmcgen-work");

export function isValidJobId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}

async function probeCmd(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 4000 });
    return { ok: true, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

export async function findPythonBin(): Promise<string | null> {
  const candidates = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
  for (const bin of candidates) {
    const res = await probeCmd(bin, ["--version"]);
    if (res.ok) return bin;
  }
  return null;
}

export function defaultCapCutDraftsDir(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "CapCut", "User Data", "Projects", "com.lveditor.draft");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Movies", "CapCut", "User Data", "Projects", "com.lveditor.draft");
  }
  return path.join(os.homedir(), "CapCutDrafts");
}

export async function detectRuntime(): Promise<RuntimeStatus> {
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const [ff, fp, pyBin] = isServerless
    ? [{ ok: false, stdout: "" }, { ok: false, stdout: "" }, null]
    : await Promise.all([
        probeCmd("ffmpeg", ["-version"]),
        probeCmd("ffprobe", ["-version"]),
        findPythonBin(),
      ]);

  let localPyCapCut = false;
  if (pyBin && !isServerless) {
    const mod = await probeCmd(pyBin, ["-c", "import pycapcut; print('ok')"]);
    localPyCapCut = mod.ok;
  }

  return {
    mode: !isServerless && ff.ok && Boolean(pyBin) ? "local-hybrid" : "web-serverless",
    isServerless,
    localFfmpeg: ff.ok,
    localFfprobe: fp.ok,
    localPython: Boolean(pyBin),
    localPyCapCut,
    ffmpegVersion: ff.ok ? ff.stdout.split(/\r?\n/)[0]?.slice(0, 80) : undefined,
    defaultCapCutDir: isServerless ? undefined : defaultCapCutDraftsDir(),
    serverKeys: {
      gemini: Boolean(process.env.GEMINI_API_KEY),
      geminiImage: Boolean(process.env.GEMINI_IMAGE_API_KEY || process.env.GEMINI_API_KEY),
      openai: Boolean(process.env.OPENAI_API_KEY),
    },
  };
}

export async function readBundledScripts(): Promise<{ renderPy: string; capcutPy: string }> {
  const scriptsDir = path.resolve(process.cwd(), "scripts");
  const [renderPy, capcutPy] = await Promise.all([
    readFile(path.join(scriptsDir, "render_ffmpeg.py"), "utf-8"),
    readFile(path.join(scriptsDir, "build_capcut_draft.py"), "utf-8"),
  ]);
  return { renderPy, capcutPy };
}

function decodeDataUrlToBuffer(dataUrl: string): { ext: string; buf: Buffer } | null {
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
  return { ext, buf: Buffer.from(m[2], "base64") };
}

export async function stageProjectWorkspace(project: NmcProject): Promise<{
  jobId: string;
  jobDir: string;
  manifestPath: string;
}> {
  const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const jobDir = path.join(WORK_ROOT, jobId);
  const mediaDir = path.join(jobDir, "media");
  await mkdir(mediaDir, { recursive: true });

  const script = getPrimaryScript(project);
  const ratio = script?.aspectRatio ?? "16:9";
  const { width, height } = resolutionFor(ratio);
  const asmNode = project.nodes.find((n) => n.kind === "assembly");
  const asm = asmNode?.data.kind === "assembly" ? (asmNode.data as AssemblyNodeData) : null;
  const segs = getOrderedSegments(project);
  const audios = getConnectedAudio(project);

  const manifestSegments: Record<string, unknown>[] = [];
  for (let i = 0; i < segs.length; i++) {
    const node = segs[i];
    const seg = node.data as SegmentNodeData;
    const adopted = getAdoptedMedia(seg);
    let relPath = "";
    let kind: "image" | "video" | "slate" = "slate";
    if (adopted) {
      const decoded = decodeDataUrlToBuffer(adopted.dataUrl);
      if (decoded) {
        relPath = `media/seg_${String(i + 1).padStart(2, "0")}.${decoded.ext}`;
        kind = adopted.kind;
        await writeFile(path.join(jobDir, relPath), decoded.buf);
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
  }

  const manifestAudio: Record<string, unknown>[] = [];
  for (let i = 0; i < audios.length; i++) {
    const aud = audios[i].data as AudioNodeData;
    if (aud.sourceMode === "ambient-rain") {
      manifestAudio.push({ mode: "ambient-rain", volume: aud.volume, start_sec: aud.startSec });
    } else if (aud.audioDataUrl) {
      const decoded = decodeDataUrlToBuffer(aud.audioDataUrl);
      if (decoded) {
        const relPath = `media/audio_${i + 1}.${decoded.ext}`;
        await writeFile(path.join(jobDir, relPath), decoded.buf);
        manifestAudio.push({ mode: "file", path: relPath, volume: aud.volume, start_sec: aud.startSec });
      }
    }
  }

  const srt = buildSrt(project);
  const ass = buildAss(project, ratio);
  await Promise.all([
    writeFile(path.join(jobDir, "captions.srt"), srt, "utf-8"),
    writeFile(path.join(jobDir, "subtitles.ass"), ass, "utf-8"),
  ]);

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

  const manifestPath = path.join(jobDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  return { jobId, jobDir, manifestPath };
}
