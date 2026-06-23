# Clash Subscription Updater

Scripts and local source data for rebuilding the customized `stash2.yaml` Clash/Stash profile.

## Update

```powershell
npm install
node .\update-stash2-preserve-groups.js
```

The updater:

- reads the base local `stash2 (2).yaml`
- applies local Huahe SSR nodes from `huahe-nodes.txt`
- fetches supported vv nodes
- fetches novas nodes, splitting return-home and other-country groups
- filters unsupported Stash proxy types
- removes WJKC nodes and groups
- writes the generated profile locally and to the cloned `clashpersonal` repo when present

