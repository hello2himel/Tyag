#!/usr/bin/env bash
#
# deUrge — iOS build (web build -> Capacitor sync -> xcodebuild).
# Runs only on macOS with Xcode command line tools installed (see
# docs/BUILDING.md); CI uses the same entry point from .github/workflows/ios.yml.
#
# Usage: scripts/build-ios.sh [simulator|archive]
#   simulator  (default) unsigned simulator build — proves the project compiles
#   archive    unsigned device archive (.xcarchive) for later signing/export
#
# Environment:
#   JAVA_HOME is NOT needed; needs Xcode + CocoaPods.
#   DEURGE_CODESIGN_IDENTITY / DEURGE_TEAM_ID are optional (signing is done in
#   Xcode/CI secrets, never in this repo).
set -euo pipefail

MODE="${1:-simulator}"
MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$MOBILE_DIR/../.." && pwd)"
IOS_APP_DIR="$MOBILE_DIR/ios/App"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "iOS builds require macOS with Xcode"
command -v xcodebuild >/dev/null || die "xcodebuild not found — install Xcode"
[[ -d "$IOS_APP_DIR" ]] || die "apps/mobile/ios is missing — run 'pnpm --filter @deurge/mobile exec cap add ios' on macOS"

say "Building web assets"
(cd "$REPO_ROOT" && pnpm --filter @deurge/web build)

say "Syncing Capacitor iOS project"
(cd "$MOBILE_DIR" && pnpm exec cap sync ios)

say "Installing CocoaPods"
(cd "$IOS_APP_DIR" && pod install --repo-update)

SCHEME="App"
DERIVED="$MOBILE_DIR/build/ios"

case "$MODE" in
  simulator)
    say "xcodebuild (iphonesimulator, unsigned)"
    (cd "$IOS_APP_DIR" && xcodebuild \
      -workspace App.xcworkspace \
      -scheme "$SCHEME" \
      -configuration Debug \
      -sdk iphonesimulator \
      -derivedDataPath "$DERIVED" \
      CODE_SIGNING_ALLOWED=NO \
      build)
    echo "APP: $DERIVED/Build/Products/Debug-iphonesimulator/App.app"
    ;;
  archive)
    say "xcodebuild archive (unsigned)"
    (cd "$IOS_APP_DIR" && xcodebuild \
      -workspace App.xcworkspace \
      -scheme "$SCHEME" \
      -configuration Release \
      -sdk iphoneos \
      -destination 'generic/platform=iOS' \
      -archivePath "$MOBILE_DIR/dist/ios/deUrge.xcarchive" \
      CODE_SIGNING_ALLOWED=NO \
      archive)
    echo "ARCHIVE: $MOBILE_DIR/dist/ios/deUrge.xcarchive"
    ;;
  *)
    die "unknown mode '$MODE' (use simulator|archive)"
    ;;
esac
