#!/usr/bin/env bash
# Regenerates every raster icon from the SVG masters in this directory.
# Needs: chromium (headless) and ImageMagick (`magick`).
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
CHROME=${CHROME_BIN:-$(command -v chromium || command -v chromium-browser || command -v google-chrome)}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# render <svg|html file> <size WxH> <output png>   (transparent background)
render() {
  local src=$1 size=$2 out=$3 w=${2%x*} h=${2#*x}
  if [[ $src == *.svg ]]; then
    printf '<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:transparent}img{display:block;width:%spx;height:%spx}</style><img src="file://%s">' \
      "$w" "$h" "$PWD/$src" > "$TMP/wrap.html"
    src=$TMP/wrap.html
  else
    src=$PWD/$src
  fi
  "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --default-background-color=00000000 --window-size="$w,$h" --screenshot="$out" "file://${src#file://}" >/dev/null 2>&1
}

WEB=$ROOT/src/assets/images
for s in 16 32 48 64 128 256; do render keeparr-icon.svg ${s}x${s} "$TMP/f$s.png"; done
magick "$TMP"/f16.png "$TMP"/f32.png "$TMP"/f48.png "$TMP"/f64.png "$TMP"/f128.png "$TMP"/f256.png "$ROOT/src/favicon.ico"
cp keeparr-icon.svg "$WEB/keeparr-icon.svg"
render keeparr-icon.svg 192x192 "$WEB/keeparr-icon-192.png"
render keeparr-icon.svg 512x512 "$WEB/keeparr-icon-512.png"
render keeparr-icon-maskable.svg 512x512 "$WEB/keeparr-icon-maskable-512.png"
render keeparr-icon-maskable.svg 180x180 "$WEB/apple-touch-icon-180.png"
render keeparr-icon.svg 512x512 "$WEB/keeparr-logo.png"

echo done
