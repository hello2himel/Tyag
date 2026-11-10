#!/usr/bin/env bash
#
# Tyag — Android build (web build -> Capacitor sync -> Gradle APK/AAB).
#
# Usage:
#   scripts/build-android.sh [auto|debug|release]
#
#   auto     (default) release build when the TYAG_KEYSTORE* env vars are
#            present, otherwise a debug build
#   debug    assembleDebug; signed with the local debug keystore (never shipped
#            to a store, fine for device testing)
#   release  assembleRelease + bundleRelease; REQUIRES the signing env vars:
#              TYAG_KEYSTORE           path to the .jks/.keystore
#              TYAG_KEYSTORE_PASSWORD  store password
#              TYAG_KEY_ALIAS          key alias
#              TYAG_KEY_PASSWORD       key password
#
# Environment (never hardcoded — see docs/BUILDING.md):
#   JAVA_HOME      JDK 21 (Capacitor 8 / AGP 8.13 needs 21)
#   ANDROID_HOME   Android SDK (android-36 + build-tools 36). Falls back to
#                  android/local.properties (machine-local, git-ignored).
#
# Outputs (all git-ignored):
#   apps/mobile/dist/apk/Tyag-<version>-[debug|release].apk
#   apps/mobile/dist/aab/Tyag-<version>-release.aab
#   apps/mobile/dist/SHA256SUMS.txt
set -euo pipefail

MODE="${1:-auto}"
MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$MOBILE_DIR/../.." && pwd)"
ANDROID_DIR="$MOBILE_DIR/android"
DIST_DIR="$MOBILE_DIR/dist"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[[ -d "$ANDROID_DIR" ]] || die "apps/mobile/android is missing — run 'pnpm --filter @tyag/mobile exec cap add android' first"

# ---------------------------------------------------------------- environment
[[ -n "${JAVA_HOME:-}" ]] || die "JAVA_HOME is not set. Point it at a JDK 21 (e.g. Temurin 21), see docs/BUILDING.md"
[[ -x "$JAVA_HOME/bin/java" ]] || die "JAVA_HOME ($JAVA_HOME) does not contain bin/java"
JAVA_MAJOR="$("$JAVA_HOME/bin/java" -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)"
[[ "$JAVA_MAJOR" -ge 21 ]] || die "JDK 21+ required (found $JAVA_MAJOR at $JAVA_HOME)"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$SDK" && -f "$ANDROID_DIR/local.properties" ]]; then
  SDK="$(sed -n 's/^sdk\.dir=//p' "$ANDROID_DIR/local.properties" | head -1)"
fi
[[ -n "$SDK" ]] || die "Android SDK not found. Set ANDROID_HOME (see docs/BUILDING.md)"
[[ -d "$SDK" ]] || die "ANDROID_HOME ($SDK) is not a directory"
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"

VERSION="$(node -p "require('$MOBILE_DIR/package.json').version")"

have_signing() {
  [[ -n "${TYAG_KEYSTORE:-}" && -n "${TYAG_KEYSTORE_PASSWORD:-}" \
     && -n "${TYAG_KEY_ALIAS:-}" && -n "${TYAG_KEY_PASSWORD:-}" ]]
}

case "$MODE" in
  auto)    if have_signing; then MODE=release; else MODE=debug; fi ;;
  debug|release) ;;
  *) die "unknown mode '$MODE' (use auto|debug|release)" ;;
esac

say "Tyag android ($MODE) — version $VERSION"
echo "    JAVA_HOME=$JAVA_HOME (JDK $JAVA_MAJOR)"
echo "    ANDROID_HOME=$ANDROID_HOME"

# ---------------------------------------------------------------- web + sync
say "Building web assets"
(cd "$REPO_ROOT" && pnpm --filter @tyag/web build)

say "Syncing Capacitor Android project"
(cd "$MOBILE_DIR" && pnpm exec cap sync android)

# --------------------------------------------------------------------- gradle
GRADLE_ARGS=(--no-daemon --console=plain)
case "$MODE" in
  debug)
    say "Gradle assembleDebug"
    (cd "$ANDROID_DIR" && ./gradlew "${GRADLE_ARGS[@]}" assembleDebug)
    APK_SRC="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
    APK_OUT="$DIST_DIR/apk/Tyag-$VERSION-debug.apk"
    ;;
  release)
    have_signing || die "release build requires TYAG_KEYSTORE, TYAG_KEYSTORE_PASSWORD, TYAG_KEY_ALIAS, TYAG_KEY_PASSWORD"
    say "Gradle assembleRelease + bundleRelease"
    (cd "$ANDROID_DIR" && ./gradlew "${GRADLE_ARGS[@]}" assembleRelease bundleRelease)
    APK_SRC="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
    APK_OUT="$DIST_DIR/apk/Tyag-$VERSION-release.apk"
    AAB_SRC="$ANDROID_DIR/app/build/outputs/bundle/release/app-release.aab"
    AAB_OUT="$DIST_DIR/aab/Tyag-$VERSION-release.aab"
    ;;
esac

# ------------------------------------------------------------------- collect
mkdir -p "$DIST_DIR/apk" "$DIST_DIR/aab"
[[ -f "$APK_SRC" ]] || die "expected APK not found: $APK_SRC"
cp -f "$APK_SRC" "$APK_OUT"
say "APK: $APK_OUT"

if [[ "$MODE" == release ]]; then
  [[ -f "$AAB_SRC" ]] || die "expected AAB not found: $AAB_SRC"
  cp -f "$AAB_SRC" "$AAB_OUT"
  say "AAB: $AAB_OUT"
fi

# ------------------------------------------------------------- verify + sums
BUILD_TOOLS="$(ls -d "$ANDROID_HOME"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
if [[ -n "$BUILD_TOOLS" && -x "$BUILD_TOOLS/apksigner" ]]; then
  "$BUILD_TOOLS/apksigner" verify "$APK_OUT" >/dev/null 2>&1 \
    && echo "    apksigner: signature OK" \
    || echo "    apksigner: WARNING — APK signature could not be verified"
fi

(
  cd "$DIST_DIR"
  : > SHA256SUMS.txt
  find apk aab -type f -name '*.apk' -o -type f -name '*.aab' 2>/dev/null | sort | while read -r f; do
    sha256sum "$f" >> SHA256SUMS.txt
  done
)
say "Checksums: $DIST_DIR/SHA256SUMS.txt"
cat "$DIST_DIR/SHA256SUMS.txt"
