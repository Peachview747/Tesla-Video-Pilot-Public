from pathlib import Path
import plistlib
import struct
import tempfile
import unittest
import zipfile

from package_ipa import ARM64, LC_LOAD_WEAK_DYLIB, LC_RPATH, check_ipa, check_macho


def binary(subtype=0, signed=True, encrypted=False, dependencies=(), filetype=6, runpaths=()):
    commands = b""
    for command, name in dependencies:
        encoded = name.encode() + b"\0"
        size = (24 + len(encoded) + 7) & ~7
        commands += struct.pack("<6I", command, size, 24, 0, 0, 0)
        commands += encoded.ljust(size - 24, b"\0")
    for name in runpaths:
        encoded = name.encode() + b"\0"
        size = (12 + len(encoded) + 7) & ~7
        commands += struct.pack("<3I", LC_RPATH, size, 12)
        commands += encoded.ljust(size - 12, b"\0")
    if encrypted:
        commands += struct.pack("<6I", 0x2C, 24, 0, 0, 1, 0)
    if signed:
        commands += struct.pack("<4I", 0x1D, 16, 32 + len(commands) + 16, 4)
    header = struct.pack("<8I", 0xFEEDFACF, ARM64, subtype, filetype,
                         len(dependencies) + len(runpaths) + int(signed) + int(encrypted), len(commands), 0, 0)
    return header + commands + (b"SIGN" if signed else b"")


def ipa(path, app_dependencies=(), frameworks=None, app_runpaths=(),
        framework_runpaths=None, minimum_ios="17.0"):
    root = "Payload/MK8iPhone.app/"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("Payload/", b"")
        archive.writestr(root, b"")
        archive.writestr(root + "Info.plist", plistlib.dumps({
            "CFBundleExecutable": "MK8iPhone", "CFBundlePackageType": "APPL",
            "CFBundleSupportedPlatforms": ["iPhoneOS"],
            "MinimumOSVersion": minimum_ios,
        }))
        archive.writestr(root + "MK8iPhone", binary(dependencies=app_dependencies,
                                                   filetype=2, runpaths=app_runpaths))
        for name, dependencies in (frameworks or {}).items():
            framework = root + f"Frameworks/{name}.framework/"
            archive.writestr(framework + "Info.plist", plistlib.dumps({"CFBundleExecutable": name}))
            archive.writestr(framework + name, binary(dependencies=dependencies,
                                                      runpaths=(framework_runpaths or {}).get(name, ())))
        for resource in ["index.html", "jsmpeg.min.js", "app.js"]:
            archive.writestr(root + "GeneratedWeb/" + resource, b"")


class SigningPackageTests(unittest.TestCase):
    def test_accepts_signed_arm64_template(self):
        check_macho(binary(), "fixture")

    def test_rejects_fat_binary_and_arm64e(self):
        for data in [b"\xca\xfe\xba\xbe" + b"\0" * 40, binary(subtype=0x80000002)]:
            with self.assertRaises(ValueError):
                check_macho(data, "fixture")

    def test_rejects_missing_or_truncated_signature(self):
        for data in [binary(signed=False), binary()[:-1]]:
            with self.assertRaises(ValueError):
                check_macho(data, "fixture")

    def test_rejects_encrypted_app(self):
        with self.assertRaisesRegex(ValueError, "encrypted"):
            check_macho(binary(encrypted=True), "fixture")

    def test_rejects_malformed_load_commands(self):
        data = bytearray(binary())
        struct.pack_into("<I", data, 36, 0)
        with self.assertRaisesRegex(ValueError, "command size"):
            check_macho(bytes(data), "fixture")

    def test_rejects_malformed_dependency_name(self):
        data = bytearray(binary(dependencies=[(0xC, "@rpath/example.framework/example")]))
        struct.pack_into("<I", data, 40, 8)
        with self.assertRaisesRegex(ValueError, "name offset"):
            check_macho(bytes(data), "fixture")

    def test_rejects_malformed_runpath_name(self):
        data = bytearray(binary(runpaths=["/usr/lib/swift"]))
        struct.pack_into("<I", data, 40, 8)
        with self.assertRaisesRegex(ValueError, "runpath name offset"):
            check_macho(bytes(data), "fixture")


class DependencyPackageTests(unittest.TestCase):
    def check_package(self, app_dependencies=(), frameworks=None, **options):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.ipa"
            ipa(path, app_dependencies, frameworks, **options)
            check_ipa(path)

    def test_accepts_embedded_chain_and_platform_dependencies(self):
        self.check_package(
            [(0xC, "@rpath/FFmpeg-Kit.framework/FFmpeg-Kit"),
             (0xC, "/System/Library/Frameworks/Foundation.framework/Foundation")],
            {"FFmpeg-Kit": [(0xC, "@rpath/ffmpegkit.framework/ffmpegkit")],
             "ffmpegkit": [(0xC, "/usr/lib/libSystem.B.dylib")]})

    def test_rejects_missing_app_dependency(self):
        for command in [0xC, 0x8000001F, 0x20, 0x80000023]:
            with self.subTest(command=command):
                with self.assertRaisesRegex(ValueError, "MK8iPhone: missing bundled dependency @rpath/FFmpeg-Kit"):
                    self.check_package([(command, "@rpath/FFmpeg-Kit.framework/FFmpeg-Kit")],
                                       {"ffmpegkit": []})

    def test_rejects_missing_transitive_dependency(self):
        with self.assertRaisesRegex(ValueError, "ffmpegkit: missing bundled dependency @rpath/libavfilter"):
            self.check_package([(0xC, "@rpath/ffmpegkit.framework/ffmpegkit")],
                               {"ffmpegkit": [(0xC, "@rpath/libavfilter.framework/libavfilter")]})

    def test_accepts_absent_weak_dependency(self):
        self.check_package([(LC_LOAD_WEAK_DYLIB, "@rpath/Optional.framework/Optional")])

    def test_accepts_system_swift_with_declared_runpath(self):
        self.check_package([(0xC, "@rpath/FFmpeg-Kit.framework/FFmpeg-Kit")],
                           {"FFmpeg-Kit": [(0xC, "@rpath/libswiftCore.dylib")]},
                           framework_runpaths={"FFmpeg-Kit": ["/usr/lib/swift"]})

    def test_rejects_swift_without_system_runpath(self):
        with self.assertRaisesRegex(ValueError, "missing bundled dependency @rpath/libswiftCore"):
            self.check_package([(0xC, "@rpath/libswiftCore.dylib")],
                               app_runpaths=["@executable_path/Frameworks"])

    def test_system_runpath_does_not_allow_other_missing_libraries(self):
        for name in ["libOther.dylib", "libswiftUnknown.dylib", "Missing.framework/Missing"]:
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, "missing bundled dependency"):
                    self.check_package([(0xC, "@rpath/" + name)], app_runpaths=["/usr/lib/swift"])

    def test_system_swift_exception_requires_supported_deployment(self):
        with self.assertRaisesRegex(ValueError, "missing bundled dependency @rpath/libswiftCore"):
            self.check_package([(0xC, "@rpath/libswiftCore.dylib")],
                               app_runpaths=["/usr/lib/swift"], minimum_ios="12.0")


if __name__ == "__main__":
    unittest.main()
