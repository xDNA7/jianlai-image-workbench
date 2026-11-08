#!/bin/sh
set -eu
version=8.30.1
archive="gitleaks_${version}_linux_x64.tar.gz"
expected=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
test "$(uname -m)" = x86_64
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
if ! curl -fsSL --retry 2 "https://github.com/gitleaks/gitleaks/releases/download/v${version}/${archive}" -o "$temporary/$archive"; then
    # Same official release asset; the checksum below is mandatory for both paths.
    gh api -H 'Accept: application/octet-stream' \
        repos/gitleaks/gitleaks/releases/assets/378332058 > "$temporary/$archive"
fi
printf '%s  %s\n' "$expected" "$temporary/$archive" | sha256sum -c -
tar -xzf "$temporary/$archive" -C "$temporary" gitleaks
install -m 755 "$temporary/gitleaks" "${1:?destination required}"
