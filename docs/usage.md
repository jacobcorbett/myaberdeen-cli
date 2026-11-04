# Using your archive

[← Back to the README](../README.md)

## Select current courses explicitly

Run `myab setup` after login. It lists your memberships with their terms, lets you select courses by number, and saves exact course IDs to the local `profiles.current` allowlist used by `--active`. Existing custom settings and other profiles are preserved; the current selection is replaced. Blank course input cancels without saving. Trailing commas in course-number input are accepted, typos are retried, and an invalid optional vault path can be corrected without repeating course selection. Quoted pasted paths and POSIX escaped spaces are accepted. No courses are selected automatically, including old memberships.

For an AI assistant or another non-interactive caller, first use `myab courses --json`, then pass exact IDs/codes explicitly:

```sh
myab setup --course YOUR_COURSE_ID --course ANOTHER_COURSE_ID
```

`myab paths` shows the local configuration file (normally `~/.local/share/myaberdeen-cli/config.json`). Manual configuration remains supported with `config.example.json`; replace its placeholder courses. Configuration is private and should not be committed. You can persist a download location with `"downloadDir": "~/Documents/MyAberdeen"` and a nonstandard Chrome executable with `"chromePath": "/path/to/chrome"` in that file. Relative JSON paths resolve beside the configuration file rather than the current shell directory. Environment overrides take precedence and retain normal shell-relative path behaviour. Chrome discovery also checks per-user macOS/Windows installations, Windows Program Files (x86), and `/opt/google/chrome/chrome`. Both `~/` and `~\` home prefixes are accepted. `doctor` and `paths` show resolved locations; malformed configuration reports its path, and `help`/`version` remain usable.

The example deliberately omits `academicStartYear`: vault folders default to academic years such as `2026-27`. If you want “Year 1”, “Year 2”, etc., set your own start year with `myab setup --course YOUR_COURSE_ID --academic-start-year YYYY`. Existing start-year settings are preserved unless explicitly changed. Existing generated course directories are reused by their Blackboard course ID, including older `Unsorted` or mislabelled year folders, so the parser correction does not create duplicate notes. If multiple generated directories declare the same course, pin the intended folder with `courseDirectories` before merging.

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
- `brief.stale` describes the six metadata sections (content, announcements, grades, schedule, messages and discussions). A recently checked but unavailable section is listed in `inaccessibleSections` rather than retried indefinitely. `staleSections` identifies old/missing/partial metadata; `sectionFreshness` separately reports optional file/Panopto checks. `recentChanges` contains the newest twenty changes for that course in chronological order.
- `changes --since` accepts an integer cursor or ISO timestamp. Each caller keeps its own cursor; reading does not consume changes for another caller.
- `show` reads one archived content body with provenance.
- `--course` is repeatable. Exact IDs/codes take precedence over fragments; a fragment may select multiple courses. `--term` selects by term label. `--all` is an explicit broad selection.
- Network refreshes, exports, merges, extraction and relocation require a selector. An omitted selector never silently starts a whole-account archive.

## Incremental behaviour and integrity

Each refresh enumerates folders, including empty ones; parent timestamps are not assumed to reflect descendant changes. It compares meaningful metadata and fetches individual details when changed, incomplete or due for a deeper check (24 hours by default, configurable with `deepCheckHours`). `--deep` forces detail reconciliation.

A failed detail request preserves the previous complete body. Recoverable folder failures do not prevent sibling traversal. Authentication expiry stops the run with exit 2; access denial remains distinct from an empty course. Rows absent from a **complete successful** section check become historical. Partial/unavailable checks never infer removal. Historical files and data are retained.

Downloads save opaque ETag/Last-Modified validators alongside a verified file. Subsequent conditional requests can return 304 without transferring a file body. Conditions survive approved Blackboard file redirects; authentication headers and browser cookies do not. Missing or changed local files trigger a full fetch. Legacy files have no trustworthy validator pair, so their first refresh may need one bounded baseline download. A current HEAD response alone does not prove that an older local file matches it.

SHA-256 remains the local integrity check. Changed versions get a hash suffix; earlier versions are kept and catalogued. Unchanged content is not rewritten. Files, JSON and generated Markdown are written atomically. API/file errors and browser navigation diagnostics redact authentication URLs and headers. Ordinary Blackboard video files are skipped. Panopto has a separate, opt-in read-only integration; other external LTI services remain links.

```sh
myab refresh --course CS4028_27 --limit-files 1
myab refresh --resume <run-id> --limit-files 5
myab verify-files --active
myab doctor
```

A file limit caps attempts, including failures. Repeated limited refreshes rotate courses by their last file-attempt run and check unattempted/oldest-attempted files first, so failed or unchanged files do not monopolise the budget. `--resume` still follows its original bounded selection. Deferred files make the run `limited`; resume advances past successful file checks and completed courses in that run. It retains the original file-attempt limit and deep-check setting unless overridden; a resume preview shows only the remaining selection. Normal cancellation records its status and releases Chrome and the archive lock. A later writer marks abandoned `running` entries interrupted. A process lock prevents simultaneous archive writers; Chrome's own profile locks are never deleted.

Transient network/429/5xx errors receive at most two retries, with bounded backoff/Retry-After. 401/403/404 are not retried. API shape changes, repeated pages and pagination caps become explicit failures instead of silent success.

## Cached text

```sh
myab extract --active
myab refresh --active --extract
```

Text extraction is cached by file SHA-256 and extractor version. Supported inputs include PDF (requires Poppler's `pdftotext`), DOCX/PPTX (read by a built-in ZIP reader; no external tool needed; slides are kept in numeric order), notebooks and common text formats. Cached text is reused without rerunning the extractor. Image-only/scanned files need separate inspection; extraction does not claim to preserve diagrams or full visual layout. `brief` distinguishes section checks, file checks and the last text extraction time.

Refreshes are on demand unless a background schedule is separately configured. The command is deterministic and can be called by a local scheduler; overlapping invocations stop at the process lock. The tool does not install a schedule or keep an SSO session alive automatically.

## Migration and moved archives

The first writable open of a legacy database makes a private SQLite backup before upgrading. `repair` upgrades, corrects availability from saved source payloads, and reindexes vault file hashes/course associations without generating notes or deleting duplicates.

```sh
myab repair
myab relocate-files --all --from /old/archive --to /mounted/archive
myab relocate-files --all --from /old/archive --to /mounted/archive --apply
```

Relocation covers Blackboard files, retained file versions and downloaded Panopto videos. Each plan item identifies its kind; all catalogue updates use one transaction and are rolled back if a destination or catalogue row changes. Relocation first produces a plan. `--apply` rechecks destination hashes and changes catalogue paths in a transaction. It never moves or deletes source files. Unavailable mounts and mismatched destinations are reported; a missing local path is not proof of data loss. Existing file versions retain their history.

## Paths and exits

Defaults: state `~/.local/share/myaberdeen-cli`, profile `chrome-profile` inside state, database `myaberdeen.sqlite` inside state, downloads `~/Documents/MyAberdeen`. Text caches also live under state. `myab paths` shows the resolved configuration.

Override using `MYAB_STATE_DIR`, `MYAB_PROFILE_DIR`, `MYAB_DATABASE`, `MYAB_DOWNLOAD_DIR`, `MYAB_CHROME`, `MYAB_VAULT`, or `MYAB_CONFIG`. Runtime profiles, databases, backups, downloaded materials and extracted text must stay out of source control.

Exit codes: `0` success; `1` fatal/usage error; `2` authentication required; `3` partial, deliberately limited, or missing/mismatched files; `130`/`143` cancelled by SIGINT/SIGTERM. Structured output uses stdout; progress and safe errors use stderr.

Development checks:

```sh
npm run check
```

Tests use synthetic data, temporary directories and mocked endpoints. CI needs no university credentials. Blackboard's internal endpoints can change; a successful local test suite does not replace a small live smoke check. Grades/schedules do not guarantee a complete assessment calendar.
