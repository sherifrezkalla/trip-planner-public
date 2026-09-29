# Public-release checklist

A clean working tree does not establish that an existing repository is safe to make public. Inspect source, history, and GitHub surfaces separately.

## Source

- Explain purpose, supported features, limits, costs, and hosting requirements.
- Separate traveler instructions, hosting instructions, contributor guidance, and optional agent setup.
- Include the chosen license and preserve required third-party notices.
- Inspect text, filenames, fixtures, binary files, image metadata, and screenshots. Replace real-world fixtures with fictional examples preserving the same boundary conditions.
- Keep private operational notes, live instance details, exports, logs, and credentials outside source control.
- Check links, run tests/lint/build, and review the staged diff.

## Secrets and Git history

Use a current secret scanner with redacted output, for example:

```sh
gitleaks git . --log-opts="--all" --redact=100
```

Fetch relevant branches, tags, and historical PR refs first. Also scan a clean source export: uncommitted changes are not covered by a Git-history scan. Keep detailed findings outside the repository with restricted permissions.

Search for private invitation/resume URLs, trip IDs, rosters, personal contacts, local home paths, booking references, account identifiers, and known production values. Inspect commit messages and author/committer names and emails. Use local OCR and manual review for images; text-only scanning is insufficient.

A clean scan is evidence about the material and rules examined, not proof of absence. Rotate exposed credentials before relying on history cleanup.

## GitHub surfaces

Review issue/PR titles, bodies, comments and reviews; commit comments; attachments; release files; Actions logs and artifacts; wiki; Pages; Discussions; repository description/homepage; branches; tags; and forks. Rewriting Git does not automatically scrub these surfaces or recall downloaded copies.

Follow [GitHub's sensitive-data removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) when historical cleanup is necessary.

## Publication options

For a private development repository containing extensive personal history, prefer a **new repository initialized from a reviewed source-only export**, while retaining the original privately. Do not import `.git`, branches, PRs, issues, logs, deployment settings, or databases. Review the first commit's public identity and use a privacy-preserving email where desired.

Alternatively, plan and approve a backed-up history and GitHub-content cleanup. Rewriting commits changes hashes and affects clones and PRs. Do not force-push, delete history, or change visibility as part of an ordinary source cleanup.

Export only explicitly reviewed source files; do not zip a working directory containing ignored files. Scan and review the export again before publication.

## Final gate

Record the reviewed commit, scan scope/version, unresolved findings, screenshot provenance, and test results privately. Confirm the intended public repository has no inherited private history or settings. Publish only after deliberate owner approval.

Enable private vulnerability reporting and secret push protection where available. Repeat these checks when adding fixtures, screenshots, integrations, or release automation.
