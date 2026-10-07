# Development notes

This repository is a public, sanitized build snapshot. Keep production
configuration, personal videos, database contents, `.env` files, Apple signing
material, Cloudflare tokens, and bot tokens outside Git.

The private development repository is the source of truth. Promote changes to
this repository only after running `python3 scripts/check_public_tree.py` and
reviewing the diff. A public build is reproducible from the source here, but
it must use the builder's own runtime configuration and Apple signing.
