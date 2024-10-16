#!/bin/bash

set -euo pipefail

usage() {
  echo "Usage: $0 [--publish] <repository> <version>"
  exit 1
}

DRY_RUN=true
REPO=""
VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --publish)
      DRY_RUN=false
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      if [[ -z "$REPO" ]]; then
        REPO="$1"
      elif [[ -z "$VERSION" ]]; then
        VERSION="$1"
      else
        usage
      fi
      shift
      ;;
  esac
done

if [[ -z "$REPO" || -z "$VERSION" ]]; then
  usage
fi

VERSION="${VERSION#v}"
RELEASE_TAG="v$VERSION"

if [ "$DRY_RUN" == false ]; then
  if [ "${GH_TOKEN:-}" = "" ]; then
    GH_TOKEN=$(gh auth token 2>/dev/null || true)
    if [ "$GH_TOKEN" = "" ]; then
      echo "GitHub authentication token not found. Run 'gh auth login' to authenticate."
      exit 1
    fi
  fi
fi

TARGETS=(
  "x86_64-unknown-linux-gnu:linux-amd64"
  "aarch64-apple-darwin:macos-arm64"
  "x86_64-pc-windows-msvc:pc-amd64.exe"
)

for target_config in "${TARGETS[@]}"; do
  IFS=":" read -r TARGET SUFFIX <<< "$target_config"

  echo "Compiling for target: $TARGET"
  deno compile \
    --allow-all \
    --target "$TARGET" \
    --output "quint-$SUFFIX" \
    "npm:@informalsystems/quint@$VERSION"

  echo "Generating SHA256 hash for quint-$SUFFIX"
  sha256sum "quint-$SUFFIX" > "quint-$SUFFIX.sha256"

  if [ "$DRY_RUN" == true ]; then
    echo "[dry run] gh release upload \"$RELEASE_TAG\" \"quint-$SUFFIX\" \"quint-$SUFFIX.sha256\" --repo \"$REPO\" --clobber"
  else
    gh release upload "$RELEASE_TAG" \
      "quint-$SUFFIX" \
      "quint-$SUFFIX.sha256" \
      --repo "$REPO" \
      --clobber
  fi
done

echo "Release process complete."
