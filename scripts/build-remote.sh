#!/usr/bin/env bash
# Build new-api docker image on a remote Docker daemon.
#
# Usage:
#   ./scripts/build-remote.sh                 # tag as weny7/new-api:latest
#   ./scripts/build-remote.sh v1.2.3          # tag as weny7/new-api:latest AND weny7/new-api:v1.2.3
#   REMOTE=tcp://host:2375 ./scripts/build-remote.sh
#   PUSH=1 ./scripts/build-remote.sh v1.2.3   # also `docker push` after build

set -euo pipefail

REMOTE="${REMOTE:-tcp://192.168.100.153:2375}"
IMAGE="${IMAGE:-wenyou7/new-api}"
EXTRA_TAG="${1:-}"
PUSH="${PUSH:-0}"

# Run from repo root regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\033[1;34m[build-remote]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[build-remote]\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker CLI not found in PATH"

log "Remote daemon : $REMOTE"
log "Image name    : $IMAGE:latest${EXTRA_TAG:+, $IMAGE:$EXTRA_TAG}"
log "Context       : $REPO_ROOT"

# ⚠️ Port 2375 is unencrypted TCP — only use it on a trusted LAN.
case "$REMOTE" in
  tcp://*:2375) log "WARN: using unencrypted tcp:2375 — ensure this daemon is on a trusted network." ;;
esac

log "Pinging remote daemon…"
docker -H "$REMOTE" version --format '{{.Server.Version}}' >/dev/null \
  || die "cannot reach docker daemon at $REMOTE"

BUILD_ARGS=(-t "$IMAGE:latest")
if [ -n "$EXTRA_TAG" ]; then
  BUILD_ARGS+=(-t "$IMAGE:$EXTRA_TAG")
fi

log "Starting build (context will be streamed to remote daemon)…"
docker -H "$REMOTE" build "${BUILD_ARGS[@]}" -f Dockerfile .

log "Build finished."
docker -H "$REMOTE" image ls --filter "reference=$IMAGE" --format 'table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}'

if [ "$PUSH" = "1" ]; then
  log "Pushing $IMAGE:latest…"
  docker -H "$REMOTE" push "$IMAGE:latest"
  if [ -n "$EXTRA_TAG" ]; then
    log "Pushing $IMAGE:$EXTRA_TAG…"
    docker -H "$REMOTE" push "$IMAGE:$EXTRA_TAG"
  fi
fi

log "Done."
