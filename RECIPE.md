# Mod Manager

A **Mods** settings screen: every installed Herdr mod with an on/off switch, a **Browse** tab for herdr.dev/mods, and updates for mods installed from there. Off mods leave your layouts, which fall back to Herdr's own pieces, and come back exactly where they were.

![Mod Manager](preview.png)

## What you see

`cmd-shift-,` (next to Settings' `cmd-,`) opens a dialog titled **Mods**:

- With `usage-status` in the status bar, a puzzle icon there opens it too.
- Tabs **Installed** (with an update count) and **Browse**.
- A filter box.
- **Your mods**: one row per mod you installed or cloned, with title, folder, version, description, and where it's used (`Layout: werlang`, `Used by spaces-plus`, `Keys: cmd-w`). A trash icon and a switch on the right; off rows are muted and tagged `off`.
- **Herdr's mods** (collapsed): the shipped mods, with locked switches.
- Under a mod installed from herdr.dev: `From owner/repo · Update · Unlink`. Same-named untracked mods get **Link to herdr.dev…**, which asks which listing.
- **Browse**: listings from `https://assets.herdr.dev/mods/index.json` (name, owner, ★, blurb), sorted by stars or by last push, with an index age and a refresh button. Each row ends with a GitHub icon, then **Install** / **Update** / `installed`. Clicking a row shows its preview (downloaded into the cache) and its folders; clicking the preview shows it over the whole dialog (click or Esc closes).
- Questions (install, update, link) show as a card above the list.

## How it behaves

- Off: personal layouts that use the mod switch that block to the mod it was cloned from (or the shipped mod named like the block), else hide it; a custom terminal menu goes back to Herdr's. Then the folder moves to `~/.config/herdr-app/mods-disabled/`. Changes are recorded in `mods-disabled/.mod-manager.json`.
- On: the folder moves back and the recorded layout changes are undone, unless you changed that spot yourself meanwhile.
- Applies live; a toast confirms each switch.
- Shipped layouts and shipped mods are never edited.
- Delete (asks first): out of layouts as with Off, then the folder goes to the system Trash (`mv` to `~/.Trash`, Finder via `osascript` if that's refused; `gio trash` or `rm -rf` on Linux). Its disable record and source record go; key bindings stay.
- Install: the repo tarball at `headCommit` is unpacked in `mods-disabled/.mod-manager-cache/dl-*`, scanned (network, programs, outside files) and shown before anything is written. Taken names become `name-2` with paths renamed. Keys are merged without replacing yours. The install is recorded in `mods-disabled/.mod-manager-sources.json`.
- What counts as an update: the index's `headCommit` is the repo's, so it moves for any change. When it moves, `api.github.com/repos/<repo>/contents/<path>/mods?ref=<commit>` gives each mod folder's git tree hash (one call per listing; 1 h pause after a 403/429). Only a hash different from the one recorded at install (computed with `git add -A -f` + `write-tree` in a scratch repo) counts. An unchanged hash moves the recorded commit forward. The download is hashed again before asking.
- Update: **Replace** (old folder kept as `mods-disabled/<name>.old-<time>`, restored if `herdr-app check` fails), **Keep mine as a clone** (`herdr-app do mod.clone` to `<name>-mine`, then replace), or **Cancel**. An edited copy (hash ≠ the one after install) is flagged, and **Keep mine as a clone** comes first.
- The index is cached (`mods-disabled/.mod-manager-cache/index.json`) and fetched again on open, on refresh, and once a day by `usage-status`, which reads `mods-disabled/.mod-manager-updates.json` for its badge.

## Built from

- A new mod, `mods/mod-manager`: `main.js` (the dialog), `manager.js` (pure layout logic: find references, fall back, restore) and `catalog.js` (pure index logic: validate listings, pending updates, free names, renames, key merge, risk notes), both unit-tested with `node --test`.
- `herdr` APIs: `appHome`, `exec` (`mv`, `rm`, `curl`, `tar`, `herdr-app check`, `herdr-app do mod.clone`, `open`), `fetch`, `fs/promises` (`readdir`, `readFile`, `writeFile`, `mkdir`, `exists`), `image`, `theme`, `shared("layout")`, `notify`, `props`/`closeOverlay`, `window().platform`.
- `mod.json` declares it as a 600×620 dialog, so `mod.open mod-manager` opens it.
- Icons: a puzzle glyph, and copies of `workspace-chrome`'s x, chevrons and spinner.

## Watch out

- Herdr's Settings window can't take mod sections; this is a separate settings-style dialog.
- Re-running a repo's `sync.sh` turns its mods back on.
- Bindings to an off mod's commands stay in `keys.json` and do nothing while it's off.
- macOS/Linux only (`mv`, `curl`, `tar`, `git`).
- `exec` has a 30 s limit, so a very large repo may not download.
- Don't link mods you sync from a local repo; the update and the sync would overwrite each other.

## Done when

- `herdr-app check` passes for `mods/mod-manager`.
- `cmd-shift-,` opens the dialog; Esc closes it.
- Turning a mod placed in your layout off swaps the block to its fallback and moves the folder to `mods-disabled/`; turning it on restores both.
- Browse lists the index; installing a listing asks first, adds its folder and records it; an older recorded commit shows **Update**, whose three choices behave as above.
- `herdr-app status` reports no errors.
