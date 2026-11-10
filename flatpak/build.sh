#!/usr/bin/env bash
#
# deUrge — build the Flatpak bundle.
#
# Pipeline:
#   1. build the web app          (pnpm --filter @deurge/web build)
#   2. build the Tauri binary     (pnpm --filter @deurge/desktop build -> target/release/deurge)
#   3. stage the payload          (flatpak/build/stage)
#   4. flatpak-builder            (org.deurge.DeUrge.yml, org.gnome.Platform//48)
#   5. flatpak build-bundle       -> flatpak/dist/deUrge-<version>-<arch>.flatpak
#
# The Flatpak ships the prebuilt Tauri binary and runs it on the WebKitGTK 4.1
# from the GNOME runtime: no Electron base app, no zypak, no bundled Chromium.
#
# Usage:
#   bash flatpak/build.sh                    # auto-detect builder
#   BUILD=direct  bash flatpak/build.sh      # host flatpak-builder
#   BUILD=docker  bash flatpak/build.sh      # containerized flatpak-builder
#   SKIP_APP_BUILD=1 bash flatpak/build.sh   # reuse existing web/Tauri build
#   FLATPAK_BUILDER=/path/to/flatpak-builder bash flatpak/build.sh
#
# Requirements (see docs/BUILDING.md):
#   - node + pnpm; Rust toolchain with the Tauri Linux deps (webkit2gtk-4.1-dev …)
#   - flatpak CLI with the flathub remote (user or system)
#   - flatpak-builder: either on PATH, via the `org.flatpak.Builder` app, or
#     Docker. `--install-deps-from=flathub` fetches org.gnome.Platform/Sdk 48.
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
BINARY="$ROOT/apps/desktop/src-tauri/target/release/deurge"
BUNDLE="$DIST/deUrge-$VERSION-$ARCH.flatpak"
MODE="${BUILD:-auto}"
FLATHUB_REPO_URL="https://dl.flathub.org/repo/flathub.flatpakrepo"
# The GNOME runtime that ships WebKitGTK 4.1. Keep in sync with the manifest.
RUNTIME_VERSION="48"

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

  say "Building Tauri binary (release, no bundle)"
  (cd "$ROOT" && pnpm --filter @deurge/desktop build)
fi

[[ -x "$BINARY" ]] || die "missing $BINARY — run without SKIP_APP_BUILD=1"

say "Staging Flatpak payload (v$VERSION, $ARCH)"
rm -rf "$STAGE"
mkdir -p "$STAGE" "$DIST"
install -Dm755 "$BINARY" "$STAGE/deurge"
install -m755 "$FP/deurge-wrapper.sh" "$STAGE/deurge-wrapper.sh"
install -m644 "$FP/$APP_ID.desktop" "$STAGE/$APP_ID.desktop"
install -m644 "$FP/$APP_ID.metainfo.xml" "$STAGE/$APP_ID.metainfo.xml"
# Tauri's generated icon set (RGBA) plus the 512px PWA asset.
install -m644 "$ROOT/apps/desktop/src-tauri/icons/128x128.png" "$STAGE/icon-128.png"
install -m644 "$ROOT/apps/desktop/src-tauri/icons/128x128@2x.png" "$STAGE/icon-256.png"
install -m644 "$ROOT/apps/web/public/icons/icon-512.png" "$STAGE/icon-512.png"

# -------------------------------------------------------------------- builder
BUILDER_CMD=()
USING_BUILDER_APP=0
# The org.flatpak.Builder app is sandboxed: its own `--user` flatpak
# installation starts empty. Point flatpak-builder at the host user
# installation instead (it is visible inside the sandbox via
# `--filesystem=xdg-data/flatpak`), so already-installed runtimes are reused.
HOST_FLATPAK_USER_DIR="${FLATPAK_USER_DIR:-$HOME/.local/share/flatpak}"
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
    BUILDER_CMD=(flatpak run "--env=FLATPAK_USER_DIR=$HOST_FLATPAK_USER_DIR" --command=flatpak-builder org.flatpak.Builder)
  else
    return 1
  fi
  return 0
}

