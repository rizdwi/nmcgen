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
import { mergeProjects, projectToSupabaseRow, packProjectForCloud, unpackProjectFromCloud } from "./supabaseSync.ts";
import {
  assetAspectFor,
  auditStoryCoherence,
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
  extractStorySpineFromScript,
  formatSegmentsToScript,
  getSegmentFrames,
  getStoryboardSegments,
  parseExtractedStoryAssets,
  parseNextFrameResponse,
  parseQuickEditResponse,
  parseScriptIntoSegments,
  reindexStoryboardFrames,
  selectFrameReferences,
  trimCandidates,
} from "./storyboard.ts";
import {
  buildAntigravityGeminiHandoff,
  buildFlowConnectorAgentPrompt,
  buildFlowConnectorCliCommand,
  buildFlowConnectorFolderSlug,
  buildFlowConnectorRunnerScript,
  buildOmniAnimationPackZip,
  buildOmniBatchJobsJson,
  buildOmniClipPlans,
  buildOmniInteractionsPayload,
  clampOmniDuration,
  extractOmniVideoFromInteraction,
  extractVideoIndexFromFilename,
  matchDownloadedVideoToPlan,
  OMNI_MODEL_ID,
  validateGoogleFileUri,
} from "./omniAnimation.ts";
import {
  buildFlowAssetImagePackZip,
  buildFlowImageFolderSlug,
  buildFlowPanelPrompt,
  buildFlowStoryboardImagePackZip,
  extractImageIndexFromFilename,
  FLOW_IMAGE_MODELS,
  matchDownloadedImageToSlot,
} from "./flowImageConnector.ts";
import { ANIMATIC_ATMOSPHERES, ANIMATIC_SCORES } from "./animaticAudio.ts";
import type { NmcProject, SegmentNodeData } from "./types.ts";
import {
  buildLocalCdpStoryboardSpec,
  buildLocalMotionRenderPackZip,
  buildMotionTimeline,
  computeFitRect,
  computeMotionTransform,
  fullHdDimsForAspect,
  sampleMotionTimeline,
} from "./motionEngine.ts";

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

// 6. Connection rules & auto-arrange
assert.equal(canConnect("asset", "segment"), true);
assert.equal(canConnect("export", "script"), false);
assert.equal(autoArrangeNodes(fixture).length, fixture.nodes.length);

