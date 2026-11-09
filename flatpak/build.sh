#!/usr/bin/env bash
#
# deUrge — build the Flatpak bundle.
#
# Pipeline:
#   1. build the web app        (pnpm --filter @deurge/web build)
#   2. package Electron         (pnpm --filter @deurge/desktop build -> linux-unpacked)
#   3. stage the payload        (flatpak/build/stage)
#   4. flatpak-builder          (org.deurge.DeUrge.yml, runtime 24.08)
#   5. flatpak build-bundle     -> flatpak/dist/deUrge-<version>-<arch>.flatpak
#
# Usage:
#   bash flatpak/build.sh                 # auto-detect builder
#   BUILD=direct  bash flatpak/build.sh   # host flatpak-builder
#   BUILD=docker  bash flatpak/build.sh   # containerized flatpak-builder
#   SKIP_APP_BUILD=1 bash flatpak/build.sh   # reuse existing web/Electron build
#   FLATPAK_BUILDER=/path/to/flatpak-builder bash flatpak/build.sh
#
# Requirements (see docs/BUILDING.md):
#   - node + pnpm; flatpak CLI with the flathub remote (user or system)
#   - flatpak-builder: either on PATH, via `org.flatpak.Builder` (flatpak app),
#     or Docker. `--install-deps-from=flathub` fetches the 24.08 runtime/SDK.
#
# The finished bundle is self-contained w.r.t. the app; at install time the
# Flathub runtime repo is referenced so the runtime can be resolved.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FP="$ROOT/flatpak"
APP_ID="org.deurge.DeUrge"
MANIFEST="$FP/$APP_ID.yml"
VERSION="$(node -p "require('$ROOT/package.json').version")"
ARCH="$(uname -m)"
DIST="$FP/dist"
BUILD_ROOT="$FP/build"
STAGE="$BUILD_ROOT/stage"
REPO="$FP/repo"
BUILD_DIR="$BUILD_ROOT/dir"
UNPACKED="$ROOT/apps/desktop/release/linux-unpacked"
BUNDLE="$DIST/deUrge-$VERSION-$ARCH.flatpak"
MODE="${BUILD:-auto}"
FLATHUB_REPO_URL="https://dl.flathub.org/repo/flathub.flatpakrepo"
RUNTIME_VERSION="24.08"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------- prerequisites
[[ -f "$MANIFEST" ]] || die "manifest not found: $MANIFEST"
command -v node >/dev/null || die "node is required"
command -v pnpm >/dev/null || die "pnpm is required"
command -v flatpak >/dev/null || die "flatpak CLI is required"

if ! flatpak remotes --user 2>/dev/null | grep -q '^flathub' \
   && ! flatpak remotes 2>/dev/null | grep -q '^flathub'; then
  die "the flathub remote is not configured (flatpak remote-add --user --if-not-exists flathub $FLATHUB_REPO_URL)"
fi

# ---------------------------------------------------------------- app payload
if [[ "${SKIP_APP_BUILD:-0}" != "1" ]]; then
  say "Building web app"
  (cd "$ROOT" && pnpm --filter @deurge/web build)

  say "Packaging Electron (linux unpacked)"
  (cd "$ROOT" && pnpm --filter @deurge/desktop build)
fi

[[ -x "$UNPACKED/deurge" ]] || die "missing $UNPACKED/deurge — run without SKIP_APP_BUILD=1"

say "Staging Flatpak payload (v$VERSION, $ARCH)"
rm -rf "$STAGE"
mkdir -p "$STAGE/deurge-app" "$DIST"
cp -a "$UNPACKED/." "$STAGE/deurge-app/"
install -m755 "$FP/deurge-wrapper.sh" "$STAGE/deurge-wrapper.sh"
install -m644 "$FP/$APP_ID.desktop" "$STAGE/$APP_ID.desktop"
install -m644 "$FP/$APP_ID.metainfo.xml" "$STAGE/$APP_ID.metainfo.xml"
for size in 128 256 512; do
  install -m644 "$ROOT/apps/desktop/build/icons/${size}x${size}.png" "$STAGE/icon-$size.png"
done

# -------------------------------------------------------------------- builder
BUILDER_CMD=()
USING_BUILDER_APP=0
resolve_builder() {
  if [[ -n "${FLATPAK_BUILDER:-}" ]]; then
    read -r -a BUILDER_CMD <<< "$FLATPAK_BUILDER"
  elif command -v flatpak-builder >/dev/null; then
    BUILDER_CMD=("$(command -v flatpak-builder)")
  elif flatpak list --app 2>/dev/null | grep -q 'org.flatpak.Builder'; then
    # The org.flatpak.Builder Flatpak app is sandboxed with its own HOME, so its
    # flatpak user installation starts without remotes. Register flathub inside
    # that installation first; --install-deps-from=flathub then works there.
    USING_BUILDER_APP=1
    BUILDER_CMD=(flatpak run --command=flatpak-builder org.flatpak.Builder)
  else
    return 1
  fi
  return 0
}

ensure_builder_app_flathub() {
  [[ "$USING_BUILDER_APP" == "1" ]] || return 0
  say "Preparing flathub remote inside the org.flatpak.Builder sandbox"
  flatpak run --command=flatpak org.flatpak.Builder remote-add \
    --user --if-not-exists flathub "$FLATHUB_REPO_URL" || {
      warn "could not configure flathub inside org.flatpak.Builder; install the 24.08 SDK/base app in its sandbox manually"
    }
}

