import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RuntimeStatus } from "./types";
import { getCloudflareAiBinding, getCloudflareEnvVar } from "./cfEnv";
import { getServerSupabaseConfigAsync } from "./supabaseSync";

const execFileAsync = promisify(execFile);

export function isCloudflareWorkers(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.userAgent === "string" &&
    navigator.userAgent === "Cloudflare-Workers"
  );
}

export function isServerlessRuntime(): boolean {
  return Boolean(
    isCloudflareWorkers() ||
      process?.env?.VERCEL ||
      process?.env?.AWS_LAMBDA_FUNCTION_NAME ||
      process?.env?.CF_PAGES ||
      process?.env?.CLOUDFLARE_WORKERS,
  );
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

export async function findChromeBin(): Promise<string | null> {
  if (isServerlessRuntime()) return null;
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch {
      // try next
    }
  }
  return null;
}

export async function detectRuntime(): Promise<RuntimeStatus> {
  const isServerless = isServerlessRuntime();
  const [ff, fp, pyBin, chromeBin] = isServerless
    ? [{ ok: false, stdout: "" }, { ok: false, stdout: "" }, null, null]
    : await Promise.all([
        probeCmd("ffmpeg", ["-version"]),
        probeCmd("ffprobe", ["-version"]),
        findPythonBin(),
        findChromeBin(),
      ]);

  let localPyCapCut = false;
  if (pyBin && !isServerless) {
    const mod = await probeCmd(pyBin, ["-c", "import pycapcut; print('ok')"]);
    localPyCapCut = mod.ok;
  }

  const [
    workersAiBinding,
    supabaseCfg,
    cfAccountId,
    cfApiToken,
    geminiKey,
    geminiImgKey,
    openAiKey,
  ] = await Promise.all([
    getCloudflareAiBinding().then(Boolean),
    getServerSupabaseConfigAsync(),
    getCloudflareEnvVar("CLOUDFLARE_ACCOUNT_ID"),
    getCloudflareEnvVar("CLOUDFLARE_API_TOKEN"),
    getCloudflareEnvVar("GEMINI_API_KEY"),
    getCloudflareEnvVar("GEMINI_IMAGE_API_KEY"),
    getCloudflareEnvVar("OPENAI_API_KEY"),
  ]);

  return {
    mode: !isServerless && ff.ok && Boolean(pyBin) ? "local-hybrid" : "web-serverless",
    isServerless,
    localFfmpeg: ff.ok,
    localFfprobe: fp.ok,
    localPython: Boolean(pyBin),
    localPyCapCut,
    localChrome: Boolean(chromeBin),
    ffmpegVersion: ff.ok ? ff.stdout.split(/\r?\n/)[0]?.slice(0, 80) : undefined,
    defaultCapCutDir: isServerless ? undefined : defaultCapCutDraftsDir(),
    supabaseConnected: Boolean(supabaseCfg),
    workersAiBinding,
    serverKeys: {
      cloudflareAi: workersAiBinding || Boolean(cfAccountId && cfApiToken),
      gemini: Boolean(geminiKey),
      geminiImage: Boolean(geminiImgKey || geminiKey),
      openai: Boolean(openAiKey),
    },
  };
}

export async function readBundledScripts(): Promise<{ renderPy: string; capcutPy: string; motionCdpPy: string }> {
  if (isServerlessRuntime()) {
    return { renderPy: "", capcutPy: "", motionCdpPy: "" };
  }
  try {
    const scriptsDir = path.resolve(process.cwd(), "public", "scripts");
    const [renderPy, capcutPy, motionCdpPy] = await Promise.all([
      readFile(path.join(scriptsDir, "render_ffmpeg.py"), "utf-8"),
      readFile(path.join(scriptsDir, "build_capcut_draft.py"), "utf-8"),
      readFile(path.join(scriptsDir, "render_motion_cdp.py"), "utf-8").catch(() => ""),
    ]);
    return { renderPy, capcutPy, motionCdpPy };
  } catch {
    return { renderPy: "", capcutPy: "", motionCdpPy: "" };
  }
}

