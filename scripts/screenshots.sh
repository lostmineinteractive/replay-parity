#!/bin/sh
# Renders the demo reports to PNG with headless Chrome. Usage:
#   sh scripts/screenshots.sh [demo/out] [docs/images]
# A whole report is captured from the top. A single section is captured by
# extracting it into a page of its own with the report's styles, since a
# headless screenshot always starts at the top of the page.
set -eu
cd "$(dirname "$0")/.."
out_dir=${1:-demo/out}
img_dir=${2:-docs/images}
mkdir -p "$img_dir"

chrome=${CHROME:-}
if [ -z "$chrome" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" google-chrome chromium chromium-browser; do
    if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then chrome=$c; break; fi
  done
fi
if [ -z "$chrome" ]; then
  echo "screenshots: no Chrome found; set CHROME to the binary" >&2
  exit 1
fi

# shot <report file> <section id or -> <image name> <height>
shot() {
  report=$1; section=$2; name=$3; height=$4
  file="$out_dir/$report"
  if [ ! -f "$file" ]; then
    echo "screenshots: $file is missing, run make demo first" >&2
    exit 1
  fi
  page=$file
  if [ "$section" != "-" ]; then
    page="$out_dir/.shot-$name.html"
    node -e '
      const fs = require("node:fs");
      const [src, id, dst] = process.argv.slice(1);
      const html = fs.readFileSync(src, "utf8");
      const head = html.slice(0, html.indexOf("<body>") + "<body>".length);
      const start = html.indexOf(`<section id="${id}">`);
      if (start < 0) { console.error(`section ${id} not found in ${src}`); process.exit(1); }
      const end = html.indexOf("</section>", start) + "</section>".length;
      fs.writeFileSync(dst, `${head}<main>${html.slice(start, end)}</main></body></html>\n`);
    ' "$file" "$section" "$page"
  fi
  url="file://$(cd "$(dirname "$page")" && pwd)/$(basename "$page")"
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1200,"$height" --screenshot="$img_dir/$name.png" "$url" >/dev/null 2>&1
  if [ "$section" != "-" ]; then rm -f -- "$page"; fi
  echo "wrote $img_dir/$name.png"
}

shot report.html - report-header 1000
shot report.html latency report-latency 1100
shot report.html correctness report-correctness 1400
shot report-unordered.html correctness report-unordered 900
shot report-clean.html - report-clean 1000
shot report-defect.html invariants report-defect-invariants 1300
shot report-defect.html reproduction report-defect-reproduction 700
shot report.html agent report-agent 900
