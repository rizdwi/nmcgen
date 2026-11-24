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
  composeSegmentPrompt,
  estimateDialogueSeconds,
  getPrimaryScript,
  getProjectCover,
  updateProjectMeta,
  validateProject,
} from "./validator.ts";
import { buildGoogleFlowGuide } from "./bundle.ts";
import { buildZip } from "./zip.ts";
import {
  buildCandidateChain,
  classifyAndRankModels,
  detectProviderKindFromKey,
  isImagenModel,
  openAiImageSizeForModel,
  shouldSwitchModel,
} from "./modelRouter.ts";
import { mergeProjects, projectToSupabaseRow } from "./supabaseSync.ts";
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

console.log("nmcGen pipeline tests: all passed");
