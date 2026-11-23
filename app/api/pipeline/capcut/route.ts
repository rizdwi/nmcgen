import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { NmcProject } from "@/lib/types";
import {
  defaultCapCutDraftsDir,
  detectRuntime,
  findPythonBin,
  stageProjectWorkspace,
} from "@/lib/serverPipeline";
import { validateProject } from "@/lib/validator";

const execFileAsync = promisify(execFile);

export async function POST(req: Request) {
  const runtime = await detectRuntime();
  if (runtime.isServerless || !runtime.localPython) {
    return Response.json(
      {
        ok: false,
        code: "SERVERLESS_FALLBACK",
        error:
          "Ekspor langsung ke folder CapCut Drafts hanya tersedia saat nmcGen berjalan lokal. Unduh Bundle ZIP untuk membuat draft di PC Anda.",
      },
      { status: 501 },
    );
  }

  let body: { project?: NmcProject; draftsDir?: string; draftName?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Body JSON tidak valid." }, { status: 400 });
  }

  const project = body.project;
  if (!project || !Array.isArray(project.nodes)) {
    return Response.json({ ok: false, error: "Data proyek nmcGen tidak lengkap." }, { status: 400 });
  }

  const report = validateProject(project);
  if (!report.ok) {
    return Response.json(
      { ok: false, error: report.errors[0]?.message || "Validasi pipeline gagal." },
      { status: 400 },
    );
  }

  const pyBin = await findPythonBin();
  if (!pyBin) {
    return Response.json({ ok: false, error: "Python 3 tidak ditemukan di PATH." }, { status: 500 });
  }

  const draftsDir = (body.draftsDir || "").trim() || defaultCapCutDraftsDir();
  const safeDraftName =
    (body.draftName || project.name || "nmcGen_Draft")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .trim()
      .slice(0, 64) || "nmcGen_Draft";

  try {
    const { manifestPath } = await stageProjectWorkspace(project);
    const scriptPath = path.resolve(process.cwd(), "scripts", "build_capcut_draft.py");

    const { stdout } = await execFileAsync(
      pyBin,
      [scriptPath, "--manifest", manifestPath, "--drafts-dir", draftsDir, "--name", safeDraftName],
      { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
    );

    const parsed = JSON.parse(stdout.trim());
    return Response.json(parsed, { status: parsed.ok ? 200 : 422 });
  } catch (err) {
    const e = err as { stdout?: string; message?: string };
    if (e.stdout) {
      try {
        const parsed = JSON.parse(e.stdout.trim());
        return Response.json(parsed, { status: parsed.code === "PYCAPCUT_MISSING" ? 422 : 500 });
      } catch {
        // fall through
      }
    }
    return Response.json({ ok: false, error: e.message || "Gagal membuat draft CapCut." }, { status: 500 });
  }
}
