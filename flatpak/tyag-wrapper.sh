#!/bin/sh
# Tyag: Flatpak launcher.
#
# Tauri renders the embedded React/Vite bundle with the GNOME runtime's
# WebKitGTK 4.1; there is no Electron/Chromium here, so no zypak wrapper and no
# sandbox workarounds are needed. This launcher exists so the Flatpak entrypoint
# stays stable (desktop file + AppStream <binary>) and to give WebKitGTK a
# writable TMPDIR even in minimal sessions. It never touches the network.
set -eu

if [ -z "${TMPDIR:-}" ] || [ ! -d "${TMPDIR}" ]; then
    export TMPDIR="${XDG_RUNTIME_DIR:-/tmp}/app/${FLATPAK_ID:-org.tyag.Tyag}"
    mkdir -p "${TMPDIR}"
fi

exec /app/bin/tyag "$@"
