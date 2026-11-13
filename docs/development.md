# Development and releases

[← Back to the README](../README.md)

## Checks, lint and coverage

```sh
npm ci
npm run check     # runtime check, syntax check, ESLint, then the test suite
npm run lint      # ESLint only (flat config in eslint.config.js)
npm test          # test suite only
npm run coverage  # tests with Node's built-in line/branch/function coverage for src/
```

Each script first checks the Node version against the supported runtime policy and stops with a clear message if dependencies are missing; run `npm ci` in that case. ESLint and its configuration packages are development dependencies only and are never included in portable downloads. Coverage is reported for information; it has no failing threshold.

Dependabot checks npm dependencies and pinned GitHub Actions weekly, grouping minor and patch updates.

## Build portable downloads yourself

From a source checkout with the supported Node version installed:

```sh
npm ci
npm run check
npm run build:release
npm run smoke:release
```

The build targets the current OS/CPU and downloads the matching official Node distribution for the exact version pinned in `.node-version` (26.13.1), independently of the build host version, verifying its published SHA-256. Internet access, npm and `tar` (macOS/Linux) or PowerShell (Windows) are required. Outputs go to ignored `dist/`. An explicit source allowlist excludes local profiles, archives and configuration, and copies only the Markdown guides from `docs/` (README and demo images, video and the demo fixture remain in the repository); the project MIT licence, security policy, contribution guide, and dependency/Node licence files are included. The smoke check extracts the archive into a temporary path containing spaces and exercises the actual launcher, bundled dependencies and SQLite with synthetic data, without university credentials.

## Checked auto-merge

The owner can select **Enable auto-merge (squash)** on an ordinary PR or run `gh pr merge NUMBER --auto --squash`. The `Merge checked PRs` workflow honours that explicit request after all required checks succeed on the current head. It also runs when auto-merge is enabled after checks have already finished; the owner can dispatch it to retry an existing request.

The owner-only branch rules intentionally remain enabled. GitHub's native merge service cannot update those protected refs by itself, so this workflow uses the existing `RELEASE_PLEASE_TOKEN` owner credential for the final owner override. It checks the live owner request, open/non-draft state, `main` target, conflict-free head, review requirements and latest reviewer decisions, and all four required Linux/macOS/Windows/security checks (including any additional required checks). It matches the checked head SHA at merge. Ordinary PRs are merged only for owner-enabled squash requests; generated owner release PRs retain their separate automatic policy below. PR code and artifacts are never checked out, downloaded or executed by this privileged workflow.

Keep the owner token limited to this repository and renewed before expiry. A missing token, changed head, unresolved change request, pending/failed/skipped check or unknown mergeability prevents merging. Generated release PRs retain their separate documented automatic release policy below. Bootstrap or recovery merges by the owner may use `gh pr merge NUMBER --squash --admin --match-head-commit SHA` only after verifying the same live check/review gates; do not use the owner override to skip them.

## Making releases

Release Please prepares releases after owner-authored pushes/merges to `main`. It maintains a release PR containing the version changes in `package.json`, `package-lock.json` and `.release-please-manifest.json`, plus generated release notes in `CHANGELOG.md`. Owner-authored release PRs are squash-merged automatically after all required Linux, macOS, Windows and security checks pass. Each merged feature/fix can therefore trigger a release. Do not manually bump versions for each feature PR.

Use Conventional Commit titles for squash merges: `fix:` proposes a patch and `feat:` proposes a minor version. Before 1.0, `feat!:` or a `BREAKING CHANGE:` footer proposes a minor bump; after 1.0 it proposes a major bump. `docs:`, `chore:` and `ci:` alone do not normally trigger a release. Review the intended release impact before merging feature/fix PRs. Use squash merge with the conventional PR title, or preserve conventional commit messages when using a merge commit.

Merging the release PR authorises publication. Release Please creates a version tag and a **draft** GitHub release. The tag starts the existing Release workflow, which runs checks, the security audit, builds and extracted-bundle smoke tests on Apple Silicon macOS, Linux x64 and Windows x64. Only after every platform succeeds are all downloads uploaded and the draft published. No npm package is published. Intel Macs are not supported. Existing assets are never overwritten.

The bootstrap records `v0.3.4` as the starting release, so older history is not repackaged. The `Release preparation` workflow can also be run manually on `main` to retry preparation or refresh its release PR.

### One-time credential setup

Owner-only branch/tag rules remain in place. Create a **fine-grained personal access token owned by the repository owner**, limited to this repository, with repository permissions **Contents: Read and write**, **Pull requests: Read and write**, and **Issues: Read and write** (for release labels). Save it as the Actions repository secret `RELEASE_PLEASE_TOKEN`. Renew the secret before the chosen expiry. Never store it in Git or a local configuration file.

This owner credential allows the release branch/tag operations under the existing rules and lets PR/tag events trigger normal CI. The built-in `GITHUB_TOKEN` cannot bypass these rules and does not trigger downstream PR/tag workflows; there is deliberately no fallback. The release preparation workflow and release build/publish workflow only run when both the original actor and rerun actor are the repository owner. A missing or expired token makes preparation fail visibly; it does not weaken the repository rules.

The `Merge checked PRs` workflow uses the same owner credential after a successful `Check` run. Its automatic release path only merges the same-repository, owner-authored, non-draft release branch targeting `main` with the `autorelease: pending` label; ordinary PRs require the explicit owner auto-merge request described above. It verifies every required check and matches the checked commit before merging; it never checks out or executes PR code. Keep the four existing CI jobs required on `main`. GitHub's native auto-merge alone cannot bypass the owner-only branch-update rule. The owner can manually dispatch this workflow to retry an existing checked release PR.

### Failed builds and manual recovery

If a release build fails, its draft stays unpublished. Rerun failed jobs after correcting the underlying problem, or run **Release** manually against the existing version tag with **publish enabled**. Release Please may already have marked that version tagged, so rerunning preparation is not a substitute for retrying its Release workflow. For a partial upload failure, inspect the draft assets before retrying: existing assets are not overwritten; remove only incomplete draft assets deliberately before uploading again. Do not move an existing tag or replace published downloads.

For an intentional manual release, update the package/lock/manifest versions together, run **Release** manually against the branch with **publish disabled** for all-platform validation, then push a matching stable `vX.Y.Z` tag. Source installation remains available. `BUILD.json` records the exact runtime and commit used. Live university authentication is excluded from CI.

## Security checks

The CI security check runs `npm run audit:security`: it checks production dependencies with npm audit and compares the supported Node floor and bundled runtime against official Node security releases and end-of-life dates. It requires network access and fails if official data is unavailable. A future security release requires a deliberate policy and pin update; these checks cannot guarantee the absence of undisclosed vulnerabilities.
