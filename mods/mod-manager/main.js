// Mods: a settings screen that turns installed mods on and off, browses the
// mods people share on herdr.dev, and updates the ones installed from there.
//
// Herdr's own Settings window can't be extended by mods, so this opens as
// a settings-style dialog of its own (`mod.open mod-manager`, bound to
// cmd-shift-, next to Settings' cmd-,).
//
// Disabling a mod parks its folder in ~/.config/herdr-app/mods-disabled/
// (Herdr only loads mods/) and takes it out of your personal layouts first,
// so nothing points at a missing mod: a block falls back to the mod it was
// cloned from (or the shipped mod named like the block), else it hides; a
// custom terminal menu goes back to Herdr's. Enabling moves the folder back
// and undoes exactly those layout changes. Herdr's shipped mods are listed
// but locked: Herdr restores them on every start.
//
// Browse reads the index herdr.dev/mods is built from (cached in
// mods-disabled/.mod-manager-cache/, fetched again when this screen opens,
// on Refresh, and by usage-status once a day). Installing downloads the repo
// at the listed commit, shows what the code reaches (network, programs,
// files) and asks; a taken folder name gets a free one, with its asset paths
// renamed; its keys.json is merged without replacing any key you use. Each
// install is recorded in mods-disabled/.mod-manager-sources.json with the
// git tree hash of the mod's folder. The index only has the repo's latest
// commit, which moves for any change (a README, a sibling mod), so a moved
// commit is looked up on GitHub (one call per listing) and only a changed
// folder hash counts as an update. An update asks: replace your copy, keep
// yours as a clone first, or cancel.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { appHome, home as userHome, exec, theme, props, closeOverlay, notify, shared, window as herdrWindow } from "herdr";
import * as fs from "fs/promises";
import {
  SELF,
  DISABLED_DIR,
  STATE_FILE,
  shippedFrom,
  isParkedName,
  modsUsedBy,
  referencesIn,
  fallbackFor,
  disableInLayout,
  restoreLayout,
  usedByMods,
  keysFor,
} from "./manager.js";
import {
  INDEX_URL,
  SOURCES_FILE,
  UPDATES_FILE,
  CACHE_DIR,
  parseIndex,
  entryKey,
  entryUrl,
  tarballUrl,
  contentsUrl,
  treesFromContents,
  sourceRecord,
  resolveSource,
  lookupsNeeded,
  pendingUpdates,
  candidatesFor,
  installedFrom,
  freeName,
  renameInText,
  renameInKeys,
  mergeKeys,
  riskNotes,
} from "./catalog.js";

const I = (name) => `mods/${SELF}/${name}.svg`;

/** How long to wait after GitHub refuses a lookup (rate limit: 60 an hour). */
const GITHUB_BACKOFF_MS = 60 * 60 * 1000;

/** How many listings one check looks up on GitHub, at most. */
const LOOKUPS_PER_CHECK = 20;

/** How many Browse rows are drawn before "Show more". */
const PAGE = 40;

/** Parsed JSON at a path, or null when missing or invalid. */
async function readJson(path) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Writes pretty JSON with a trailing newline. */
async function writeJson(path, value) {
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Folder names in a directory (no hidden ones); [] when it doesn't exist. */
async function folders(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Concatenated top-level .js sources of a mod folder, for "used by" hints. */
async function sourcesOf(dir) {
  try {
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith(".js"));
    const texts = await Promise.all(names.map((n) => fs.readFile(`${dir}/${n}`, "utf8").catch(() => "")));
    return texts.join("\n");
  } catch {
    return "";
  }
}

/** Every file path under a folder, recursively. */
async function filesIn(dir) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...(await filesIn(path)));
    else out.push(path);
  }
  return out;
}

/** Runs a program; rejects with its error text when it exits non-zero. */
async function run(command, args, options) {
  const r = await exec(command, args, options);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `${command} exited ${r.code}`).trim());
  return r;
}

/** Moves a folder; rejects with the command's error text. */
async function move(from, to) {
  await run("mv", [from, to]);
}

/** "5 min ago" style age of a time in ms. */
function ago(ms) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** The error text of anything thrown. */
const message = (e) => String(e?.message ?? e);

export default class ModManager extends View {
  init(_props, cx) {
    this.home = appHome();
    this.mods = null; // entries, once scanned
    this.busy = {}; // name / listing key -> true while working on it
    this.errors = {}; // name / listing key -> last error text
    this.showShipped = false;
    this.tab = "installed";
    this.sort = "stars";
    this.shown = PAGE;
    this.expanded = null; // listing key open in Browse
    this.previews = {}; // listing key -> image path | "loading" | "failed"
    this.prompt = null; // the question being asked (install, update, link, delete)
    this.lightbox = null; // preview image shown full size over the screen
    this.index = null; // { fetchedAt, generatedAt, mods }
    this.fetching = false;
    this.fetchError = null;
    this.sources = {};
    this.query = "";
    this.input = InputState.new({ placeholder: "Filter mods" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.shown = PAGE;
      cx.notify();
    });
    this.inputFocused = false;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.rescan(cx);
    cx.spawn(async (cx) => {
      await this.loadCachedIndex();
      cx.notify();
      await this.cleanDownloads();
      // Opening the screen is one of the moments the index is fetched again.
      await this.refreshIndex(cx);
    });
  }

  get modsDir() { return `${this.home}/mods`; }
  get parkDir() { return `${this.home}/${DISABLED_DIR}`; }
  get layoutsDir() { return `${this.home}/layouts`; }
  get statePath() { return `${this.parkDir}/${STATE_FILE}`; }
  get sourcesPath() { return `${this.parkDir}/${SOURCES_FILE}`; }
  get updatesPath() { return `${this.parkDir}/${UPDATES_FILE}`; }
  get cacheDir() { return `${this.parkDir}/${CACHE_DIR}`; }
  get indexPath() { return `${this.cacheDir}/index.json`; }

  rescan(cx) {
    cx.spawn(async (cx) => {
      try {
        await this.scan();
        await this.writeUpdates();
      } catch (e) {
        this.scanError = message(e);
      }
      cx.notify();
    });
  }

