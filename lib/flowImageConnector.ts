// Flow Connector image generation automation for Step 2 (Assets) & Step 3 (Storyboard Panels)
// Uses Google Flow's 0-credit Nano Banana 2 Lite (`nano-banana-2-lite`, up to 400 free images/day on Flow)
// via `flow-connector-cli` (`flow-auto`) to bypass Cloudflare Workers AI & AI Studio API image quotas.
import type { StoryAsset, StoryboardData, StoryFrame } from "./types.ts";
import {
  ASSET_CATEGORY_LABEL,
  assetAspectFor,
  buildAssetImagePrompt,
  CAMERA_ANGLE_META,
  getSelectedAssetImage,
  getSelectedFrameImage,
  getStoryboardSegments,
  reindexStoryboardFrames,
  SHOT_SIZE_META,
} from "./storyboard.ts";
import {
  ANIMATION_APP_LINKS,
  parseDataUrlBase64,
} from "./omniAnimation.ts";
import { buildZip, type ZipEntryInput } from "./zip.ts";

export type FlowConnectorImageModel = "nano-banana-2-lite" | "nano-banana-2" | "nano-banana-pro";

export const FLOW_IMAGE_MODELS: Array<{
  value: FlowConnectorImageModel;
  label: string;
  hint: string;
}> = [
  {
    value: "nano-banana-2-lite",
    label: "Nano Banana 2 Lite (0 Kredit · Cepat · 400/Hari)",
    hint: "Default hemat kuota di Google Flow (0 kredit Flow, hingga 400 gambar/hari gratis)",
  },
  {
    value: "nano-banana-2",
    label: "Nano Banana 2 / 2.1 (0 Kredit · Lebih Detail)",
    hint: "Konsistensi karakter & detail lebih tajam (berbagi kuota 400 gambar/hari gratis di Flow)",
  },
  {
    value: "nano-banana-pro",
    label: "Nano Banana Pro (0 Kredit · 20/Hari Gratis)",
    hint: "Kualitas tertinggi untuk keyframe utama (kuota harian gratis 20 gambar/hari)",
  },
];

export interface FlowImageJob {
  index: number;
  targetId: string;
  label: string;
  mode: "flow-text-to-image" | "flow-image-to-image";
  aspectRatio: string;
  images: string[];
  prompt: string;
}

export function buildFlowImageFolderSlug(projectName: string, scope: "assets" | "panels"): string {
  const slug =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30) || "proyek";
  return `nmcgen-${slug}-${scope}`;
}

/**
 * Extracts a 1-based slot index (1..99) from a Flow Connector downloaded image filename
 * (e.g. `1 - Raka.png`, `02_panel.jpg`, `P03_scene.webp`, `A01_raka.jpg`), ignoring timestamps.
 */
export function extractImageIndexFromFilename(filename: string): number | null {
  const base = (filename.split(/[/\\]/).pop() || filename).trim();
  const leading = base.match(/^0?([1-9]\d?)(?:\s*[-_. ]|$)/);
  if (leading) {
    const n = Number(leading[1]);
    if (n >= 1 && n <= 99) return n;
  }
  const tagged = base.match(/(?:^|[\s_-])(?:a|aset|asset|p|panel|frame|f|img)[\s_-]?0?([1-9]\d?)(?:\b|[._-])/i);
  if (tagged) {
    const n = Number(tagged[1]);
    if (n >= 1 && n <= 99) return n;
  }
  return null;
}

/**
 * Matches a downloaded image filename to its exact 1-based slot inside `slots` (Assets or Ordered Frames).
 * Falls back to the first slot that does not yet have an image in `attachedIds`.
 */
export function matchDownloadedImageToSlot<T extends { id: string }>(
  filename: string,
  slots: T[],
  attachedIds: ReadonlySet<string>,
  options?: { allowOverwriteIndexed?: boolean },
): T | null {
  const indexed = extractImageIndexFromFilename(filename);
  if (indexed !== null && indexed >= 1 && indexed <= slots.length) {
    const exact = slots[indexed - 1];
    if (exact && (options?.allowOverwriteIndexed || !attachedIds.has(exact.id))) return exact;
  }
  return slots.find((s) => !attachedIds.has(s.id)) ?? null;
}

function decodeBase64Bytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Builds a Nano Banana natural-language prompt for a Storyboard Panel (supports up to 10 ACC reference images!).
 */
