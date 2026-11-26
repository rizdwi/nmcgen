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
      AI: bindings.ai({ dev: { remote: true } }),
      SUPABASE_URL: bindings.secret(),
      SUPABASE_PUBLISHABLE_KEY: bindings.secret(),
      // GEMINI_API_KEY sengaja tidak dideklarasikan sebagai secret wajib:
      // secret-nya belum ada di Worker sehingga deploy ditolak, dan
      // getCloudflareEnvVar() sudah mengembalikan "" bila binding tidak ada
      // (perilaku sama seperti live saat ini; kunci lokal browser tetap jalan).
    },
  }),
});
