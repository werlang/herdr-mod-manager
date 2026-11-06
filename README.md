# Herdr Mod Manager

A **Mods** settings screen for Herdr: every installed mod with an on/off switch. Turning a mod off takes it out of your layouts (they fall back to Herdr's own pieces) and parks its folder; turning it on puts everything back.

![Herdr Mod Manager](preview.png)

## What it shows

- **Your mods** — every folder in `~/.config/herdr-app/mods/` that Herdr didn't ship, plus the ones you turned off. Each row has the title, folder, version and description from `mod.json`, and where the mod is used:
  - `Layout: …` — personal layouts that place it;
  - `Used by …` — other mods whose code names it (an overlay they open, a presence check);
  - `Keys: …` — bindings in `keys.json` that run its commands.
- **Herdr's mods** (collapsed) — shipped mods, listed but locked: Herdr restores them on every start.
- A filter box, and Esc / × to close.

## How it behaves

Turning a mod **off**:

1. In each personal layout (`layouts/*.json`, not Herdr's shipped ones) that uses it:
   - a block switches to the mod it was cloned from (`cloned_from` in `mod.json`), else to the shipped mod named like the block (`files`, `changes`), else it is hidden;
   - a stack header goes back to the plain `tabs` strip; a pane header is removed;
   - a custom `terminal_menu` is removed, so Herdr's `menu` is used.
2. The folder moves to `~/.config/herdr-app/mods-disabled/<name>`. Herdr only loads `mods/`.
3. What changed is recorded in `mods-disabled/.mod-manager.json`.

Turning it **on** moves the folder back and undoes exactly those layout changes. If you changed a block yourself meanwhile, your change is kept.

Herdr redraws from the files within a second, so the switch applies live.

## Requirements

- Herdr app 0.1.13 or newer.
- macOS or Linux (folders are moved with `mv`).

## Install

Copy/sync `mods/mod-manager` into `~/.config/herdr-app/mods/`, then bind a key (merge `keys.json` from this repo into yours):

```json
{ "global": { "cmd-shift-,": "mod.open:mod-manager" } }
```

With [`usage-status`](https://github.com/werlang/herdr-usage-status) in your status bar, a puzzle icon there opens it too (it appears by itself once this mod is installed).

Or open it once with:

```sh
herdr-app do mod.open --name mod-manager
```

## Watch out

- Herdr's Settings window can't be extended by mods, so **Mods** is its own settings-style dialog, one key next to Settings (`cmd-,` / `cmd-shift-,`).
- A mod's own repo `sync.sh` copies it back into `mods/`, turning it on again. If both a parked copy and a fresh one exist, the fresh one wins and the parked copy is kept as `<name>.old-<time>`.
- Key bindings to an off mod's commands stay in `keys.json`; they do nothing until it's on again.
- Mods that open an off mod (for example a menu opening another mod's dialog) can't open it while it's off; the row lists them under `Used by`.
- The manager can't turn itself off.

## Repository

```sh
./sync.sh          # copy to the live Herdr folder and run herdr-app check
node --test test/  # unit tests of the layout logic
```

## Publish

App-mod repo: `mods/mod-manager` at the root, `RECIPE.md`, `preview.png`, topic `herdr-mod`. See `.agents/skills/herdr-publish/`.
