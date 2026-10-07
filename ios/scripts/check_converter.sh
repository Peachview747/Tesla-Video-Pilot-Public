#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
from pathlib import Path
import plistlib, shutil
root = Path('build/DerivedData/SourcePackages/artifacts')
target = Path('build/ConverterFrameworks')
target.mkdir(parents=True, exist_ok=True)
found = set()
for bundle in root.rglob('*.xcframework'):
    metadata = plistlib.loads((bundle / 'Info.plist').read_bytes())
    for library in metadata['AvailableLibraries']:
        if library['SupportedPlatform'] == 'macos' and not library.get('SupportedPlatformVariant'):
            source = bundle / library['LibraryIdentifier'] / library['LibraryPath']
            shutil.copytree(source, target / source.name, dirs_exist_ok=True)
            found.add(source.stem)
            break
if len(found) != 8 or 'ffmpegkit' not in found:
    raise RuntimeError('All eight macOS FFmpeg binary frameworks are required for the native smoke check')
PY
mkdir -p build/ConverterCore
xcrun swiftc -O -emit-module -emit-library -module-name MK8Core Core/*.swift \
  -emit-module-path build/ConverterCore/MK8Core.swiftmodule -o build/ConverterCore/libMK8Core.dylib
xcrun swiftc -O -parse-as-library -I build/ConverterCore -L build/ConverterCore -lMK8Core \
  -Xlinker -rpath -Xlinker "$PWD/build/ConverterCore" -F build/ConverterFrameworks -framework ffmpegkit \
  -Xlinker -rpath -Xlinker "$PWD/build/ConverterFrameworks" \
  App/MediaConverter.swift scripts/ConverterSmoke.swift -o build/converter-smoke
DYLD_FRAMEWORK_PATH="$PWD/build/ConverterFrameworks" build/converter-smoke
