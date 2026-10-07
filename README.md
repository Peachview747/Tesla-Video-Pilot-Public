# Video Pilot public builds

This repository is a sanitized, buildable source snapshot for Video Pilot. It
is intended for people who want to inspect the project or build their own
iPhone package. The private development repository remains the source of truth
for private deployment files and credentials.

## What is public

- iPhone host, Tesla web UI, Cloudflare relay source, tests, and build scripts
- a macOS GitHub Actions workflow that builds an unsigned arm64 IPA
- instructions for local Mac builds and personal sideload signing

There are no committed IPAs, `.env` files, signing certificates, bot tokens,
Cloudflare secrets, or production database credentials. Do not add any of
those files. The public workflow creates a short-lived build artifact; it does
not publish a release.

## Build an IPA with GitHub Actions

1. Open **Actions → Build unsigned iPhone IPA**.
2. Choose **Run workflow** on `main`.
3. When the run finishes, open the run summary and download the
   `VideoPilot-unsigned-ipa` artifact.
4. Extract the artifact and use Sideloadly, SideStore, AltStore, or Xcode with
   your own Apple signing. An unsigned IPA cannot be installed directly from
   Safari.

The workflow runs source-safety checks, web tests, native Swift tests, FFmpeg
checks, and the macOS Xcode build before uploading the artifact. Artifacts from
a public repository may be visible to other repository readers, so never put a
secret in an IPA or build log.

## Build locally on a Mac

Install Xcode 26 or later, XcodeGen, Python 3, and Node.js. Then run:

```bash
brew install xcodegen
python3 scripts/check_public_tree.py
bash ios/scripts/build_unsigned.sh
python3 ios/scripts/package_ipa.py --check ios/build/MK8iPhone-unsigned.ipa
```

The resulting `ios/build/MK8iPhone-unsigned.ipa` is ignored by Git. Select it
in your sideloading tool and sign it with your own Apple ID. Personal signing
and iOS device trust are Apple-account responsibilities; this repository does
not contain signing credentials.

## Use the app

The iPhone app is the host. It serves the Tesla browser locally and can connect
to a separately deployed Cloudflare Worker through the native relay. Enter your
own `TV_SECRET` in the app's Keychain settings; never add it to source, an IPA,
an issue, or an Actions log. A YouTube Data API key, when used, should also be
entered at runtime rather than committed.

The public URL in the sample configuration is only an endpoint reference, not
an authentication secret. Deploy your own Worker and use your own secret when
sharing this code with other users. See [the iPhone guide](ios/README.md) and
[the Cloudflare guide](cloudflare/README-iPhone.md) for the full setup.

## Project map

| Directory | Purpose |
| --- | --- |
| `ios/` | SwiftUI host, native relay, media preparation, tests, and IPA packaging |
| `cloudflare/` | Worker and phone-relay deployment files |
| `app/` | Laptop/web stack and frontend source |
| `.github/workflows/` | Public, manual macOS build workflow |
| `scripts/check_public_tree.py` | Fails if common secret files or credential patterns are added |

The app currently targets iOS 17+, uses MPEG-1/MP2 MPEG-TS playback for the
Tesla browser, and requires personal signing before installation. Review the
dependency licenses and add an appropriate project license before distributing
modified source or binaries.

## Updating this public snapshot

Keep the private repository authoritative. Promote changes here only after a
secret scan and a review of generated files. Start from a fresh sanitized
snapshot when necessary; do not copy private Git history or the old source
archives into this repository.
