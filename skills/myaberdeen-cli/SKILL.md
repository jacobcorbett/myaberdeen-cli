---
name: myaberdeen-cli
description: Install, update and use the MyAberdeen CLI to read University of Aberdeen Blackboard courses, inspect a local archive, and refresh selected course materials. Use for MyAberdeen setup, course lookups, downloads and archive maintenance.
---

# MyAberdeen CLI

Use `myab` for read-only Blackboard access and a local SQLite/file archive. University sign-in and MFA belong to the user. The CLI cannot submit work, send messages or change enrolment. Local refreshes and exports do write archive data.

## Portable releases

For users who want a download without installing Node/npm, use the matching asset from https://github.com/jacobcorbett/myaberdeen-cli/releases/latest: `macos-arm64`, `macos-x64`, `linux-x64` or `windows-x64`. Verify the adjacent SHA-256, extract the entire folder, and run `./myab` (macOS/Linux) or `.\myab.cmd` (Windows). Keep `lib/` beside the launcher; add the bundle directory to PATH rather than linking only the launcher. Chrome is still required; optional extractors are separate.

The bundle contains `BUILD.json`, `lib/app/README.md`, `lib/app/config.example.json` and this skill under `lib/app/skills/myaberdeen-cli/`. Follow sign-in, configuration and scoped-operation guidance below. Node/npm/Git are only needed for the source route. Bundles are unsigned/not notarised; Windows state relies on inherited user-directory ACLs.

For a portable update, download and verify the new matching archive, extract it separately, check the new launcher with `help` and `doctor`, and update PATH. Preserve external private state. Refresh copied skills or repoint links into the new bundle. Do not apply the Git update procedure to an extracted bundle. Report its `BUILD.json` version and revision.

## Locate or install from source

Canonical source: https://github.com/jacobcorbett/myaberdeen-cli (access is required while the repository is private).

Find the existing checkout and `myab` executable before cloning another copy. Read that checkout's `README.md`, `package.json` and `myab help`; these are authoritative for the installed revision. Run `myab paths` to resolve local configuration rather than assuming the author's filesystem layout.

For a new install, use Git, npm, Node 22.13+ on the 22 branch or Node 24+ (not Node 23), and an installed Google Chrome:

```sh
git clone https://github.com/jacobcorbett/myaberdeen-cli.git
cd myaberdeen-cli
npm ci
npm run check
npm link
myab help
myab doctor
myab login
myab doctor --live
```

If GitHub requires authentication, use the user's existing GitHub access; never request credentials in chat. If npm's global prefix is not writable, use a user-owned prefix or run `node /absolute/path/to/myaberdeen-cli/src/cli.js` instead of using sudo. Keep the checkout because `npm link` points into it.

`myab login` opens the dedicated Chrome profile. Let the user complete SSO/MFA; choosing “Stay signed in” allows remembered SSO. Normal live reads then run headlessly. Do not install an extra Playwright browser: this project uses `playwright-core` and installed Chrome. `MYAB_CHROME` can override its executable.

Use `myab paths` to locate the configuration file. Copy the checkout's `config.example.json` there only if no configuration exists, then replace example values with the user's course selection and academic start year. Preserve existing settings. `profiles.current` must be a nonempty allowlist for `--active`. Use `myab courses --json` to discover exact current course IDs/codes; do not assume example codes or years are current.

## Answer course questions

1. Start with `myab brief --active --json` (or an explicit `--course CODE`). Check section freshness, visibility and recorded failures.
2. Read returned local sources or `myab show --course CODE --id CONTENT_ID`. Cite course/content identity and observation dates. Cached grades and schedules may not be complete assessment calendars.
3. For a requested live check, stale material or an empty archive, refresh only the relevant selection. Metadata: `myab check --course CODE`. Files too: `myab refresh --course CODE`. Preview selection with `--dry-run` when a fragment could match several courses.
4. For document text use `myab extract --course CODE` or refresh with `--extract`. PDF extraction needs Poppler's `pdftotext`; DOCX/PPTX needs `unzip`. Scans and diagrams still require visual inspection.

`--course` is repeatable; exact IDs/codes take precedence over fragments. `--active` uses the configured current profile. Do not substitute `--all` when a profile is missing or a selector fails. Whole-account downloads require the user's intended scope to include them. `courses` queries live memberships; `brief`, `show`, `changes` and `status` use local data.

For incremental monitoring, use `myab changes --active --since CURSOR --json`. Each caller stores its own returned `nextCursor`; reading changes does not consume another caller's results. Refresh on demand; the CLI does not install a background schedule.

## Failures and local maintenance

- Exit 2 means authentication is needed: run `myab login`, allow user MFA, then retry the bounded request. Exit 3 means partial/limited results or file integrity problems, not complete success. Exit 1 is fatal/usage failure; 130/143 means cancellation.
- A 403/unavailable section is not an empty course. Partial refreshes preserve older data. State which sections are stale or inaccessible rather than claiming there is nothing there.
- Run one live/profile operation at a time. If Chrome reports a profile lock, identify the dedicated CLI browser and close it cleanly when safe. Never delete Chrome locks or terminate unrelated browser sessions.
- File limits cap attempts, including failed ones. `myab refresh --course CODE --limit-files 1` is a bounded file smoke check. Resume with `myab refresh --resume RUN_ID`; it keeps the original selection and limit unless overridden. Verify files with `myab verify-files --course CODE`.
- If an older archive needs migration, read the current README and use `myab repair`; the first writable legacy open makes a private database backup.
- Preview `merge-vault --course CODE --dry-run` before applying it. Merge writes generated notes and may remove hash-identical raw duplicates; `--keep-duplicates` retains them. Do not infer permission to merge from a course lookup.
- `relocate-files --course CODE --from OLD --to NEW` previews catalogue changes. `--apply` verifies destination hashes and updates paths; it does not move or delete source files.
- Keep profiles, cookies, authentication state, databases/backups, grades, messages, downloaded files and extracted text out of commits, shared logs and source-only handoffs. External LTI/video links remain links.

## Update a source checkout from GitHub

When asked to update, or when checking whether an installed CLI is outdated, work in its existing checkout. Software updates and course refreshes are separate operations. There is no built-in `myab update` command or background self-updater.

```sh
git remote -v
git status --short --branch
git fetch origin
git log --oneline HEAD..origin/main
git diff --stat HEAD..origin/main
```

Verify that `origin` is the intended source above (SSH and HTTPS forms are both valid), and inspect incoming changes, particularly installation scripts and runtime requirements. The maintained branch is currently `main`; respect an intentionally pinned revision or fork. If the working tree is dirty, the checkout is detached, or history has diverged, preserve local work and report the situation rather than resetting, stashing or switching branches automatically.

For an authorised update of a clean checkout on `main` that can fast-forward:

```sh
git merge --ff-only origin/main
npm ci
npm run check
npm link
myab help
myab doctor
git rev-parse HEAD
```

If any step fails, stop and report it; do not continue to relink after failed checks. If using the direct Node entrypoint, omit `npm link` and verify that entrypoint instead. Keep private state/configuration outside the checkout and preserve it across updates. A local check does not establish live authentication: use `myab doctor --live` only when live verification is needed.

Re-read this skill and the README after updating. If the agent uses a copied skill, refresh that copy from `skills/myaberdeen-cli/` in the updated checkout, preserving any intentional local customisations. A link to this directory follows checkout updates automatically. Report the installed commit and verification outcome; package version alone may not distinguish revisions.
