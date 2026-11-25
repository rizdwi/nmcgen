import assert from "node:assert/strict";
import {
  canConnect,
  createDefaultNode,
  createEmptyProject,
  createStarterProject,
  matchVisualStylePreset,
  VISUAL_STYLE_PRESETS,
} from "./presets.ts";
import {
  autoArrangeNodes,
  buildAss,
  buildSrt,
  composeGoogleFlowPrompt,
  composeSegmentImagePrompt,
  composeSegmentPrompt,
  estimateDialogueSeconds,
  getPrimaryScript,
  getProjectCover,
  selectSegmentReferenceImages,
  updateProjectMeta,
  validateProject,
} from "./validator.ts";
import { buildGoogleFlowGuide } from "./bundle.ts";
import { buildZip } from "./zip.ts";
import {
  buildCandidateChain,
  classifyAndRankModels,
  CLOUDFLARE_FREE_IMAGE_MODELS,
  CLOUDFLARE_FREE_TEXT_MODELS,
  cloudflareImageDims,
  detectBase64ImageMime,
  detectProviderKindFromKey,
  extractWorkersAiText,
  isCloudflareFluxSchnellModel,
  isCloudflareMultipartImageModel,
  isImagenModel,
  openAiImageSizeForModel,
  parseCloudflareRestCredentials,
  shouldSwitchModel,
} from "./modelRouter.ts";
import { mergeProjects, projectToSupabaseRow } from "./supabaseSync.ts";
import {
  applyExtractedAssetsToProject,
  buildAssetReferenceImagePrompt,
  cleanSourceText,
  formatScenesToScreenplay,
  parseConversationalEditResponse,
  parseEventGraphResponse,
  parseExtractedAssets,
  parseScriptAgentResponse,
  parseStoryboardBeats,
  parseSupervisionResponse,
  rebuildSegmentsFromBeats,
  splitIntoChapters,
  storyArcStages,
} from "./toonflow.ts";
import {
  assetAspectFor,
  buildAssetImagePrompt,
  buildExtractAssetsFromScriptPrompt,
  buildGenerateScriptPrompt,
  buildNextFramePrompt,
  buildQuickEditPrompt,
  buildStoryboardMarkdown,
  buildStoryboardZip,
  clampTargetPanels,
  composeStoryboardFramePrompt,
  createStoryboardProject,
  ensureStoryboard,
  formatSegmentsToScript,
  getSegmentFrames,
  getStoryboardSegments,
  parseExtractedStoryAssets,
  parseNextFrameResponse,
  parseQuickEditResponse,
  parseScriptIntoSegments,
  reindexStoryboardFrames,
} from "./storyboard.ts";
import type { NmcProject, SegmentNodeData } from "./types.ts";

// Synthetic test fixture built in test code only (no hardcoded sample in app source)
function makeFixtureProject(): NmcProject {
  const base = createStarterProject("Tes Produksi", {
    aspectRatio: "16:9",
    visualStyle: VISUAL_STYLE_PRESETS[0].prompt,
    premise: "Dua tokoh bertemu di stasiun saat senja.",
    maxSegmentSec: 8,
  });
  const scriptNode = base.nodes.find((n) => n.kind === "script")!;
  const asmNode = base.nodes.find((n) => n.kind === "assembly")!;

  const assetChar = createDefaultNode("asset", 380, 40, 1);
  if (assetChar.data.kind === "asset") {
    assetChar.data.tag = "@TokohA";
    assetChar.data.lockPrompt = "Jaket gelap, tas selempang kanvas";
  }
  const assetLoc = createDefaultNode("asset", 380, 220, 2);
  if (assetLoc.data.kind === "asset") {
    assetLoc.data.tag = "@Stasiun";
    assetLoc.data.category = "location";
    assetLoc.data.lockPrompt = "Peron stasiun senja, lampu kuning hangat";
  }

  const seg1 = createDefaultNode("segment", 760, 40, 1);
  if (seg1.data.kind === "segment") {
    seg1.data = {
      ...seg1.data,
      code: "G01",
      durationSec: 7,
      shotSize: "MS",
      cameraAngle: "Front",
      cameraMotion: "Push-In",
      timelineText: "[0:00-0:07] Tokoh berjalan menyusuri peron.",
      dialogue: "Keretanya sebentar lagi tiba.",
      continuityLock: "Tas di bahu kanan, cahaya senja dari kiri",
    };
  }
  const seg2 = createDefaultNode("segment", 760, 280, 2);
  if (seg2.data.kind === "segment") {
    seg2.data = {
      ...seg2.data,
      code: "G02",
      durationSec: 6,
      shotSize: "CU",
      cameraAngle: "Side 90",
      cameraMotion: "Static",
      timelineText: "[0:00-0:06] Close-up melihat jam tangan.",
      dialogue: "Kita masih punya waktu.",
      continuityLock: "Arah pandang ke kanan frame",
    };
  }

  return {
    ...base,
    nodes: [...base.nodes, assetChar, assetLoc, seg1, seg2],
    edges: [
      ...base.edges,
      { id: "e1", source: scriptNode.id, target: assetChar.id },
      { id: "e2", source: scriptNode.id, target: assetLoc.id },
      { id: "e3", source: assetChar.id, target: seg1.id },
      { id: "e4", source: assetLoc.id, target: seg1.id },
      { id: "e5", source: seg1.id, target: asmNode.id },
      { id: "e6", source: seg2.id, target: asmNode.id },
    ],
  };
}

