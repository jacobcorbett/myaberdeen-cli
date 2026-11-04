# Development and releases

[← Back to the README](../README.md)

## Build portable downloads yourself

From a source checkout with the supported Node version installed:

```sh
npm ci
npm run check
npm run build:release
npm run smoke:release
```

The build targets the current OS/CPU and downloads the matching official Node distribution for the exact version pinned in `.node-version` (26.13.0), independently of the build host version, verifying its published SHA-256. Internet access, npm and `tar` (macOS/Linux) or PowerShell (Windows) are required. Outputs go to ignored `dist/`. An explicit source allowlist excludes local profiles, archives and configuration; the project MIT licence, security policy, contribution guide, and dependency/Node licence files are included. The smoke check extracts the archive into a temporary path containing spaces and exercises the actual launcher, bundled dependencies and SQLite with synthetic data, without university credentials.

## Making releases

1. Update `package.json` and `package-lock.json` to the same version and commit the changes.
2. Run the **Release** workflow manually against the branch with **publish disabled** to check every platform before tagging.
3. Push a matching stable tag, for example `git tag v0.2.0` then `git push origin v0.2.0`.

The Release workflow runs tests, builds and smoke-checks each archive on its native platform, and publishes the release with all downloads/checksums only when every build succeeds. Manual publishing requires an existing `vX.Y.Z` tag matching the package version. GitHub's source archives and the normal source-install route remain available.

Release jobs use the exact Node 26.13.0 pin in `.node-version`. Platform checks run on macOS ARM64, macOS Intel, Linux x64 and Windows x64. Live authentication is deliberately excluded from CI. Only the repository owner can run the release jobs. Existing release assets are never overwritten by the workflow; `BUILD.json` records the exact runtime and commit used.

## Security checks

The CI security check runs `npm run audit:security`: it checks production dependencies with npm audit and compares the supported Node floor and bundled runtime against official Node security releases and end-of-life dates. It requires network access and fails if official data is unavailable. A future security release requires a deliberate policy and pin update; these checks cannot guarantee the absence of undisclosed vulnerabilities.