// 7. Zero-dependency ZIP output header check
const zipBytes = buildZip([
  { name: "project.json", data: '{"name":"nmcGen"}' },
  { name: "google_flow_prompts.md", data: flowPrompt },
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

// 9b. Dedupe data URL gambar duplikat saat tulis cloud & pulihkan saat baca
const dupImg = "data:image/jpeg;base64," + "A".repeat(5000);
const dupProject = {
  ...edited,
  storyboard: {
    ...edited.storyboard,
    assets: [
      { id: "a1", candidates: [{ id: "c1", dataUrl: dupImg }] },
      { id: "a2", candidates: [{ id: "c2", dataUrl: dupImg }] },
    ],
    frames: [{ id: "f1", candidates: [{ id: "c3", dataUrl: dupImg }] }],
  },
};
const packed = packProjectForCloud(dupProject as never);
assert.ok(JSON.stringify(packed).length < JSON.stringify(dupProject).length);
const restored = unpackProjectFromCloud(packed);
assert.deepEqual(restored, dupProject);
assert.deepEqual(unpackProjectFromCloud(edited), edited);

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

// 12. Candidate history cap preserves active selection even if older than recent N
const sampleCandidates = [
  { id: "c1", dataUrl: "data:image/jpeg;base64,AAA", createdAt: 1 },
  { id: "c2", dataUrl: "data:image/jpeg;base64,BBB", createdAt: 2 },
  { id: "c3", dataUrl: "data:image/jpeg;base64,CCC", createdAt: 3 },
  { id: "c4", dataUrl: "data:image/jpeg;base64,DDD", createdAt: 4 },
  { id: "c5", dataUrl: "data:image/jpeg;base64,EEE", createdAt: 5 },
];
assert.deepEqual(
  trimCandidates(sampleCandidates.slice(0, 3), "c2", 3).map((c) => c.id),
  ["c1", "c2", "c3"],
  "Arrays within maxCount must remain untouched",
);
assert.deepEqual(
  trimCandidates(sampleCandidates, "c5", 3).map((c) => c.id),
  ["c3", "c4", "c5"],
  "When selectedId is recent, keep the latest 3 candidates",
);
assert.deepEqual(
  trimCandidates(sampleCandidates, "c1", 3).map((c) => c.id),
  ["c1", "c4", "c5"],
  "When selectedId is older than latest 3, keep selectedId plus newest 2",
);
assert.deepEqual(
  trimCandidates(sampleCandidates, undefined, 3).map((c) => c.id),
  ["c3", "c4", "c5"],
);

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

// 15. Step 4 Animation: Antigravity / Gemini Handoff & Gemini Omni 1.2 Flash Interactions API
assert.equal(OMNI_MODEL_ID, "gemini-omni-1.2-flash");
assert.equal(clampOmniDuration(20, "segment"), 10, "Segment First+Last frame interpolation in Omni 1.2 must cap at 10s");
assert.equal(clampOmniDuration(15, "transition"), 10, "First+last frame interpolation in Omni 1.2 must cap at 10s");
assert.equal(clampOmniDuration(14, "extend"), 10, "Video extension in Omni 1.2 must cap at 10s");
assert.equal(clampOmniDuration(20, "panel"), 15);
assert.equal(clampOmniDuration(1, "panel"), 3);

// SSRF protection on Google Files API URIs
assert.equal(
  validateGoogleFileUri("https://generativelanguage.googleapis.com/v1beta/files/abc123_vid:download?alt=media").ok,
  true,
);
assert.equal(validateGoogleFileUri("https://evil.example.com/v1beta/files/abc123").ok, false);
assert.equal(validateGoogleFileUri("http://127.0.0.1:8080/v1beta/files/abc").ok, false);

// Attach mock images to reindexed panels to test clip planning modes
const renderedSegmented: NmcProject = {
  ...segmentedProject,
  storyboard: {
    ...segmentedProject.storyboard!,
    frames: segmentedProject.storyboard!.frames.map((f, i) => ({
      ...f,
      candidates: [{ id: `anim-c-${i}`, dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==", createdAt: 10 }],
      selectedCandidateId: `anim-c-${i}`,
    })),
  },
};

const segPlans = buildOmniClipPlans(renderedSegmented, { mode: "segment", durationSec: 12, resolution: "720p" });
assert.equal(segPlans.length, 2);
assert.equal(segPlans[0].images.length, 2, "Segment mode sends only Start + End frame");
assert.equal(segPlans[0].durationSec, 10, "Segment First+Last frame must cap at 10s");
assert.equal(segPlans[0].prompt.includes("<FIRST_FRAME>"), false, "Must never emit deprecated Omni tags");
assert.ok(segPlans[0].prompt.includes("Use the first image as the starting frame and the second image as the final frame"));
assert.ok(segPlans[0].prompt.includes("[0-"), "Segment prompt must include timestamped beat pacing");

// 7-panel segment must strictly pick ONLY 2 frames: Panel 1 (start) and Panel 7 (end)
const sevenPanelFrames = Array.from({ length: 7 }, (_, i) => ({
  ...renderedSegmented.storyboard!.frames[0],
  id: `p7-${i + 1}`,
  segmentId: seg1Target.id,
  panelNumber: i + 1,
  index: i + 1,
  title: `Panel ${i + 1}`,
}));
const sevenPanelProject: NmcProject = {
  ...renderedSegmented,
  storyboard: {
    ...renderedSegmented.storyboard!,
    segments: [{ ...seg1Target, targetPanels: 7 }],
    frames: sevenPanelFrames,
  },
};
const sevenPlans = buildOmniClipPlans(sevenPanelProject, { mode: "segment", durationSec: 12, resolution: "720p" });
assert.equal(sevenPlans[0].images.length, 2, "Must only attach Start Frame + End Frame");
assert.ok(sevenPlans[0].images[0].label.includes("Panel 1"), "Must keep starting Panel 1");
assert.ok(sevenPlans[0].images[1].label.includes("Panel 7"), "Must keep ending Panel 7");
const segBatchJobs = JSON.parse(buildOmniBatchJobsJson(sevenPanelProject, sevenPlans)) as Array<Record<string, unknown>>;
assert.equal(segBatchJobs[0].first_frame, "keyframes/S01_P01.jpg");
assert.equal(segBatchJobs[0].last_frame, "keyframes/S01_P07.jpg");

const transPlans = buildOmniClipPlans(renderedSegmented, { mode: "transition", durationSec: 15, resolution: "1080p" });
assert.equal(transPlans[0].durationSec, 10, "Transition mode must clamp duration to 10s max");
assert.equal(transPlans[0].images.length, 2, "Transition clip pairs Panel 1 -> Panel 2");
assert.ok(transPlans[0].prompt.includes("Use the first image as the starting frame and the second image as the final frame"));

const panelPlans = buildOmniClipPlans(renderedSegmented, { mode: "panel", durationSec: 6, resolution: "360p" });
assert.equal(panelPlans.length, 3);
assert.equal(panelPlans[0].images.length, 1);

const omniPayload = buildOmniInteractionsPayload({
  prompt: transPlans[0].prompt,
  images: [{ mimeType: "image/jpeg", data: "/9j/4AAQ==" }],
  durationSec: 12,
  resolution: "720p",
  aspectRatio: "16:9",
  mode: "transition",
  previousInteractionId: "v1_prev_123",
});
assert.equal(omniPayload.model, "gemini-omni-1.2-flash");
assert.equal(omniPayload.background, true);
assert.equal(omniPayload.store, true);
assert.equal(omniPayload.previous_interaction_id, "v1_prev_123");
assert.deepEqual(omniPayload.response_format, {
  type: "video",
  delivery: "uri",
  duration: "10s",
  resolution: "720p",
  aspect_ratio: "16:9",
});
assert.equal("temperature" in omniPayload, false, "Omni 1.2 Interactions API rejects temperature param");

// Parse BOTH official REST steps[] URI response AND inline base64 response
const parsedRestUri = extractOmniVideoFromInteraction({
  id: "v1_int_001",
  status: "completed",
  steps: [
    { type: "thought", content: [{ type: "thought", text: "planning" }] },
    {
      type: "model_output",
      content: [
        {
          type: "video",
          mime_type: "video/mp4",
          uri: "https://generativelanguage.googleapis.com/v1beta/files/vid_001:download?alt=media",
        },
      ],
    },
  ],
});
assert.equal(parsedRestUri.id, "v1_int_001");
assert.equal(parsedRestUri.done, true);
assert.equal(parsedRestUri.failed, false);
assert.ok(parsedRestUri.fileUri?.includes("files/vid_001"));

const parsedInline = extractOmniVideoFromInteraction({
  id: "v1_int_002",
  status: "completed",
  output_video: { mime_type: "video/mp4", data: "AAAAIGZ0eXBpc29t" },
});
assert.equal(parsedInline.videoBase64, "AAAAIGZ0eXBpc29t");

const handoffMd = buildAntigravityGeminiHandoff(renderedSegmented, segPlans);
assert.ok(handoffMd.includes("gemini-omni-1.2-flash"));
assert.ok(handoffMd.includes("keyframes/S01_P01.jpg"));

const batchJobs = JSON.parse(buildOmniBatchJobsJson(renderedSegmented, transPlans)) as Array<Record<string, unknown>>;
assert.equal(batchJobs[0].first_frame, "keyframes/S01_P01.jpg");
assert.equal(batchJobs[0].last_frame, "keyframes/S01_P02.jpg");

const omniZip = buildOmniAnimationPackZip(renderedSegmented, segPlans, { flowModel: "omni-flash" });
assert.equal(omniZip[0], 0x50);
assert.equal(omniZip[1], 0x4b);
const omniZipAscii = new TextDecoder("latin1").decode(omniZip);
assert.ok(omniZipAscii.includes("run_flow_connector.mjs"), "ZIP must bundle cross-platform Flow Connector runner");
assert.ok(omniZipAscii.includes("run_flow_connector.bat"), "ZIP must bundle Windows .bat launcher");
assert.ok(omniZipAscii.includes("run_flow_connector.command"), "ZIP must bundle macOS .command launcher");
assert.ok(omniZipAscii.includes("FLOW_CONNECTOR_PROMPT.md"), "ZIP must bundle Flow Connector agent prompt");

// 16. Flow Connector CLI, Runner Script, Agent Prompt & Smart Filename Matcher
assert.equal(buildFlowConnectorFolderSlug("Subuh di Kampung Asing!"), "nmcgen-subuh-di-kampung-asing");
assert.equal(extractVideoIndexFromFilename("1 - dawn harbor scene.mp4"), 1);
assert.equal(extractVideoIndexFromFilename("02_transition.mp4"), 2);
assert.equal(extractVideoIndexFromFilename("Downloads/nmcgen-test/S02_render.mp4"), 2);
assert.equal(extractVideoIndexFromFilename("20261126_1732612.mp4"), null, "Must not treat timestamps as clip index");

// Out-of-order Flow Connector download `2 - ...mp4` lands cleanly on Clip 2 even while Clip 1 is waiting!
const matchedSecond = matchDownloadedVideoToPlan(
  "2 - menuju fajar.mp4",
  segPlans,
  new Set(),
  segPlans[0].id,
);
assert.equal(matchedSecond?.id, segPlans[1].id, "Indexed filename must route to exact segment index");

const matchedFallback = matchDownloadedVideoToPlan(
  "google_flow_export.mp4",
  segPlans,
  new Set(),
  segPlans[0].id,
);
assert.equal(matchedFallback?.id, segPlans[0].id, "Unnumbered filename must fall back to waiting segment");

const flowCliOmni = buildFlowConnectorCliCommand(segPlans[0], {
  index: 1,
  folderSlug: "nmcgen-kopi-senja",
  model: "omni-flash",
  wait: true,
});
assert.ok(flowCliOmni.includes("flow-auto generate create flow-frame-to-video"));
assert.ok(flowCliOmni.includes('--image "./keyframes/S01_P01.jpg" --image "./keyframes/S01_P02.jpg"'));
assert.ok(flowCliOmni.includes("--model omni-flash"));
assert.ok(flowCliOmni.includes("--duration 10"));
assert.ok(flowCliOmni.includes("--resolution 720p"));
assert.ok(flowCliOmni.includes("--index 1 --folder nmcgen-kopi-senja --wait --wait-timeout 15"));

const flowCliVeo = buildFlowConnectorCliCommand(segPlans[0], {
  index: 1,
  folderSlug: "nmcgen-kopi-senja",
  model: "veo-3.1-fast",
});
assert.ok(flowCliVeo.includes("--model veo-3.1-fast"));
assert.equal(flowCliVeo.includes("--duration"), false, "Veo models use fixed 8s and omit --duration flag");

const runnerCode = buildFlowConnectorRunnerScript(renderedSegmented, segPlans, { model: "omni-flash" });
assert.ok(runnerCode.includes('spawnSync("flow-auto"'));
assert.ok(runnerCode.includes("keyframes/S01_P01.jpg"));
assert.ok(runnerCode.includes("keyframes/S01_P02.jpg"));

const agentPrompt = buildFlowConnectorAgentPrompt(renderedSegmented, segPlans, { model: "omni-flash" });
assert.ok(agentPrompt.includes("flow-auto status --site flow"));
assert.ok(agentPrompt.includes("node run_flow_connector.mjs"));

// 17. Flow Connector Nano Banana 2 Lite Image Generation (Step 2 Assets & Step 3 Storyboard Panels)
assert.equal(FLOW_IMAGE_MODELS[0].value, "nano-banana-2-lite");
assert.equal(buildFlowImageFolderSlug("Hujan Pertama di Stasiun!", "assets"), "nmcgen-hujan-pertama-di-stasiun-assets");
assert.equal(buildFlowImageFolderSlug("Hujan Pertama di Stasiun!", "panels"), "nmcgen-hujan-pertama-di-stasiun-panels");

assert.equal(extractImageIndexFromFilename("1 - Raka.png"), 1);
assert.equal(extractImageIndexFromFilename("02_panel.jpg"), 2);
assert.equal(extractImageIndexFromFilename("A03_amplop.webp"), 3);
assert.equal(extractImageIndexFromFilename("P08_ending.png"), 8);
assert.equal(extractImageIndexFromFilename("20261126_161022.png"), null, "Must ignore date timestamps");

const assetSlots = accAssets;
const matchedAsset2 = matchDownloadedImageToSlot("2 - Kafe Senja.png", assetSlots, new Set([assetSlots[0].id]));
assert.equal(matchedAsset2?.id, assetSlots[1].id);
const matchedAssetFallback = matchDownloadedImageToSlot("google_flow_img.png", assetSlots, new Set([assetSlots[0].id]));
assert.equal(matchedAssetFallback?.id, assetSlots[1].id, "Unnumbered image must fall back to first empty slot");
const matchedAssetUpgrade = matchDownloadedImageToSlot(
  "1 - Dimas.png",
  assetSlots,
  new Set([assetSlots[0].id]),
  { allowOverwriteIndexed: true },
);
assert.equal(matchedAssetUpgrade?.id, assetSlots[0].id, "Explicitly indexed file can upgrade existing slot as new candidate");

// Asset ZIP pack with slot 1 already drawn & slots 2..3 missing -> stable 1-based indices 2 and 3!
const partialAssetsSb = {
  ...segmentedProject.storyboard!,
  assets: accAssets.map((a, idx) =>
    idx === 0 ? a : { ...a, candidates: [], selectedCandidateId: undefined },
  ),
};
const assetPack = buildFlowAssetImagePackZip("Kopi Senja", partialAssetsSb, {
  model: "nano-banana-2-lite",
  onlyMissing: true,
});
assert.equal(assetPack.zipBytes[0], 0x50);
assert.equal(assetPack.zipBytes[1], 0x4b);
assert.equal(assetPack.jobCount, 2, "Only missing assets should be queued when onlyMissing=true");
assert.ok(assetPack.runnerScript.includes('"index": 2'), "Missing asset #2 must keep stable 1-based slot index 2");
assert.ok(assetPack.runnerScript.includes('"index": 3'), "Missing asset #3 must keep stable 1-based slot index 3");
assert.ok(assetPack.runnerScript.includes("flow-text-to-image"));
assert.ok(assetPack.runnerScript.includes("nano-banana-2-lite"));
const assetZipAscii = new TextDecoder("latin1").decode(assetPack.zipBytes);
assert.ok(assetZipAscii.includes("run_flow_images.mjs"));
assert.ok(assetZipAscii.includes("run_flow_images.bat"));
assert.ok(assetZipAscii.includes("run_flow_images.command"));
assert.ok(assetZipAscii.includes("FLOW_ASSETS_PROMPT.md"));

// Storyboard panel prompt uses Nano Banana natural-language references (NOT FLUX.2 0-based "image 0")
const flowPanelPrompt = buildFlowPanelPrompt(
  segmentedProject.storyboard!.frames[0],
  segmentedProject.storyboard!,
  [accAssets[0], accAssets[1]],
);
assert.ok(flowPanelPrompt.includes('Reference image 1 shows character "Dimas"'));
assert.ok(flowPanelPrompt.includes('Reference image 2 shows location "Kafe Senja"'));
assert.equal(flowPanelPrompt.includes("image 0"), false, "Nano Banana prompt must not use FLUX.2 0-based image 0 syntax");

// Storyboard panel ZIP pack bundles ACC refs/ and preserves global 1-based slot index for missing panels
const partialPanelsSb = {
  ...renderedSegmented.storyboard!,
  frames: renderedSegmented.storyboard!.frames.map((f, idx) =>
    idx === 0 ? f : { ...f, candidates: [], selectedCandidateId: undefined },
  ),
};
const panelPack = buildFlowStoryboardImagePackZip("Kopi Senja", partialPanelsSb, {
  model: "nano-banana-2-lite",
  onlyMissing: true,
});
assert.equal(panelPack.zipBytes[0], 0x50);
assert.equal(panelPack.zipBytes[1], 0x4b);
assert.equal(panelPack.jobCount, 2, "Only missing panels (#2 & #3) should be queued");
assert.ok(panelPack.runnerScript.includes('"index": 2'));
assert.ok(panelPack.runnerScript.includes('"index": 3'));
assert.ok(panelPack.runnerScript.includes("flow-image-to-image"));
assert.ok(panelPack.runnerScript.includes("refs/01_dimas.png"));
const panelZipAscii = new TextDecoder("latin1").decode(panelPack.zipBytes);
assert.ok(panelZipAscii.includes("refs/01_dimas.png"), "Panel ZIP must bundle ACC reference image files");
assert.ok(panelZipAscii.includes("FLOW_PANELS_PROMPT.md"));

// 18. Cinema Animatic atmosphere & built-in soundtrack presets
assert.ok(ANIMATIC_ATMOSPHERES.some((a) => a.value === "rain"));
assert.ok(ANIMATIC_ATMOSPHERES.some((a) => a.value === "golden"));
assert.ok(ANIMATIC_SCORES.some((s) => s.value === "rain_piano"));
assert.ok(ANIMATIC_SCORES.some((s) => s.value === "morning_warm"));

// 19. Unified Story Spine (Benang Merah), Coherence Audit & Anti-Ghosting / Anti-Shot-Lock Engine
const spineScript = [
  "BENANG MERAH: Kael mencari adiknya yang tersesat di jalur hujan, menemukan suar api petunjuk, lalu menyelamatkannya di pondok puncak.",
  "",
  "SEGMEN 1 — Misi di Tengah Badai | EXT. JALUR HUTAN - MALAM",
  'Kael memeluk ransel obat sambil memanggil adiknya, "Reno, tunggu aku!"',
  "",
  "SEGMEN 2 — Jejak Lentera | EXT. TEBING BASAH - MALAM",
  'Kael menemukan syal merah dan jejak suar hangat. "Dia masih di depan, belum jauh."',
  "",
  "SEGMEN 3 — Api Penunjuk | EXT. BATU DATAR HUTAN - MALAM",
  'Kael menyalakan suar balasan dari api yang tidak padam itu. "Kalau kau lihat cahaya ini, balas aku!"',
  "",
  "SEGMEN 4 — Akhirnya Bertemu | INT. PONDOK KAYU - MALAM",
  'Reno membuka pintu pondok sambil menangis lega. "Kak Kael! Aku tahu kau pasti datang."',
].join("\n");

const extractedSpine = extractStorySpineFromScript(spineScript);
assert.ok(extractedSpine.storySpine.includes("Kael mencari adiknya"));
assert.equal(extractedSpine.cleanScript.startsWith("SEGMEN 1"), true);

const spineSegs = parseScriptIntoSegments(spineScript, [], 5);
assert.equal(spineSegs.length, 4, "BENANG MERAH preamble must never create a ghost Segment 0");
assert.equal(spineSegs[0].title, "Misi di Tengah Badai");

const goodAudit = auditStoryCoherence({
  scriptText: extractedSpine.cleanScript,
  segments: spineSegs,
  storySpine: extractedSpine.storySpine,
  frames: [],
});
assert.equal(goodAudit.ok, true, "Well-structured 4-segment story with spine & dialogue must pass audit");

// Regression: shot-list-only nearly silent script (like original Fire on the Rain Trail) must be flagged!
const weakShotListScript = [
  "SEGMEN 1 — Jalan Hujan | EXT. HUTAN - MALAM",
  "1. Wide shot hujan deras. 2. Close-up lumpur. 3. Kamera fokus pada sepatu bot.",
  "",
  "SEGMEN 2 — Melihat Api | EXT. BATU - MALAM",
  'Kamera memperlihatkan api. "Bagaimana mungkin..."',
].join("\n");
const weakAudit = auditStoryCoherence({
  scriptText: weakShotListScript,
  segments: parseScriptIntoSegments(weakShotListScript, [], 5),
  storySpine: "",
  frames: [],
});
assert.equal(weakAudit.ok, false, "Fragmented shot-list script without spine or dialogue must raise audit warnings");
assert.ok(weakAudit.warnings.length >= 3);

// Cross-segment continuity in buildNextFramePrompt injects storySpine & previous segment's closing beat
const seg2OpenPrompt = buildNextFramePrompt({
  projectName: "Jejak Api di Hujan",
  scriptText: extractedSpine.cleanScript,
  storySpine: extractedSpine.storySpine,
  visualStyle: VISUAL_STYLE_PRESETS[1].prompt,
  aspectRatio: "16:9",
  approvedAssets: accAssets,
  previousFrames: [segP1.frame, segP2.frame],
  activeSegment: seg2Target,
  segmentFrames: [],
  totalSegments: 2,
});
assert.ok(seg2OpenPrompt.prompt.includes("BENANG MERAH CERITA UTUH"));
assert.ok(seg2OpenPrompt.prompt.includes("AKHIR SEGMEN SEBELUMNYA"));
assert.ok(seg2OpenPrompt.prompt.includes("WAJIB isi field `dialogue`"));

// Anti-Ghosting regression: if previous frame had a character, a characterless POV/scenery shot MUST NOT inherit previousFrame!
const povFrameNoChar = {
  ...parsedF2.frame,
  id: "pov-no-char",
  shotSize: "WS" as const,
  assetIds: [accAssets[1].id, accAssets[2].id], // Location + Prop ONLY (no character Dimas!)
  sameLocationAsPrev: true,
};
const povRefs = selectFrameReferences(povFrameNoChar, accAssets, parsedF1.frame);
assert.equal(
  povRefs.some((r) => r.kind === "previous-frame"),
  false,
  "Characterless POV/scenery frame must skip previousFrame to prevent FLUX.2 character ghosting",
);

// Anti-Shot-Scale-Lock regression: WS -> CU jump MUST NOT attach previousFrame so FLUX.2 doesn't clone the wide layout!
const widePrevFrame = {
  ...parsedF1.frame,
  shotSize: "WS" as const,
};
const tightNextFrame = {
  ...parsedF2.frame,
  id: "tight-cu",
  shotSize: "CU" as const,
  sameLocationAsPrev: true,
};
const tightRefs = selectFrameReferences(tightNextFrame, accAssets, widePrevFrame);
assert.equal(
  tightRefs.some((r) => r.kind === "previous-frame"),
  false,
  "Extreme WS -> CU shot jump must skip previousFrame to prevent FLUX.2 composition cloning",
);

// When previousFrame IS safe to use (MS -> MS same character), prompt explicitly warns against cloning pose/layout
assert.ok(composedF2.prompt.includes("never copy its layout or pose"));

// 19. Local Motion Engine (Zero Veo/Flow deterministic Canvas2D + Chrome CDP/FFmpeg MP4 pipeline)
assert.deepEqual(fullHdDimsForAspect("9:16"), { width: 1080, height: 1920 });
assert.deepEqual(fullHdDimsForAspect("16:9"), { width: 1920, height: 1080 });

const motionOpts = {
  segmentId: null,
  secPerPanel: 3.0,
  transitionSec: 0.6,
  motionPreset: "auto" as const,
  motionAmount: 0.12,
  transitionPreset: "auto" as const,
  fitMode: "cover" as const,
  showBadge: true,
  showSubtitles: true,
  showProgress: true,
  fps: 30,
  audioMode: "synth" as const,
  audioVolume: 0.8,
};

const fullMotionTl = buildMotionTimeline(renderedSegmented, motionOpts);
assert.equal(fullMotionTl.slides.length, 3);
assert.equal(fullMotionTl.width, 1920);
assert.equal(fullMotionTl.height, 1080);
assert.equal(fullMotionTl.slides[0].transition, "cut");
assert.equal(fullMotionTl.slides[1].transition, "crossfade");
assert.notEqual(fullMotionTl.slides[2].transition, "crossfade");
assert.ok(Math.abs(fullMotionTl.totalDuration - (3.0 + 3.0 - 0.6 + 3.0 - 0.6)) < 1e-6);

const seg1OnlyTl = buildMotionTimeline(renderedSegmented, { ...motionOpts, segmentId: seg1Target.id });
assert.equal(seg1OnlyTl.slides.length, 2);

const midTrans = sampleMotionTimeline(fullMotionTl, 2.7);
assert.ok(midTrans && midTrans.inTransition);
assert.equal(midTrans.from?.slide.index, 0);
assert.equal(midTrans.to.slide.index, 1);

const tfZoom = computeMotionTransform("zoom-in", 0.12, 1);
assert.ok(Math.abs(tfZoom.scale - 1.12) < 1e-6);
const fitBlur = computeFitRect(1920, 1080, 1080, 1920, "contain-blur");
assert.ok(fitBlur.w <= 1080 && fitBlur.h <= 1920);

const cdpSpec = buildLocalCdpStoryboardSpec(renderedSegmented, fullMotionTl, motionOpts, null);
assert.equal(cdpSpec.slides.length, 3);
assert.equal(cdpSpec.audio.mode, "synth");

const localPackZip = buildLocalMotionRenderPackZip({
  project: renderedSegmented,
  timeline: fullMotionTl,
  options: motionOpts,
  renderScriptText: "#!/usr/bin/env python3\nprint('ok')\n",
});
assert.equal(localPackZip[0], 0x50);
assert.equal(localPackZip[1], 0x4b);
const localPackText = new TextDecoder("latin1").decode(localPackZip);
assert.ok(localPackText.includes("storyboard.json"));
assert.ok(localPackText.includes("render_motion_cdp.py"));
assert.ok(localPackText.includes("render_mp4.bat"));
assert.ok(localPackText.includes("images/panel_001.jpg"));

console.log("nmcGen pipeline tests: all passed");