ensure_builder_app_flathub() {
  [[ "$USING_BUILDER_APP" == "1" ]] || return 0
  say "Preparing flathub remote inside the org.flatpak.Builder sandbox"
  flatpak run "--env=FLATPAK_USER_DIR=$HOST_FLATPAK_USER_DIR" --command=flatpak \
    org.flatpak.Builder remote-add --user --if-not-exists flathub "$FLATHUB_REPO_URL" || {
      warn "could not configure flathub inside org.flatpak.Builder; install org.gnome.Platform//$RUNTIME_VERSION and org.gnome.Sdk//$RUNTIME_VERSION in its sandbox manually"
    }
  # `flatpak install <remote> <ref>` needs the remote summary before it can
  # resolve a ref; fetch it once so --install-deps-from can work.
  flatpak run "--env=FLATPAK_USER_DIR=$HOST_FLATPAK_USER_DIR" --command=flatpak \
    org.flatpak.Builder update --appstream flathub >/dev/null 2>&1 || \
    warn "could not refresh the flathub appstream inside org.flatpak.Builder (will try the installed runtimes)"
}

# Is the GNOME runtime/SDK for $RUNTIME_VERSION already available to the builder?
builder_runtime_available() {
  local ref
  for ref in "org.gnome.Platform//$RUNTIME_VERSION" "org.gnome.Sdk//$RUNTIME_VERSION"; do
    if [[ "$USING_BUILDER_APP" == "1" ]]; then
      flatpak run "--env=FLATPAK_USER_DIR=$HOST_FLATPAK_USER_DIR" --command=flatpak \
        org.flatpak.Builder info --user "$ref" >/dev/null 2>&1 || return 1
    else
      flatpak info "$ref" >/dev/null 2>&1 || return 1
    fi
  done
  return 0
}

# Some distributions ship appstreamcli built against libvips without JPEG-XL
# support, which makes `appstreamcli compose` fail with `media-worker-error`.
# The AppStream in the GNOME SDK works; run only the compose step through the
# SDK (transparent shim on PATH) and retry once.
# shellcheck disable=SC2016
make_appstream_shim() {
  local shim_dir="$BUILD_ROOT/appstream-shim"
  local sdk="org.gnome.Sdk//$RUNTIME_VERSION"
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
exec flatpak run --filesystem=host --command=appstreamcli "org.gnome.Sdk//${DEURGE_FLATPAK_RUNTIME:-48}" "${argv[@]}"
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
      warn "host appstreamcli compose failed (libvips/JPEG-XL); retrying with the GNOME SDK AppStream shim"
      DEURGE_FLATPAK_RUNTIME="$RUNTIME_VERSION" PATH="$shim_dir:$PATH" "$@" 2>&1 | tee -a "$log"
      return "${PIPESTATUS[0]}"
    fi
  fi
  return 1
}

direct_build() {
  say "flatpak-builder (direct: ${BUILDER_CMD[*]})"
  local -a deps_args=()
  if builder_runtime_available; then
    say "Using the installed org.gnome.Platform/org.gnome.Sdk //$RUNTIME_VERSION"
  else
    say "org.gnome.Platform/org.gnome.Sdk //$RUNTIME_VERSION missing — installing from flathub"
    ensure_builder_app_flathub
    deps_args=(--install-deps-from=flathub)
  fi
  if ! run_flatpak_builder "${BUILDER_CMD[@]}" --user --force-clean --disable-rofiles-fuse \
    --default-branch=stable --repo="$REPO" "${deps_args[@]}" --arch="$ARCH" \
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
    need a matching Tauri build for that architecture (CI builds x86_64 only).
  * Runtime: org.gnome.Platform//48 provides GTK 3 + WebKitGTK 4.1; the bundle
    references the Flathub runtime repo so the runtime can be resolved at
    install time.
  * Sandbox: no network, no home-directory access, only xdg-download for
    user-initiated exports/backups.
  * Install locally:  flatpak install --user --bundle dist/deUrge-*.flatpak
    Run:              flatpak run org.deurge.DeUrge
EOF