  /** Reads what's installed, parked, shipped and used, into this.mods. */
  async scan() {
    const shipped = shippedFrom(await readJson(`${this.home}/installed.json`));
    this.shippedLayouts = shipped.layouts;
    const live = await folders(this.modsDir);
    const parked = (await folders(this.parkDir)).filter((n) => isParkedName(n) && !live.includes(n));
    this.state = (await readJson(this.statePath)) ?? { disabled: {} };
    this.state.disabled ??= {};
    this.sources = (await readJson(this.sourcesPath)) ?? {};

    // Layouts: every *.json file directly in layouts/.
    let layoutFiles = [];
    try {
      layoutFiles = (await fs.readdir(this.layoutsDir)).filter((n) => n.endsWith(".json"));
    } catch {}
    this.layouts = {};
    for (const file of layoutFiles) {
      const json = await readJson(`${this.layoutsDir}/${file}`);
      if (json) this.layouts[file.slice(0, -".json".length)] = json;
    }
    const usedIn = {};
    for (const [layout, json] of Object.entries(this.layouts)) {
      for (const mod of modsUsedBy(json)) (usedIn[mod] ??= []).push(layout);
    }

    const keys = (await readJson(`${this.home}/keys.json`)) ?? {};
    const sources = {};
    for (const name of live) sources[name] = await sourcesOf(`${this.modsDir}/${name}`);

    const entry = async (name, enabled) => {
      const dir = `${enabled ? this.modsDir : this.parkDir}/${name}`;
      const manifest = (await readJson(`${dir}/mod.json`)) ?? {};
      return {
        name,
        enabled,
        shipped: shipped.mods.has(name),
        self: name === SELF,
        manifest,
        title: manifest.title || name,
        description: manifest.description || (manifest.cloned_from?.name ? `Clone of ${manifest.cloned_from.name}` : ""),
        version: manifest.version || null,
        layouts: (usedIn[name] ?? []).sort(),
        usedBy: usedByMods(name, sources),
        keys: keysFor(name, keys),
      };
    };
    const all = [];
    for (const name of live) all.push(await entry(name, true));
    for (const name of parked) all.push(await entry(name, false));
    all.sort((a, b) => a.name.localeCompare(b.name));
    // A source whose folder is gone (deleted by hand) no longer counts.
    for (const name of Object.keys(this.sources)) if (!all.some((m) => m.name === name)) delete this.sources[name];
    this.mods = all;
    this.scanError = null;
  }

  async writeState() {
    await fs.mkdir(this.parkDir, { recursive: true });
    await writeJson(this.statePath, this.state);
  }

  async writeSources() {
    await fs.mkdir(this.parkDir, { recursive: true });
    await writeJson(this.sourcesPath, this.sources);
  }

  async writeLayout(name, json) {
    await writeJson(`${this.layoutsDir}/${name}.json`, json);
  }

  /** A folder already sitting at `path` is kept aside as `<path>.old-<time>`. */
  async setAside(path) {
    if (await fs.exists(path)) await move(path, `${path}.old-${Date.now()}`);
  }

  /** Takes the mod out of personal layouts, then parks its folder. */
  async disable(mod, { quiet = false } = {}) {
    const available = new Set(this.mods.filter((m) => m.enabled && m.name !== mod.name).map((m) => m.name));
    const changed = {};
    for (const [layout, json] of Object.entries(this.layouts)) {
      // Shipped layouts are Herdr's (an edit gets moved to <name>-edited).
      if (this.shippedLayouts.has(layout) || !referencesIn(json, mod.name).length) continue;
      const copy = JSON.parse(JSON.stringify(json));
      const changes = disableInLayout(copy, mod.name, (id) => fallbackFor(mod.name, mod.manifest, id, available));
      if (!changes.length) continue;
      await this.writeLayout(layout, copy);
      changed[layout] = changes;
    }
    try {
      await fs.mkdir(this.parkDir, { recursive: true });
      await this.setAside(`${this.parkDir}/${mod.name}`);
      await move(`${this.modsDir}/${mod.name}`, `${this.parkDir}/${mod.name}`);
    } catch (e) {
      // Couldn't park it: give the layouts back as they were.
      for (const layout of Object.keys(changed)) await this.writeLayout(layout, this.layouts[layout]);
      throw e;
    }
    this.state.disabled[mod.name] = { at: new Date().toISOString(), layouts: changed };
    await this.writeState();
    const n = Object.keys(changed).length;
    if (!quiet) notify({ title: `${mod.title} disabled`, body: n ? `Taken out of ${Object.keys(changed).join(", ")}.` : "Its folder is parked in mods-disabled.", level: "info", timeout: 3500 });
  }

  /** Moves the folder back, then undoes its layout changes. */
  async enable(mod) {
    const parked = `${this.parkDir}/${mod.name}`;
    const live = `${this.modsDir}/${mod.name}`;
    // A sync may have put a fresh copy in mods/ meanwhile: that one wins.
    if (await fs.exists(live)) await move(parked, `${parked}.old-${Date.now()}`);
    else await move(parked, live);
    const record = this.state.disabled[mod.name];
    let restored = 0;
    for (const [layout, changes] of Object.entries(record?.layouts ?? {})) {
      const json = await readJson(`${this.layoutsDir}/${layout}.json`);
      if (!json) continue;
      const n = restoreLayout(json, changes);
      if (n) {
        await this.writeLayout(layout, json);
        restored += n;
      }
    }
    delete this.state.disabled[mod.name];
    await this.writeState();
    notify({ title: `${mod.title} enabled`, body: restored ? "Put back in your layouts." : "Back in mods.", level: "success", timeout: 3500 });
  }

