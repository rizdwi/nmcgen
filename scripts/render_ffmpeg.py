#!/usr/bin/env python3
"""nmcGen local FFmpeg renderer.
Reads manifest.json and renders a verified H.264/AAC MP4 with Ken Burns motion,
video trim/scale, burned ASS subtitles, and audio/ambient mixing.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg gagal ({proc.returncode}): {proc.stderr[-600:]}")
    return proc


def probe_mp4(path: Path) -> dict:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return {"size_bytes": path.stat().st_size}
    proc = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-show_entries",
            "stream=codec_type,codec_name,width,height,r_frame_rate",
            "-of",
            "json",
            str(path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    info = {"size_bytes": path.stat().st_size}
    if proc.returncode == 0:
        try:
            parsed = json.loads(proc.stdout)
            info["duration_sec"] = round(float(parsed.get("format", {}).get("duration", 0)), 2)
            for s in parsed.get("streams", []):
                if s.get("codec_type") == "video":
                    info["width"] = s.get("width")
                    info["height"] = s.get("height")
                    info["video_codec"] = s.get("codec_name")
                elif s.get("codec_type") == "audio":
                    info["audio_codec"] = s.get("codec_name")
        except Exception:
            pass
    return info


def zoompan_expr(motion: str, frames: int, w: int, h: int, fps: int) -> str:
    denom = max(1, frames - 1)
    if motion == "Pull-Out":
        z = f"1.08-0.08*(on/{denom})"
        x = "iw/2-(iw/zoom/2)"
        y = "ih/2-(ih/zoom/2)"
    elif motion == "Pan Right":
        z = "1.06"
        x = f"iw/2-(iw/zoom/2)+40*(on/{denom})-20"
        y = "ih/2-(ih/zoom/2)"
    elif motion == "Pan Left":
        z = "1.06"
        x = f"iw/2-(iw/zoom/2)-40*(on/{denom})+20"
        y = "ih/2-(ih/zoom/2)"
    elif motion == "Static":
        z = "1.02"
        x = "iw/2-(iw/zoom/2)"
        y = "ih/2-(ih/zoom/2)"
    else:  # Push-In default
        z = f"1+0.08*(on/{denom})"
        x = "iw/2-(iw/zoom/2)"
        y = "ih/2-(ih/zoom/2)"
    return (
        f"scale={w*2}:{h*2}:force_original_aspect_ratio=increase,"
        f"crop={w*2}:{h*2},"
        f"zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={w}x{h}:fps={fps},setsar=1"
    )


def find_system_font() -> str | None:
    candidates = [
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/tahoma.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            return p.replace("\\", "/").replace(":", "\\:")
    return None


def escape_drawtext(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("%", "\\%")
        .replace("\n", " ")
    )


def main():
    parser = argparse.ArgumentParser(description="nmcGen FFmpeg Renderer")
    parser.add_argument("--manifest", required=True, help="Path to manifest.json")
    parser.add_argument("--out", required=True, help="Output MP4 path")
    args = parser.parse_args()

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print(json.dumps({"ok": False, "code": "FFMPEG_MISSING", "error": "ffmpeg tidak ditemukan di PATH."}))
        sys.exit(1)

    manifest_path = Path(args.manifest).resolve()
    work_dir = manifest_path.parent
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    width = int(manifest.get("width", 1280))
    height = int(manifest.get("height", 720))
    fps = int(manifest.get("fps", 24))
    burn_subtitles = bool(manifest.get("burn_subtitles", True))
    fade_out_sec = float(manifest.get("fade_out_sec", 0.8))
    segments = manifest.get("segments", [])
    audio_tracks = manifest.get("audio_tracks", [])
    ass_rel = manifest.get("ass_file", "")

    if not segments:
        print(json.dumps({"ok": False, "error": "Daftar segmen kosong pada manifest."}))
        sys.exit(1)

    seg_clips: list[Path] = []
    total_dur = 0.0

    for idx, seg in enumerate(segments):
        dur = max(1.0, float(seg.get("duration_sec", 5.0)))
        total_dur += dur
        frames = max(1, int(round(dur * fps)))
        clip_out = work_dir / f"seg_{idx:03d}.mp4"
        kind = seg.get("kind", "slate")
        media_rel = seg.get("path", "")
        media_path = (work_dir / media_rel).resolve() if media_rel else None

        if kind == "video" and media_path and media_path.exists():
            vf = (
                f"scale={width}:{height}:force_original_aspect_ratio=increase,"
                f"crop={width}:{height},fps={fps},setsar=1"
            )
            run([
                ffmpeg, "-y", "-loglevel", "error",
                "-i", str(media_path),
                "-t", f"{dur:.3f}",
                "-vf", vf,
                "-an",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "19",
                str(clip_out),
            ])
        elif kind == "image" and media_path and media_path.exists():
            vf = zoompan_expr(seg.get("motion", "Push-In"), frames, width, height, fps)
            run([
                ffmpeg, "-y", "-loglevel", "error",
                "-i", str(media_path),
                "-vf", vf,
                "-t", f"{dur:.3f}",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "19",
                "-r", str(fps),
                str(clip_out),
            ])
        else:
            label = escape_drawtext(f"{seg.get('code', f'G0{idx+1}')} - {seg.get('title', 'Segmen')}")
            meta = escape_drawtext(
                f"{seg.get('shot_size', 'MS')} | {seg.get('camera_angle', 'Front')} | {dur:.1f}s"
            )
            font_arg = find_system_font()
            parts = [f"drawbox=x=40:y=40:w={width-80}:h={height-80}:color=#2d3340:t=2"]
            if font_arg:
                parts.append(
                    f"drawtext=fontfile='{font_arg}':text='{label}':fontcolor=#f2ae54:fontsize={max(28, height//20)}:x=80:y={height//3}"
                )
                parts.append(
                    f"drawtext=fontfile='{font_arg}':text='{meta}':fontcolor=#f1ede6:fontsize={max(20, height//32)}:x=80:y={height//3 + max(48, height//14)}"
                )
            vf = ",".join(parts)
            run([
                ffmpeg, "-y", "-loglevel", "error",
                "-f", "lavfi",
                "-i", f"color=c=#15181e:s={width}x{height}:d={dur:.3f}:r={fps}",
                "-vf", vf,
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "19",
                str(clip_out),
            ])

        seg_clips.append(clip_out)

    concat_list = work_dir / "concat.txt"
    concat_list.write_text(
        "\n".join(f"file '{c.name}'" for c in seg_clips) + "\n",
        encoding="utf-8",
    )

    video_filters = ["fade=t=in:st=0:d=0.35"]
    if fade_out_sec > 0 and total_dur > fade_out_sec + 0.5:
        video_filters.append(f"fade=t=out:st={max(0, total_dur - fade_out_sec):.2f}:d={fade_out_sec:.2f}")

    ass_path = (work_dir / ass_rel) if ass_rel else None
    if burn_subtitles and ass_path and ass_path.exists():
        ass_text = ass_path.read_text(encoding="utf-8")
        if "Dialogue:" in ass_text:
            video_filters.append(f"ass={ass_path.name}")

    cmd = [ffmpeg, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat_list.name]

    # Audio input: uploaded file, ambient rain synthesis, or silent stereo bed
    audio_filter = None
    first_file_audio = next(
        (a for a in audio_tracks if a.get("mode") == "file" and a.get("path") and (work_dir / a["path"]).exists()),
        None,
    )
    has_ambient = any(a.get("mode") == "ambient-rain" for a in audio_tracks)

    if first_file_audio:
        vol = max(0.02, min(1.5, float(first_file_audio.get("volume", 0.6))))
        cmd += ["-i", str((work_dir / first_file_audio["path"]).resolve())]
        audio_filter = (
            f"[1:a]aformat=channel_layouts=stereo,volume={vol:.2f},"
            f"afade=t=in:st=0:d=0.5,afade=t=out:st={max(0, total_dur - 1.0):.2f}:d=1.0[aout]"
        )
    elif has_ambient:
        amb = next(a for a in audio_tracks if a.get("mode") == "ambient-rain")
        vol = max(0.02, min(0.5, float(amb.get("volume", 0.12))))
        cmd += ["-f", "lavfi", "-t", f"{total_dur:.3f}", "-i", "anoisesrc=color=brown:sample_rate=48000:amplitude=0.12"]
        audio_filter = (
            f"[1:a]aformat=channel_layouts=stereo,lowpass=f=600,highpass=f=80,volume={vol:.2f},"
            f"afade=t=in:st=0:d=0.8,afade=t=out:st={max(0, total_dur - 1.2):.2f}:d=1.2[aout]"
        )
    else:
        cmd += ["-f", "lavfi", "-t", f"{total_dur:.3f}", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        audio_filter = "[1:a]acopy[aout]"

    fc = f"[0:v]{','.join(video_filters)}[vout];{audio_filter}"
    cmd += [
        "-filter_complex", fc,
        "-map", "[vout]", "-map", "[aout]",
        "-t", f"{total_dur:.3f}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "18",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(out_path),
    ]

    run(cmd, cwd=work_dir)
    meta = probe_mp4(out_path)
    print(json.dumps({"ok": True, "output": str(out_path), **meta}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)
