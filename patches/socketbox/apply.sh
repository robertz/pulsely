#!/usr/bin/env bash
# Reapplies tracked local patches to the vendored, gitignored
# lib/modules/socketbox/ tree. Must run after every `box install` (which
# refetches lib/modules/socketbox fresh and silently discards direct
# edits) - see patches/socketbox/README.md for the bug each file works
# around (ortus-boxlang/BoxLang#595).
#
# box.json's postInstallAll hook fires on ANY `box install` run from this
# project root - including, in the Docker build, an earlier system-level
# `box install commandbox-boxlang --system` step that runs before the
# app's own dependencies (and therefore lib/modules/socketbox) exist at
# all. Treat a missing target as "nothing to patch yet" and exit 0 rather
# than failing that unrelated install - the app's own `box install
# --production` step re-triggers this script later in the same build, by
# which point socketbox is actually present. Avoids `find`/GNU-specific
# tools since minimal container images may not have them.
set -euo pipefail
cd "$(dirname "$0")"

TARGET_ROOT="../../lib/modules/socketbox"

if [ ! -d "$TARGET_ROOT" ]; then
    echo "patches/socketbox/apply.sh: $TARGET_ROOT not found yet (nothing to patch) - skipping"
    exit 0
fi

patch_dir() {
    local src_dir="$1" rel_dir="$2"
    local entry
    for entry in "$src_dir"/*; do
        [ -e "$entry" ] || continue
        local name; name="$(basename "$entry")"
        local rel="$rel_dir$name"
        if [ -d "$entry" ]; then
            patch_dir "$entry" "$rel/"
        else
            local dest="$TARGET_ROOT/$rel"
            if [ ! -f "$dest" ]; then
                echo "patches/socketbox/apply.sh: WARNING - $dest missing (socketbox layout changed?); skipping $rel" >&2
                continue
            fi
            cp "$entry" "$dest"
            echo "patched: lib/modules/socketbox/$rel"
        fi
    done
}

patch_dir "files" ""