// 1. Starter project & visual style presets
assert.ok(VISUAL_STYLE_PRESETS.length >= 6);
assert.equal(matchVisualStylePreset(VISUAL_STYLE_PRESETS[1].prompt), VISUAL_STYLE_PRESETS[1].id);
assert.equal(matchVisualStylePreset("Custom experimental collage"), "custom");

const starter = createStarterProject("Proyek Flow", {
  aspectRatio: "9:16",
  visualStyle: VISUAL_STYLE_PRESETS[1].prompt,
  maxSegmentSec: 8,
});
assert.equal(starter.nodes.length, 3);
assert.equal(getPrimaryScript(starter)?.maxSegmentSec, 8);
assert.equal(getPrimaryScript(starter)?.aspectRatio, "9:16");

// 2. Fixture validation & continuity checks
const fixture = makeFixtureProject();
const report = validateProject(fixture);
assert.equal(report.ok, true, "Fixture project should pass hard validation");
assert.equal(report.totalDurationSec, 13);
assert.equal(report.orderedSegmentIds.length, 2);
assert.equal(report.missingAssetImages, 2);
assert.equal(report.missingSegmentMedia, 2);
assert.equal(
  report.warnings.some((w) => w.code === "SAME_FRAMING_TRANSITION"),
  false,
);

const seg2 = fixture.nodes.find((n) => n.kind === "segment" && (n.data as SegmentNodeData).code === "G02")!;
if (seg2.data.kind === "segment") {
  seg2.data.shotSize = "MS";
  seg2.data.cameraAngle = "Front";
}
assert.equal(
  validateProject(fixture).warnings.some((w) => w.code === "SAME_FRAMING_TRANSITION"),
  true,
  "Identical consecutive framing must raise continuity warning",
);

// 3. Empty project fails hard validation honestly
const empty = createEmptyProject("Kosong");
const emptyReport = validateProject(empty);
assert.equal(emptyReport.ok, false);
assert.ok(emptyReport.errors.some((e) => e.code === "NO_SEGMENTS"));

// 4. Dialogue timing & subtitles
assert.ok(estimateDialogueSeconds("Keretanya sebentar lagi tiba.") > 2);
const srt = buildSrt(fixture);
assert.ok(srt.includes("Keretanya sebentar lagi tiba."));
assert.ok(srt.includes("-->"));
const ass = buildAss(fixture);
assert.ok(ass.includes("PlayResX: 1280"));
assert.ok(ass.includes("Dialogue: 0,"));

// 5. Standard prompt & Google Flow Veo/Ingredients prompt + guide
const seg1 = fixture.nodes.find((n) => n.kind === "segment" && (n.data as SegmentNodeData).code === "G01")!;
const prompt = composeSegmentPrompt(fixture, seg1);
assert.ok(prompt.includes("@TokohA"));
assert.ok(prompt.includes("@Stasiun"));

const imgPrompt = composeSegmentImagePrompt(fixture, seg1);
assert.ok(imgPrompt.includes("Single full-bleed cinematic movie frame"));
assert.equal(imgPrompt.includes("Keretanya sebentar lagi tiba."), false, "Still image prompt must not leak spoken dialogue");
assert.equal(imgPrompt.includes("[0:00-0:07]"), false, "Still image prompt must not leak timecodes");
assert.equal(imgPrompt.includes("@TokohA"), false, "Still image prompt must resolve @Tags so diffusion models never print @ text");

// Close-up segment should prioritize character refs and skip wide location ref image (without mutating shared fixture)
const cuProject: NmcProject = {
  ...fixture,
  nodes: fixture.nodes.map((n) => {
    if (n.id === seg1.id && n.data.kind === "segment") {
      return { ...n, data: { ...n.data, shotSize: "CU" as const } };
    }
    if (n.kind === "asset" && n.data.kind === "asset") {
      return {
        ...n,
        data: {
          ...n.data,
          imageDataUrl: n.data.category === "character" ? "data:image/png;base64,CHAR" : "data:image/png;base64,LOC",
        },
      };
    }
    return n;
  }),
};
const cuSeg = cuProject.nodes.find((n) => n.id === seg1.id)!;
const cuRefs = selectSegmentReferenceImages(cuProject, cuSeg);
assert.deepEqual(cuRefs, ["data:image/png;base64,CHAR"]);

