import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  worker: defineWorker({
    name: "nmcgen",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-11-23",
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*", "!/scripts/*"],
    },
    env: {
      ASSETS: bindings.assets(),
    },
  }),
});