export function buildFlowPanelPrompt(
  frame: StoryFrame,
  sb: StoryboardData,
  refAssets: StoryAsset[],
): string {
  const shot = SHOT_SIZE_META[frame.shotSize]?.en || "medium shot";
  const angle = CAMERA_ANGLE_META[frame.cameraAngle]?.en || "eye-level angle";
  const sceneCore = (frame.visualPrompt || frame.sceneSummary || frame.title || "cinematic story frame")
    .replace(/\s+/g, " ")
    .trim();

  const parts: string[] = [
    "Single full-bleed cinematic movie frame, no panel borders, no split-screen, no text, no speech bubbles, no watermarks.",
    `Visual style: ${sb.visualStyle}.`,
    `Camera framing: ${shot}, ${angle}.`,
  ];

  if (refAssets.length > 0) {
    const refNotes = refAssets.map((a, idx) => {
      const catEn = a.category === "character" ? "character" : a.category === "location" ? "location" : "prop";
      const desc = a.visualDesc.trim() ? ` (${a.visualDesc.trim()})` : "";
      return `Reference image ${idx + 1} shows ${catEn} "${a.name}"${desc}`;
    });
    parts.push(
      `Match exact likeness, wardrobe, colors, and lighting from attached reference images: ${refNotes.join("; ")}.`,
    );
  }

  parts.push(`Scene action: ${sceneCore}.`);
  return parts.join(" ");
}

