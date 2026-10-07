#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'An iPhone build requires macOS and Xcode. Use the GitHub Actions build on other systems.' >&2
  exit 1
fi
command -v xcodegen >/dev/null || { echo 'Install XcodeGen: brew install xcodegen' >&2; exit 1; }
python3 scripts/prepare_web.py
bash scripts/prepare_icon.sh
xcodegen generate
swift test
bash scripts/check_downloader.sh
xcodebuild -project MK8iPhone.xcodeproj -scheme MK8iPhone \
  -derivedDataPath build/DerivedData \
  -destination 'generic/platform=iOS' -archivePath build/MK8iPhone.xcarchive \
  CODE_SIGNING_ALLOWED=NO archive
bash scripts/check_converter.sh
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/package_ipa.py
