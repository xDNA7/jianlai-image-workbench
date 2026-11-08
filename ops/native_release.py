"""Small release-directory primitives. The caller owns draining and DB backups.

No credentials, service name or production paths are embedded here. Never restore
a database when rolling back an application release that may have accepted writes.
"""
import hashlib
import json
import os
import pathlib
import re
import shutil


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stage(root, name, binary, app, expected_sha, metadata):
    root, binary, app = map(pathlib.Path, (root, binary, app))
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}', name):
        raise ValueError('Invalid release name')
    if not re.fullmatch(r'[a-f0-9]{64}', expected_sha) or sha256(binary) != expected_sha:
        raise ValueError('Binary SHA256 mismatch')
    if not (app / 'public/templates.json').is_file():
        raise ValueError('Application template seed missing')
    releases = root / 'releases'
    releases.mkdir(parents=True, exist_ok=True)
    release = releases / name
    # mkdir fails on collisions: never mutate an existing/running release.
    release.mkdir(mode=0o755)
    shutil.copy2(binary, release / 'server')
    os.chmod(release / 'server', 0o755)
    shutil.copytree(app, release / 'app', symlinks=False)
    if sha256(release / 'server') != expected_sha:
        raise ValueError('Staged binary SHA256 mismatch')
    (release / 'release.json').write_text(json.dumps({**metadata, 'binarySha256': expected_sha}, indent=2) + '\n')
    return release


def switch(root, release):
    root, release = pathlib.Path(root), pathlib.Path(release).resolve()
    if release.parent != (root / 'releases').resolve() or not (release / 'server').is_file():
        raise ValueError('Release must be staged inside this release root')
    metadata = json.loads((release / 'release.json').read_text())
    if sha256(release / 'server') != metadata.get('binarySha256'):
        raise ValueError('Release binary changed after staging')
    current = root / 'current'
    if current.exists() and not current.is_symlink():
        raise ValueError('Current must be a symlink')
    previous = current.resolve() if current.is_symlink() else None
    pending = root / f'.current.pending-{os.getpid()}'
    try:
        pending.symlink_to(release)
        os.replace(pending, current)
    finally:
        pending.unlink(missing_ok=True)
    return previous
