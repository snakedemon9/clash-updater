# Clash Subscription Updater

Scripts and local source data for rebuilding the customized `stash2.yaml` Clash/Stash profile.

## Update (automated, recommended)

The profile is rebuilt and published automatically via GitHub Actions.

**Trigger 1 — update the Huahe nodes, then push:**

```bash
# edit huahe-nodes.txt with the new SSR nodes, then:
git add huahe-nodes.txt
git commit -m "Update Huahe SSR nodes"
git push
```

Pushing a change to `huahe-nodes.txt` runs the workflow, which downloads the
current `stash2.yaml` from the `clashpersonal` repo, merges the latest
huahe / vv / novas nodes, re-aligns every proxy-group by name, and pushes the
result back to `clashpersonal/stash2.yaml`.

**Trigger 2 — run on demand:**

Go to the **Actions** tab → **Update stash2** → **Run workflow**.

### Required secret

The workflow needs a `CLASHPERSONAL_TOKEN` repository secret: a GitHub Personal
Access Token with **read + write** access to `snakedemon9/clashpersonal`.
Set it under **Settings → Secrets and variables → Actions → New repository secret**.

The runner script is `update-stash2-ci.js`. It fails loudly (non-zero exit) if
validation finds any empty group or dangling reference, so a broken profile is
never auto-published.

## Update (local, Windows)

For local use the original script still works (it reads a local base file and
writes to a local clone of `clashpersonal`):

```powershell
npm install
node .\update-stash2-preserve-groups.js
```

## What the updater does

- reads the base `stash2.yaml` (CI downloads it from `clashpersonal`; local uses `stash2 (2).yaml`)
- applies local Huahe SSR nodes from `huahe-nodes.txt`
- fetches supported vv nodes
- fetches novas nodes, splitting return-home and other-country groups
- re-aligns every proxy-group by name (replaces old huahe / vv / novas entries
  in place instead of dropping them, so groups never end up empty)
- filters unsupported Stash proxy types
- removes WJKC nodes and groups
- writes the generated profile (CI: pushes to `clashpersonal/stash2.yaml`; local: writes locally)
