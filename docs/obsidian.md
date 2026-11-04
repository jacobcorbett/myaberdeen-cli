# Exports and Obsidian

[← Back to the README](../README.md)

## Exports and Obsidian

Obsidian is optional. There is no default vault path, and ordinary archive, download and export commands do not require a vault. To enable integration, provide your own vault containing a `Uni` directory, either during guided `myab setup`, through `vaultRoot` in your local config, or through `MYAB_VAULT`. For example:

```sh
myab setup --course YOUR_COURSE_ID --vault "/path/to/your/vault"
```

The `--course` selection replaces your current profile; include every course you want in `--active`, or use guided setup. `merge-vault` refuses to run without an explicit, available vault. `repair` skips vault indexing when no vault is configured. Users upgrading from older versions who relied on the implicit vault path must configure it explicitly.

```sh
myab export --active
myab merge-vault --active --dry-run
myab merge-vault --active --keep-duplicates
myab merge-vault --active
```

Selections apply to generated notes, export datasets and duplicate removals. Merge previews list the intended course directories, generated files and hash-identical duplicate removals. Same-course curated copies are preferred. Course directories include academic-year identity; explicit mappings can be supplied using `courseDirectories`, keyed by Blackboard course ID and relative to the vault's `Uni` directory. Conflicting existing course ownership is rejected.

Generated files live in each course's `MyAberdeen` directory. Imported HTML is decoded once and emitted as escaped text, including Markdown image syntax, so message/announcement text cannot become active markup in vault section notes. Recording transcript exports retain their existing formatting. Keep personal notes in separate files; generated section files are owned by the exporter. Arbitrary personal Markdown elsewhere is preserved. Byte-identical raw duplicates may be removed during merge; `--keep-duplicates` retains them. An unselected course's raw files are not removed.

Exports keep ordinary dataset shapes and add `_archive` visibility/change metadata. `freshness.json` contains per-record observation dates and section outcomes separately, so polling timestamps do not rewrite unchanged content bodies. Scoped exports update only selected course directories and preserve other entries in the main index.