# Some distributions ship appstreamcli built against libvips without JPEG-XL
# support, which makes `appstreamcli compose` fail with `media-worker-error`.
# The org.freedesktop.Sdk used by the Flatpak contains an AppStream that works;
# run only the compose step through it (transparent shim on PATH) and retry.
make_appstream_shim() {
  local shim_dir="$BUILD_ROOT/appstream-shim"
  local sdk="org.freedesktop.Sdk//$RUNTIME_VERSION"
  flatpak info "$sdk" >/dev/null 2>&1 || return 1
  mkdir -p "$shim_dir"
  cat > "$shim_dir/appstreamcli" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
argv=()
skip=0
for arg in "$@"; do
  if [[ $skip -eq 1 ]]; then skip=0; continue; fi
  case "$arg" in
    --image-format) skip=1 ;;
    --image-format=*) ;;
    *) argv+=("$arg") ;;
  esac
done
exec flatpak run --filesystem=host --command=appstreamcli "org.freedesktop.Sdk//${DEURGE_FLATPAK_RUNTIME:-24.08}" "${argv[@]}"
SHIM
  chmod +x "$shim_dir/appstreamcli"
  printf '%s' "$shim_dir"
}

run_flatpak_builder() {
  local log="$BUILD_ROOT/flatpak-builder.log"
  mkdir -p "$BUILD_ROOT"
  if "$@" 2>&1 | tee "$log"; then
    return 0
  fi
  if grep -qE 'media-worker-error|filters-but-no-output|asc-mediaworker' "$log"; then
    local shim_dir
    if shim_dir="$(make_appstream_shim)"; then
      warn "host appstreamcli compose failed (libvips/JPEG-XL); retrying with the SDK AppStream shim"
      PATH="$shim_dir:$PATH" "$@" 2>&1 | tee -a "$log"
      return "${PIPESTATUS[0]}"
    fi
  fi
  return 1
}

direct_build() {
  say "flatpak-builder (direct: ${BUILDER_CMD[*]})"
  ensure_builder_app_flathub
  if ! run_flatpak_builder "${BUILDER_CMD[@]}" --user --force-clean --disable-rofiles-fuse \
    --default-branch=stable --repo="$REPO" --install-deps-from=flathub --arch="$ARCH" \
    "$BUILD_DIR" "$MANIFEST"; then
    die "flatpak-builder failed — see $BUILD_ROOT/flatpak-builder.log"
  fi

  rm -f "$BUNDLE"
  flatpak build-bundle --runtime-repo="$FLATHUB_REPO_URL" \
    "$REPO" "$BUNDLE" "$APP_ID" stable
}

docker_build() {
  local image="${FLATPAK_BUILDER_IMAGE:-ghcr.io/flathub-infra/flatpak-builder:latest}"
  command -v docker >/dev/null || die "docker is not available (needed for BUILD=docker)"
  say "flatpak-builder (docker image: $image)"
  docker run --rm --entrypoint /bin/bash \
    -v "$ROOT:$ROOT" -w "$FP" \
    -e "HOST_UID=$(id -u)" -e "HOST_GID=$(id -g)" \
    -e "APP_ID=$APP_ID" -e "VERSION=$VERSION" -e "ARCH=$ARCH" \
    "$image" -lc "
      set -euo pipefail
      flatpak remote-add --system --if-not-exists flathub '$FLATHUB_REPO_URL'
      flatpak-builder --force-clean --disable-rofiles-fuse \
        --default-branch=stable --repo=repo --install-deps-from=flathub --arch=$ARCH \
        build/dir org.deurge.DeUrge.yml
      flatpak build-bundle --runtime-repo='$FLATHUB_REPO_URL' \
        repo 'dist/deUrge-$VERSION-$ARCH.flatpak' '$APP_ID' stable
      chown -R \"\$HOST_UID:\$HOST_GID\" build repo dist
    "
}

case "$MODE" in
  direct)
    resolve_builder || die "flatpak-builder not found (install it, or use BUILD=docker)"
    direct_build
    ;;
  docker)
    docker_build
    ;;
  auto)
    if resolve_builder; then
      direct_build
    elif command -v docker >/dev/null; then
      docker_build
    else
      die "no flatpak-builder and no docker — install one of them (docs/BUILDING.md)"
    fi
    ;;
  *)
    die "unknown BUILD mode '$MODE' (direct|docker|auto)"
    ;;
esac

# ------------------------------------------------------------------- checksums
[[ -f "$BUNDLE" ]] || die "bundle was not produced: $BUNDLE"
(
  cd "$DIST"
  sha256sum "$(basename "$BUNDLE")" > SHA256SUMS.txt
)
say "Done"
ls -lh "$BUNDLE"
echo "    sha256: $(cut -d' ' -f1 "$DIST/SHA256SUMS.txt")"
cat <<'EOF'

Notes:
  * The bundle targets the build host architecture only. Cross-arch Flatpaks
    need a matching Electron build + arch-specific manifest (see docs/BUILDING.md).
  * Sandbox: no network, no home-directory access, only xdg-download for
    user-initiated backup export/import.
  * Install locally:  flatpak install --user --bundle dist/deUrge-*.flatpak
    Run:              flatpak run org.deurge.DeUrge
EOF
