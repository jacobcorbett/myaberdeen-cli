# MyAberdeen CLI

A private, read-only terminal client for the University of Aberdeen's Blackboard Learn site. It reuses a dedicated Chrome profile after interactive sign-in, archives course data in SQLite, and keeps ordinary Blackboard files locally. Normal lookups can use the archive without opening Chrome.

## Install and sign in

Use Node **22.13+ on the 22 branch, or Node 24+**, and an installed Google Chrome. Node 23 is not supported. Runtime code uses `node:sqlite`; no extra browser is downloaded.

```sh
npm ci
npm link
myab login
myab doctor --live
```

Complete Aberdeen's normal password/MFA flow yourself. If Microsoft offers **Stay signed in?**, choose **Yes**. The CLI can reuse remembered SSO when the Blackboard session expires; it cannot override university expiry or MFA requirements. Authentication state stays inside the private Chrome profile.

Interactive login launches the configured Chrome executable. Defaults cover macOS, standard Google Chrome installations on Linux, and Windows; override `MYAB_CHROME` for another installation. Live SSO has been verified on macOS. CI checks the deterministic code on macOS and Linux; other live platform/login combinations still need local verification.

## Select current courses explicitly

Copy `config.example.json` to `~/.local/share/myaberdeen-cli/config.json` and replace the example course codes. The configuration is local and should not be committed. `profiles.current` is an allowlist used by `--active`. Academic start year, merged-course aliases and explicit course-to-vault directories are configurable.

```sh
myab courses
myab check --course CS4028_27 --dry-run
myab check --active
myab refresh --active
myab brief --active --json
myab changes --active --since 0 --json
myab show --course CS4028_27 --id <content-id>
```

- `check` and plain `sync` refresh metadata without downloading lecture files.
- `refresh`, `download`, and `sync --download-files` also verify/download current file candidates.
- `brief` and `status` read the local archive, including section freshness, visibility, file paths, extraction paths and recent changes. They do not launch Chrome or fetch anything.
- `changes --since` accepts an integer cursor or ISO timestamp. Each caller keeps its own cursor; reading does not consume changes for another caller.
- `show` reads one archived content body with provenance.
- `--course` is repeatable. Exact IDs/codes take precedence over fragments; a fragment may select multiple courses. `--term` selects by term label. `--all` is an explicit broad selection.
- Network refreshes, exports, merges, extraction and relocation require a selector. An omitted selector never silently starts a whole-account archive.

## Incremental behaviour and integrity

Each refresh enumerates folders, including empty ones; parent timestamps are not assumed to reflect descendant changes. It compares meaningful metadata and fetches individual details when changed, incomplete or due for a deeper check (24 hours by default, configurable with `deepCheckHours`). `--deep` forces detail reconciliation.

A failed detail request preserves the previous complete body. Recoverable folder failures do not prevent sibling traversal. Authentication expiry stops the run with exit 2; access denial remains distinct from an empty course. Rows absent from a **complete successful** section check become historical. Partial/unavailable checks never infer removal. Historical files and data are retained.

Downloads save opaque ETag/Last-Modified validators alongside a verified file. Subsequent conditional requests can return 304 without transferring a file body. Conditions survive approved Blackboard file redirects; authentication headers and browser cookies do not. Missing or changed local files trigger a full fetch. Legacy files have no trustworthy validator pair, so their first refresh may need one bounded baseline download. A current HEAD response alone does not prove that an older local file matches it.

SHA-256 remains the local integrity check. Changed versions get a hash suffix; earlier versions are kept and catalogued. Unchanged content is not rewritten. Files, JSON and generated Markdown are written atomically. API/file errors and browser navigation diagnostics redact authentication URLs and headers. External LTI/video services remain links; video files are skipped.

```sh
myab refresh --course CS4028_27 --limit-files 1
myab refresh --resume <run-id> --limit-files 5
myab verify-files --active
myab doctor
```

