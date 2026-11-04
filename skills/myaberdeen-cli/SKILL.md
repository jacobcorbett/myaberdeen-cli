---
name: myaberdeen-cli
description: Install, update and use the MyAberdeen CLI to read University of Aberdeen Blackboard courses, inspect a local archive, and refresh selected course materials. Use for MyAberdeen setup, course lookups, downloads and archive maintenance.
---

# MyAberdeen CLI

Use `myab` for read-only Blackboard access and a local SQLite/file archive. University sign-in and MFA belong to the user. The CLI cannot submit work, send messages or change enrolment. Local refreshes and exports do write archive data.

## Portable releases

For users who want a download without installing Node/npm, use the matching asset from https://github.com/jacobcorbett/myaberdeen-cli/releases/latest: `macos-arm64` (Apple Silicon), `linux-x64` or `windows-x64`. Intel Macs are not supported. Verify the adjacent SHA-256, extract the entire folder, and run `./myab` (macOS/Linux) or `.\myab.cmd` (Windows). Keep `lib/` beside the launcher; add the bundle directory to PATH rather than linking only the launcher. Chrome is still required; optional extractors are separate.

The bundle contains `BUILD.json`, `lib/app/README.md`, `lib/app/config.example.json` and this skill under `lib/app/skills/myaberdeen-cli/`. Follow sign-in, configuration and scoped-operation guidance below. Node/npm/Git are only needed for the source route. Bundles are unsigned/not notarised; Windows state relies on inherited user-directory ACLs.

For a portable update, download and verify the new matching archive, extract it separately, check the new launcher with `help` and `doctor`, and update PATH. Preserve external private state. Refresh copied skills or repoint links into the new bundle. Do not apply the Git update procedure to an extracted bundle. Report its `BUILD.json` version and revision.

## Locate or install from source

Canonical source: https://github.com/jacobcorbett/myaberdeen-cli.

Find the existing checkout and `myab` executable before cloning another copy. Read that checkout's `README.md`, `package.json` and `myab help`; these are authoritative for the installed revision. Run `myab paths` to resolve local configuration rather than assuming the author's filesystem layout.

For a new install, use Git, npm, Node 26.13.0 or newer within Node 26 (Node 22, 24 and other majors are unsupported; `.node-version` pins 26.13.0), and an installed Google Chrome:

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

`myab login` opens the dedicated Chrome profile. Before a new user signs in, explain the authentication/local-data section of the README: session-only cookies (including identity-provider cookies) are made persistent for up to seven days on disk, provider expiry still applies, OS keychain integration is reduced, and the profile must not be shared or synced. Deleting the dedicated profile stops local reuse but does not revoke copied sessions. Let the user complete SSO/MFA; choosing “Stay signed in” allows remembered SSO. Normal live reads then run headlessly. Do not install an extra Playwright browser: this project uses `playwright-core` and installed Chrome. `MYAB_CHROME` can override its executable.

After login, use `myab setup` in a terminal to choose current courses. For an agent without an interactive terminal, read `myab courses --json` and run `myab setup --course EXACT_ID_OR_CODE` with one repeated flag per chosen course. Never infer a selection from example codes. Setup replaces only `profiles.current`, preserves unrelated settings and other profiles, validates exact unambiguous memberships, and does not download content.

Use `myab paths` to locate the local configuration. Manual JSON configuration remains supported; preserve existing settings. No academic start year is assumed: vault folders default to academic-year labels. Only set `academicStartYear` (or `setup --academic-start-year YYYY`) when the user wants relative “Year N” folders and their actual start year is known.

Obsidian is optional and has no default vault path. Normal archive commands work without it. Only configure `vaultRoot`/`MYAB_VAULT` when integration is requested; the selected vault must contain `Uni`. Guided setup offers an optional path, or pass `--vault PATH` alongside the complete `--course` selection. Existing users who relied on the old implicit vault path must configure it explicitly. `merge-vault` fails without a configured vault; `repair` skips vault indexing if none is configured. `myab doctor` reports configuration, current-course selection, vault availability and optional extraction tools with suggested fixes.

## Answer course questions

1. Start with `myab brief --active --json` (or an explicit `--course CODE`). Check `staleSections`, `sectionFreshness`, `inaccessibleSections`, visibility and recorded failures. Overall `stale` covers metadata; optional file/video freshness is separate. A recent access denial is checked-but-inaccessible, not a reason to repeat refreshes indefinitely.
2. Read returned local sources or `myab show --course CODE --id CONTENT_ID`. Cite course/content identity and observation dates. Cached grades and schedules may not be complete assessment calendars.
3. For a requested live check, stale material or an empty archive, refresh only the relevant selection. Metadata: `myab check --course CODE`. Files too: `myab refresh --course CODE`. Preview selection with `--dry-run` when a fragment could match several courses.
4. For document text use `myab extract --course CODE` or refresh with `--extract`. PDF extraction needs Poppler's `pdftotext`; DOCX/PPTX extraction is built in. Scans and diagrams still require visual inspection.

