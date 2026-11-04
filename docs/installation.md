# Installation and updates

[← Back to the README](../README.md)

## Download a portable release

Download the archive for your computer from [GitHub Releases](https://github.com/jacobcorbett/myaberdeen-cli/releases/latest).

| Computer | Asset suffix | Command after extracting |
| --- | --- | --- |
| Mac with Apple Silicon | `macos-arm64.tar.gz` | `./myab help` |
| Linux x64 | `linux-x64.tar.gz` | `./myab help` |
| Windows x64 | `windows-x64.zip` | `.\myab.cmd help` |

These are portable folders containing a launcher, the official Node runtime, and locked production dependencies. **No separate Node or npm installation is needed.** Extract the whole archive and keep `lib/` beside the launcher. Run it from a terminal; this is a CLI, not a desktop app. Add the extracted folder to `PATH` to use `myab` elsewhere. Do not move or symlink just the launcher.

Google Chrome is still required. Start with `myab login`, complete sign-in/MFA yourself, then run `myab doctor --live`. Run `myab setup` to select your courses; the example configuration and AI skill are under `lib/app/`. Optional text extractors still need to be installed separately.

Each archive has a `.sha256` checksum. On macOS use `shasum -a 256 -c ARCHIVE.sha256`; on Linux use `sha256sum -c ARCHIVE.sha256`. On Windows compare `Get-FileHash ARCHIVE.zip -Algorithm SHA256` with the supplied checksum. `BUILD.json` records the version, source commit, runtime and architecture.

Bundles are currently unsigned and not notarised, so OS security prompts may appear. Native release checks cover the platforms above; they do not verify every OS version or university login. Windows uses inherited filesystem ACLs: keep private state in your own user directory.

To update a portable installation, download and verify the new matching archive, extract it into a new folder, run its `help` and `doctor`, then point `PATH` at that folder. Keep state/configuration outside the bundle; your existing archive and login profile are reused. Refresh any copied AI skill from the new `lib/app/skills/myaberdeen-cli/` directory. A link into an older bundle must also be repointed. Do not run Git/npm update commands inside a release bundle.

## Install from source and sign in

Use Node **26.13.0 or newer within Node 26**, and an installed Google Chrome. Node 22, 24 and other major versions are unsupported. The exact development and portable-release pin is **26.13.0**, recorded in `.node-version`. Runtime code uses `node:sqlite`; no extra browser is downloaded.

```sh
git clone https://github.com/jacobcorbett/myaberdeen-cli.git
cd myaberdeen-cli
npm ci
npm link
myab login
myab doctor --live
myab setup
```

Complete Aberdeen's normal password/MFA flow yourself. If Microsoft offers **Stay signed in?**, choose **Yes**. The CLI can reuse remembered SSO when the Blackboard session expires; it cannot override university expiry or MFA requirements. Authentication state stays inside the private Chrome profile.

Read [Authentication and local data](authentication.md) before signing in, including how session cookies are persisted and how to stop local reuse.

## AI agent skill and updates

The portable [MyAberdeen CLI skill](../skills/myaberdeen-cli/SKILL.md) covers installation, authentication, archive-first queries, scoped refreshes, troubleshooting and updates from GitHub. Give an AI assistant the repository URL and ask it to read that file. It contains no account data and works without this author's personal vault or agent setup.

For an agent that supports installed skills, copy or link the whole `skills/myaberdeen-cli` directory into its configured skills directory. A link follows checkout updates; a copied skill must be refreshed after updating. Agents working in this repository are routed to it by `AGENTS.md`.

Example request:

> Read `skills/myaberdeen-cli/SKILL.md`, install this CLI, help me sign in, and configure only the courses I select. When I ask for an update, check GitHub, preserve my local state and changes, update the CLI and skill, and verify the installed revision.

There is no published npm package or built-in self-updater. The following updates a **source checkout**; portable downloads use the replacement procedure above. For source updates, first inspect `git status`, verify `origin`, run `git fetch origin`, and review incoming changes. On a clean `main` checkout that can fast-forward, run these commands in order, stopping if any fails:

```sh
git merge --ff-only origin/main
npm ci
npm run check
npm link
myab help
myab doctor
git rev-parse HEAD
```

Preserve local edits and pinned/forked installations instead of resetting them. Re-read the updated README and skill for changed requirements. State, authentication and downloads remain outside the checkout. `myab doctor` checks local health; `myab doctor --live` separately checks authentication. Neither a software update nor skill installation automatically downloads courses or creates a schedule.
