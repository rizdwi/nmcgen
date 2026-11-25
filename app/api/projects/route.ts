import type { NmcProject } from "@/lib/types";
import {
  getServerSupabaseConfigAsync,
  sbDeleteProject,
  sbListProjects,
  sbUpsertProject,
} from "@/lib/supabaseSync";

export async function GET() {
  const cfg = await getServerSupabaseConfigAsync();
  if (!cfg) {
    return Response.json({ ok: true, connected: false, projects: [] });
  }
  try {
    const projects = await sbListProjects(cfg);
    return Response.json({ ok: true, connected: true, projects });
  } catch (err) {
    return Response.json(
      { ok: false, connected: true, projects: [], error: (err as Error).message },
      { status: 502 },
    );
  }
}

export async function POST(req: Request) {
  const cfg = await getServerSupabaseConfigAsync();
  if (!cfg) {
    return Response.json({ ok: true, connected: false });
  }
  let body: { project?: NmcProject };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, connected: true, error: "Body JSON proyek tidak valid." }, { status: 400 });
  }
  const project = body.project;
  if (!project?.id || !Array.isArray(project.nodes)) {
    return Response.json({ ok: false, connected: true, error: "Data proyek nmcGen tidak lengkap." }, { status: 400 });
  }
  try {
    await sbUpsertProject(cfg, project);
    return Response.json({ ok: true, connected: true });
  } catch (err) {
    return Response.json({ ok: false, connected: true, error: (err as Error).message }, { status: 502 });
  }
}

export async function DELETE(req: Request) {
  const cfg = await getServerSupabaseConfigAsync();
  if (!cfg) {
    return Response.json({ ok: true, connected: false });
  }
  const id = new URL(req.url).searchParams.get("id")?.trim() || "";
  if (!id || id.length > 120) {
    return Response.json({ ok: false, connected: true, error: "ID proyek tidak valid." }, { status: 400 });
  }
  try {
    await sbDeleteProject(cfg, id);
    return Response.json({ ok: true, connected: true });
  } catch (err) {
    return Response.json({ ok: false, connected: true, error: (err as Error).message }, { status: 502 });
  }
}