const flowPrompt = composeGoogleFlowPrompt(fixture, seg1);
assert.ok(flowPrompt.includes("[Google Flow | G01"));
assert.ok(flowPrompt.includes("Ingredients-to-Video"));
assert.ok(flowPrompt.includes("@TokohA"));
const flowGuide = buildGoogleFlowGuide(fixture);
assert.ok(flowGuide.includes("https://labs.google/fx/tools/flow"));
assert.ok(flowGuide.includes("Prompt Veo / Flow:"));

// 6. Connection rules & auto-arrange
assert.equal(canConnect("asset", "segment"), true);
assert.equal(canConnect("export", "script"), false);
assert.equal(autoArrangeNodes(fixture).length, fixture.nodes.length);

// 7. Zero-dependency ZIP output header check
const zipBytes = buildZip([
  { name: "project.json", data: '{"name":"nmcGen"}' },
  { name: "google_flow_prompts.md", data: flowGuide },
]);
assert.equal(zipBytes[0], 0x50);
assert.equal(zipBytes[1], 0x4b);
assert.equal(zipBytes[2], 0x03);
assert.equal(zipBytes[3], 0x04);

// 8. Dashboard metadata edit & cover extraction
const edited = updateProjectMeta(fixture, {
  name: "Episode Stasiun",
  aspectRatio: "9:16",
  maxSegmentSec: 8,
  premise: "Pertemuan di peron senja.",
  visualStyle: VISUAL_STYLE_PRESETS[3].prompt,
});
assert.equal(edited.name, "Episode Stasiun");
assert.equal(getPrimaryScript(edited)?.aspectRatio, "9:16");
assert.equal(getPrimaryScript(edited)?.visualStyle, VISUAL_STYLE_PRESETS[3].prompt);
assert.equal(getProjectCover(edited), null);

// 9. Supabase row mapping & mergeProjects
const row = projectToSupabaseRow(edited);
assert.equal(row.id, edited.id);
assert.equal(row.name, "Episode Stasiun");
assert.equal(row.aspect_ratio, "9:16");
assert.equal(row.visual_style, VISUAL_STYLE_PRESETS[3].prompt);

const olderLocal = { ...edited, name: "Versi Lama", updatedAt: 1000 };
const newerRemote = { ...edited, name: "Versi Cloud Baru", updatedAt: 2000 };
const merged = mergeProjects([olderLocal], [newerRemote]);
assert.equal(merged.length, 1);
assert.equal(merged[0].name, "Versi Cloud Baru");

// 10. Auto model discovery & 429 fallback router
assert.equal(detectProviderKindFromKey("AIzaSyDummyKey1234567890abcd"), "Gemini");
assert.equal(detectProviderKindFromKey("sk-ant-api03-dummy1234567890"), "Anthropic");
assert.equal(detectProviderKindFromKey("sk-proj-dummyKey1234567890abcd"), "OpenAI");

