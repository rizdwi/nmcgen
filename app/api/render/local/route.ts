import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { findChromeBin, findPythonBin, isServerlessRuntime } from "@/lib/serverPipeline";
import { parseDataUrlBase64 } from "@/lib/omniAnimation";

const execFileAsync = promisify(execFile);

interface RenderImagePayload {
  fileName: string;
  dataUrl: string;
}

interface LocalRenderBody {
  spec?: Record<string, unknown>;
  images?: RenderImagePayload[];
  audioDataUrl?: string;
  audioExt?: string;
}

function sanitizeRelativePath(raw: string): string | null {
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || normalized.includes(":")) return null;
  if (!/^[A-Za-z0-9/_.-]+$/.test(normalized)) return null;
  return normalized;
}

export async function POST(req: Request) {
  if (isServerlessRuntime()) {
    return Response.json(
      {
        ok: false,
        code: "SERVERLESS_UNSUPPORTED",
        error:
          "Render Chrome + FFmpeg lokal hanya tersedia saat nmcGen berjalan lokal di PC. Gunakan tombol Rekam Video 1080p di Browser atau Unduh Paket Render MP4 (.zip).",
      },
      { status: 501 },
    );
  }

  const [pyBin, chromeBin] = await Promise.all([findPythonBin(), findChromeBin()]);
  if (!pyBin) {
    return Response.json({ ok: false, error: "Python 3 tidak ditemukan di PATH sistem." }, { status: 500 });
  }
  if (!chromeBin) {
    return Response.json(
      { ok: false, error: "Google Chrome atau Microsoft Edge tidak ditemukan untuk render CDP lokal." },
      { status: 500 },
    );
  }

  let body: LocalRenderBody;
  try {
    body = (await req.json()) as LocalRenderBody;
  } catch {
    return Response.json({ ok: false, error: "Payload JSON tidak valid." }, { status: 400 });
  }

  const spec = body.spec;
  const images = Array.isArray(body.images) ? body.images : [];
  if (!spec || typeof spec !== "object" || images.length === 0) {
    return Response.json({ ok: false, error: "Storyboard atau daftar gambar kosong." }, { status: 400 });
  }
  if (images.length > 60) {
    return Response.json({ ok: false, error: "Maksimal 60 panel gambar per render lokal." }, { status: 400 });
  }

  const scriptPath = path.resolve(process.cwd(), "public", "scripts", "render_motion_cdp.py");
  const workDir = await mkdtemp(path.join(os.tmpdir(), "nmcgen-local-render-"));

  try {
    for (const im of images) {
      const rel = sanitizeRelativePath(String(im.fileName || ""));
      if (!rel) {
        return Response.json({ ok: false, error: `Nama file gambar tidak valid: ${im.fileName}` }, { status: 400 });
      }
      const parsed = parseDataUrlBase64(String(im.dataUrl || ""));
      if (!parsed) {
        return Response.json({ ok: false, error: `Data URL gambar rusak pada ${rel}.` }, { status: 400 });
      }
      const dst = path.join(/*turbopackIgnore: true*/ workDir, rel);
      await mkdir(path.dirname(dst), { recursive: true });
      await writeFile(dst, Buffer.from(parsed.data, "base64"));
    }

    const args = [scriptPath, "--spec", path.join(workDir, "storyboard.json"), "--out", path.join(workDir, "final.mp4"), "--json"];

    if (body.audioDataUrl && typeof body.audioDataUrl === "string") {
      const parsedAudio = parseDataUrlBase64(body.audioDataUrl);
      if (parsedAudio) {
        const cleanExt = String(body.audioExt || "mp3").replace(/[^a-z0-9]/gi, "").slice(0, 6) || "mp3";
        const audioPath = path.join(workDir, `bgm.${cleanExt}`);
        await writeFile(audioPath, Buffer.from(parsedAudio.data, "base64"));
        args.push("--audio", audioPath);
      }
    }

    await writeFile(path.join(workDir, "storyboard.json"), JSON.stringify(spec, null, 2), "utf-8");

    const { stdout, stderr } = await execFileAsync(pyBin, args, {
      cwd: workDir,
      timeout: 10 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });

    const lastLine = stdout.trim().split(/\r?\n/).pop() || "{}";
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(lastLine) as Record<string, unknown>;
    } catch {
      meta = { ok: false, error: stderr.trim() || stdout.trim() };
    }

    if (!meta.ok) {
      return Response.json(
        { ok: false, error: String(meta.error || stderr.trim() || "Render MP4 lokal gagal.") },
        { status: 500 },
      );
    }

    const mp4Buf = await readFile(path.join(workDir, "final.mp4"));
    return new Response(mp4Buf, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(mp4Buf.byteLength),
        "Cache-Control": "no-store",
        "X-Nmcgen-Render-Meta": JSON.stringify({
          width: meta.width,
          height: meta.height,
          fps: meta.fps,
          durationSec: meta.duration_sec,
          renderSec: meta.render_sec,
        }),
      },
    });
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    const detail = (e.stderr || e.stdout || e.message || "Render lokal gagal.").slice(-600);
    return Response.json({ ok: false, error: detail }, { status: 500 });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
