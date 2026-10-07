#!/usr/bin/env python3
"""Bundle the iPhone browser UI with the repository's existing JSMpeg decoder."""
from pathlib import Path
import shutil

ios = Path(__file__).resolve().parents[1]
output = ios / "GeneratedWeb"
output.mkdir(exist_ok=True)
for source in (ios / "Web").iterdir():
    if source.is_file():
        shutil.copyfile(source, output / source.name)
decoder = ios.parent / "app/client/public/jsmpeg.min.js"
if not decoder.is_file():
    raise SystemExit("Missing repository JSMpeg decoder. Check out the entire project.")
shutil.copyfile(decoder, output / "jsmpeg.min.js")
print("Prepared MK8 browser assets in ios/GeneratedWeb")
