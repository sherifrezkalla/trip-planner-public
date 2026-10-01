# Contributing

Start with the [README](README.md), [roadmap](ROADMAP.md), and [hosting guide](docs/self-hosting.md). Documentation, accessibility, and test improvements are welcome alongside code changes.

## Good places to start

- Try the [fictional walkthrough](docs/project-tour.md) on your own configured installation and report unclear instructions with synthetic examples.
- Improve keyboard navigation, form labels or error explanations, with focused reproduction steps.
- Add meaningful regression coverage for a reported bug without depending on paid APIs.
- Fix broken documentation links or explain a setup failure using redacted errors.

Use the repository’s [issue forms](https://github.com/sherifrezkalla/trip-planner-public/issues/new/choose) for bugs and proposals. Larger work such as proactive monitoring, offline writes, hosted agents or the mobile companion needs design discussion before implementation. Live-provider claims require their own evidence; ordinary web improvements do not require connecting WhatsApp.

## Workflow

1. Check existing issues and PRs. Describe problems with synthetic examples; discuss substantial product changes first.
2. Fork, clone, and use Node.js 24. Run `npm ci`. Tests and builds do not need production credentials.
3. Create a focused branch from the latest default branch. Keep nested checkouts and scratch files outside the source directory.
4. Make the change and test behavior that can regress. Keep the README, roadmap, and relevant architecture document consistent.
5. Run `npm test`, `npm run lint`, `npm run build`, and `git diff --check`.
6. Review the staged diff for personal data, then submit a PR using the template. Include migrations, deployment order, validation, and rollback.

Read [AGENTS.md](AGENTS.md) when using coding assistants. Contributors without upstream write access submit from a fork; maintainers handle the merge and release process. A preview deployment or passing build does not prove that a live integration works.

## Synthetic data only

Never copy a real roster, booking, invitation, transcript, or trip into a fixture. Recreate the structure and boundary conditions using fictional names, synthetic dates and IDs, and `example.com` addresses. Screenshots must have a documented synthetic source and no access credentials.

Keep environment files, logs, database exports, agent profiles, WhatsApp sessions, private operational notes, and audit reports outside the checkout. Run a redacted secret scan and follow the [public-release checklist](docs/public-release.md). Scanners supplement human review; they do not establish that an ordinary-looking name is fictional.

## Security and licensing

Use [SECURITY.md](SECURITY.md) for vulnerability reports. Do not put private data or working credentials in public issues. Contribute only material you have the right to submit under the project's [MIT license](LICENSE), retaining required third-party notices.
