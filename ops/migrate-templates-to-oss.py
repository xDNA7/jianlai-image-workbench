#!/usr/bin/env python3
"""Publish built-in template originals and compressed WebP previews to OSS."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "app/public/templates"
CONFIG = Path(os.environ.get("CONFIG_FILE", "/etc/jianlai-studio.env"))

config = {}
for line in CONFIG.read_text().splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.split("=", 1)
        config[key.strip()] = value.strip()

bucket = config["OSS_PUBLIC_BUCKET"]
prefix = config["OSS_PUBLIC_PREFIX"].strip("/")
public_base = config["OSS_PUBLIC_BASE"].rstrip("/") + "/" + prefix
cli = config.get("OSSUTIL_BIN", "aliyun")
ffmpeg = config.get("FFMPEG_BIN", "ffmpeg")
image_exts = {".png", ".jpg", ".jpeg", ".webp", ".svg"}
manifests = [ROOT / "app/public/templates.json", Path("/var/lib/jianlai-studio/templates.json")]
references = set()
for manifest in manifests:
    if not manifest.is_file():
        continue
    import json
    data = json.loads(manifest.read_text())
    items = data if isinstance(data, list) else data.get("templates", [])
    for item in items:
        if isinstance(item, dict):
            for field in ("preview", "image", "asset", "source"):
                value = item.get(field)
                if isinstance(value, str) and value.startswith("templates/"):
                    references.add(value)

files = []
for reference in sorted(references):
    relative = Path(reference)
    if ".." in relative.parts or relative.suffix.lower() not in image_exts:
        continue
    source = ROOT / "app/public" / relative
    if source.is_file():
        files.append((source, Path(*relative.parts[1:])))
images = [(source, relative) for source, relative in files if source.suffix.lower() in image_exts - {".svg"}]
if not files or not images:
    raise SystemExit("No referenced built-in template assets found")

original_bytes = sum(source.stat().st_size for source, _ in images)
preview_bytes = 0
sample_paths = []
with tempfile.TemporaryDirectory(prefix="jianlai-template-oss-", dir="/tmp") as temp:
    original_root = Path(temp) / "originals"
    preview_root = Path(temp) / "previews"
    for source, relative in files:
        original = original_root / relative
        original.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, original)
    for source, relative in images:
        relative = relative.with_suffix(".webp")
        preview = preview_root / relative
        preview.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(source),
             "-frames:v", "1", "-vf",
             "scale=1600:1600:force_original_aspect_ratio=decrease",
             "-c:v", "libwebp", "-quality", "78", "-compression_level", "4",
             str(preview), "-y"],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        data = preview.read_bytes()
        if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
            raise RuntimeError(f"Invalid WebP preview for {relative}")
        preview_bytes += len(data)
        if len(sample_paths) < 3:
            sample_paths.append(relative.as_posix())

    common = ["--recursive", "--force", "--no-progress", "--acl", "public-read",
              "--cache-control", "public,max-age=3600"]
    subprocess.run(
        [cli, "ossutil", "cp", str(original_root), f"oss://{bucket}/{prefix}/templates"]
        + common,
        check=True, stdout=subprocess.DEVNULL,
    )
    subprocess.run(
        [cli, "ossutil", "cp", str(preview_root),
         f"oss://{bucket}/{prefix}/templates/previews"]
        + common + ["--content-type", "image/webp"],
        check=True, stdout=subprocess.DEVNULL,
    )

    for relative in sample_paths:
        url = f"{public_base}/templates/previews/{relative}"
        with urllib.request.urlopen(url, timeout=20) as response:
            signature = response.read(12)
            if response.status != 200 or signature[:4] != b"RIFF" or signature[8:12] != b"WEBP":
                raise RuntimeError("OSS template preview verification failed")

print(f"published={len(files)} raster={len(images)} original_bytes={original_bytes} "
      f"preview_bytes={preview_bytes} preview_ratio={preview_bytes / max(original_bytes, 1):.3f}")