const geminiDiscovered = classifyAndRankModels("Gemini", [
  { id: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
  { id: "models/gemini-3.8-flash-tts", supportedGenerationMethods: ["generateContent"] },
  { id: "models/imagen-4.0-fast-generate-001", supportedGenerationMethods: ["predict"] },
  { id: "models/gemini-3-pro-image", supportedGenerationMethods: ["generateContent"] },
  { id: "models/gemini-nano-banana-2.1", supportedGenerationMethods: ["generateContent"] },
  { id: "models/gemini-3.1-flash-lite-image", supportedGenerationMethods: ["generateContent"] },
  { id: "models/gemini-4-argon", supportedGenerationMethods: ["generateContent"] },
  { id: "models/gemini-4-hydrogen", supportedGenerationMethods: ["generateContent"] },
]);
assert.equal(geminiDiscovered.textModels[0], "gemini-4-hydrogen");
assert.deepEqual(geminiDiscovered.imageModels, [
  "gemini-nano-banana-2.1",
  "gemini-3.1-flash-lite-image",
  "gemini-3-pro-image",
  "imagen-4.0-fast-generate-001",
]);
assert.equal(isImagenModel("imagen-4.0-fast-generate-001"), true);
assert.equal(openAiImageSizeForModel("dall-e-3", "16:9"), "1792x1024");
assert.equal(
  buildCandidateChain({ autoModel: true, preferred: "stale", discovered: geminiDiscovered.imageModels })[0],
  "gemini-nano-banana-2.1",
);
assert.equal(shouldSwitchModel(429, "RESOURCE_EXHAUSTED"), true);
assert.equal(shouldSwitchModel(401, "API_KEY_INVALID"), false);

// 11. Cloudflare Workers AI model routing, schema helpers, and response extraction
const cfDiscovered = classifyAndRankModels("CloudflareAI", [
  { id: "@cf/meta/llama-guard-3-8b" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  { id: "@cf/google/gemma-4-26b-a4b-it" },
  { id: "@cf/aisingapore/gemma-sea-lion-v4-27b-it" },
  { id: "@cf/black-forest-labs/flux-1-schnell" },
  { id: "@cf/black-forest-labs/flux-2-klein-4b" },
  { id: "@cf/black-forest-labs/flux-2-klein-9b" },
  { id: "@cf/leonardo/phoenix-1.0" },
]);
assert.equal(cfDiscovered.textModels[0], CLOUDFLARE_FREE_TEXT_MODELS[0]);
assert.equal(cfDiscovered.textModels.includes("@cf/meta/llama-guard-3-8b"), false);
assert.deepEqual(cfDiscovered.imageModels, [
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-2-klein-9b",
  "@cf/black-forest-labs/flux-1-schnell",
  "@cf/leonardo/phoenix-1.0",
]);
assert.equal(isCloudflareMultipartImageModel("@cf/black-forest-labs/flux-2-klein-4b"), true);
assert.equal(isCloudflareMultipartImageModel("@cf/black-forest-labs/flux-1-schnell"), false);
assert.equal(isCloudflareFluxSchnellModel("@cf/black-forest-labs/flux-1-schnell"), true);
assert.deepEqual(cloudflareImageDims("16:9"), { width: 1024, height: 576 });
assert.deepEqual(cloudflareImageDims("9:16"), { width: 576, height: 1024 });
assert.deepEqual(cloudflareImageDims("3:4"), { width: 640, height: 832 });
assert.deepEqual(cloudflareImageDims("1:1"), { width: 768, height: 768 });
assert.equal(detectBase64ImageMime("/9j/4AAQSkZJRg"), "image/jpeg");
assert.equal(detectBase64ImageMime("iVBORw0KGgoAAA"), "image/png");
assert.equal(extractWorkersAiText({ response: "Halo dunia" }), "Halo dunia");
assert.equal(
  extractWorkersAiText({
    result: { choices: [{ message: { content: "<think>cek</think>Naskah jadi." } }] },
  }),
  "Naskah jadi.",
);
assert.deepEqual(
  parseCloudflareRestCredentials(
    "https://api.cloudflare.com/client/v4",
    "0123456789abcdef0123456789abcdef:cf_token_test",
  ),
  { accountId: "0123456789abcdef0123456789abcdef", apiToken: "cf_token_test" },
);
assert.equal(shouldSwitchModel(403, "Model requires Workers Paid"), true);

// 12. Full Toonflow pipeline (legacy compatibility)
assert.equal(storyArcStages(5).length, 5);
assert.equal(cleanSourceText("Bab 1\r\nHalaman 1\r\nHalo   dunia\n\n\n\nBaru"), "Bab 1\nHalo dunia\n\nBaru");
const chaps = splitIntoChapters("Bab 1: Awal\nRaka mencari adiknya.\n\nBab 2: Gudang\nMonster terbangun.");
assert.equal(chaps.length, 2);
assert.equal(chaps[0].title, "Bab 1: Awal");

const parsedEvents = parseEventGraphResponse(
  JSON.stringify([
    { code: "EV01", stage: "Intro / Perkenalan", title: "Syal di Gerbang", summary: "@Raka menemukan syal kuning.", cause: "Adik hilang", effect: "Masuk gudang", conflict: "Gerbang terkunci", emotion: "cemas", location: "Gerbang Kota Tua", characters: ["@Raka"], durationSec: 8 },
    { code: "EV02", stage: "Masalah 1 (Pemicu)", title: "Monster Bangkit", summary: "@Raka menemukan @Nadia lalu @Monster bangun.", cause: "Masuk gudang", effect: "Terjebak", conflict: "Monster menyerang", emotion: "panik", location: "Lorong Gudang", characters: ["@Raka", "@Nadia", "@Monster"], durationSec: 8 },
  ]),
  2,
  8,
);
assert.equal(parsedEvents.length, 2);
assert.deepEqual(parsedEvents[0].characters, ["@Raka"]);

const extractedAssets = parseExtractedAssets(
  JSON.stringify([
    { tag: "@Raka", title: "Raka", category: "character", lockPrompt: "26-year-old Indonesian man olive jacket DSLR camera" },
    { tag: "@Nadia", title: "Nadia", category: "character", lockPrompt: "12-year-old Indonesian girl mustard yellow hoodie" },
    { tag: "@Monster", title: "Monster Gudang", category: "character", lockPrompt: "3m stone and black smoke monster amber eyes" },
    { tag: "@Gudang", title: "Gudang Rempah", category: "location", lockPrompt: "Interior of dilapidated colonial spice warehouse with wooden crates" },
  ]),
);
const tfStarter = createStarterProject("Tes Toonflow", { aspectRatio: "16:9", maxSegmentSec: 8 });
const withAssets = applyExtractedAssetsToProject(tfStarter, extractedAssets);
assert.equal(withAssets.addedCount, 4);
assert.ok(
  buildAssetReferenceImagePrompt(
    { kind: "asset", tag: "@Nadia", category: "character", lockPrompt: "12-year-old Indonesian girl yellow hoodie" },
    "Neo-noir",
  ).includes("Single full-body front-facing studio character reference portrait"),
);

const parsedScenes = parseScriptAgentResponse(
  JSON.stringify([
    { code: "SC01", stage: "Intro / Perkenalan", heading: "EXT. JALANAN KOTA TUA - MALAM", action: "@Raka memungut syal di depan gerbang.", dialogue: "Nadia, kamu di dalam?", emotion: "cemas" },
    { code: "SC02", stage: "Masalah 1 (Pemicu)", heading: "INT. GUDANG - MALAM", action: "@Monster keluar dari tembok.", dialogue: "Jangan mendekat!", emotion: "panik" },
  ]),
  parsedEvents,
);
assert.ok(formatScenesToScreenplay(parsedScenes).includes("BABAK 1 [Intro / Perkenalan]"));

const sbBeats = parseStoryboardBeats(
  JSON.stringify([
    { code: "E01", stage: "Intro / Perkenalan", durationSec: 8, visibleAssets: ["@Raka"], summary: "@Raka memungut syal @Nadia di trotoar luar depan @Gudang.", dialogue: "Nadia, kamu di dalam?", continuityLock: "Syal di tangan kiri", shotSize: "WS", cameraAngle: "Front", cameraMotion: "Push-In", visualPrompt: "Wide exterior rainy cobblestone street shot of a 26-year-old Indonesian man picking up a yellow scarf" },
    { code: "E02", stage: "Masalah 1 (Pemicu)", durationSec: 8, visibleAssets: ["@Raka", "@Nadia", "@Monster", "@Gudang"], summary: "@Raka dan @Nadia menghadapi @Monster di dalam @Gudang.", dialogue: "Jangan mendekat!", continuityLock: "Dalam gudang gelap", shotSize: "WS", cameraAngle: "Front", cameraMotion: "Pan Right", visualPrompt: "Inside dark warehouse, stone monster rising behind wooden crates" },
  ]),
  parsedEvents,
  parsedScenes,
  8,
);
assert.notEqual(sbBeats[0].cameraAngle, sbBeats[1].cameraAngle);

const rebuiltTf = rebuildSegmentsFromBeats(withAssets.project, sbBeats, { replaceExisting: true });
const rebuiltSegs = rebuiltTf.nodes.filter((n) => n.kind === "segment");
assert.equal(rebuiltSegs.length, 2);
const g01Incoming = rebuiltTf.edges.filter((e) => e.target === rebuiltSegs[0].id).map((e) => e.source);
const nadiaAsset = rebuiltTf.nodes.find((n) => n.kind === "asset" && n.data.kind === "asset" && n.data.tag === "@Nadia")!;
const monsterAsset = rebuiltTf.nodes.find((n) => n.kind === "asset" && n.data.kind === "asset" && n.data.tag === "@Monster")!;
const gudangAsset = rebuiltTf.nodes.find((n) => n.kind === "asset" && n.data.kind === "asset" && n.data.tag === "@Gudang")!;
assert.equal(g01Incoming.includes(nadiaAsset.id), false);
assert.equal(g01Incoming.includes(monsterAsset.id), false);
assert.equal(g01Incoming.includes(gudangAsset.id), false);

const convPatch = parseConversationalEditResponse(
  JSON.stringify({ shotSize: "CU", cameraAngle: "Low", cameraMotion: "Static", timelineSummary: "Wajah Raka tegang.", visualPrompt: "Close-up low angle of Raka sweating in rain" }),
  rebuiltSegs[0].data as SegmentNodeData,
);
assert.equal(convPatch.shotSize, "CU");
assert.equal(convPatch.cameraAngle, "Low");

const supReport = parseSupervisionResponse(
  JSON.stringify({ score: 88, verdict: "siap", summary: "Alur cerita utuh dan jelas.", strengths: ["Sebab-akibat kuat"], issues: [] }),
);
assert.equal(supReport.verdict, "siap");
assert.equal(supReport.score, 88);

// 13. Storyboard Studio v2: Idea -> Script -> Script-Grounded Assets (ACC) -> Per-Frame Continue + FLUX.2 0-based prompting
const v2Proj = createStoryboardProject("Kopi Senja", {
  idea: "Seorang barista muda bernama Dimas menemukan surat lama di bawah meja kafe.",
  aspectRatio: "16:9",
  visualStyle: VISUAL_STYLE_PRESETS[1].prompt, // Anime Modern (NOT photorealistic!)
});
assert.equal(v2Proj.schemaVersion, 2);
assert.equal(v2Proj.storyboard?.step, "script");

// Legacy migration sanity check
const migrated = ensureStoryboard(fixture);
assert.equal(migrated.assets.length, 2);
assert.equal(migrated.frames.length, 2);

const scriptBuilt = buildGenerateScriptPrompt({
  projectName: v2Proj.name,
  idea: v2Proj.storyboard!.idea,
  visualStyle: v2Proj.storyboard!.visualStyle,
  aspectRatio: "16:9",
});
assert.ok(scriptBuilt.prompt.includes("Kopi Senja"));

const extractBuilt = buildExtractAssetsFromScriptPrompt({
  projectName: v2Proj.name,
  scriptText: "ADEGAN 1 — KAFE SENJA\nDimas (24, apron cokelat) mengelap meja kayu lalu menemukan amplop biru.",
  visualStyle: v2Proj.storyboard!.visualStyle,
});
assert.ok(extractBuilt.prompt.includes("DILARANG menambah karakter"));

const parsedStoryAssets = parseExtractedStoryAssets(
  JSON.stringify([
    { name: "Dimas", category: "character", roleInScript: "Tokoh utama (Adegan 1): barista muda", visualDesc: "24-year-old Indonesian man, tidy black hair, white shirt with dark brown barista apron" },
    { name: "Kafe Senja", category: "location", roleInScript: "Lokasi utama (Adegan 1): kafe kayu hangat", visualDesc: "Cozy wooden Indonesian coffee shop interior, warm hanging bulbs, espresso counter" },
    { name: "Amplop Biru", category: "prop", roleInScript: "Properti kunci (Adegan 1): surat lama", visualDesc: "Weathered pale blue paper envelope tied with twine" },
  ]),
);
assert.equal(parsedStoryAssets.length, 3);
assert.equal(assetAspectFor("character", "16:9"), "3:4");
assert.equal(assetAspectFor("prop", "16:9"), "1:1");
assert.equal(assetAspectFor("location", "9:16"), "9:16");

// Anime visual style must NEVER be contaminated with hardcoded "Photorealistic"
const animeAssetPrompt = buildAssetImagePrompt(parsedStoryAssets[0], VISUAL_STYLE_PRESETS[1].prompt);
assert.ok(animeAssetPrompt.includes("Modern high-budget Japanese anime"));
assert.equal(/photorealistic/i.test(animeAssetPrompt), false, "Anime asset prompt must not force photorealistic");

// Approve assets with mock thumbnails
const accAssets = parsedStoryAssets.map((a, idx) => ({
  ...a,
  approved: true,
  candidates: [{ id: `c${idx}`, dataUrl: `data:image/png;base64,iVBORw0KGgoAAA==`, createdAt: 1 }],
  selectedCandidateId: `c${idx}`,
}));

const nextPrompt1 = buildNextFramePrompt({
  projectName: v2Proj.name,
  scriptText: "ADEGAN 1 — KAFE SENJA\nDimas mengelap meja lalu melihat amplop biru.",
  visualStyle: VISUAL_STYLE_PRESETS[1].prompt,
  aspectRatio: "16:9",
  approvedAssets: accAssets,
  previousFrames: [],
});
assert.ok(nextPrompt1.prompt.includes(accAssets[0].id));

// Frame 1 parsing strictly ignores hallucinated asset IDs
const parsedF1 = parseNextFrameResponse(
  JSON.stringify({
    title: "Menyapu Meja Kafe",
    scriptExcerpt: "Dimas mengelap meja kayu.",
    sceneSummary: "Dimas mengelap meja kayu kafe yang tenang saat senja.",
    dialogue: "",
    shotSize: "MS",
    cameraAngle: "Front",
    assetIds: [accAssets[0].id, accAssets[1].id, "hallucinated-nonexistent-id"],
    sameLocationAsPrev: true, // Frame 1 must force false!
    visualPrompt: "Barista wiping a wooden table inside a cozy warm coffee shop at sunset",
    storyFinished: false,
  }),
  accAssets,
  [],
);
assert.equal(parsedF1.frame.index, 1);
assert.deepEqual(parsedF1.frame.assetIds, [accAssets[0].id, accAssets[1].id]);
assert.equal(parsedF1.frame.sameLocationAsPrev, false);

// Add generated image to Frame 1, then test Frame 2 Continue + FLUX.2 0-based prompt
parsedF1.frame.candidates = [{ id: "fc1", dataUrl: "data:image/png;base64,iVBORw0KGgoAAA==", createdAt: 2 }];
parsedF1.frame.selectedCandidateId = "fc1";

const parsedF2 = parseNextFrameResponse(
  JSON.stringify({
    title: "Menemukan Amplop Biru",
    scriptExcerpt: "Dimas melihat amplop biru di bawah meja.",
    sceneSummary: "Dimas membungkuk dan meraih amplop biru tua di bawah meja.",
    dialogue: "Surat siapa ini?",
    shotSize: "MS", // Same as F1 -> parser must auto-break identical framing!
    cameraAngle: "Front",
    assetIds: [accAssets[0].id, accAssets[2].id],
    sameLocationAsPrev: true,
    visualPrompt: "Barista kneeling to pick up a weathered pale blue envelope under the wooden cafe table",
    storyFinished: true,
  }),
  accAssets,
  [parsedF1.frame],
);
assert.equal(parsedF2.frame.index, 2);
assert.equal(parsedF2.storyFinished, true);
assert.notEqual(parsedF2.frame.cameraAngle, parsedF1.frame.cameraAngle, "Adjacent identical framing must vary");

const composedF2 = composeStoryboardFramePrompt(
  parsedF2.frame,
  { visualStyle: VISUAL_STYLE_PRESETS[1].prompt, assets: accAssets },
  parsedF1.frame,
);
assert.equal(composedF2.refs.length, 3, "Char + Prop + Previous Frame continuity = 3 refs");
assert.ok(composedF2.prompt.includes("image 0 shows character Dimas"), "Must use 0-based FLUX.2 index image 0");
assert.ok(composedF2.prompt.includes("image 1 shows object Amplop Biru"), "Must use 0-based FLUX.2 index image 1");
assert.ok(composedF2.prompt.includes("image 2 shows the previous shot's lighting"), "Must reference previous frame as image 2");
assert.equal(/photorealistic/i.test(composedF2.prompt), false, "Must obey Anime visualStyle without hardcoded photorealistic");

const editPrompt = buildQuickEditPrompt({
  mode: "frame",
  label: "Frame 2",
  currentVisualDesc: parsedF2.frame.visualPrompt,
  instruction: "buat wajahnya lebih terkejut",
  visualStyle: VISUAL_STYLE_PRESETS[1].prompt,
});
assert.ok(editPrompt.prompt.includes("image 0"));
const parsedEdit = parseQuickEditResponse(
  JSON.stringify({ editPrompt: "Edit image 0: make the barista look surprised", updatedVisualDesc: "Surprised barista holding blue envelope" }),
  VISUAL_STYLE_PRESETS[1].prompt,
  "buat wajahnya lebih terkejut",
);
assert.ok(parsedEdit.editPrompt.includes("image 0"));

const populatedV2: NmcProject = {
  ...v2Proj,
  storyboard: {
    ...v2Proj.storyboard!,
    scriptText: "ADEGAN 1 — KAFE SENJA",
    scriptApproved: true,
    assets: accAssets,
    assetsApproved: true,
    frames: [parsedF1.frame, parsedF2.frame],
  },
};
assert.ok(buildStoryboardMarkdown(populatedV2).includes("Frame 02: Menemukan Amplop Biru"));
const sbZip = buildStoryboardZip(populatedV2);
assert.equal(sbZip[0], 0x50);
assert.equal(sbZip[1], 0x4b);

// 14. Per-Segment Script & 4-7 Panel Smooth Anti-Jump Storyboard Engine
assert.equal(clampTargetPanels(2), 4);
assert.equal(clampTargetPanels(5), 5);
assert.equal(clampTargetPanels(9), 7);
assert.equal(clampTargetPanels(undefined), 5);

const multiSegScript = [
  "SEGMEN 1 — Tiba di Pelabuhan | EXT. DERMAGA KOTA - SUBUH",
  "Dimas turun dari kapal, menyusuri jalan batu, berhenti di bawah lampu jalan membaca surat, lalu bertanya arah ke toko roti.",
  "",
  "SEGMEN 2 — Menuju Fajar | EXT. JALAN KAMPUNG - PAGI",
  "Dimas berjalan mengikuti petunjuk arah sambil tersenyum menyambut matahari terbit.",
].join("\n");

const parsedSegs = parseScriptIntoSegments(multiSegScript, [], 5);
assert.equal(parsedSegs.length, 2);
assert.equal(parsedSegs[0].title, "Tiba di Pelabuhan");
assert.equal(parsedSegs[0].locationHint, "EXT. DERMAGA KOTA - SUBUH");
assert.equal(parsedSegs[0].targetPanels, 5);
assert.equal(parsedSegs[1].title, "Menuju Fajar");

const formattedBack = formatSegmentsToScript(parsedSegs);
assert.ok(formattedBack.includes("SEGMEN 1 — Tiba di Pelabuhan | EXT. DERMAGA KOTA - SUBUH"));
assert.ok(formattedBack.includes("SEGMEN 2 — Menuju Fajar | EXT. JALAN KAMPUNG - PAGI"));

// Paragraph fallback when user pastes plain prose without SEGMEN headers
const plainParsed = parseScriptIntoSegments("Paragraf satu tentang kedatangan.\n\nParagraf dua tentang perjalanan pulang.");
assert.equal(plainParsed.length, 2);

const seg1Target = { ...parsedSegs[0], targetPanels: 5 };
const seg2Target = { ...parsedSegs[1], targetPanels: 4 };

const segPanel1Prompt = buildNextFramePrompt({
  projectName: "Pelabuhan Subuh",
  scriptText: formattedBack,
  visualStyle: VISUAL_STYLE_PRESETS[1].prompt,
  aspectRatio: "9:16",
  approvedAssets: accAssets,
  previousFrames: [],
  activeSegment: seg1Target,
  segmentFrames: [],
  totalSegments: 2,
});
assert.ok(segPanel1Prompt.prompt.includes("PANEL 1 dari 5 pada SEGMEN 1"));
assert.ok(segPanel1Prompt.prompt.includes("JANGAN langsung melompat"));

const segP1 = parseNextFrameResponse(
  JSON.stringify({
    title: "Tiba di Pelabuhan",
    scriptExcerpt: "Dimas turun dari kapal.",
    sceneSummary: "Dimas berdiri di dermaga memegang koper menatap lampu jalan subuh.",
    dialogue: "",
    shotSize: "WS",
    cameraAngle: "Front",
    assetIds: [accAssets[0].id, accAssets[1].id],
    sameLocationAsPrev: false,
    visualPrompt: "Wide shot of Dimas standing calmly on a misty harbor pier next to a glowing streetlamp at dawn",
    segmentFinished: false,
    storyFinished: false,
  }),
  accAssets,
  [],
  { activeSegment: seg1Target, segmentFrames: [] },
);
assert.equal(segP1.frame.segmentId, seg1Target.id);
assert.equal(segP1.frame.panelNumber, 1);
assert.equal(segP1.segmentFinished, false);

const segP2 = parseNextFrameResponse(
  JSON.stringify({
    title: "Menyusuri Jalan",
    scriptExcerpt: "Menyusuri jalan batu.",
    sceneSummary: "Dimas melangkah pelan menyusuri gang batu basah.",
    dialogue: "",
    shotSize: "MS",
    cameraAngle: "Front",
    assetIds: [accAssets[0].id],
    visualPrompt: "Medium shot of Dimas walking forward along a quiet misty cobblestone alley at dawn",
    segmentFinished: false,
    storyFinished: false,
  }),
  accAssets,
  [segP1.frame],
  { activeSegment: seg1Target, segmentFrames: [segP1.frame] },
);
assert.equal(segP2.frame.segmentId, seg1Target.id);
assert.equal(segP2.frame.panelNumber, 2);
assert.equal(segP2.frame.sameLocationAsPrev, true, "Panel 2 inside a segment must default to continuous location/lighting");

const seg2P1 = parseNextFrameResponse(
  JSON.stringify({
    title: "Menuju Fajar",
    scriptExcerpt: "Dimas berjalan menuju fajar.",
    sceneSummary: "Dimas melangkah ringan ke arah cahaya matahari pagi.",
    dialogue: "",
    shotSize: "WS",
    cameraAngle: "Rear 3/4",
    assetIds: [accAssets[0].id],
    sameLocationAsPrev: false,
    visualPrompt: "Wide rear three-quarter shot of Dimas walking down a sunlit village street toward warm golden dawn",
    segmentFinished: false,
    storyFinished: false,
  }),
  accAssets,
  [segP1.frame, segP2.frame],
  { activeSegment: seg2Target, segmentFrames: [] },
);
assert.equal(seg2P1.frame.segmentId, seg2Target.id);
assert.equal(seg2P1.frame.panelNumber, 1);

// Reindexing sorts out-of-order array strictly by Segment order and keeps per-segment panelNumber clean
const reindexed = reindexStoryboardFrames([seg2P1.frame, segP1.frame, segP2.frame], [seg1Target, seg2Target]);
assert.deepEqual(
  reindexed.map((f) => `${f.segmentId}:${f.panelNumber}:${f.index}`),
  [`${seg1Target.id}:1:1`, `${seg1Target.id}:2:2`, `${seg2Target.id}:1:3`],
);

const segmentedProject: NmcProject = {
  ...v2Proj,
  storyboard: {
    ...v2Proj.storyboard!,
    scriptText: formattedBack,
    segments: [seg1Target, seg2Target],
    scriptApproved: true,
    assets: accAssets,
    assetsApproved: true,
    frames: reindexed,
  },
};
assert.equal(getStoryboardSegments(segmentedProject.storyboard!).length, 2);
assert.equal(getSegmentFrames(segmentedProject.storyboard!, seg1Target.id, 0).length, 2);
assert.equal(getSegmentFrames(segmentedProject.storyboard!, seg2Target.id, 1).length, 1);
const segMd = buildStoryboardMarkdown(segmentedProject);
assert.ok(segMd.includes("### Segmen 01: Tiba di Pelabuhan"));
assert.ok(segMd.includes("#### Panel 2 — Frame 02: Menyusuri Jalan"));
assert.ok(segMd.includes("### Segmen 02: Menuju Fajar"));

console.log("nmcGen pipeline tests: all passed");
