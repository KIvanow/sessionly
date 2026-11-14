#!/usr/bin/env bash
# Regenerates website/dpa.pdf from website/dpa.html, using the page's print styles.
# Needs Chromium (set CHROMIUM to its path if it is not called "chromium").
set -euo pipefail
cd "$(dirname "$0")/../website"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Links to the site become absolute, so they work from the PDF.
sed -e 's|href="/site.css"|href="@CSS@"|' \
    -e 's|href="/\([a-z]\)|href="https://sessionly.dev/\1|g' \
    -e "s|@CSS@|file://$PWD/site.css|" dpa.html > "$tmp/dpa.html"
"${CHROMIUM:-chromium}" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$PWD/dpa.pdf" "file://$tmp/dpa.html" 2> /dev/null
echo "wrote website/dpa.pdf"
