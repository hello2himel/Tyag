#!/bin/sh
# deUrge — Flatpak launcher.
#
# zypak-wrapper comes from org.electronjs.Electron2.BaseApp: it lets Chromium's
# own sandbox run inside the Flatpak sandbox, where the setuid chrome-sandbox
# helper is unavailable. TMPDIR is redirected into the per-app runtime dir so
# Chromium never writes outside the sandbox.
set -eu

if [ -z "${TMPDIR:-}" ] || [ ! -d "${TMPDIR}" ]; then
    export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"
    mkdir -p "${TMPDIR}"
fi

# Electron 44 auto-detects Wayland/X11 through Ozone; the flags are explicit so
# behaviour is identical on both sessions.
exec zypak-wrapper /app/deurge/deurge \
    --ozone-platform-hint=auto \
    --enable-features=WaylandWindowDecorations \
    "$@"
