#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Export the original artwork to the platform's required icon dimensions.
# JPEG produces an opaque asset without changing the original PNG artwork.
if ! sips -s format jpeg -s formatOptions 100 --resampleHeightWidth 1024 1024 \
  Artwork/MK8Icon.png --out Assets.xcassets/AppIcon.appiconset/AppIcon.jpg >/dev/null 2>&1; then
  # The checked-in JPEG fallback keeps builds working when sips cannot decode
  # a newly generated PNG on a particular macOS runner.
  cp Artwork/MK8Icon.jpg Assets.xcassets/AppIcon.appiconset/AppIcon.jpg
fi
cp Assets.xcassets/AppIcon.appiconset/AppIcon.jpg Assets.xcassets/BrandMark.imageset/BrandMark.jpg

