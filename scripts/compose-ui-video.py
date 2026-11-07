"""Combine Playwright recordings into labeled, silent before/after MP4s."""
import argparse
from pathlib import Path
import subprocess
from PIL import Image, ImageChops, ImageStat

parser = argparse.ArgumentParser()
parser.add_argument("--ffmpeg", default="ffmpeg")
args = parser.parse_args()
out = Path(__file__).resolve().parents[1] / "dist" / "ui-review"
font = "C\\:/Windows/Fonts/segoeui.ttf"

def content_start(device, phase):
    # Align visible content, excluding Vite's cold-start time in the old capture.
    frame_width, frame_height = (360, 250) if device == "desktop" else (195, 422)
    viewport = (1440, 1000) if device == "desktop" else (390, 844)
    reference = Image.open(out / f"{device}-{phase}.png").convert("RGB").crop((0, 0, *viewport)).resize((frame_width, frame_height))
    decoded = subprocess.run([
        args.ffmpeg, "-v", "error", "-i", str(out / f"{device}-{phase}.webm"),
        "-t", "7", "-vf", f"fps=5,scale={frame_width}:{frame_height}",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], capture_output=True, check=True).stdout
    frame_bytes = frame_width * frame_height * 3
    scores = []
    for offset in range(0, len(decoded) - frame_bytes + 1, frame_bytes):
        frame = Image.frombytes("RGB", (frame_width, frame_height), decoded[offset:offset + frame_bytes])
        scores.append(sum(ImageStat.Stat(ImageChops.difference(frame, reference)).mean) / 3)
    best = min(scores)
    start = next(index / 5 for index, score in enumerate(scores) if score <= best + 0.15)
    print(f"{device} {phase}: visible-content start {start:.1f}s", flush=True)
    return start

for device, width, height in [("desktop", 960, 666), ("mobile", 390, 844)]:
    filters = []
    for index, label in enumerate(["BEFORE", "AFTER"]):
        filters.append(
            f"[{index}:v]trim=start={content_start(device, label.lower())},setpts=PTS-STARTPTS,scale={width}:{height},setsar=1,"
            f"pad=iw:ih+64:0:64:color=0x171717,"
            f"drawtext=fontfile='{font}':text='{label} / {device.upper()}':"
            f"fontcolor=white:fontsize=22:x=24:y=18[v{index}]"
        )
    filters.append("[v0][v1]hstack=inputs=2:shortest=1[v]")
    subprocess.run([
        args.ffmpeg, "-y", "-i", str(out / f"{device}-before.webm"),
        "-i", str(out / f"{device}-after.webm"), "-filter_complex", ";".join(filters),
        "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "20", "-preset", "fast",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out / f"{device}-before-after.mp4"),
    ], check=True)
