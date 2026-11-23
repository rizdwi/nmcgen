#!/usr/bin/env python3
"""nmcGen CapCut Draft builder powered by pyCapCut (0.0.4+).
Generates a multi-track CapCut draft (video + audio + SRT subtitles) directly
into the CapCut Drafts folder. Open CapCut desktop to polish and export MP4.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def find_system_font() -> str | None:
    candidates = [
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            return p.replace("\\", "/").replace(":", "\\:")
    return None


def make_slate_png(out_png: Path, width: int, height: int, title: str) -> bool:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    safe_title = title.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'").replace("\n", " ")
    font_arg = find_system_font()
    vf = (
        f"drawbox=x=40:y=40:w={width-80}:h={height-80}:color=#2d3340:t=2,"
        f"drawtext=fontfile='{font_arg}':text='{safe_title}':fontcolor=#f2ae54:fontsize={max(28, height//22)}:x=80:y={height//2}"
        if font_arg
        else f"drawbox=x=40:y=40:w={width-80}:h={height-80}:color=#2d3340:t=2"
    )
    proc = subprocess.run(
        [
            ffmpeg, "-y", "-loglevel", "error",
            "-f", "lavfi",
            "-i", f"color=c=#15181e:s={width}x{height}:d=0.1",
            "-vf", vf,
            "-frames:v", "1",
            str(out_png),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return proc.returncode == 0 and out_png.exists()


def main():
    parser = argparse.ArgumentParser(description="nmcGen pyCapCut Draft Builder")
    parser.add_argument("--manifest", required=True, help="Path to manifest.json")
    parser.add_argument("--drafts-dir", required=True, help="CapCut Drafts directory")
    parser.add_argument("--name", required=True, help="Draft folder name")
    args = parser.parse_args()

    try:
        import pycapcut as cc
        from pycapcut import trange_seconds
    except ImportError:
        print(
            json.dumps(
                {
                    "ok": False,
                    "code": "PYCAPCUT_MISSING",
                    "error": "Paket Python pycapcut belum terpasang. Jalankan: pip install pycapcut==0.0.4",
                }
            )
        )
        sys.exit(2)

    manifest_path = Path(args.manifest).resolve()
    work_dir = manifest_path.parent
    drafts_dir = Path(os.path.expanduser(args.drafts_dir)).resolve()
    drafts_dir.mkdir(parents=True, exist_ok=True)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    width = int(manifest.get("width", 1280))
    height = int(manifest.get("height", 720))
    fps = int(manifest.get("fps", 24))
    segments = manifest.get("segments", [])
    audio_tracks = manifest.get("audio_tracks", [])
    srt_rel = manifest.get("srt_file", "")

    if not segments:
        print(json.dumps({"ok": False, "error": "Tidak ada segmen untuk dirakit ke CapCut."}))
        sys.exit(1)

    draft_folder = cc.DraftFolder(str(drafts_dir))
    script = draft_folder.create_draft(args.name, width, height, fps=fps, allow_replace=True)
    script.add_track(cc.TrackType.video).add_track(cc.TrackType.audio).add_track(cc.TrackType.text)

    cursor = 0.0
    added_video = 0
    for idx, seg in enumerate(segments):
        dur = max(1.0, float(seg.get("duration_sec", 5.0)))
        media_rel = seg.get("path", "")
        media_path = (work_dir / media_rel).resolve() if media_rel else None

        if not media_path or not media_path.exists():
            slate = work_dir / f"capcut_slate_{idx:03d}.png"
            if make_slate_png(slate, width, height, f"{seg.get('code', f'G0{idx+1}')} {seg.get('title', '')}"):
                media_path = slate

        if media_path and media_path.exists():
            vseg = cc.VideoSegment(str(media_path), trange_seconds(cursor, duration=dur))
            script.add_segment(vseg)
            added_video += 1
        cursor += dur

    added_audio = 0
    for aud in audio_tracks:
        if aud.get("mode") == "file" and aud.get("path"):
            apath = (work_dir / aud["path"]).resolve()
            if apath.exists():
                vol = max(0.05, min(1.5, float(aud.get("volume", 0.6))))
                start_s = max(0.0, float(aud.get("start_sec", 0.0)))
                aseg = cc.AudioSegment(str(apath), trange_seconds(start_s, duration=max(1.0, cursor - start_s)), volume=vol)
                script.add_segment(aseg)
                added_audio += 1

    imported_srt = False
    if srt_rel:
        srt_path = (work_dir / srt_rel).resolve()
        if srt_path.exists() and srt_path.read_text(encoding="utf-8").strip():
            script.import_srt(str(srt_path), track_name="subtitle")
            imported_srt = True

    script.save()
    out_draft = drafts_dir / args.name
    print(
        json.dumps(
            {
                "ok": True,
                "draft_path": str(out_draft),
                "segments_added": added_video,
                "audio_added": added_audio,
                "imported_srt": imported_srt,
                "duration_sec": round(cursor, 2),
                "note": "Draft CapCut berhasil dibuat. Buka aplikasi CapCut Desktop untuk poles akhir dan klik Export.",
            }
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)