function buildFlowImageRunnerScript(params: {
  projectName: string;
  scopeLabel: string;
  folderSlug: string;
  defaultModel: FlowConnectorImageModel;
  jobs: FlowImageJob[];
}): string {
  return [
    "#!/usr/bin/env node",
    `// Auto-generated by nmcGen — Flow Connector Image Runner (${params.scopeLabel})`,
    '// Membutuhkan Chrome Desktop + Ekstensi "Flow Connector" + CLI: npm install -g flow-connector-cli',
    'import { spawnSync } from "node:child_process";',
    'import { existsSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    "const __dirname = dirname(fileURLToPath(import.meta.url));",
    'const IS_WIN = process.platform === "win32";',
    `const PROJECT_NAME = ${JSON.stringify(params.projectName)};`,
    `const SCOPE_LABEL = ${JSON.stringify(params.scopeLabel)};`,
    `const DEFAULT_FOLDER = ${JSON.stringify(params.folderSlug)};`,
    `const DEFAULT_MODEL = ${JSON.stringify(params.defaultModel)};`,
    `const JOBS = ${JSON.stringify(params.jobs, null, 2)};`,
    "",
    "function parseArgs(argv) {",
    "  const out = { only: null, model: DEFAULT_MODEL, folder: DEFAULT_FOLDER, waitEach: false };",
    "  for (let i = 0; i < argv.length; i++) {",
    "    const a = argv[i];",
    '    if ((a === "--index" || a === "-i") && argv[i + 1]) {',
    "      out.only = Number(argv[++i]);",
    '    } else if ((a === "--model" || a === "-m") && argv[i + 1]) {',
    "      out.model = argv[++i];",
    '    } else if ((a === "--folder" || a === "-f") && argv[i + 1]) {',
    "      out.folder = argv[++i];",
    '    } else if (a === "--wait-each") {',
    "      out.waitEach = true;",
    "    }",
    "  }",
    "  return out;",
    "}",
    "",
    "function runFlowAuto(args, stdinText) {",
    '  return spawnSync("flow-auto", args, {',
    "    cwd: __dirname,",
    "    input: stdinText,",
    '    encoding: "utf8",',
    "    shell: IS_WIN,",
    "  });",
    "}",
    "",
    "function sleep(ms) {",
    "  return new Promise((resolve) => setTimeout(resolve, ms));",
    "}",
    "",
    "async function main() {",
    "  const opts = parseArgs(process.argv.slice(2));",
    '  console.log("\\n=== nmcGen x Flow Connector Image Runner (" + SCOPE_LABEL + ") ===");',
    '  console.log("Proyek :", PROJECT_NAME);',
    '  console.log("Model  :", opts.model, "(0 Kredit Flow)");',
    '  console.log("Folder : Downloads/" + opts.folder + "/");',
    "",
    '  const ver = runFlowAuto(["--version"]);',
    "  if (ver.error || ver.status !== 0) {",
    '    console.error("\\n[!] CLI \'flow-auto\' belum terpasang.");',
    '    console.error("    Jalankan sekali: npm install -g flow-connector-cli");',
    `    console.error("    Pasang ekstensi Chrome: ${ANIMATION_APP_LINKS.flowConnectorExtension}");`,
    "    process.exit(1);",
    "  }",
    '  console.log("CLI    :", (ver.stdout || "").trim());',
    "",
    '  const st = runFlowAuto(["status", "--site", "flow"]);',
    '  if (st.stdout) console.log("\\nStatus Flow Connector:\\n" + st.stdout.trim());',
    "  if (st.stderr) console.error(st.stderr.trim());",
    '  console.log("\\n[Tips] Biarkan tab https://flow.google.com terbuka & terlihat di Chrome Desktop.");',
    '  console.log("[Tips] Aktifkan \'Pantau Downloads\' di nmcGen agar gambar otomatis langsung masuk!\\n");',
    "",
    "  const selected = opts.only ? JOBS.filter((j) => j.index === opts.only) : JOBS;",
    "  if (selected.length === 0) {",
    '    console.error("Item tidak ditemukan. Indeks tersedia:", JOBS.map((j) => j.index).join(", "));',
    "    process.exit(1);",
    "  }",
    "",
    "  const shouldWaitPerJob = selected.length === 1 || opts.waitEach;",
    "  let submitted = 0;",
    "",
    "  for (const job of selected) {",
    "    for (const imgPath of job.images) {",
    "      if (!existsSync(join(__dirname, imgPath))) {",
    '        console.error("[!] Gambar referensi tidak ditemukan: " + imgPath);',
    "        process.exit(1);",
    "      }",
    "    }",
    '    const args = ["generate", "create", job.mode];',
    "    for (const imgPath of job.images) {",
    '      args.push("--image", imgPath);',
    "    }",
    '    args.push("--model", opts.model);',
    '    args.push("--aspect-ratio", job.aspectRatio);',
    '    args.push("--outputs", "1");',
    '    args.push("--index", String(job.index));',
    '    args.push("--folder", opts.folder);',
    "    if (shouldWaitPerJob) {",
    '      args.push("--wait", "--wait-timeout", "10");',
    "    }",
    "",
    '    console.log("[#" + job.index + "] Mengirim: " + job.label + (job.images.length ? " (" + job.images.length + " acuan ACC)" : "") + "...");',
    "    const res = runFlowAuto(args, job.prompt);",
    '    if (res.stdout && res.stdout.trim()) console.log("  ->", res.stdout.trim());',
    '    if (res.stderr && res.stderr.trim()) console.error("  [info]", res.stderr.trim());',
    "    if (res.status !== 0) {",
    '      console.error("  [!] Gagal mengirim item #" + job.index + ". Lanjut ke item berikutnya...");',
    "    } else {",
    "      submitted += 1;",
    "    }",
    "  }",
    "",
    "  if (shouldWaitPerJob) {",
    '    console.log("\\nSelesai! Gambar tersimpan di Downloads/" + opts.folder + "/");',
    "    return;",
    "  }",
    "",
    '  console.log("\\n" + submitted + " gambar masuk antrean Flow Connector! Memantau progres sampai selesai...");',
    "  for (;;) {",
    "    await sleep(6000);",
    '    const list = runFlowAuto(["generate", "list"]);',
    '    const out = (list.stdout || "").trim();',
    "    const activeLines = out",
    "      .split(/\\r?\\n/)",
    "      .filter((ln) => /\\b(queued|running|downloading|waiting_for_extension)\\b/i.test(ln));",
    "    if (activeLines.length === 0) {",
    '      console.log("\\nSemua antrean gambar selesai!");',
    "      break;",
    "    }",
    '    console.log("[" + new Date().toLocaleTimeString() + "] Masih menggambar " + activeLines.length + " item di Google Flow...");',
    "  }",
    "",
    '  const failed = runFlowAuto(["generate", "list", "--failed", "--run", opts.folder]);',
    "  if (failed.stdout && failed.stdout.trim()) {",
    '    console.log("\\nItem gagal (jika ada):\\n" + failed.stdout.trim());',
    "  }",
    '  console.log("\\nSelesai! Semua gambar tersimpan di Downloads/" + opts.folder + "/");',
    '  console.log("Kembali ke tab nmcGen (dengan Pantau Downloads aktif) — semua gambar otomatis terpasang!");',
    "}",
    "",
    "main().catch((err) => {",
    '  console.error("Error:", err);',
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
}

function buildFlowImageAgentPrompt(params: {
  projectName: string;
  scopeLabel: string;
  folderSlug: string;
  model: FlowConnectorImageModel;
  jobs: FlowImageJob[];
}): string {
  const lines: string[] = [
    `# Generate Gambar ${params.scopeLabel} via Flow Connector (${params.model}) — ${params.projectName}`,
    "",
    `Tolong generate seluruh gambar **${params.scopeLabel}** proyek **"${params.projectName}"** di Google Flow memakai **Flow Connector** (\`flow-auto\` / MCP \`flow-connector\`) dengan model \`${params.model}\` (**0 kredit Flow**).`,
    "",
    `- **Folder Unduhan Wajib (\`--folder\`):** \`${params.folderSlug}\` (agar nmcGen menangkap otomatis lewat Pantau Downloads)`,
    `- **Total Item:** ${params.jobs.length}`,
    "",
    `## Eksekusi Cepat`,
    `1. Pastikan tab \`https://flow.google.com\` terbuka & terlihat di Chrome Desktop.`,
    `2. Jalankan \`node run_flow_images.mjs\` di dalam folder hasil ekstrak ZIP ini (atau jalankan tiap job \`flow-auto generate create\` di bawah dengan \`--index\` & \`--folder ${params.folderSlug}\`).`,
    "",
    `## Daftar Item`,
  ];

  for (const job of params.jobs) {
    const safePrompt = job.prompt.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n+/g, " ");
    const imgFlags = job.images.map((im) => `--image "./${im}"`).join(" ");
    const cmd = [
      "flow-auto generate create",
      job.mode,
      `--prompt "${safePrompt}"`,
      imgFlags,
      `--model ${params.model}`,
      `--aspect-ratio ${job.aspectRatio}`,
      "--outputs 1",
      `--index ${job.index}`,
      `--folder ${params.folderSlug}`,
    ]
      .filter(Boolean)
      .join(" ");

    lines.push(
      "",
      `### #${String(job.index).padStart(2, "0")} — ${job.label} (${job.aspectRatio})`,
      "```bash",
      cmd,
      "```",
    );
  }
  return lines.join("\n") + "\n";
}