`--course` is repeatable; exact IDs/codes take precedence over fragments. `--active` uses the configured current profile. Do not substitute `--all` when a profile is missing or a selector fails. Whole-account downloads require the user's intended scope to include them. `courses` queries live memberships; `brief`, `show`, `changes` and `status` use local data.

For incremental monitoring, use `myab changes --active --since CURSOR --json`. Each caller stores its own returned `nextCursor`; reading changes does not consume another caller's results. Refresh on demand; the CLI does not install a background schedule.

## Failures and local maintenance

- Exit 2 means authentication is needed: run `myab login`, allow user MFA, then retry the bounded request. Exit 3 means partial/limited results or file integrity problems, not complete success. Exit 1 is fatal/usage failure; 130/143 means cancellation.
- A 403/unavailable section is not an empty course. Partial refreshes preserve older data. State which sections are stale or inaccessible rather than claiming there is nothing there.
- Run one live/profile operation at a time. If Chrome reports a profile lock, identify the dedicated CLI browser and close it cleanly when safe. Never delete Chrome locks or terminate unrelated browser sessions.
- File limits cap attempts, including failed ones. Repeated limited refreshes rotate courses and prioritise unattempted/oldest-attempted files; resume preserves its original scope. `myab refresh --course CODE --limit-files 1` is a bounded file smoke check. Resume with `myab refresh --resume RUN_ID`; it keeps the original selection and limit unless overridden. Verify files with `myab verify-files --course CODE`.
- If an older archive needs migration, read the current README and use `myab repair`; the first writable legacy open makes a private database backup.
- Preview `merge-vault --course CODE --dry-run` before applying it. Merge writes generated notes and may remove hash-identical raw duplicates; `--keep-duplicates` retains them. Do not infer permission to merge from a course lookup.
- `relocate-files --course CODE --from OLD --to NEW` previews catalogue changes. `--apply` verifies destination hashes and updates paths; it covers Blackboard files, retained file versions and video assets, and does not move or delete source files.
- Keep profiles, cookies, authentication state, databases/backups, grades, messages, downloaded files and extracted text out of commits, shared logs and source-only handoffs. Other external LTI/video links remain links; Panopto has the explicit read-only commands below.

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

## Panopto (v0.3.0)

Use `panopto-login` for the normal browser sign-in/MFA flow. Use `panopto-sync --course CODE` (or `--active`) after refreshing Blackboard metadata, or add `--panopto` to `check`, `sync` or `refresh`. Panopto sync uses the existing Chrome profile and website read requests, not OAuth credentials. Keep course scope explicit. `--limit-recordings N` bounds recording attempts, including failures.

Read offline with `recordings --course CODE [--search TEXT]`, `recording --course CODE --id UUID`, and `transcript --course CODE --id UUID [--language ID] [--format text|json|srt|vtt]`. Exports contain timed transcripts, AI chapters/summary/key points and recording metadata. Treat generated captions and summaries as fallible source material.

Report discovery coverage accurately. `course-links-and-search` is not a complete folder inventory; a viewer may be denied folder enumeration while individual links work. Do not infer no recordings from hidden folders. `--folder UUID` maps one selected course for that invocation; persistent `panoptoFolders` mappings are local arrays keyed by course ID/code. Folder enumeration stays within explicit mappings and exposed subfolders. Failed/limited refreshes retain old data. Failed folder reads fall back to course search with partial status. Explicit `--folder` scans cannot retire recordings found outside the selected folder.

Media is opt-in: `panopto-download --course CODE --id UUID --dry-run`, then the same command without `--dry-run` when a download is requested. Only use exposed permitted podcast downloads. The server may still deny one; never fall back to player stream extraction. The maximum is 2 GiB by default (`--max-bytes`). Keep media local and verify via `verify-files`. Do not download all course videos just because metadata/transcript support was requested. Audio-only downloads and remote writes are not implemented.

## Local configuration and diagnostics

Persist `downloadDir` and `chromePath` in local JSON when settings must survive new shells or schedulers; corresponding environment variables override them. Relative JSON paths are anchored to the configuration directory. Existing generated course directories are reused by their recorded Blackboard ID, so old year labels are retained; use explicit courseDirectories to resolve duplicate ownership. Home expansion accepts `~/` and `~\`. `help` and `version` work with broken configuration; `doctor`/`paths` return `configPath` and `configError` with exit 1 so the user can repair the file. Setup retries invalid interactive input without discarding course choices. For lock errors, inspect `doctor.operationLock` (path, owner PID/aliveness, recovery state); never remove active operation locks or Chrome profile locks.
