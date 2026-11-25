export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

function isCloudflareWorkersRuntime(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.userAgent === "string" &&
    navigator.userAgent === "Cloudflare-Workers"
  );
}

// Runtime lookup keeps Node.js (next dev/build) working without bundling cloudflare:workers.
export async function getCloudflareAiBinding(): Promise<WorkersAiBinding | null> {
  if (!isCloudflareWorkersRuntime()) {
    return null;
  }
  try {
    const modId = "cloudflare:workers";
    const mod = (await import(/* webpackIgnore: true */ /* @vite-ignore */ modId)) as {
      env?: { AI?: WorkersAiBinding };
    };
    const ai = mod?.env?.AI;
    return ai && typeof ai.run === "function" ? ai : null;
  } catch {
    return null;
  }
}

export async function getCloudflareEnvVar(name: string): Promise<string> {
  const fromProcess = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (fromProcess && fromProcess.trim()) return fromProcess.trim();
  if (!isCloudflareWorkersRuntime()) return "";
  try {
    const modId = "cloudflare:workers";
    const mod = (await import(/* webpackIgnore: true */ /* @vite-ignore */ modId)) as {
      env?: Record<string, unknown>;
    };
    const val = mod?.env?.[name];
    return typeof val === "string" ? val.trim() : "";
  } catch {
    return "";
  }
}
