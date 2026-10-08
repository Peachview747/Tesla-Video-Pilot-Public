#!/usr/bin/env python3
"""Prepare a re-signable, arm64-only iPhone IPA from an Xcode archive.

Apple ad-hoc signing validates and normalizes Mach-O signatures; it does not
replace the personal Apple signing performed by Sideloadly/AltStore.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import sys
from typing import NamedTuple
import zipfile

ARM64 = 0x0100000C
LC_CODE_SIGNATURE = 0x1D
LC_ENCRYPTION_INFO_64 = 0x2C
LC_LOAD_WEAK_DYLIB = 0x80000018
LC_RPATH = 0x8000001C
STRONG_DYLIB_COMMANDS = {0xC, 0x8000001F, 0x20, 0x80000023}
# This deployment supports the system Swift runtime. Do not treat arbitrary
# libswift* names as system libraries: package libraries still need embedding.
SYSTEM_SWIFT_LIBRARIES = {"libswiftCore.dylib"}
IPA_PREFIX = "Tesla-Video-Pilot"


def distribution_ipa_name(version: str, build: str) -> str:
    """Return the stable, user-facing IPA filename for a release."""
    return f"{IPA_PREFIX}-Ver-{version}-Build-{build}.ipa"


def default_output_path() -> Path:
    """Derive the output name from the committed distribution metadata."""
    configuration_path = Path(__file__).resolve().parents[1] / "DISTRIBUTION.json"
    try:
        configuration = json.loads(configuration_path.read_text())
        version = str(configuration["version"])
        build = str(configuration["build"])
        return Path("build") / distribution_ipa_name(version, build)
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        # Keep local packaging usable while a new checkout is being prepared.
        return Path("build") / f"{IPA_PREFIX}.ipa"


class MachOImports(NamedTuple):
    dependencies: tuple[str, ...]
    runpaths: tuple[str, ...]


def check_macho(data: bytes, label: str) -> MachOImports:
    if len(data) < 32 or data[:4] != b"\xcf\xfa\xed\xfe":
        raise ValueError(f"{label}: expected a thin 64-bit Mach-O, not a universal/archive binary")
    _, cpu, subtype, filetype, ncmds, command_size, _, _ = struct.unpack_from("<8I", data)
    if cpu != ARM64 or (subtype & 0x00FFFFFF) != 0:
        raise ValueError(f"{label}: expected ordinary arm64; arm64e is not supported by this distribution")
    if filetype not in (2, 6):
        raise ValueError(f"{label}: expected an executable or dynamic library")
    end = 32 + command_size
    if end > len(data):
        raise ValueError(f"{label}: truncated Mach-O commands")
    position = 32
    signature = False
    dependencies = []
    runpaths = []
    for _ in range(ncmds):
        if position + 8 > end:
            raise ValueError(f"{label}: truncated Mach-O command")
        command, size = struct.unpack_from("<II", data, position)
        if size < 8 or position + size > end:
            raise ValueError(f"{label}: invalid Mach-O command size")
        if command in STRONG_DYLIB_COMMANDS or command in (LC_LOAD_WEAK_DYLIB, LC_RPATH):
            kind = "runpath" if command == LC_RPATH else "dynamic-library"
            header_size = 12 if command == LC_RPATH else 24
            if size < header_size:
                raise ValueError(f"{label}: invalid {kind} command")
            name_offset = struct.unpack_from("<I", data, position + 8)[0]
            if name_offset < header_size or name_offset >= size:
                raise ValueError(f"{label}: invalid {kind} name offset")
            encoded_name = data[position + name_offset:position + size]
            if b"\0" not in encoded_name:
                raise ValueError(f"{label}: unterminated {kind} name")
            try:
                name = encoded_name.split(b"\0", 1)[0].decode("utf-8")
            except UnicodeDecodeError as error:
                raise ValueError(f"{label}: invalid {kind} name") from error
            if command == LC_RPATH:
                runpaths.append(name)
            elif command in STRONG_DYLIB_COMMANDS:
                dependencies.append(name)
        if command == LC_CODE_SIGNATURE:
            if size != 16:
                raise ValueError(f"{label}: invalid signature command")
            offset, length = struct.unpack_from("<II", data, position + 8)
            if length == 0 or offset < end or offset + length > len(data):
                raise ValueError(f"{label}: invalid signature extent")
            signature = True
        if command == LC_ENCRYPTION_INFO_64:
            if size < 24:
                raise ValueError(f"{label}: invalid encryption command")
            if struct.unpack_from("<I", data, position + 16)[0] != 0:
                raise ValueError(f"{label}: encrypted binaries cannot be re-signed")
        position += size
    if position != end:
        raise ValueError(f"{label}: inconsistent Mach-O command count")
    if not signature:
        raise ValueError(f"{label}: missing code-signature load command")
    return MachOImports(tuple(dependencies), tuple(runpaths))


def check_bundled_dependencies(binaries: dict[str, MachOImports],
                               app_root: str, minimum_ios: tuple[int, ...]) -> None:
    """Require every strong @rpath library to be a validated embedded binary.

    The app's runtime search path is @executable_path/Frameworks. Checking
    every embedded framework also catches dependencies missing further down
    the chain. Absolute platform libraries and optional weak imports do not
    need to be present in the IPA. On iOS 17+, libswiftCore can resolve from
    the system when the importing binary explicitly declares /usr/lib/swift.
    """
    for binary, imports in binaries.items():
        for dependency in imports.dependencies:
            if dependency.startswith("@rpath/"):
                relative = dependency.removeprefix("@rpath/")
                embedded = app_root + "Frameworks/" + relative
                if (minimum_ios >= (17,) and relative in SYSTEM_SWIFT_LIBRARIES
                        and "/usr/lib/swift" in imports.runpaths):
                    continue
                if embedded not in binaries:
                    raise ValueError(f"{binary}: missing bundled dependency {dependency}")


def check_ipa(path: Path) -> None:
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        apps = [name for name in names if name.startswith("Payload/") and name.endswith(".app/Info.plist")
                and name.count("/") == 2]
        if len(apps) != 1:
            raise ValueError("Expected one iPhone app under Payload/. An outer download ZIP containing an IPA is not itself an IPA.")
        info_path = apps[0]
        app_root = info_path.removesuffix("Info.plist")
        info = plistlib.loads(archive.read(info_path))
        if info.get("CFBundlePackageType") != "APPL" or "iPhoneOS" not in info.get("CFBundleSupportedPlatforms", []):
            raise ValueError("The Payload app is not an iPhone application")
        executable = app_root + info["CFBundleExecutable"]
        binaries = {executable: check_macho(archive.read(executable), "iPhone executable")}
        frameworks = [name for name in names if name.startswith(app_root + "Frameworks/")
                      and name.endswith(".framework/Info.plist")]
        for name in frameworks:
            metadata = plistlib.loads(archive.read(name))
            binary = name.removesuffix("Info.plist") + metadata["CFBundleExecutable"]
            binaries[binary] = check_macho(archive.read(binary), binary)
        minimum_ios = tuple(int(part) for part in info.get("MinimumOSVersion", "0").split("."))
        check_bundled_dependencies(binaries, app_root, minimum_ios)
        for resource in ["GeneratedWeb/index.html", "GeneratedWeb/jsmpeg.min.js", "GeneratedWeb/app.js"]:
            if app_root + resource not in names:
                raise ValueError(f"Missing browser resource: {resource}")
        if "Payload/" not in names or app_root not in names:
            raise ValueError("Missing explicit Payload/app directory entries")
        if archive.testzip() is not None:
            raise ValueError("IPA ZIP integrity check failed")
        print(f"Verified {info.get('CFBundleShortVersionString')}: iPhone executable and {len(frameworks)} arm64 frameworks have valid signature extents.")


def run(*arguments: str) -> str:
    return subprocess.check_output(arguments, text=True, stderr=subprocess.STDOUT).strip()


def normalize_binary(binary: Path) -> None:
    arches = run("xcrun", "lipo", "-archs", str(binary)).split()
    if "arm64" not in arches:
        raise ValueError(f"{binary}: no arm64 device slice; found {arches}")
    if arches != ["arm64"]:
        mode = binary.stat().st_mode
        temporary = binary.with_name(binary.name + ".arm64")
        run("xcrun", "lipo", str(binary), "-thin", "arm64", "-output", str(temporary))
        temporary.chmod(mode)
        temporary.replace(binary)
        print(f"Selected arm64 slice: {binary.name} (was {', '.join(arches)})")


def sign(path: Path) -> None:
    run("codesign", "--force", "--sign", "-", "--timestamp=none", str(path))


def package(archive: Path, output: Path) -> None:
    if sys.platform != "darwin":
        raise RuntimeError("Packaging requires macOS lipo/codesign. --check runs on any platform.")
    applications = archive / "Products/Applications"
    apps = list(applications.glob("*.app"))
    if len(apps) != 1:
        raise ValueError("Xcode archive must contain exactly one application")
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = output.parent / "Payload"
    if payload.exists():
        shutil.rmtree(payload)
    payload.mkdir()
    app = payload / apps[0].name
    shutil.copytree(apps[0], app)
    metadata = plistlib.loads((app / "Info.plist").read_bytes())
    normalize_binary(app / metadata["CFBundleExecutable"])
    frameworks = sorted((app / "Frameworks").glob("*.framework"))
    for framework in frameworks:
        info = plistlib.loads((framework / "Info.plist").read_bytes())
        normalize_binary(framework / info["CFBundleExecutable"])
        sign(framework)
        run("codesign", "--verify", "--strict", str(framework))
    sign(app)
    run("codesign", "--verify", "--deep", "--strict", str(app))
    # Exercise replacing an existing signature, the operation a sideload tool performs.
    for framework in frameworks:
        sign(framework)
    sign(app)
    run("codesign", "--verify", "--deep", "--strict", str(app))
    print("Apple signing, replacement signing, and strict verification passed.")
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as ipa:
        ipa.write(payload, "Payload/")
        for item in sorted(payload.rglob("*")):
            ipa.write(item, item.relative_to(output.parent))
    check_ipa(output)
    print(f"Created {output}; personal Apple signing is still required before installation.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", type=Path, help="Validate a packaged IPA without Apple tooling")
    parser.add_argument("--archive", type=Path, default=Path("build/MK8iPhone.xcarchive"))
    parser.add_argument("--output", type=Path, default=default_output_path())
    args = parser.parse_args()
    if args.check:
        check_ipa(args.check)
    else:
        package(args.archive, args.output)
