#!/usr/bin/env python3
"""Reject common credential files and high-confidence token patterns.

This guard is intentionally conservative about runtime configuration: values
read from an environment variable, Keychain, or a documented example file are
allowed. It reports locations and never prints matching values.
"""
from __future__ import annotations

from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SKIP_PARTS = {".git", "node_modules", ".build", "ios/build", "attachments"}
SKIP_NAMES = {"jsmpeg.min.js"}
SENSITIVE_SUFFIXES = {".ipa", ".p12", ".mobileprovision", ".pem", ".key"}
HIGH_CONFIDENCE = (
    ("private-key", re.compile(r"-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----")),
    ("github-token", re.compile(r"(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})")),
    ("aws-access-key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("google-api-key", re.compile(r"AIza[0-9A-Za-z_-]{20,}")),
    ("slack-token", re.compile(r"xox[baprs]-[0-9A-Za-z-]{20,}")),
    ("stripe-secret", re.compile(r"sk_live_[0-9A-Za-z]{16,}")),
    ("bearer-token", re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]{20,}")),
)
ASSIGNMENT = re.compile(
    r"(?i)(TV_SECRET|CLOUDFLARE_API_TOKEN|YOUTUBE_API_KEY|GOOGLE_MAPS_API_KEY|"
    r"API_KEY|SECRET_KEY|CLIENT_SECRET|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)"
    r"\s*[:=]\s*(.+)"
)
RUNTIME_REFERENCES = (
    "process.env",
    "import.meta.env",
    "settings.",
    "userdefaults",
    "keychain",
    "getenv",
    "${",
    "environment",
    "url.",
)
PLACEHOLDER_WORDS = re.compile(
    r"(?i)(example|your|change[-_ ]?me|replace|placeholder|dummy|fake|localhost|"
    r"postgres|dbname|database|token=|private\+value)"
)


def skipped(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    return any(part in SKIP_PARTS for part in relative.parts) or path.name in SKIP_NAMES


def main() -> int:
    findings: list[tuple[str, int | None, str]] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or skipped(path):
            continue
        relative = path.relative_to(ROOT).as_posix()
        if path.name != ".env.example" and (path.name == ".env" or path.suffix in SENSITIVE_SUFFIXES):
            findings.append((relative, None, "sensitive filename"))
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for label, pattern in HIGH_CONFIDENCE:
            if pattern.search(text):
                findings.append((relative, None, label))
        if path.name == ".env.example":
            continue
        for number, line in enumerate(text.splitlines(), 1):
            match = ASSIGNMENT.search(line)
            if not match:
                continue
            rhs = match.group(2).strip()
            lowered = rhs.lower()
            if not rhs or any(reference in lowered for reference in RUNTIME_REFERENCES):
                continue
            value = rhs.strip("\"'`").split()[0].rstrip(",;)}]")
            if len(value) >= 12 and not PLACEHOLDER_WORDS.search(value):
                findings.append((relative, number, "literal credential assignment"))
    if findings:
        print("Public-source safety check failed:")
        for relative, line, label in sorted(set(findings)):
            suffix = f":{line}" if line is not None else ""
            print(f"- {relative}{suffix}: {label}")
        return 1
    print("Public-source safety check passed; no credential files or high-confidence token values found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
