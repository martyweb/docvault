#!/usr/bin/env bash
# Build and deploy DocVault to a Docker host.
#
#   scripts/deploy.sh               deploy only if files changed since the last successful deploy
#   scripts/deploy.sh --force       always deploy
#
# Configured through .env (see .env.example):
#   DEPLOY_DOCKER_CONTEXT   docker context to deploy to (default: the current context)
#   DATA_DIR                host directory for data (default: Docker named volumes)
#   DOCVAULT_HOST           hostname to serve through Traefik (default: publish DOCVAULT_PORT)
#   TRAEFIK_MIDDLEWARES     optional Traefik middlewares for the router
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

CONTEXT="${DEPLOY_DOCKER_CONTEXT:-$(docker context show)}"
HASH_FILE=.deploy-hash

FILES=(-f docker-compose.yml)
[[ -n "${DATA_DIR:-}" ]] && FILES+=(-f docker-compose.datadir.yml)
[[ -n "${DOCVAULT_HOST:-}" ]] && FILES+=(-f docker-compose.traefik.yml)
[[ -n "${DOCVAULT_HOST:-}" && -n "${TRAEFIK_MIDDLEWARES:-}" ]] && FILES+=(-f docker-compose.traefik-middlewares.yml)
compose() { docker --context "$CONTEXT" compose "${FILES[@]}" "$@"; }

# Fingerprint every non-ignored file, plus .env (ignored by git but affects the deployment).
current_hash() {
  { git ls-files -co --exclude-standard -z; [ -f .env ] && printf '.env\0'; } \
    | grep -zv '^\.claude/' | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
}

hash="$(current_hash)"
if [[ "${1:-}" != "--force" && -f "$HASH_FILE" && "$(cat "$HASH_FILE")" == "$hash" ]]; then
  echo "DocVault: no changes since last deploy; skipping."
  exit 0
fi

echo "DocVault: deploying to docker context '$CONTEXT'..."
if [[ -n "${DATA_DIR:-}" ]]; then
  # Some hosts (e.g. Synology) won't create missing bind-mount directories, so make them first.
  name="$(basename "$DATA_DIR")"
  docker --context "$CONTEXT" run --rm -v "$(dirname "$DATA_DIR"):/host" alpine:3 \
    mkdir -p "/host/$name/db" "/host/$name/uploads" "/host/$name/models"
fi
compose up -d --build --remove-orphans

# Wait for the backend to report healthy (first start downloads the embedding model).
status=""
for _ in $(seq 1 60); do
  status="$(compose ps backend --format '{{.Health}}' 2>/dev/null || true)"
  [[ "$status" == "healthy" ]] && break
  sleep 5
done
if [[ "$status" != "healthy" ]]; then
  echo "DocVault: backend not healthy (status: ${status:-unknown}). Recent logs:" >&2
  compose logs --tail 40 backend >&2
  exit 1
fi

echo "$hash" > "$HASH_FILE"
if [[ -n "${DOCVAULT_HOST:-}" ]]; then
  echo "DocVault: deployed. https://$DOCVAULT_HOST"
else
  echo "DocVault: deployed on port ${DOCVAULT_PORT:-8080}."
fi
