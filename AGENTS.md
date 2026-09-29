<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Delivery standards

- GitHub is the source of truth. Before inspecting or changing project code, run
  `git fetch --prune origin`, switch to the default branch, and fast-forward it with
  `git merge --ff-only origin/master`. Verify that `HEAD` and `origin/master` resolve
  to the same commit, then check open pull requests before choosing work.
- Never hide divergence with a force push or destructive reset. If the checkout has
  local work or cannot fast-forward, preserve it on its branch and resolve the
  mismatch explicitly before continuing.
- Create the focused work branch only from that verified GitHub commit. Push the
  branch, review and merge it through a GitHub pull request, then fetch and
  fast-forward local `master` again so local ends on the merged GitHub commit.
- Do not leave feature commits, fixes, or documentation only on a local branch.
- Develop changes on a focused branch; never commit feature work directly to the default branch.
- Every material change must end in a documented GitHub pull request.
- Keep `README.md`, `ROADMAP.md`, and `docs/architecture/` synchronized with user-facing behavior and product status. Documentation is part of the change, not a follow-up: a feature PR that alters behavior and leaves the docs stale is incomplete, whatever its tests say.
- Never ask permission to write or merge documentation. Update it, open the PR, merge it. Ask only when the *product* decision behind the words is genuinely unresolved — never about the act of documenting.
- The moment a feature is verified in production, update `ROADMAP.md` in the same turn. The window between deploying and recording it is where the roadmap goes quietly wrong.
- Every shipped feature carries a `docs/architecture/` document recording what the code cannot say for itself: the alternatives rejected and why, the constraint that forced the design, and the limitations it ships with.
- Add or update automated tests for behavior that can regress.
- Run `npm test`, `npm run lint`, and `npm run build` before publishing a PR.
- PR descriptions must document purpose, user/developer impact, migrations, deployment, rollback, validation, and screenshots for material UI changes.
- Never mark a roadmap item shipped until it is merged, migrated when necessary, deployed, and verified in production.