A file limit caps attempts, including failures. Deferred files make the run `limited`; resume advances past successful file checks and completed courses in that run. It retains the original file-attempt limit and deep-check setting unless overridden; a resume preview shows only the remaining selection. Normal cancellation records its status and releases Chrome and the archive lock. A later writer marks abandoned `running` entries interrupted. A process lock prevents simultaneous archive writers; Chrome's own profile locks are never deleted.

Transient network/429/5xx errors receive at most two retries, with bounded backoff/Retry-After. 401/403/404 are not retried. API shape changes, repeated pages and pagination caps become explicit failures instead of silent success.

## Cached text

```sh
myab extract --active
myab refresh --active --extract
```

Text extraction is cached by file SHA-256 and extractor version. Supported inputs include PDF (requires Poppler's `pdftotext`), DOCX/PPTX (requires `unzip`), notebooks and common text formats. Cached text is reused without rerunning the extractor. Image-only/scanned files need separate inspection; extraction does not claim to preserve diagrams or full visual layout. `brief` distinguishes section checks, file checks and the last text extraction time.

Refreshes are on demand unless a background schedule is separately configured. The command is deterministic and can be called by a local scheduler; overlapping invocations stop at the process lock. The tool does not install a schedule or keep an SSO session alive automatically.

## Exports and Obsidian

```sh
myab export --active
myab merge-vault --active --dry-run
myab merge-vault --active --keep-duplicates
myab merge-vault --active
```

Selections apply to generated notes, export datasets and duplicate removals. Merge previews list the intended course directories, generated files and hash-identical duplicate removals. Same-course curated copies are preferred. Course directories include academic-year identity; explicit mappings can be supplied using `courseDirectories`, keyed by Blackboard course ID and relative to the vault's `Uni` directory. Conflicting existing course ownership is rejected.

Generated files live in each course's `MyAberdeen` directory. Keep personal notes in separate files; generated section files are owned by the exporter. Arbitrary personal Markdown elsewhere is preserved. Byte-identical raw duplicates may be removed during merge; `--keep-duplicates` retains them. An unselected course's raw files are not removed.

Exports keep ordinary dataset shapes and add `_archive` visibility/change metadata. `freshness.json` contains per-record observation dates and section outcomes separately, so polling timestamps do not rewrite unchanged content bodies. Scoped exports update only selected course directories and preserve other entries in the main index.

## Migration and moved archives

The first writable open of a legacy database makes a private SQLite backup before upgrading. `repair` upgrades, corrects availability from saved source payloads, and reindexes vault file hashes/course associations without generating notes or deleting duplicates.

```sh
myab repair
myab relocate-files --all --from /old/archive --to /mounted/archive
myab relocate-files --all --from /old/archive --to /mounted/archive --apply
```

Relocation first produces a plan. `--apply` rechecks destination hashes and changes catalogue paths in a transaction. It never moves or deletes source files. Unavailable mounts and mismatched destinations are reported; a missing local path is not proof of data loss. Existing file versions retain their history.

## Paths and exits

Defaults: state `~/.local/share/myaberdeen-cli`, profile `chrome-profile` inside state, database `myaberdeen.sqlite` inside state, downloads `~/Documents/MyAberdeen`. Text caches also live under state. `myab paths` shows the resolved configuration.

Override using `MYAB_STATE_DIR`, `MYAB_PROFILE_DIR`, `MYAB_DATABASE`, `MYAB_DOWNLOAD_DIR`, `MYAB_CHROME`, `MYAB_VAULT`, or `MYAB_CONFIG`. Runtime profiles, databases, backups, downloaded materials and extracted text must stay out of source control.

Exit codes: `0` success; `1` fatal/usage error; `2` authentication required; `3` partial, deliberately limited, or missing/mismatched files; `130`/`143` cancelled by SIGINT/SIGTERM. Structured output uses stdout; progress and safe errors use stderr.

Development checks:

```sh
npm run check
```

Tests use synthetic data, temporary directories and mocked endpoints. CI needs no university credentials. Blackboard's internal endpoints can change; a successful local test suite does not replace a small live smoke check. Grades/schedules do not guarantee a complete assessment calendar.
