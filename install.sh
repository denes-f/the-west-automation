#!/bin/bash
# Puts the current the-west-automation.js in front of the browsers, so a page
# reload runs the new version -- no editor, no copy-paste.
#
#   ./install.sh                 Safari: copy into the Userscripts app's folder
#   ./install.sh chrome-loader   Chrome: print the one-time Tampermonkey loader
#
# Safari's Userscripts keeps every script as a plain file and maps URL patterns
# to file NAMES in its manifest.json, so the file is simply overwritten. The name
# comes from @name, which is why @name carries no version number: a new name per
# release would leave the old file behind, still matching the same pages.
#
# Tampermonkey keeps its scripts in its own database, which nothing outside can
# write. Instead, a small loader is installed once, and it @requires this file
# from disk -- Tampermonkey reads a file:// @require afresh, so a reload is enough.
set -euo pipefail
cd "$(dirname "$0")"

SRC="$PWD/the-west-automation.js"
NAME="The-West Modular Job Queue (Lisa).user.js"
DIR="$HOME/Library/Containers/com.userscripts.macos.Userscripts-Extension/Data/Documents"
VERSION=$(sed -n 's#^// @version *##p' "$SRC" | head -1)

case "${1:-safari}" in
safari)
    # A broken build must never reach the game: the same two checks as before a commit.
    node smoke-load.js > /dev/null
    node test-queue.js > /dev/null || { echo "A tesztek elbuktak, nem telepítem." >&2; exit 1; }

    [ -d "$DIR/scripts" ] || { echo "Nem találom a Userscripts mappáját: $DIR/scripts" >&2; exit 1; }
    cp "$SRC" "$DIR/scripts/$NAME"

    # Older installs were named after a versioned @name ("Lisa v12.20"). Remove
    # those files and point the manifest's entries at the stable name instead.
    shopt -s nullglob
    for old in "$DIR/scripts/The-West Modular Job Queue (Lisa v"*").user.js"; do
        rm -- "$old"
        echo "Régi példány törölve: $(basename "$old")"
    done
    if grep -q 'The-West Modular Job Queue (Lisa v' "$DIR/manifest.json"; then
        cp "$DIR/manifest.json" "${TMPDIR:-/tmp}/userscripts-manifest.backup.json"
        python3 - "$DIR/manifest.json" "$NAME" <<'PY'
import re, sys
path, name = sys.argv[1], sys.argv[2]
text = open(path, encoding='utf-8').read()
text = re.sub(r'The-West Modular Job Queue \(Lisa v[0-9.]+\)\.user\.js', name, text)
open(path, 'w', encoding='utf-8').write(text)
PY
        echo "manifest.json frissítve (mentés: ${TMPDIR:-/tmp}/userscripts-manifest.backup.json)"
    fi
    grep -q "$NAME" "$DIR/manifest.json" \
        || echo "Figyelem: a manifest még nem ismeri a scriptet -- nyisd meg egyszer a Userscripts alkalmazást."
    echo "Safari: v$VERSION telepítve. Töltsd újra a játék oldalát."
    ;;
chrome-loader)
    cat <<EOF
// ==UserScript==
// @name         The-West Modular Job Queue (Lisa, helyi fájlból)
// @namespace    http://tampermonkey.net/
// @version      1
// @description  A Lisa scriptet közvetlenül a gépen lévő fájlból tölti be: új verzióhoz elég újratölteni az oldalt.
// @include      https://*.the-west.hu/*
// @match        https://*.the-west.hu/*
// @grant        none
// @run-at       document-end
// @require      file://$SRC
// ==/UserScript==
EOF
    ;;
*)
    echo "Használat: ./install.sh [safari|chrome-loader]" >&2
    exit 2
    ;;
esac
