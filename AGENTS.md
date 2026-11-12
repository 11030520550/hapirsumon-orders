# Repository contribution instructions

## GitHub workflow

- After **every change to any project file**, including a very small change, immediately:
  1. Inspect `git status` and the complete relevant `git diff`.
  2. Verify the change is correct, run the relevant checks, and confirm no sensitive files or data are included.
  3. Create a dedicated commit with a message describing that change.
  4. Push to `main` on the private `hapirsumon-orders` repository through the existing `origin` remote.
  5. Verify the push succeeded and the local branch is synchronized with `origin/main`.
- Do not wait until a large task is complete to save changes. For work with multiple development stages, commit and push after every independently completed stage.
- If a check fails, do not claim the change is ready or push it. If a push fails, report the failure immediately and do not represent the work as saved on GitHub.
- In every task completion report, state whether a commit was created, whether the push succeeded, the latest commit ID, and whether any local changes remain unpushed.
- Never force-push. Do not rewrite shared history.
- Do not configure or trigger automatic Netlify publishing. Deployment remains a separate action requiring explicit user approval.
- Do not change Supabase data or run database migrations unless the user explicitly authorizes that operation.

## Sensitive files and data

- Never commit customer/order data, JSON exports, backups, private environment files, credentials, Supabase `service_role`/secret keys, or temporary files.
- A Supabase publishable key may be present in client configuration; verify that no secret key is included before staging.
- Review `git status` and the staged diff before every commit. Use `git diff --cached --check` and inspect the staged file list. Never push customer data, backups, passwords, secret keys, or other sensitive files.
- Keep data backups and internal reference material (`reference/`) outside version control.
- Exception approved by the user (2026-11-12): historical **code** versions, dev tooling and UI screenshots are kept in `archive/` (see `ARCHIVE-INDEX.md`). The archive must never contain customer data, JSON exports or secrets.
- Never ask the user to send a password or access token in chat. Use Git Credential Manager or another secure GitHub sign-in flow.

## Project constraints

- Preserve the existing Hebrew RTL interface and visual design unless the user requests a change.
- Supabase remains the application's central data source; do not add local customer/order data as a fallback.
- Report the commit identifier and push result after each successful task.