function buildBatWrapper(): string {
  return '@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nnode run_flow_images.mjs %*\r\necho.\r\npause\r\n';
}

function buildCommandWrapper(): string {
  return '#!/bin/bash\ncd "$(dirname "$0")"\nnode ./run_flow_images.mjs "$@"\necho ""\nread -p "Tekan Enter untuk menutup..." _\n';
}

/**
 * Packages Step 2 (Assets) into a zero-dependency Flow Connector ZIP runner using Nano Banana 2 Lite (0 Flow credits).
 */
export function buildFlowAssetImagePackZip(
  projectName: string,
  sb: StoryboardData,
  options?: { model?: FlowConnectorImageModel; onlyMissing?: boolean },
): {
  zipBytes: Uint8Array;
  folderSlug: string;
  jobCount: number;
  runnerScript: string;
  agentPrompt: string;
} {
  const model: FlowConnectorImageModel = options?.model ?? "nano-banana-2-lite";
  const onlyMissing = options?.onlyMissing ?? true;
  const folderSlug = buildFlowImageFolderSlug(projectName, "assets");

  const jobs: FlowImageJob[] = [];
  sb.assets.forEach((asset, idx) => {
    if (onlyMissing && getSelectedAssetImage(asset)) return;
    jobs.push({
      index: idx + 1, // Stable 1-based slot index matching sb.assets[idx]
      targetId: asset.id,
      label: `${asset.name} (${ASSET_CATEGORY_LABEL[asset.category]})`,
      mode: "flow-text-to-image",
      aspectRatio: assetAspectFor(asset.category, sb.aspectRatio),
      images: [],
      prompt: buildAssetImagePrompt(asset, sb.visualStyle),
    });
  });

  const runnerScript = buildFlowImageRunnerScript({
    projectName,
    scopeLabel: "Aset & Karakter",
    folderSlug,
    defaultModel: model,
    jobs,
  });
  const agentPrompt = buildFlowImageAgentPrompt({
    projectName,
    scopeLabel: "Aset & Karakter",
    folderSlug,
    model,
    jobs,
  });

  const entries: ZipEntryInput[] = [
    { name: "run_flow_images.mjs", data: runnerScript },
    { name: "run_flow_images.bat", data: buildBatWrapper() },
    { name: "run_flow_images.command", data: buildCommandWrapper() },
    { name: "FLOW_ASSETS_PROMPT.md", data: agentPrompt },
    { name: "asset_prompts.json", data: JSON.stringify(jobs, null, 2) + "\n" },
  ];

  return {
    zipBytes: buildZip(entries),
    folderSlug,
    jobCount: jobs.length,
    runnerScript,
    agentPrompt,
  };
}

