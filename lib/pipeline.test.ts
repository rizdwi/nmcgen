import assert from "node:assert/strict";
import { canConnect, createEmptyProject, createSampleProject } from "./presets.ts";
import {
  autoArrangeNodes,
  buildAss,
  buildSrt,
  composeSegmentPrompt,
  estimateDialogueSeconds,
  getPrimaryScript,
  getProjectCover,
  updateProjectMeta,
  validateProject,
} from "./validator.ts";
import { buildZip } from "./zip.ts";

// 1. Sample project validates with zero hard errors and expected warnings for missing images
const sample = createSampleProject();
const report = validateProject(sample);
assert.equal(report.ok, true, "Sample project should pass hard validation");
assert.equal(report.totalDurationSec, 22);
assert.equal(report.orderedSegmentIds.length, 2);
assert.equal(report.missingAssetImages, 3);
assert.equal(report.missingSegmentMedia, 2);
assert.equal(
  report.warnings.some((w) => w.code === "SAME_FRAMING_TRANSITION"),
  false,
  "Sample segments intentionally change shot size & angle",
);

// 2. Same shot size + same angle triggers continuity warning
const seg2 = sample.nodes.find((n) => n.id === "node_seg_2")!;
if (seg2.data.kind === "segment") {
  seg2.data.shotSize = "MS";
  seg2.data.cameraAngle = "Front";
}
const reportJump = validateProject(sample);
assert.equal(
  reportJump.warnings.some((w) => w.code === "SAME_FRAMING_TRANSITION"),
  true,
  "Identical consecutive framing must raise continuity warning",
);

// 3. Empty project fails hard validation honestly
const empty = createEmptyProject("Kosong");
const emptyReport = validateProject(empty);
assert.equal(emptyReport.ok, false);
assert.ok(emptyReport.errors.some((e) => e.code === "NO_SEGMENTS"));

// 4. Dialogue timing & subtitles
assert.ok(estimateDialogueSeconds("Din, soal kemarin... aku yang salah.") > 3);
const srt = buildSrt(sample);
assert.ok(srt.includes("Din, soal kemarin... aku yang salah."));
assert.ok(srt.includes("-->"));
const ass = buildAss(sample);
assert.ok(ass.includes("PlayResX: 1280"));
assert.ok(ass.includes("Dialogue: 0,"));

// 5. Prompt composition binds connected assets
const seg1 = sample.nodes.find((n) => n.id === "node_seg_1")!;
const prompt = composeSegmentPrompt(sample, seg1);
assert.ok(prompt.includes("@Raka"));
assert.ok(prompt.includes("@Dina"));
assert.ok(prompt.includes("@WarungKopi"));

// 6. Connection rules & auto-arrange
assert.equal(canConnect("asset", "segment"), true);
assert.equal(canConnect("export", "script"), false);
const arranged = autoArrangeNodes(sample);
assert.equal(arranged.length, sample.nodes.length);

// 7. Zero-dependency ZIP output header check
const zipBytes = buildZip([
  { name: "project.json", data: '{"name":"nmcGen"}' },
  { name: "captions.srt", data: srt },
]);
assert.equal(zipBytes[0], 0x50);
assert.equal(zipBytes[1], 0x4b);
assert.equal(zipBytes[2], 0x03);
assert.equal(zipBytes[3], 0x04);

// 8. Dashboard project metadata edit and cover extraction
const editedSample = updateProjectMeta(sample, {
  name: "Drama Warung Malam",
  aspectRatio: "9:16",
  premise: "Pertemuan tak terduga di bawah hujan.",
  visualStyle: "Cinematic 9:16 neon rain",
});
assert.equal(editedSample.name, "Drama Warung Malam");
assert.equal(getPrimaryScript(editedSample)?.aspectRatio, "9:16");
assert.equal(getPrimaryScript(editedSample)?.premise, "Pertemuan tak terduga di bawah hujan.");
assert.equal(getProjectCover(editedSample), null);

const editedEmpty = updateProjectMeta(empty, {
  name: "Episode Perdana",
  aspectRatio: "9:16",
  premise: "Premis baru dari dashboard.",
});
assert.equal(editedEmpty.name, "Episode Perdana");
assert.equal(getPrimaryScript(editedEmpty)?.aspectRatio, "9:16");
assert.equal(getPrimaryScript(editedEmpty)?.premise, "Premis baru dari dashboard.");

console.log("nmcGen pipeline tests: all passed");
