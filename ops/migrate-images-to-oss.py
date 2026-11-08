#!/usr/bin/env python3
from pathlib import Path
import os, shutil, sqlite3, subprocess, tempfile, urllib.request

DATA = Path(os.environ.get('DATA', '/var/lib/jianlai-studio'))
DB = DATA / 'state.sqlite'
CONFIG = Path(os.environ.get('CONFIG_FILE', '/etc/jianlai-studio.env'))
config = {}
for line in CONFIG.read_text().splitlines():
    if '=' in line and not line.lstrip().startswith('#'):
        key, value = line.split('=', 1)
        config[key.strip()] = value.strip()
bucket = config['OSS_PUBLIC_BUCKET']
prefix = config['OSS_PUBLIC_PREFIX'].strip('/')
base = config['OSS_PUBLIC_BASE'].rstrip('/') + '/' + prefix
cli = config.get('OSSUTIL_BIN', 'aliyun')
ffmpeg = config.get('FFMPEG_BIN', 'ffmpeg')

db = sqlite3.connect(DB)
backup = Path('/tmp') / 'jianlai-state-before-oss.sqlite'
with sqlite3.connect(backup) as target:
    db.backup(target)
columns = {row[1] for row in db.execute('PRAGMA table_info(stored_images)')}
for name in ('object_url', 'preview_url'):
    if name not in columns:
        db.execute(f'ALTER TABLE stored_images ADD COLUMN {name} TEXT')
rows = db.execute('SELECT job,idx,account,file,type FROM stored_images WHERE deleted=0 ORDER BY created,job,idx').fetchall()
if not rows:
    raise SystemExit('No result images found')

temp_root = Path('/tmp')
temp_root.mkdir(parents=True, exist_ok=True)
original_bytes = preview_bytes = 0
objects = []
with tempfile.TemporaryDirectory(prefix='jianlai-oss-migration-', dir=temp_root) as tmp:
    stage = Path(tmp)
    originals, previews = stage / 'originals', stage / 'previews'
    originals.mkdir(parents=True)
    previews.mkdir(parents=True)
    for job, idx, account, relative, mime in rows:
        rel = Path(relative)
        if rel.is_absolute() or '..' in rel.parts:
            raise RuntimeError('Unsafe stored image path')
        source = DATA / 'results' / rel
        if not source.is_file():
            raise FileNotFoundError(source)
        ext = 'jpg' if mime == 'image/jpeg' else 'webp' if mime == 'image/webp' else 'png'
        preview = source.with_suffix('.webp')
        subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-i', str(source), '-frames:v', '1', '-vf', 'scale=1600:1600:force_original_aspect_ratio=decrease', '-c:v', 'libwebp', '-quality', '78', '-compression_level', '6', str(preview), '-y'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        preview_data = preview.read_bytes()
        if preview_data[:4] != b'RIFF' or preview_data[8:12] != b'WEBP':
            raise RuntimeError(f'Invalid WebP preview for {relative}')
        original_rel = Path(str(rel) + '.' + ext)
        preview_rel = Path(str(rel) + '.webp')
        original_stage = originals / original_rel
        preview_stage = previews / preview_rel
        original_stage.parent.mkdir(parents=True, exist_ok=True)
        preview_stage.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, original_stage)
        shutil.copyfile(preview, preview_stage)
        original_bytes += source.stat().st_size
        preview_bytes += len(preview_data)
        object_key = f'results/originals/{original_rel.as_posix()}'
        preview_key = f'results/previews/{preview_rel.as_posix()}'
        objects.append((job, idx, f'{base}/{object_key}', f'{base}/{preview_key}'))

    common = ['--recursive', '--force', '--no-progress', '--acl', 'public-read', '--cache-control', 'public,max-age=3600']
    subprocess.run([cli, 'ossutil', 'cp', str(originals), f'oss://{bucket}/{prefix}/results/originals'] + common + ['--content-disposition', 'attachment'], check=True, stdout=subprocess.DEVNULL)
    subprocess.run([cli, 'ossutil', 'cp', str(previews), f'oss://{bucket}/{prefix}/results/previews'] + common + ['--content-type', 'image/webp'], check=True, stdout=subprocess.DEVNULL)

    for _, _, original_url, preview_url in objects[:1]:
        for url, signature in ((original_url, b'\x89PNG'), (preview_url, b'RIFF')):
            with urllib.request.urlopen(url, timeout=20) as response:
                body = response.read(12)
                if response.status != 200 or not body.startswith(signature):
                    raise RuntimeError('OSS image verification failed')

    db.execute('BEGIN IMMEDIATE')
    db.executemany('UPDATE stored_images SET object_url=?,preview_url=? WHERE job=? AND idx=?',
                   [(original, preview, job, idx) for job, idx, original, preview in objects])
    db.commit()

print(f'migrated={len(objects)} original_bytes={original_bytes} preview_bytes={preview_bytes} preview_ratio={preview_bytes / max(original_bytes, 1):.3f}')
