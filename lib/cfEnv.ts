export interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

// Runtime lookup keeps Node.js (next dev/build) working without bundling cloudflare:workers.
export async function getCloudflareAiBinding(): Promise<WorkersAiBinding | null> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.userAgent !== "string" ||
    navigator.userAgent !== "Cloudflare-Workers"
  ) {
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
