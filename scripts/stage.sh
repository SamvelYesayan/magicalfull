#!/usr/bin/env bash
# Verification helper (NOT part of the product build): stages the unbundled sources so the real
# Node server can serve them, for browser testing where `vite build` is unavailable.
set -e
OUT=${1:-/tmp/stage}; rm -rf "$OUT"; mkdir -p "$OUT/node_modules/@fontsource"
cp index.html invitation.html admin.html "$OUT"/; cp -r src shared "$OUT"/; cp -r public/* "$OUT"/
for p in inter outfit noto-sans-armenian; do mkdir -p "$OUT/node_modules/@fontsource/$p"; cp node_modules/@fontsource/$p/*.css "$OUT/node_modules/@fontsource/$p/"; cp -r node_modules/@fontsource/$p/files "$OUT/node_modules/@fontsource/$p/"; done
sed -i "s#'@fontsource/#'/node_modules/@fontsource/#" "$OUT/src/fonts.css"
