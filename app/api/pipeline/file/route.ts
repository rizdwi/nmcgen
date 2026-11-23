import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isValidJobId, WORK_ROOT } from "@/lib/serverPipeline";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const job = url.searchParams.get("job") || "";
  const rawName = url.searchParams.get("name") || "nmcgen-final.mp4";
  const download = url.searchParams.get("download") === "1";

  if (!isValidJobId(job)) {
    return Response.json({ ok: false, error: "ID render tidak valid." }, { status: 400 });
  }

  const filePath = path.join(WORK_ROOT, job, "final.mp4");
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(WORK_ROOT + path.sep)) {
    return Response.json({ ok: false, error: "Akses jalur berkas ditolak." }, { status: 403 });
  }

  try {
    const info = await stat(resolved);
    const data = await readFile(resolved);
    const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const headers: Record<string, string> = {
      "content-type": "video/mp4",
      "content-length": String(info.size),
      "cache-control": "no-store",
    };
    if (download) {
      headers["content-disposition"] = `attachment; filename="${safeName}"`;
    }
    return new Response(data, { status: 200, headers });
  } catch {
    return Response.json({ ok: false, error: "Berkas hasil render tidak ditemukan." }, { status: 404 });
  }
}
