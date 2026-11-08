#!/usr/bin/env python3
"""Check exactly the objects supplied by Git pre-push; report no raw matches."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    repo = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
    checker = repo / 'scripts/public_repo_check.py'
    policy = repo / 'scripts/public_repo_policy.json'
    local_checker = os.environ.get('PUBLIC_REPO_LOCAL_CHECKER')
    command = [local_checker] if local_checker else [sys.executable, str(checker), '--policy', str(policy)]
    revisions = []
    for row in sys.stdin:
        local_ref, sha, remote_ref, _ = row.split()
        if set(sha) == {'0'}:
            continue
        if len(sha) not in {40, 64} or any(c not in '0123456789abcdef' for c in sha):
            return 2
        revisions.append(sha)
        command += ['--revision', sha, '--ref-name', remote_ref]
    if not revisions:
        return 0
    p = subprocess.run(command + ['--repo', str(repo)], capture_output=True, text=True)
    try:
        result = json.loads(p.stdout)
    except (ValueError, TypeError):
        print('Publication blocked: scanner failed.', file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True))
    if p.returncode:
        return p.returncode
    try:
        if subprocess.check_output(['gitleaks', 'version'], stderr=subprocess.DEVNULL, text=True).strip() != '8.30.1':
            raise RuntimeError('unsupported-scanner-version')
    except (OSError, RuntimeError, subprocess.CalledProcessError):
        print('Publication blocked: pinned secret scanner unavailable.', file=sys.stderr)
        return 2
    for sha in sorted(set(revisions)):
        with tempfile.TemporaryFile() as private_log:
            try:
                status = subprocess.run(['gitleaks', 'git', '--log-opts=' + sha + ' --full-history -m', '--redact', '--no-banner', '.'],
                                        cwd=repo, stdout=private_log, stderr=private_log).returncode
            except OSError:
                status = 2
        if status:
            print('Publication blocked: secret scan failed; inspect privately.', file=sys.stderr)
            return status
    return 0


if __name__ == '__main__':
    sys.exit(main())
