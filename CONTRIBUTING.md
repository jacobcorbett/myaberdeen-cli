# Contributing

Please open an issue before starting a change. Describe the problem or proposal so Jacob can agree the scope before you spend time implementing it. Bug reports should include the CLI version (`myab version`), operating system, a redacted command and error, and the expected behaviour.

## Fork and pull request workflow

For a public repository, you can fork and submit a PR without collaborator access. If the repository is still private, GitHub access is required until publication. Only Jacob (`jacobcorbett`) can change branches or tags in the upstream repository, including merging pull requests. Contributors should work in their own fork, not push branches here.

1. Open an issue and discuss the change with Jacob.
2. Use GitHub's **Fork** button to create your own fork.
3. Clone your fork and add the upstream repository. Replace `YOUR_USERNAME` below with your GitHub username:

   ```sh
   git clone https://github.com/YOUR_USERNAME/myaberdeen-cli.git
   cd myaberdeen-cli
   git remote add upstream https://github.com/jacobcorbett/myaberdeen-cli.git
   git fetch upstream
   git switch -c fix/describe-the-change upstream/main
   npm ci
   ```

4. Make a focused change and add meaningful regression tests where appropriate. Keep the README and `skills/myaberdeen-cli/SKILL.md` aligned with any command or setup changes. Record user-facing changes under Unreleased in `CHANGELOG.md`, using Added, Changed or Fixed entries that explain the effect on users and any limits or upgrade steps. Release dates belong to published releases.
5. Run the checks below and review your complete diff for accidental files and personal data.
6. Commit and push to **your fork**:

   ```sh
   git add path/to/changed-file
   git commit -m "fix: describe the change"
   git push -u origin fix/describe-the-change
   ```

7. Open a pull request from your fork's branch to `jacobcorbett/myaberdeen-cli:main`. Link the issue, explain the resulting behaviour, list the checks you ran and call out any limitations. Jacob reviews and merges accepted changes; approval alone does not grant you merge access.

Use Conventional Commit PR titles and preserve that title when squash merging; release automation derives version bumps from the merged commit. Do not bump package versions in feature PRs: the owner reviews and merges the generated release PR when ready to ship. See [release operations](docs/development.md#making-releases).

Use concise commit prefixes such as `feat:`, `fix:`, `docs:`, `chore:` or `refactor:`. Keep unrelated changes in separate PRs. Do not change the version, create upstream release tags or publish release assets as part of a contribution unless Jacob asks.

## Local checks

Development requires Git, npm and Node 26.13.0 or newer within Node 26; use the exact 26.13.0 pin in `.node-version` for reproducible development. Node 22, 24 and other major versions are unsupported. Google Chrome is needed for live sign-in, but the automated tests use synthetic data and mocked services and need no university account.

```sh
npm ci
npm run check
npm run audit:security
git diff --check
```

`npm run check` runs the syntax check, ESLint and the test suite. Use `npm run lint` to run ESLint alone and `npm run coverage` to see test coverage for `src/`.

For packaging or launcher changes, also build and test an extracted portable package:

```sh
npm run build:release
npm run smoke:release
```

These packaging checks run on your current OS/CPU and download the official Node runtime. A passing local check does not prove that live university login, other operating systems or recording discovery work. State exactly what you tested.

## Privacy and scope

- Keep credentials, cookies, browser profiles, authentication headers, account identifiers, personal configuration, SQLite databases/backups and downloaded course materials out of commits, issues, PRs and shared logs. Use synthetic fixtures instead of real grades, messages or transcripts.
- Inspect diagnostics before sharing them: paths, course membership and error details can reveal personal information. Never paste raw browser/network captures or your local archive.
- Blackboard access stays read-only: no submission, messaging, enrolment or assessment-attempt operations. Respect authentication, course permissions and download controls; do not add bypasses or broad account crawls.
- Obsidian integration is optional. Do not add a contributor's personal paths, course selection or academic start year as defaults.
- If you discover an exposed credential or security problem, follow the private reporting instructions in [SECURITY.md](SECURITY.md). Do not put the secret or a working exploit in an issue; revoke any exposed credential promptly.

Read [AGENTS.md](AGENTS.md) for the repository's development guidance and the [README](README.md) for setup and supported behaviour. AI-assisted contributions are welcome under the same review, privacy and testing requirements; you remain responsible for understanding the change.

## Licence

By submitting a contribution, you agree to license it under the project's [MIT licence](LICENSE). Keep existing copyright/licence notices and include the necessary notices for third-party code. Jacob Corbett's copyright and the MIT permission notice must remain in redistributed copies or substantial portions.
