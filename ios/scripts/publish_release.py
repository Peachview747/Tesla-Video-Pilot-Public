#!/usr/bin/env python3
"""Publish a verified iPhone build from the iphone-native branch to GitHub.

Source/version changes are committed first. The successful workflow attaches
the compiled IPA to a matching prerelease. A corrected rebuild replaces the
same-version IPA/setup assets so the release link always matches the branch.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile
import zipfile

from package_ipa import check_ipa, distribution_ipa_name


def command(*arguments: str) -> str:
    return subprocess.check_output(arguments, text=True, stderr=subprocess.STDOUT).strip()


def release(repository: str, tag: str) -> dict | None:
    result = subprocess.run(["gh", "api", f"repos/{repository}/releases/tags/{tag}"],
                            text=True, capture_output=True)
    if result.returncode == 0:
        return json.loads(result.stdout)
    if "HTTP 404" in result.stderr:
        return None
    raise RuntimeError(result.stderr.strip() or "Could not read GitHub releases")


def package_setup(repository_root: Path, version: str, destination: Path, build: str | None = None) -> None:
    # Explicit allowlist: never package the user's .env, tokens, node_modules,
    # Wrangler login state, or generated deployment data.
    files = ["worker.js", "phone-relay.js", "wrangler.json", "package.json", "package-lock.json",
             "setup-iphone.mjs", "Setup-iPhone-Tunnel.cmd", "README-iPhone.md"]
    folder = f"Tesla-Video-Pilot-Ver-{version}"
    if build:
        folder += f"-Build-{build}"
    folder += "-Cloudflare-Setup"
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in files:
            archive.write(repository_root / "cloudflare" / name, f"{folder}/{name}")


def main() -> None:
    if os.environ.get("GITHUB_REF") != "refs/heads/iphone-native" or os.environ.get("GITHUB_EVENT_NAME") == "pull_request":
        raise RuntimeError("Release publishing is restricted to the iphone-native branch")
    repository = os.environ["GITHUB_REPOSITORY"]
    commit = os.environ["GITHUB_SHA"]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) or not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Invalid repository or commit")
    ios = Path(__file__).resolve().parents[1]
    configuration = json.loads((ios / "DISTRIBUTION.json").read_text())
    version = configuration["version"]
    build = str(configuration["build"])
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Distribution version must use major.minor.patch")
    if not re.fullmatch(r"[0-9]+", build):
        raise ValueError("Distribution build must be numeric")
    ipa = ios / "build" / distribution_ipa_name(version, build)
    check_ipa(ipa)
    with zipfile.ZipFile(ipa) as archive:
        info = plistlib.loads(archive.read("Payload/MK8iPhone.app/Info.plist"))
        if info["CFBundleShortVersionString"] != version:
            raise ValueError("IPA version does not match the committed distribution version")
        if str(info["CFBundleVersion"]) != build:
            raise ValueError("IPA build does not match the committed distribution build")
    tag = f"ios-v{version}"
    name = distribution_ipa_name(version, build)
    existing = release(repository, tag)
    with ipa.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    with tempfile.TemporaryDirectory(prefix="mk8-release-") as temporary:
        directory = Path(temporary)
        asset = directory / name
        shutil.copyfile(ipa, asset)
        setup = directory / f"Tesla-Video-Pilot-Ver-{version}-Build-{build}-Cloudflare-Setup.zip"
        package_setup(ios.parent, version, setup, build)
        setup_digest = hashlib.sha256(setup.read_bytes()).hexdigest()
        if existing:
            # GitHub release assets are immutable by filename. Remove the
            # previous same-version files before uploading the corrected build.
            legacy_names = [asset["name"] for asset in existing["assets"]
                            if asset["name"].lower().endswith((".ipa", "-cloudflare-setup.zip"))]
            for old_name in set([name, setup.name, *legacy_names]):
                if any(asset["name"] == old_name for asset in existing["assets"]):
                    command("gh", "release", "delete-asset", tag, old_name, "--yes", "--repo", repository)
            command("gh", "release", "upload", tag, str(asset), str(setup), "--repo", repository)
        else:
            notes = directory / "notes.md"
            notes.write_text(
                f"# Tesla Video Pilot Ver {version} Build {build} — prototype\n\n"
                + (configuration.get("releaseNotes", "") + "\n\n" if configuration.get("releaseNotes") else "") +
                f"Download **{name}** under **Assets**. This is the compiled iPhone app. "
                "Install it with Sideloadly or AltStore using personal Apple signing. Minimum iOS: 17.0.\n\n"
                "Source/version changes are committed to `iphone-native`; the IPA is attached here after the build and checks pass. "
                "This version has ordinary arm64 FFmpeg libraries and Apple ad-hoc signature templates. "
                "The macOS build verifies signing, replacement signing, packaged signatures, and bundled framework dependencies. "
                "Successful personal signing, installation, and iPhone/Tesla playback still require device testing.\n\n"
                "The app includes an authenticated native iPhone WebSocket relay to the existing Cloudflare Worker, "
                "with reconnects, external header/cookie forwarding, binary video streaming, and bounded backpressure. "
                "**One-time Cloudflare deployment is required:** download the Cloudflare Setup ZIP below, extract it, "
                "run Setup-iPhone-Tunnel.cmd on your Windows PC, and select the original MK8 folder containing .env. "
                "The setup reuses/tests your existing TV_SECRET and preserves the laptop route. "
                "In the app, save that TV_SECRET under Settings > Cloudflare tunnel, start hosting, and wait for Connected. "
                "Approve Face ID once when starting hosting, then open https://tv.jcruzhoovertesla.workers.dev in the Tesla browser; no browser code is required, so keep the public address private. "
                "Keep the app open for continuous hosting; iOS allows only limited background tunnel/server time. "
                "The Worker has not been deployed by this build. Physical iPhone/Tesla playback and network handoff remain device checks.\n\n"
                f"Source commit: `{commit}`.\n\nSHA-256:\n```text\n{digest}\n```\n\n"
                "This repository is private. Open this release in your regular browser while signed into GitHub with repository access. "
                "The release page and asset link do not use the temporary ChatGPT download link.\n\n"
                f"Cloudflare setup SHA-256: `{setup_digest}`.\n"
            )
            command("gh", "release", "create", tag, str(asset), str(setup), "--repo", repository,
                    "--target", commit, "--prerelease", "--title", f"Tesla Video Pilot Ver {version} Build {build}",
                    "--notes-file", str(notes))
    published = release(repository, tag)
    if not published:
        raise RuntimeError("Release was not published")
    uploaded = next((asset for asset in published["assets"] if asset["name"] == name), None)
    if not uploaded or uploaded["size"] != ipa.stat().st_size:
        raise RuntimeError("Uploaded IPA is missing or has the wrong size")
    if uploaded.get("digest") and uploaded["digest"] != "sha256:" + digest:
        raise RuntimeError("Uploaded IPA checksum differs from the verified build")
    print(f"Published {published['html_url']}")
    print(f"IPA: {uploaded['browser_download_url']}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as stream:
            stream.write(f"## iPhone download\n\n[Open v{version} release]({published['html_url']})\n\n")
            stream.write(f"[Download {name}]({uploaded['browser_download_url']})\n")


if __name__ == "__main__":
    main()
