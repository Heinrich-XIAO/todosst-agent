# Git

- When you commit, also push so the branch stays up to date.
- After a verified fix, always auto-commit and push, then report the hash. Only hold off if tests are failing or the change is risky/incomplete.
- Pushing to master deploys to production: CI (`.github/workflows/ci.yml`) runs checks, then `bunx convex deploy` to Convex prod `fantastic-sandpiper-942` (project todosst-agent) and a Vercel prod deploy (project todosst-agent). Vercel's own git deploys are off for master (`vercel.json`); PRs still get previews.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