  /**
   * Runs one job for a row (a mod name or a listing key): marks it busy,
   * keeps its error, rescans after.
   */
  work(id, cx, job) {
    if (this.busy[id]) return;
    this.busy[id] = true;
    delete this.errors[id];
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await job(cx);
      } catch (e) {
        this.errors[id] = message(e);
      }
      delete this.busy[id];
      await this.scan().catch(() => null);
      await this.resolveUpdates().catch(() => null);
      await this.writeUpdates().catch(() => null);
      cx.notify();
    });
  }

  toggle(mod, cx) {
    if (mod.shipped || mod.self) return;
    this.work(mod.name, cx, () => (mod.enabled ? this.disable(mod) : this.enable(mod)));
  }

  /** Where a deleted folder goes: the system trash, so a delete can be undone. */
  get trashName() {
    const platform = herdrWindow()?.platform;
    return platform === "macos" ? "Trash" : platform === "linux" ? "trash" : "bin";
  }

  /** Asks before deleting a mod, saying what else changes. */
  askDelete(mod, cx) {
    const lines = [];
    if (mod.layouts.length) lines.push(`It's taken out of ${mod.layouts.join(", ")} first; those spots fall back to Herdr's pieces.`);
    if (mod.usedBy.length) lines.push(`${mod.usedBy.join(", ")} name${mod.usedBy.length === 1 ? "s" : ""} it in code and may stop working fully.`);
    if (mod.keys.length) lines.push(`Its keys (${mod.keys.join(", ")}) stay in keys.json and do nothing.`);
    this.ask(cx, {
      id: mod.name,
      title: `Delete ${mod.title}?`,
      subtitle: `mods/${mod.name}/ moves to the ${this.trashName}.`,
      notes: [],
      lines,
      actions: [
        { label: "Delete", danger: true, run: () => this.remove(mod) },
        { label: "Cancel" },
      ],
    });
  }

  /** Takes the mod out of layouts (as turning it off does), then trashes the folder. */
  async remove(mod) {
    if (mod.enabled) await this.disable(mod, { quiet: true });
    const parked = `${this.parkDir}/${mod.name}`;
    await this.trash(parked, mod.name);
    // Nothing to put back any more: the layouts keep their fallbacks.
    delete this.state.disabled[mod.name];
    await this.writeState();
    if (this.sources[mod.name]) {
      delete this.sources[mod.name];
      await this.writeSources();
    }
    notify({ title: `${mod.title} deleted`, body: `Moved to the ${this.trashName}.`, level: "info", timeout: 3500 });
  }

  /** Moves a folder to the system trash; deletes it where there is none. */
  async trash(path, name) {
    const platform = herdrWindow()?.platform;
    if (platform === "macos") {
      const bin = `${userHome()}/.Trash`;
      let to = `${bin}/${name}`;
      if (await fs.exists(to)) to = `${bin}/${name} ${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        await move(path, to);
      } catch {
        // ~/.Trash can be off limits to the app; Finder can still trash it.
        // On failure the folder stays parked in mods-disabled/.
        await run("osascript", ["-e", "on run argv", "-e", 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', "-e", "end run", path]);
      }
      return;
    }
    if (platform === "linux") {
      const r = await exec("gio", ["trash", path]).catch(() => null);
      if (r?.code === 0) return;
    }
    await run("rm", ["-rf", path]);
  }

  // ---- The index -----------------------------------------------------------

  async loadCachedIndex() {
    const cached = await readJson(this.indexPath);
    const parsed = parseIndex(cached?.index);
    if (parsed) this.index = { fetchedAt: Number(cached.fetchedAt) || 0, ...parsed };
  }

  /** Fetches the index again, caches it, and recounts updates. */
  async refreshIndex(cx) {
    if (this.fetching) return;
    this.fetching = true;
    this.fetchError = null;
    cx.notify();
    try {
      const res = await fetch(INDEX_URL);
      if (!res.ok) throw new Error(`herdr.dev answered ${res.status}`);
      const json = await res.json();
      const parsed = parseIndex(json);
      if (!parsed) throw new Error("The index didn't look like one");
      const fetchedAt = Date.now();
      this.index = { fetchedAt, ...parsed };
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(this.indexPath, JSON.stringify({ fetchedAt, index: json }));
    } catch (e) {
      this.fetchError = message(e);
    }
    if (this.index && this.mods) {
      await this.resolveUpdates().catch(() => null);
      await this.writeUpdates().catch(() => null);
    }
    this.fetching = false;
    cx.notify();
  }

  /**
   * Turns "the repo moved" into "this mod changed": fills in hashes missing
   * from older records, then looks moved listings up on GitHub. A listing
   * whose folder hash is unchanged just moves its recorded commit forward.
   */
  async resolveUpdates() {
    if (!this.mods) return;
    let changed = false;
    // Records from before hashes (or linked by hand): hash the installed copy.
    for (const [name, source] of Object.entries(this.sources)) {
      if (source.localTree) continue;
      const mod = this.mods.find((m) => m.name === name);
      const hash = mod ? await this.treeHash(`${mod.enabled ? this.modsDir : this.parkDir}/${name}`) : null;
      if (!hash) continue;
      this.sources[name] = { ...source, localTree: hash, tree: source.tree ?? (name === source.modName ? hash : null) };
      changed = true;
    }
    if (Date.now() - (this.githubRefusedAt ?? 0) >= GITHUB_BACKOFF_MS) {
      for (const { entry, names } of lookupsNeeded(this.sources, this.entries).slice(0, LOOKUPS_PER_CHECK)) {
        const res = await fetch(contentsUrl(entry), { headers: { Accept: "application/vnd.github+json", "User-Agent": "herdr-mod-manager" } }).catch(() => null);
        if (!res) break; // offline: try again next time
        if (res.status === 403 || res.status === 429) {
          this.githubRefusedAt = Date.now();
          break;
        }
        const trees = res.ok ? treesFromContents(await res.json().catch(() => null)) : {};
        // 404: the listing's mods/ folder is gone at that commit.
        if (!res.ok && res.status !== 404) continue;
        for (const name of names) this.sources[name] = resolveSource(this.sources[name], entry, trees[this.sources[name].modName] ?? null);
        changed = true;
      }
    }
    if (changed) await this.writeSources();
  }

  get entries() { return this.index?.mods ?? []; }

  /** Updates for mods that are on now (a parked one updates once it's back). */
  get updates() {
    const enabled = new Set((this.mods ?? []).filter((m) => m.enabled).map((m) => m.name));
    return pendingUpdates(this.sources, this.entries).filter((u) => enabled.has(u.name));
  }

  /** The count usage-status shows on its Mods button. */
  async writeUpdates() {
    if (!this.index || !this.mods) return;
    const names = this.updates.map((u) => u.name);
    await fs.mkdir(this.parkDir, { recursive: true });
    await writeJson(this.updatesPath, { checkedAt: new Date(this.index.fetchedAt).toISOString(), count: names.length, names });
  }

  // ---- Downloads -----------------------------------------------------------

  /** Removes downloads left behind by a closed screen. */
  async cleanDownloads() {
    for (const name of await folders(this.cacheDir)) {
      if (name.startsWith("dl-")) await this.removeDownload(`${this.cacheDir}/${name}`).catch(() => null);
    }
  }

  /** Deletes one download folder (only ever inside the cache). */
  async removeDownload(dir) {
    if (!dir || !dir.startsWith(`${this.cacheDir}/dl-`)) return;
    await exec("rm", ["-rf", dir]);
  }

  /**
   * Downloads a listing's repo at its commit and unpacks it.
   * @returns {Promise<{ dir: string, base: string }>} base: the listing's folder inside it
   */
  async download(entry) {
    const dir = `${this.cacheDir}/dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.mkdir(dir, { recursive: true });
    try {
      await run("curl", ["-fsSL", "--max-time", "25", "-o", `${dir}/repo.tgz`, tarballUrl(entry)]);
      await run("tar", ["-xzf", `${dir}/repo.tgz`, "-C", dir]);
      const [top] = await folders(dir);
      if (!top) throw new Error("The download was empty");
      const base = `${dir}/${top}${entry.path ? `/${entry.path}` : ""}`;
      return { dir, base };
    } catch (e) {
      await this.removeDownload(dir);
      throw e;
    }
  }

  /** A downloaded mod folder with its name changed (paths, overlays, mod.json). */
  async renameFolder(folder, from, to) {
    if (from === to) return;
    for (const file of await filesIn(folder)) {
      if (!/\.(js|mjs|json)$/.test(file)) continue;
      const text = await fs.readFile(file, "utf8").catch(() => null);
      if (text == null) continue;
      let next = renameInText(text, from, to);
      if (file === `${folder}/mod.json`) {
        try {
          const json = JSON.parse(next);
          if (json.name === from) json.name = to;
          next = `${JSON.stringify(json, null, 2)}\n`;
        } catch {}
      }
      if (next !== text) await fs.writeFile(file, next);
    }
  }

  /** Runs `herdr-app check` on a live mod; rejects with its output when it fails. */
  async check(folder) {
    let r;
    try {
      r = await exec("herdr-app", ["check", folder]);
    } catch {
      return; // herdr-app not on PATH here: Herdr still reports it on load.
    }
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "herdr-app check failed").trim());
  }

  /**
   * The git tree hash of a folder, the same one GitHub reports for it, or
   * null when git isn't there. Hashed in a scratch repo, so the folder is
   * only read; every file counts (no ignore rules) except Finder's .DS_Store.
   */
  async treeHash(folder) {
    if (!(await fs.exists(folder))) return null;
    const gitDir = `${this.cacheDir}/dl-git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const git = ["-c", "core.autocrlf=false", "-c", "core.excludesFile=/dev/null", "--git-dir", gitDir, "--work-tree", folder];
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      await run("git", ["init", "-q", "--bare", gitDir]);
      await run("git", [...git, "add", "-A", "-f", "--", ".", ":(exclude,glob)**/.DS_Store"], { cwd: folder });
      const hash = (await run("git", [...git, "write-tree"], { cwd: folder })).stdout.trim();
      return /^[0-9a-f]{40}$/.test(hash) ? hash : null;
    } catch {
      return null;
    } finally {
      await this.removeDownload(gitDir);
    }
  }

  /** Every folder name in use: yours, parked and Herdr's. */
  takenNames() {
    return new Set((this.mods ?? []).map((m) => m.name));
  }

  // ---- Install ---------------------------------------------------------------

  /** Downloads a listing and asks before installing, with what it reaches. */
  prepareInstall(entry, cx) {
    const key = entryKey(entry);
    this.work(key, cx, async () => {
      const dl = await this.download(entry);
      const taken = this.takenNames();
      const plan = [];
      for (const from of entry.modNames) {
        const src = `${dl.base}/mods/${from}`;
        if (!(await fs.exists(`${src}/mod.json`)) && !(await fs.exists(`${src}/main.js`))) continue;
        const to = freeName(from, taken);
        taken.add(to);
        const text = (await Promise.all((await filesIn(src)).filter((f) => /\.(js|mjs)$/.test(f)).map((f) => fs.readFile(f, "utf8").catch(() => "")))).join("\n");
        plan.push({ from, to, src, notes: riskNotes(text, from), tree: await this.treeHash(src) });
      }
      if (!plan.length) {
        await this.removeDownload(dl.dir);
        throw new Error("No mod folder found at the listed commit");
      }
      let keys = null;
      if (await fs.exists(`${dl.base}/keys.json`)) {
        let theirs = (await readJson(`${dl.base}/keys.json`)) ?? {};
        for (const p of plan) theirs = renameInKeys(theirs, p.from, p.to);
        keys = mergeKeys((await readJson(`${this.home}/keys.json`)) ?? {}, theirs);
      }
      const notes = [...new Set(plan.flatMap((p) => p.notes))];
      const lines = plan.map((p) => (p.from === p.to ? `Adds mods/${p.to}/` : `Adds mods/${p.to}/ (${p.from} is taken; its paths are renamed)`));
      if (keys?.added.length) lines.push(`Adds keys: ${keys.added.join(", ")}`);
      if (keys?.conflicts.length) lines.push(`Keeps your ${keys.conflicts.map((c) => `${c.key} (${c.mine})`).join(", ")}; the mod wanted ${keys.conflicts.map((c) => c.theirs).join(", ")}`);
      this.ask(cx, {
        id: key,
        title: `Install ${entry.name}?`,
        subtitle: `${entry.fullName} · ${entry.headCommit.slice(0, 7)}`,
        notes,
        lines,
        cleanup: () => this.removeDownload(dl.dir),
        actions: [
          { label: "Install", primary: true, run: () => this.install(entry, plan, keys, dl) },
          { label: "Cancel" },
        ],
      });
    });
  }

  async install(entry, plan, keys, dl) {
    const done = [];
    try {
      for (const p of plan) {
        await this.renameFolder(p.src, p.from, p.to);
        const live = `${this.modsDir}/${p.to}`;
        if (await fs.exists(live)) throw new Error(`mods/${p.to} appeared meanwhile`);
        await move(p.src, live);
        done.push(p);
        await this.check(live);
      }
    } catch (e) {
      // Take back what this install put in mods/.
      for (const p of done) await move(`${this.modsDir}/${p.to}`, `${dl.dir}/${p.to}.failed`).catch(() => null);
      throw e;
    }
    for (const p of plan) {
      const localTree = await this.treeHash(`${this.modsDir}/${p.to}`);
      this.sources[p.to] = sourceRecord(entry, p.from, entry.headCommit, { tree: p.tree, localTree, remoteCommit: entry.headCommit, remoteTree: p.tree });
    }
    await this.writeSources();
    if (keys?.added.length) await writeJson(`${this.home}/keys.json`, keys.merged);
    const names = plan.map((p) => p.to).join(", ");
    notify({ title: `${entry.name} installed`, body: `In mods/${names}. Add it to a layout to see it.`, level: "success", timeout: 4500 });
  }

  // ---- Update ----------------------------------------------------------------

  /** Downloads the listed commit and asks: replace, keep mine as a clone, or cancel. */
  prepareUpdate(update, cx) {
    const { name, entry, source } = update;
    this.work(name, cx, async () => {
      const dl = await this.download(entry);
      const src = `${dl.base}/mods/${source.modName}`;
      if (!(await fs.exists(src))) {
        await this.removeDownload(dl.dir);
        throw new Error(`${entry.fullName} no longer has mods/${source.modName}`);
      }
      // The download itself is the final word: an unchanged folder is no update.
      const tree = await this.treeHash(src);
      if (tree && tree === source.tree) {
        await this.removeDownload(dl.dir);
        this.sources[name] = { ...source, commit: entry.headCommit, remoteCommit: entry.headCommit, remoteTree: tree };
        await this.writeSources();
        notify({ title: `${name} is up to date`, body: "Only other files in its repo changed.", level: "info", timeout: 3500 });
        return;
      }
      const text = (await Promise.all((await filesIn(src)).filter((f) => /\.(js|mjs)$/.test(f)).map((f) => fs.readFile(f, "utf8").catch(() => "")))).join("\n");
      const now = await this.treeHash(`${this.modsDir}/${name}`);
      const edited = Boolean(source.localTree && now && now !== source.localTree);
      const clone = freeName(`${name}-mine`, this.takenNames());
      const replace = { label: "Replace", run: () => this.update(update, src, tree) };
      const keep = { label: "Keep mine as a clone", run: () => this.update(update, src, tree, clone) };
      this.ask(cx, {
        id: name,
        title: `Update ${name}?`,
        subtitle: `${entry.fullName} · ${source.commit ? source.commit.slice(0, 7) : "linked"} → ${entry.headCommit.slice(0, 7)}`,
        notes: riskNotes(text, source.modName),
        lines: [
          ...(edited ? ["You changed this copy since it was installed."] : []),
          "Replace: your copy is swapped for the new one (the old folder is kept in mods-disabled/ as a backup).",
          `Keep mine as a clone: your copy is saved as ${clone} first, then this one is updated.`,
        ],
        cleanup: () => this.removeDownload(dl.dir),
        // Edited copies lead with keeping them; untouched ones with replacing.
        actions: edited ? [{ ...keep, primary: true }, replace, { label: "Cancel" }] : [{ ...replace, primary: true }, keep, { label: "Cancel" }],
      });
    });
  }

  async update({ name, entry, source }, src, tree, cloneAs = null) {
    if (cloneAs) {
      // Herdr's own clone: renames asset paths and records cloned_from.
      await run("herdr-app", ["do", "mod.clone", JSON.stringify({ name, as: cloneAs })]);
    }
    await this.renameFolder(src, source.modName, name);
    const live = `${this.modsDir}/${name}`;
    const backup = `${this.parkDir}/${name}.old-${Date.now()}`;
    await fs.mkdir(this.parkDir, { recursive: true });
    await move(live, backup);
    try {
      await move(src, live);
      await this.check(live);
    } catch (e) {
      // The new one doesn't load: put yours back.
      if (await fs.exists(live)) await exec("rm", ["-rf", live]);
      await move(backup, live);
      throw e;
    }
    this.sources[name] = {
      ...source,
      commit: entry.headCommit,
      tree,
      localTree: await this.treeHash(live),
      remoteCommit: entry.headCommit,
      remoteTree: tree,
      at: new Date().toISOString(),
    };
    await this.writeSources();
    notify({
      title: `${name} updated`,
      body: cloneAs ? `Your version is kept as ${cloneAs}.` : `The old folder is in ${DISABLED_DIR}/ as a backup.`,
      level: "success",
      timeout: 4500,
    });
  }

  // ---- Link ------------------------------------------------------------------

  /** Asks which listing an untracked mod came from (names alone can't tell). */
  askLink(mod, candidates, cx) {
    this.ask(cx, {
      id: mod.name,
      title: `Where did ${mod.name} come from?`,
      subtitle: "Linking lets the updater follow that listing. Your copy is compared with the published folder: an update shows only if they differ.",
      notes: [],
      lines: [],
      actions: [
        ...candidates.slice(0, 3).map((e) => ({
          label: `${e.fullName}${e.path ? `/${e.path}` : ""}`,
          run: async () => {
            const hash = await this.treeHash(`${mod.enabled ? this.modsDir : this.parkDir}/${mod.name}`);
            this.sources[mod.name] = sourceRecord(e, mod.name, null, { tree: hash, localTree: hash });
            await this.writeSources();
          },
        })),
        { label: "None of these" },
      ],
    });
  }

  async unlink(mod) {
    delete this.sources[mod.name];
    await this.writeSources();
  }

  // ---- Prompt ----------------------------------------------------------------

  ask(cx, prompt) {
    this.prompt = prompt;
    cx.notify();
  }

  /** Answers the open prompt; actions without `run` just close it. */
  answer(action, cx) {
    const prompt = this.prompt;
    if (!prompt) return;
    this.prompt = null;
    if (!action.run) {
      prompt.cleanup?.();
      cx.notify();
      return;
    }
    this.work(prompt.id, cx, async () => {
      try {
        await action.run();
      } finally {
        await prompt.cleanup?.();
      }
    });
  }

  // ---- Previews and links ------------------------------------------------------

  /** Downloads a listing's preview image into the cache, once. */
  loadPreview(entry, cx) {
    const key = entryKey(entry);
    if (this.previews[key] || !entry.previewUrl) return;
    const file = entry.previewUrl.split("/").pop();
    if (!/^[0-9a-f]+\.png$/.test(file)) return;
    const rel = `${DISABLED_DIR}/${CACHE_DIR}/previews/${file}`;
    this.previews[key] = "loading";
    cx.spawn(async (cx) => {
      try {
        const path = `${this.home}/${rel}`;
        if (!(await fs.exists(path))) {
          await fs.mkdir(`${this.cacheDir}/previews`, { recursive: true });
          await run("curl", ["-fsSL", "--max-time", "20", "-o", path, entry.previewUrl]);
        }
        this.previews[key] = rel;
      } catch {
        this.previews[key] = "failed";
      }
      cx.notify();
    });
  }

  openUrl(url) {
    const platform = herdrWindow()?.platform;
    exec(platform === "windows" ? "explorer" : platform === "linux" ? "xdg-open" : "open", [url]).catch(() => null);
  }

  close() {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  key(e, cx) {
    if (e.key === "escape") {
      if (this.lightbox) { this.lightbox = null; cx.notify(); }
      else if (this.prompt) this.answer({}, cx);
      else this.close();
      cx.stop_propagation();
    }
  }

  matches(mod) {
    const q = this.query.trim().toLowerCase();
    if (!q) return true;
    return [mod.name, mod.title, mod.description].some((s) => String(s).toLowerCase().includes(q));
  }

  matchesEntry(e) {
    const q = this.query.trim().toLowerCase();
    if (!q) return true;
    return `${e.name} ${e.blurb} ${e.owner} ${e.modNames.join(" ")}`.toLowerCase().includes(q);
  }

  // ---- UI -----------------------------------------------------------------

  spinner(t) {
    return svg(I("spinner")).size(14).text_color(t.working).spin(900);
  }

  /** The on/off switch: a pill with a knob, drawn from divs. */
  switch(t, mod) {
    const on = mod.enabled;
    const locked = mod.shipped || mod.self;
    const busy = Boolean(this.busy[mod.name]);
    if (busy) {
      return h_flex().w(34).justify_center().child(this.spinner(t));
    }
    return h_flex()
      .id(`mm-switch-${mod.name}`)
      .flex_none()
      .w(34)
      .h(20)
      .p(2)
      .rounded(10)
      .bg(on ? t.accent : t.input)
      .when(on, (el) => el.justify_end())
      .when(!on, (el) => el.justify_start())
      .when(locked, (el) => el.opacity(0.45))
      .when(!locked, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => this.toggle(mod, cx)))
      .child(div().w(16).h(16).rounded(8).bg(on ? t.accent_foreground : t.foreground));
  }

  badge(t, text, color) {
    return div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.raised).text_size(10.5).text_color(color ?? t.muted).child(text);
  }

  /** A small text button. */
  button(t, id, label, onClick, primary = false, danger = false) {
    return div()
      .id(id)
      .flex_none()
      .px(10)
      .h(26)
      .flex()
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .text_size(12)
      .font_medium()
      .bg(danger ? t.blocked : primary ? t.accent : t.raised)
      .text_color(danger ? t.background : primary ? t.accent_foreground : t.foreground)
      .hover((s) => s.opacity(0.88))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(label);
  }

  /** A square icon button with a tooltip. */
  iconButton(t, id, icon, tip, onClick, size = 26) {
    return div()
      .id(id)
      .flex_none()
      .w(size)
      .h(size)
      .rounded(6)
      .flex()
      .items_center()
      .justify_center()
      .cursor_pointer()
      .text_color(t.dim)
      .hover((s) => s.bg(t.raised).text_color(t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(svg(I(icon)).size(13));
  }

  /** A text link inside a row. */
  link(t, id, label, onClick, color = t.accent) {
    return div()
      .id(id)
      .flex_none()
      .cursor_pointer()
      .text_size(11.5)
      .text_color(color)
      .hover((s) => s.opacity(0.8))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(label);
  }

  row(t, mod) {
    const facts = [];
    if (mod.layouts.length) facts.push(`Layout: ${mod.layouts.join(", ")}`);
    if (mod.usedBy.length) facts.push(`Used by ${mod.usedBy.join(", ")}`);
    if (mod.keys.length) facts.push(`Keys: ${mod.keys.join(", ")}`);
    const error = this.errors[mod.name];
    const source = this.sources[mod.name];
    const update = this.updates.find((u) => u.name === mod.name);
    const candidates = !source && !mod.shipped && !mod.self && this.index ? candidatesFor(mod.name, this.entries) : [];
    const origin = h_flex().gap(8).items_center();
    if (source) {
      origin.child(div().text_size(11.5).text_color(t.dim).truncate().child(`From ${source.fullName}${source.path ? `/${source.path}` : ""}`));
      if (update && !this.busy[mod.name]) origin.child(this.link(t, `mm-update-${mod.name}`, "Update", (cx) => this.prepareUpdate(update, cx)));
      origin.child(this.link(t, `mm-unlink-${mod.name}`, "Unlink", (cx) => this.work(mod.name, cx, () => this.unlink(mod))));
    }
    const factsLine = h_flex().gap(8).items_center()
      .when(facts.length > 0, (el) => el.child(div().min_w(0).text_size(11.5).text_color(t.dim).truncate().child(facts.join("  ·  "))))
      .when(candidates.length > 0, (el) => el.child(this.link(t, `mm-link-${mod.name}`, "Link to herdr.dev…", (cx) => this.askLink(mod, candidates, cx), t.dim)));
    return v_flex()
      .flex_none()
      .id(`mm-row-${mod.name}`)
      .px(10)
      .py(8)
      .gap(3)
      .rounded(8)
      .hover((s) => s.bg(t.hover))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(2)
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(div().text_size(13).font_medium().text_color(mod.enabled ? t.foreground : t.muted).truncate().child(mod.title))
                  .when(mod.title !== mod.name, (el) => el.child(div().text_size(11.5).text_color(t.dim).truncate().child(mod.name)))
                  .when(Boolean(mod.version), (el) => el.child(this.badge(t, `v${mod.version}`)))
                  .when(Boolean(update), (el) => el.child(this.badge(t, "update", t.accent)))
                  .when(mod.self, (el) => el.child(this.badge(t, "this screen")))
                  .when(!mod.enabled, (el) => el.child(this.badge(t, "off", t.blocked))),
              )
              .when(Boolean(mod.description), (el) => el.child(div().text_size(12).text_color(t.dim).truncate().child(mod.description)))
              .when(facts.length > 0 || candidates.length > 0, (el) => el.child(factsLine))
              .when(Boolean(source), (el) => el.child(origin)),
          )
          .when(!mod.shipped && !mod.self && !this.busy[mod.name], (el) => el.child(this.iconButton(t, `mm-del-${mod.name}`, "trash", "Delete", (cx) => this.askDelete(mod, cx), 24)))
          .child(this.switch(t, mod)),
      )
      .when(Boolean(error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(error)));
  }

  /** One listing in Browse; click to expand its preview and actions. */
  entryRow(t, e) {
    const key = entryKey(e);
    const open = this.expanded === key;
    const installed = installedFrom(e, this.sources);
    const folders = Object.values(installed);
    const update = this.updates.find((u) => folders.includes(u.name));
    const looseName = !folders.length && e.modNames.some((n) => this.takenNames().has(n));
    const busy = this.busy[key] || (update && this.busy[update.name]);
    const error = this.errors[key] ?? (update && this.errors[update.name]);
    const preview = this.previews[key];

    let action;
    if (busy) action = h_flex().w(60).justify_center().child(this.spinner(t));
    else if (update) action = this.button(t, `mm-up-${key}`, "Update", (cx) => this.prepareUpdate(update, cx), true);
    else if (folders.length) action = this.badge(t, "installed");
    else action = this.button(t, `mm-in-${key}`, "Install", (cx) => this.prepareInstall(e, cx), true);

    return v_flex()
      .flex_none()
      .id(`mm-entry-${key}`)
      .px(10)
      .py(8)
      .gap(4)
      .rounded(8)
      .cursor_pointer()
      .when(open, (el) => el.bg(t.hover))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.expanded = open ? null : key;
        if (!open) this.loadPreview(e, cx);
        cx.notify();
      })
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(2)
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(div().text_size(13).font_medium().truncate().child(e.name))
                  .child(div().text_size(11.5).text_color(t.dim).truncate().child(e.owner))
                  .when(e.stars > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`★ ${e.stars}`)))
                  .when(e.modNames.length > 1, (el) => el.child(this.badge(t, `${e.modNames.length} mods`)))
                  .when(looseName, (el) => el.child(this.badge(t, "name taken"))),
              )
              .when(Boolean(e.blurb), (el) =>
                el.child(open ? div().text_size(12).line_height("17px").text_color(t.muted).whitespace_normal().child(e.blurb) : div().text_size(12).text_color(t.dim).truncate().child(e.blurb)),
              ),
          )
          .child(this.iconButton(t, `mm-gh-${key}`, "external-link", "Open on GitHub", () => this.openUrl(entryUrl(e))))
          .child(action),
      )
      .when(open, (el) =>
        el
          .child(
            preview && preview !== "loading" && preview !== "failed"
              ? h_flex()
                  .id(`mm-pic-${key}`)
                  .w_full()
                  .h(220)
                  .justify_center()
                  .items_center()
                  .rounded(6)
                  .overflow_hidden()
                  .bg(t.background)
                  .cursor_pointer()
                  .tooltip("Show full size")
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.lightbox = preview;
                    cx.notify();
                  })
                  .child(image(preview).max_w_full().max_h_full())
              : div().text_size(11.5).text_color(t.dim).child(preview === "failed" ? "No preview." : e.previewUrl ? "Loading preview…" : "No preview."),
          )
          .child(
            h_flex()
              .gap(10)
              .items_center()
              .child(div().flex_1().text_size(11.5).text_color(t.dim).truncate().child(`mods: ${e.modNames.join(", ")}${e.hasKeys ? " · brings keys" : ""}${e.pushedAt ? ` · pushed ${e.pushedAt.slice(0, 10)}` : ""}`)),
          ),
      )
      .when(Boolean(error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(error)));
  }

  section(t, label) {
    return div().flex_none().px(10).pt(12).pb(4).text_size(11.5).font_medium().text_color(t.dim).child(label);
  }

  installedList(t) {
    const mods = this.mods ?? [];
    const yours = mods.filter((m) => !m.shipped && this.matches(m));
    const herdrs = mods.filter((m) => m.shipped && this.matches(m));
    const off = mods.filter((m) => !m.enabled).length;
    const list = [];
    if (this.mods === null) {
      list.push(div().px(10).py(8).text_size(12.5).text_color(t.dim).child(this.scanError ?? "Reading mods…"));
      return list;
    }
    list.push(this.section(t, `Your mods · ${yours.length}${off ? ` · ${off} off` : ""}`));
    if (!yours.length) list.push(div().px(10).py(6).text_size(12.5).text_color(t.dim).child(this.query ? "No mod matches." : "No mods of your own yet."));
    list.push(...yours.map((m) => this.row(t, m)));
    list.push(
      h_flex()
        .flex_none()
        .id("mm-shipped")
        .px(10)
        .pt(14)
        .pb(4)
        .gap(4)
        .items_center()
        .cursor_pointer()
        .text_size(11.5)
        .font_medium()
        .text_color(t.dim)
        .hover((s) => s.text_color(t.muted))
        .on_click((_e, cx) => { this.showShipped = !this.showShipped; cx.notify(); })
        .child(svg(I(this.showShipped ? "chevron-down" : "chevron-right")).size(12))
        .child(`Herdr's mods · ${herdrs.length} · always on`),
    );
    if (this.showShipped) list.push(...herdrs.map((m) => this.row(t, m)));
    return list;
  }

  browseList(t) {
    const list = [];
    if (!this.index) {
      list.push(div().px(10).py(8).text_size(12.5).text_color(this.fetchError ? t.blocked : t.dim).child(this.fetchError ?? "Loading herdr.dev/mods…"));
      return list;
    }
    const by = this.sort === "new" ? (a, b) => b.pushedAt.localeCompare(a.pushedAt) : (a, b) => b.stars - a.stars || b.pushedAt.localeCompare(a.pushedAt);
    const found = this.entries.filter((e) => this.matchesEntry(e)).sort(by);
    if (!found.length) list.push(div().px(10).py(6).text_size(12.5).text_color(t.dim).child("No mod matches."));
    list.push(...found.slice(0, this.shown).map((e) => this.entryRow(t, e)));
    if (found.length > this.shown) {
      list.push(
        div()
          .flex_none()
          .id("mm-more")
          .px(10)
          .py(8)
          .cursor_pointer()
          .text_size(12)
          .text_color(t.accent)
          .hover((s) => s.opacity(0.8))
          .on_click((_e, cx) => { this.shown += PAGE; cx.notify(); })
          .child(`Show more · ${found.length - this.shown} left`),
      );
    }
    return list;
  }

  /** The question being asked, pinned above the list. */
  promptCard(t) {
    const p = this.prompt;
    return v_flex()
      .flex_none()
      .mt(10)
      .p(12)
      .gap(6)
      .rounded(8)
      .border_1()
      .border_color(t.accent)
      .bg(t.background)
      .child(div().text_size(13).font_semibold().child(p.title))
      .when(Boolean(p.subtitle), (el) => el.child(div().text_size(11.5).text_color(t.dim).whitespace_normal().child(p.subtitle)))
      .when(p.notes.length > 0, (el) => el.child(div().text_size(12).text_color(t.blocked).whitespace_normal().child(`Its code: ${p.notes.join(" · ")}. Mods run as you, unsandboxed.`)))
      .when(!p.notes.length && p.title.startsWith("Install"), (el) => el.child(div().text_size(12).text_color(t.dim).child("Its code reaches no network, programs or outside files.")))
      .children(p.lines.map((line) => div().text_size(12).text_color(t.muted).whitespace_normal().child(line)))
      .child(
        h_flex()
          .pt(4)
          .gap(6)
          .flex_wrap()
          .children(p.actions.map((a, i) => this.button(t, `mm-ask-${i}`, a.label, (cx) => this.answer(a, cx), Boolean(a.primary), Boolean(a.danger)))),
      );
  }

  tabButton(t, id, label, count) {
    const on = this.tab === id;
    return h_flex()
      .id(`mm-tab-${id}`)
      .flex_none()
      .px(10)
      .h(26)
      .gap(6)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .text_size(12.5)
      .font_medium()
      .bg(on ? t.raised : t.popover)
      .text_color(on ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.tab = id; this.shown = PAGE; cx.notify(); })
      .child(label)
      .when(count > 0, (el) => el.child(div().px(5).h(16).flex().items_center().rounded(8).bg(t.accent).text_size(10).text_color(t.accent_foreground).child(String(count))));
  }

  /** Browse's sort and refresh controls, with how fresh the index is. */
  browseBar(t) {
    const sortLink = (id, label) =>
      div()
        .id(`mm-sort-${id}`)
        .cursor_pointer()
        .text_size(11.5)
        .text_color(this.sort === id ? t.foreground : t.dim)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.sort = id; cx.notify(); })
        .child(label);
    const limited = Date.now() - (this.githubRefusedAt ?? 0) < GITHUB_BACKOFF_MS ? " · GitHub limit, checking later" : "";
    const status = this.fetching ? "Refreshing…" : this.fetchError && this.index ? `Offline: ${this.fetchError}` : `${this.entries.length} mods · ${ago(this.index?.fetchedAt)}${limited}`;
    return h_flex()
      .flex_none()
      .pt(8)
      .px(2)
      .gap(10)
      .items_center()
      .child(sortLink("stars", "Most stars"))
      .child(sortLink("new", "Recently pushed"))
      .child(div().flex_1())
      .child(div().text_size(11.5).text_color(this.fetchError && !this.fetching ? t.blocked : t.dim).truncate().child(status))
      .child(
        div()
          .id("mm-refresh")
          .w(22)
          .h(22)
          .rounded(6)
          .flex()
          .items_center()
          .justify_center()
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => cx.spawn(async (cx) => this.refreshIndex(cx)))
          .child(this.fetching ? this.spinner(t) : svg(I("refresh")).size(12).text_color(t.muted)),
      );
  }

  render() {
    const t = theme();
    const layout = shared("layout");
    const browsing = this.tab === "browse";
    const intro = browsing
      ? "Mods people share on herdr.dev. Installing asks first and shows what the code reaches; mods run as you."
      : `Turn mods on and off. Off mods wait in ${DISABLED_DIR}/ and leave your layouts${layout ? ` (now: ${layout})` : ""}, which fall back to Herdr's own pieces until you turn them back on.`;

    return v_flex()
      .id("mod-manager")
      .relative()
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .min_h(0)
      .p(18)
      .gap(0)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(
        h_flex()
          .flex_none()
          .gap(8)
          .items_center()
          .child(svg(I("puzzle")).size(16).text_color(t.muted))
          .child(div().text_size(15).font_semibold().child("Mods"))
          .child(h_flex().flex_1().pl(8).gap(2).child(this.tabButton(t, "installed", "Installed", this.updates.length)).child(this.tabButton(t, "browse", "Browse", 0)))
          .child(div().text_size(11).text_color(t.dim).child("Esc"))
          .child(
            div()
              .id("mm-close")
              .w(22)
              .h(22)
              .rounded(6)
              .flex()
              .items_center()
              .justify_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click(() => this.close())
              .child(svg(I("x")).size(12).text_color(t.muted)),
          ),
      )
      .child(div().flex_none().pt(6).text_size(12.5).line_height("18px").text_color(t.muted).child(intro))
      .child(
        h_flex()
          .flex_none()
          .pt(12)
          .child(
            Input.new(this.input)
              .flex_1()
              .h(32)
              .px(10)
              .gap(6)
              .items_center()
              .rounded(8)
              .border_1()
              .border_color(this.inputFocused ? t.accent : t.input)
              .bg(t.background)
              .text_size(13)
              .text_color(t.foreground),
          ),
      )
      .when(browsing, (el) => el.child(this.browseBar(t)))
      .when(Boolean(this.prompt), (el) => el.child(this.promptCard(t)))
      .child(
        v_flex()
          .id(browsing ? "mm-browse" : "mm-list")
          .flex_1()
          .min_h(0)
          .pt(4)
          .overflow_y_scroll()
          .children(browsing ? this.browseList(t) : this.installedList(t)),
      )
      .child(
        div()
          .flex_none()
          .pt(10)
          .text_size(11.5)
          .text_color(t.dim)
          .child(browsing ? `Updates are checked when this opens, on refresh, and once a day.` : "A repo's ./sync.sh copies its mods back into mods/ and turns them on again."),
      )
      .when(Boolean(this.lightbox), (el) => el.child(this.lightboxView(t)));
  }

  /** The preview at full size over the whole screen; a click or Esc closes it. */
  lightboxView(t) {
    return v_flex()
      .id("mm-lightbox")
      .absolute()
      .inset_0()
      .p(12)
      .gap(8)
      .bg(t.popover)
      .cursor_pointer()
      .on_click((_e, cx) => {
        this.lightbox = null;
        cx.notify();
      })
      .child(
        h_flex()
          .flex_none()
          .items_center()
          .child(div().flex_1().text_size(11.5).text_color(t.dim).child("Click or Esc to close"))
          .child(svg(I("x")).size(12).text_color(t.muted)),
      )
      .child(h_flex().flex_1().min_h(0).justify_center().items_center().child(image(this.lightbox).max_w_full().max_h_full()));
  }
}
