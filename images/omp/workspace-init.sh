#!/usr/bin/env bash
set -euo pipefail

: "${SAND_WORKSPACE_URL:?SAND_WORKSPACE_URL is required}"
: "${SAND_WORKSPACE_SHA256:?SAND_WORKSPACE_SHA256 is required}"

package_directory="$(mktemp -d)"
cleanup() {
  rm -rf "$package_directory"
}
trap cleanup EXIT

curl --fail --location --retry 3 "$SAND_WORKSPACE_URL" \
  --output "$package_directory/workspace.tar.gz"
printf '%s  %s\n' "$SAND_WORKSPACE_SHA256" "$package_directory/workspace.tar.gz" \
  | sha256sum --check --strict
tar -xzf "$package_directory/workspace.tar.gz" -C "$package_directory"

rm -rf /workspace
git clone --quiet "$package_directory/repository.bundle" /workspace

branch="$(jq -r '.branch // empty' "$package_directory/metadata.json")"
repository="${SAND_REPOSITORY:-$(jq -r '.repository // empty' "$package_directory/metadata.json")}"
if [[ -n "$branch" ]]; then
  git -C /workspace checkout --quiet -B "$branch" HEAD
fi
if [[ -n "$repository" ]]; then
  git -C /workspace remote set-url origin "$repository"
else
  git -C /workspace remote remove origin
fi

find /workspace -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} +
tar -xzf "$package_directory/tree.tar.gz" -C /workspace
