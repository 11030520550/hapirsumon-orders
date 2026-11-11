# Repository contribution instructions

## GitHub workflow

- After each successful development task, inspect the complete diff and run the relevant checks before committing.
- Create a commit with a concise message that describes the completed task, then push it to the existing `origin` remote on `main`.
- If checks fail, do not claim the changes are ready and do not push them.
- Never force-push. Do not rewrite shared history.
- Do not configure or trigger automatic Netlify publishing. Deployment remains a separate action requiring explicit user approval.
- Do not change Supabase data or run database migrations unless the user explicitly authorizes that operation.

## Sensitive files and data

- Never commit customer/order data, JSON exports, backups, private environment files, credentials, Supabase `service_role`/secret keys, or temporary files.
- A Supabase publishable key may be present in client configuration; verify that no secret key is included before staging.
- Review `git status` and the staged diff before every commit. Use `git diff --cached --check` and inspect the staged file list.
- Keep backups and internal reference material outside version control.
- Never ask the user to send a password or access token in chat. Use Git Credential Manager or another secure GitHub sign-in flow.

## Project constraints

- Preserve the existing Hebrew RTL interface and visual design unless the user requests a change.
- Supabase remains the application's central data source; do not add local customer/order data as a fallback.
- Report the commit identifier and push result after each successful task.