/**
 * Packages Step 3 (Storyboard Panels) + all referenced ACC Asset images into a Flow Connector ZIP runner
 * using `flow-image-to-image` (up to 10 ACC references!) with Nano Banana 2 Lite (0 Flow credits).
 */
export function buildFlowStoryboardImagePackZip(
  projectName: string,
  sb: StoryboardData,
  options?: { model?: FlowConnectorImageModel; onlyMissing?: boolean; segmentId?: string },
): {
  zipBytes: Uint8Array;
  folderSlug: string;
  jobCount: number;
  runnerScript: string;
  agentPrompt: string;
} {
  const model: FlowConnectorImageModel = options?.model ?? "nano-banana-2-lite";
  const onlyMissing = options?.onlyMissing ?? true;
  const folderSlug = buildFlowImageFolderSlug(projectName, "panels");

  const segments = getStoryboardSegments(sb);
  const orderedFrames = reindexStoryboardFrames(sb.frames, segments);

  const assetFileMap = new Map<string, string>();
  const refEntries: ZipEntryInput[] = [];

  sb.assets.forEach((asset, idx) => {
    const dataUrl = getSelectedAssetImage(asset);
    if (!dataUrl) return;
    const dec = parseDataUrlBase64(dataUrl);
    if (!dec) return;
    const bytes = decodeBase64Bytes(dec.data);
    if (!bytes) return;
    const slug = asset.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `aset_${idx + 1}`;
    const relPath = `refs/${String(idx + 1).padStart(2, "0")}_${slug}.${dec.ext}`;
    assetFileMap.set(asset.id, relPath);
    refEntries.push({ name: relPath, data: bytes });
  });

  const jobs: FlowImageJob[] = [];
  orderedFrames.forEach((frame, globalIdx) => {
    if (options?.segmentId && frame.segmentId !== options.segmentId) return;
    if (onlyMissing && getSelectedFrameImage(frame)) return;

    const seg = segments.find((s) => s.id === frame.segmentId);
    const segNum = seg?.index ?? 1;
    const pNum = frame.panelNumber ?? globalIdx + 1;

    // Attach up to 10 ACC reference images that belong to this panel (characters -> props -> locations)
    const refAssets = frame.assetIds
      .map((id) => sb.assets.find((a) => a.id === id))
      .filter((a): a is StoryAsset => Boolean(a && assetFileMap.has(a.id)))
      .slice(0, 10);

    const refPaths = refAssets.map((a) => assetFileMap.get(a.id)!);

    jobs.push({
      index: globalIdx + 1, // Stable 1-based global frame index matching orderedFrames[globalIdx]
      targetId: frame.id,
      label: `Segmen ${String(segNum).padStart(2, "0")} · Panel ${pNum}: ${frame.title}`,
      mode: refPaths.length > 0 ? "flow-image-to-image" : "flow-text-to-image",
      aspectRatio: sb.aspectRatio,
      images: refPaths,
      prompt: buildFlowPanelPrompt(frame, sb, refAssets),
    });
  });

  const runnerScript = buildFlowImageRunnerScript({
    projectName,
    scopeLabel: "Storyboard Panel",
    folderSlug,
    defaultModel: model,
    jobs,
  });
  const agentPrompt = buildFlowImageAgentPrompt({
    projectName,
    scopeLabel: "Storyboard Panel",
    folderSlug,
    model,
    jobs,
  });

  const entries: ZipEntryInput[] = [
    { name: "run_flow_images.mjs", data: runnerScript },
    { name: "run_flow_images.bat", data: buildBatWrapper() },
    { name: "run_flow_images.command", data: buildCommandWrapper() },
    { name: "FLOW_PANELS_PROMPT.md", data: agentPrompt },
    { name: "panel_prompts.json", data: JSON.stringify(jobs, null, 2) + "\n" },
    ...refEntries,
  ];

  return {
    zipBytes: buildZip(entries),
    folderSlug,
    jobCount: jobs.length,
    runnerScript,
    agentPrompt,
  };
}
