import { detectRuntime, readBundledScripts } from "@/lib/serverPipeline";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const status = await detectRuntime();
  if (url.searchParams.get("scripts") === "1") {
    const scripts = await readBundledScripts();
    return Response.json({ ok: true, runtime: status, scripts });
  }
  return Response.json({ ok: true, runtime: status });
}
