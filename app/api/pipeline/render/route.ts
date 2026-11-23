import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { NmcProject } from "@/lib/types";
import { detectRuntime, findPythonBin, stageProjectWorkspace } from "@/lib/serverPipeline";
import { validateProject } from "@/lib/validator";

const execFileAsync = promisify(execFile);

export async function POST(req: Request) {
  const runtime = await detectRuntime();
  if (!runtime.localFfmpeg || !runtime.localPython) {
    return Response.json(
      {
        ok: false,
        code: "SERVERLESS_FALLBACK",
        error:
          "FFmpeg atau Python lokal tidak tersedia di environment server ini. Gunakan Render WebM Browser atau Unduh Bundle ZIP untuk merender di PC Anda.",
      },
      { status: 501 },
    );
  }

  let body: { project?: NmcProject };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Body JSON proyek tidak valid." }, { status: 400 });
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

  try {
    const { jobId, jobDir, manifestPath } = await stageProjectWorkspace(project);
    const outPath = path.join(jobDir, "final.mp4");
    const scriptPath = path.resolve(process.cwd(), "public", "scripts", "render_ffmpeg.py");

    const { stdout } = await execFileAsync(
      pyBin,
      [scriptPath, "--manifest", manifestPath, "--out", outPath],
      { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
    );

    const parsed = JSON.parse(stdout.trim());
    if (!parsed.ok) {
      return Response.json({ ok: false, error: parsed.error || "Render FFmpeg gagal." }, { status: 500 });
    }

    const safeName =
      project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "nmcgen-video";

    return Response.json({
      ok: true,
      jobId,
      fileUrl: `/api/pipeline/file?job=${encodeURIComponent(jobId)}&name=${encodeURIComponent(safeName + ".mp4")}`,
      fileName: `${safeName}.mp4`,
      durationSec: parsed.duration_sec,
      sizeBytes: parsed.size_bytes,
      resolution: parsed.width && parsed.height ? `${parsed.width}x${parsed.height}` : undefined,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    let msg = e.message || "Render FFmpeg gagal.";
    if (e.stdout) {
      try {
        const parsed = JSON.parse(e.stdout.trim());
        if (parsed.error) msg = parsed.error;
      } catch {
        // ignore non-json stdout
      }
    }
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
