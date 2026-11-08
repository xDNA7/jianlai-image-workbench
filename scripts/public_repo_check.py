#!/usr/bin/env python3
"""Read-only publication checks. Never print matched values or raw filenames."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import struct
import sys
import zlib

VERSION = '1.0.0'
RULES = {
    'machine-path': re.compile(rb'(?:/(?:root|home|Users)/[^\s\x00"\'<>]+|[A-Z]:\\Users\\[^\s\x00"\'<>]+)'),
    'oss-origin': re.compile(rb'https?://[a-zA-Z0-9_.-]+\.oss(?:-[a-zA-Z0-9-]+)?\.aliyuncs\.com'),
    'tool-attribution': re.compile(rb'(?i)created\s+(?:in|with|by)\s+(?:t3\s*code|codex|claude)'),
    'private-key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'access-token': re.compile(rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})'),
}
AGENTS = {'agents.md', 'agent.md', 'claude.md', 'claude.local.md'}
PRIVATE_DIRS = {'.codex', '.claude', '.ssh'}
TEXT_EXT = {'.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.rs', '.json', '.toml', '.yaml', '.yml', '.md', '.css', '.html', '.sql', '.txt', '.svg', '.webmanifest', '.example', '.lock', '.sh', '.conf', '.ini', '.xml', '.csv', '.map'}
ARCHIVES = {'.zip', '.gz', '.tar', '.7z', '.bz2', '.xz', '.bundle', '.pdf', '.docx'}
MAX_BYTES = 32 * 1024 * 1024


def git(repo, *args):
    p = subprocess.run(['git', '-C', str(repo), *args], capture_output=True)
    if p.returncode:
        raise RuntimeError('git-operation-failed')
    return p.stdout


class Scan:
    def __init__(self, policy):
        self.policy = policy
        self.findings = []
        self.unknown = []
        self.scanned = 0
        self.reviewed = 0
        self.media = 0
        self.executables = 0

    def event(self, rule, location, commit='', data=None, unknown=False, line=None):
        row = {'rule': rule, 'location_id': hashlib.sha256(location.encode()).hexdigest()[:16]}
        if commit:
            row['commit'] = commit[:12]
        if data is not None:
            row['sha256'] = hashlib.sha256(data).hexdigest()
        if line is not None:
            row['line'] = line
        (self.unknown if unknown else self.findings).append(row)

    def content(self, data, location, commit=''):
        self.scanned += 1
        for name, pattern in RULES.items():
            match = pattern.search(data)
            if match:
                self.event(name, location, commit, line=data[:match.start()].count(b'\n') + 1)
        for value in self.policy.get('blocked_literals', []):
            if value and value.encode().lower() in data.lower():
                self.event('private-policy-match', location, commit)

    def path(self, name, location, commit=''):
        parts = PurePosixPath(name).parts
        base = parts[-1].lower() if parts else ''
        if base in AGENTS or any(x.lower() in PRIVATE_DIRS for x in parts):
            self.event('private-agent-file', location, commit)
        if base == '.env' or (base.startswith('.env.') and base not in {'.env.example', '.env.sample'}):
            self.event('private-env-file', location, commit)
        if base.endswith(('.pem', '.key', '.p12', '.pfx', '.bundle')):
            self.event('private-container-file', location, commit)
        self.content(name.encode(errors='surrogateescape'), location, commit)

    def identity(self, data, location, commit):
        self.content(data, location, commit)
        for email in re.findall(rb'<([^<>\s]+@[^<>\s]+)>', data):
            if not re.fullmatch(rb'[A-Za-z0-9+_.-]+@users\.noreply\.github\.com', email):
                self.event('unapproved-commit-email', location, commit)

    def blob(self, name, data, location, commit=''):
        self.content(data, location, commit)
        suffix = PurePosixPath(name).suffix.lower()
        if len(data) > MAX_BYTES:
            self.event('oversize-unreviewed', location, commit, data, True)
            return
        if suffix == '.map':
            self.event('source-map', location, commit)
        if data.startswith(b'version https://git-lfs.github.com/spec/v1'):
            self.event('lfs-unreviewed', location, commit, data, True)
            return
        if suffix == '.png':
            self.media += 1
            pos, valid = 8, data.startswith(b'\x89PNG\r\n\x1a\n')
            ended, header, pixels = False, False, False
            while valid and pos + 12 <= len(data):
                length = int.from_bytes(data[pos:pos+4], 'big')
                kind = data[pos+4:pos+8]
                if pos + length + 12 > len(data):
                    valid = False
                    break
                payload = data[pos+8:pos+8+length]
                crc = int.from_bytes(data[pos+8+length:pos+12+length], 'big')
                if zlib.crc32(kind + payload) != crc:
                    valid = False
                    break
                if pos == 8:
                    header = kind == b'IHDR' and length == 13 and all(struct.unpack('>II', payload[:8]))
                if kind == b'IDAT' and length:
                    pixels = True
                if kind in {b'tEXt', b'zTXt', b'iTXt', b'eXIf', b'iCCP'}:
                    self.event('image-metadata', location, commit)
                pos += length + 12
                if kind == b'IEND':
                    ended = True
                    break
            if not valid or not header or not pixels or not ended or pos != len(data):
                self.event('invalid-image', location, commit, data, True)
            elif not self.policy.get('reviewed_media_sha256', {}).get(hashlib.sha256(data).hexdigest()):
                self.event('image-visual-review-required', location, commit, data, True)
            return
        if suffix == '.webp':
            self.media += 1
            pos, valid = 12, data[:4] == b'RIFF' and data[8:12] == b'WEBP'
            valid = valid and len(data) >= 12 and int.from_bytes(data[4:8], 'little') + 8 == len(data)
            frame = False
            while valid and pos + 8 <= len(data):
                length = int.from_bytes(data[pos+4:pos+8], 'little')
                kind = data[pos:pos+4]
                payload = data[pos+8:pos+8+length]
                if kind == b'VP8 ':
                    frame = frame or len(payload) >= 10 and payload[3:6] == b'\x9d\x01\x2a'
                if kind == b'VP8L':
                    frame = frame or len(payload) >= 5 and payload[0] == 0x2f
                if data[pos:pos+4] in {b'EXIF', b'XMP ', b'ICCP'}:
                    self.event('image-metadata', location, commit)
                pos += 8 + length + (length % 2)
            if not valid or not frame or pos != len(data):
                self.event('invalid-image', location, commit, data, True)
            elif not self.policy.get('reviewed_media_sha256', {}).get(hashlib.sha256(data).hexdigest()):
                self.event('image-visual-review-required', location, commit, data, True)
            return
        if suffix in TEXT_EXT or PurePosixPath(name).name in {'.gitignore', '.gitkeep', 'SHA256SUMS', 'LICENSE', 'Dockerfile'}:
            try:
                data.decode('utf-8')
                if b'\x00' in data:
                    raise UnicodeDecodeError('utf-8', data, 0, 1, 'unexpected-nul')
            except UnicodeDecodeError:
                self.event('nontext-input', location, commit, data, True)
            return
        if data.startswith(b'\x7fELF') and self.policy.get('artifact_mode'):
            # Validate tables/segments and reject debug sections; ABI is a separate gate.
            valid = len(data) >= 64 and data[4:7] == b'\x02\x01\x01'
            if valid:
                values = struct.unpack('<HHIQQQIHHHHHH', data[16:64])
                kind, machine, version, _, phoff, shoff, _, ehsize, phsize, phnum, shsize, shnum, names = values
                valid = (kind in {2, 3} and machine in {62, 183} and version == 1 and ehsize == 64
                         and phsize == 56 and phnum > 0 and phoff >= 64 and phoff + phsize * phnum <= len(data)
                         and shsize == 64 and shnum > 0 and shoff >= 64 and shoff + shsize * shnum <= len(data)
                         and 0 < names < shnum)
            if valid:
                for index in range(phnum):
                    segment = struct.unpack('<IIQQQQQQ', data[phoff+index*phsize:phoff+(index+1)*phsize])
                    valid = valid and segment[2] + segment[5] <= len(data)
                sections = [struct.unpack('<IIQQQQIIQQ', data[shoff+i*shsize:shoff+(i+1)*shsize]) for i in range(shnum)]
                valid = valid and all(s[1] == 8 or s[4] + s[5] <= len(data) for s in sections)
                name_section = sections[names]
                table = data[name_section[4]:name_section[4]+name_section[5]]
                valid = valid and bool(table) and all(s[0] < len(table) for s in sections)
                if valid and any(table[s[0]:].split(b'\x00', 1)[0].startswith((b'.debug', b'.zdebug')) for s in sections):
                    self.event('binary-debug-info', location, commit)
            if valid:
                self.executables += 1
            else:
                self.event('invalid-executable', location, commit, data, True)
            return
        digest = hashlib.sha256(data).hexdigest()
        if self.policy.get('reviewed_binary_sha256', {}).get(digest):
            self.reviewed += 1
            return
        try:
            if suffix not in ARCHIVES and b'\x00' not in data:
                data.decode('utf-8')
                return
        except UnicodeDecodeError:
            pass
        self.event('binary-unreviewed', location, commit, data, True)


def scan_git(scan, repo, revisions):
    commits = set()
    objects = set()
    for rev in revisions:
        obj = git(repo, 'rev-parse', '--verify', '--end-of-options', rev).decode().strip()
        while git(repo, 'cat-file', '-t', obj).strip() == b'tag':
            tag = git(repo, 'cat-file', 'tag', obj)
            scan.identity(tag, 'annotated-tag', obj)
            obj = tag.splitlines()[0].split()[1].decode()
        # Resolve as an object, not a Git option supplied by an untrusted caller.
        tip = git(repo, 'rev-parse', '--verify', '--end-of-options', rev + '^{commit}').decode().strip()
        commits.update(git(repo, 'rev-list', tip).decode().splitlines())
    for commit in sorted(commits):
        header = git(repo, 'show', '-s', '--format=%an <%ae>%n%cn <%ce>%n%B', commit)
        scan.identity(header, 'commit-message-and-identity', commit)
        for entry in git(repo, 'ls-tree', '-r', '-z', commit).split(b'\0'):
            if not entry:
                continue
            meta, rawname = entry.split(b'\t', 1)
            mode, kind, oid = meta.decode().split()
            name = os.fsdecode(rawname)
            location = name
            scan.path(name, location, commit)
            if mode == '160000' or kind != 'blob':
                scan.event('submodule-unreviewed', location, commit, unknown=True)
                continue
            key = (name, oid)
            if key in objects:
                continue
            objects.add(key)
            if mode == '120000':
                scan.event('symlink-unreviewed', location, commit, unknown=True)
            else:
                size = int(git(repo, 'cat-file', '-s', oid))
                if size > MAX_BYTES:
                    scan.event('oversize-unreviewed', location, commit, unknown=True)
                else:
                    scan.blob(name, git(repo, 'cat-file', 'blob', oid), location, commit)
    return len(commits)


def scan_artifact(scan, root):
    if not root.is_dir():
        raise RuntimeError('artifact-directory-missing')
    for directory, children, files in os.walk(root, followlinks=False):
        for child in children[:]:
            path = Path(directory) / child
            if path.is_symlink():
                scan.event('symlink-unreviewed', path.relative_to(root).as_posix(), unknown=True)
                children.remove(child)
        for name in files:
            path = Path(directory) / name
            rel = path.relative_to(root).as_posix()
            scan.path(rel, rel)
            if path.is_symlink():
                scan.event('symlink-unreviewed', rel, unknown=True)
            elif path.stat().st_size > MAX_BYTES:
                scan.event('oversize-unreviewed', rel, unknown=True)
            else:
                scan.blob(rel, path.read_bytes(), rel)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo', type=Path, default=Path('.'))
    p.add_argument('--revision', action='append', default=[])
    p.add_argument('--ref-name', action='append', default=[])
    p.add_argument('--artifact', type=Path)
    p.add_argument('--policy', type=Path)
    p.add_argument('--report', type=Path)
    args = p.parse_args(argv)
    try:
        policy = json.loads(args.policy.read_text()) if args.policy else {}
        if not isinstance(policy, dict):
            raise RuntimeError('invalid-policy')
        if not isinstance(policy.get('blocked_literals', []), list) or any(not isinstance(x, str) or not x for x in policy.get('blocked_literals', [])):
            raise RuntimeError('invalid-policy')
        for key in ('reviewed_binary_sha256', 'reviewed_media_sha256'):
            values = policy.get(key, {})
            if not isinstance(values, dict) or any(not re.fullmatch(r'[a-f0-9]{64}', k) or not isinstance(v, str) or not v.strip() for k, v in values.items()):
                raise RuntimeError('invalid-policy')
        if args.artifact:
            policy['artifact_mode'] = True
        scan = Scan(policy)
        for name in args.ref_name:
            scan.content(name.encode(), 'ref-name')
        commits = 0
        if args.artifact:
            scan_artifact(scan, args.artifact)
        else:
            if git(args.repo, 'rev-parse', '--is-shallow-repository').strip() == b'true':
                raise RuntimeError('shallow-history-unverified')
            commits = scan_git(scan, args.repo, args.revision or ['HEAD'])
        result = {'version': VERSION, 'status': 'blocked' if scan.findings else 'unverified' if scan.unknown else 'passed',
                  'commits': commits, 'scanned_inputs': scan.scanned, 'reviewed_binaries': scan.reviewed,
                  'media_need_visual_review': scan.media, 'findings': scan.findings, 'unverified': scan.unknown}
        result['validated_executables'] = scan.executables
        output = json.dumps(result, ensure_ascii=True, sort_keys=True)
        if args.report:
            fd = os.open(args.report, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as f:
                f.write(output + '\n')
        print(output)
        return 1 if scan.findings else 2 if scan.unknown else 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        print(json.dumps({'version': VERSION, 'status': 'tool-error', 'error': 'input-or-git-failure'}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
