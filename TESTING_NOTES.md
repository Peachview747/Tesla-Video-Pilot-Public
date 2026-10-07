# Video Pilot testing branch

This branch is for experiments and notes only. Put benchmark results, UI prototypes, transport experiments, and reproduction steps here before promoting a change to `iphone-native` or `laptop`.

## Suggested experiment format

- Date, device model, iOS version, network type, and app build.
- Exact YouTube URL or imported file characteristics.
- Download and preparation timings, plus shared download details.
- Expected behavior, observed behavior, and a small proposed change.
- Whether the experiment is safe to promote to a release branch.

Never store `TV_SECRET`, Cloudflare API tokens, Apple signing material, personal `.env` files, or private media in this branch.
