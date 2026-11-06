// Pure logic for the Browse tab and the updater: reading the herdr.dev mods
// index, matching installed mods to where they came from, and the edits an
// install makes (a free folder name, renamed asset paths, merged keys).
//
// Kept free of `herdr` imports so it can be tested with plain Node.

/** The index herdr.dev/mods is built from (refreshed there every ~30 min). */
export const INDEX_URL = "https://assets.herdr.dev/mods/index.json";

/** File inside DISABLED_DIR recording where each installed mod came from. */
export const SOURCES_FILE = ".mod-manager-sources.json";

/** File inside DISABLED_DIR with the last update check, read by usage-status. */
export const UPDATES_FILE = ".mod-manager-updates.json";

/** Hidden folder inside DISABLED_DIR for downloads and preview images. */
export const CACHE_DIR = ".mod-manager-cache";

/** How old the cached index may get before it is fetched again on its own. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A folder name safe to join into a path: no separators, no `..`, not hidden.
 * @param {unknown} name
 */
export function isSafeName(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..");
}

/** A repo-relative path safe to join: empty, or safe names separated by `/`. */
function isSafePath(path) {
  return path === "" || path.split("/").every(isSafeName);
}

/**
 * The valid entries of a parsed index.json; malformed ones are dropped so one
 * bad listing can't break the screen or reach the filesystem.
 * @param {any} json
 * @returns {{ generatedAt: string | null, mods: object[] } | null} null when it isn't an index at all
 */
export function parseIndex(json) {
  if (!json || typeof json !== "object" || !Array.isArray(json.mods)) return null;
  const strings = ["owner", "repo", "fullName", "defaultBranch", "headCommit", "name"];
  const mods = json.mods.filter(
    (e) =>
      e &&
      strings.every((k) => typeof e[k] === "string" && e[k]) &&
      typeof e.path === "string" &&
      isSafePath(e.path.replace(/\/+$/, "")) &&
      /^[0-9a-f]{40}$/.test(e.headCommit) &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(e.fullName) &&
      Array.isArray(e.modNames) &&
      e.modNames.length > 0 &&
      e.modNames.every(isSafeName),
  ).map((e) => ({
    ...e,
    path: e.path.replace(/\/+$/, ""),
    blurb: typeof e.blurb === "string" ? e.blurb : "",
    stars: Number(e.stars) || 0,
    pushedAt: typeof e.pushedAt === "string" ? e.pushedAt : "",
    hasKeys: e.hasKeys === true,
    previewUrl: typeof e.previewUrl === "string" && e.previewUrl.startsWith("https://assets.herdr.dev/previews/") ? e.previewUrl : "",
  }));
  return { generatedAt: typeof json.generatedAt === "string" ? json.generatedAt : null, mods };
}

/**
 * Identity of a listing: repo plus folder, case-insensitive like GitHub.
 * @param {{ fullName: string, path: string }} e
 */
export function entryKey(e) {
  return `${e.fullName}/${e.path}`.toLowerCase();
}

/** The listing's folder on GitHub. */
export function entryUrl(e) {
  return `https://github.com/${e.fullName}/tree/${e.defaultBranch}${e.path ? `/${e.path}` : ""}`;
}

/** The repo at the listed commit, as a .tar.gz. */
export function tarballUrl(e) {
  return `https://codeload.github.com/${e.fullName}/tar.gz/${e.headCommit}`;
}

/**
 * Whether a cached index fetched at `fetchedAt` (ms) should be refreshed.
 * @param {number | null | undefined} fetchedAt
 * @param {number} now
 */
export function isStale(fetchedAt, now, maxAge = DAY_MS) {
  return !Number.isFinite(fetchedAt) || now - fetchedAt >= maxAge;
}

/**
 * What a source record for an installed folder looks like.
 * @param {object} entry the index listing
 * @param {string} modName folder name inside the listing
 * @param {string | null} commit the commit installed, or null when unknown (linked by hand)
 */
export function sourceRecord(entry, modName, commit) {
  return {
    key: entryKey(entry),
    fullName: entry.fullName,
    path: entry.path,
    modName,
    commit,
    at: new Date().toISOString(),
  };
}

/**
 * Installed mods whose listing has a newer commit than the one installed.
 * @param {Record<string, { key: string, modName: string, commit: string | null }>} sources folder -> record
 * @param {object[]} entries parsed index entries
 * @returns {{ name: string, entry: object, source: object }[]}
 */
export function pendingUpdates(sources, entries) {
  const byKey = new Map(entries.map((e) => [entryKey(e), e]));
  const out = [];
  for (const [name, source] of Object.entries(sources ?? {})) {
    const entry = byKey.get(source?.key);
    if (!entry || !entry.modNames.includes(source.modName)) continue;
    if (entry.headCommit !== source.commit) out.push({ name, entry, source });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Listings that might be where an untracked installed mod came from: same
 * folder name. Only a hint: different authors reuse names, so linking is
 * always the person's call.
 * @param {string} name installed folder name
 * @param {object[]} entries
 * @returns {object[]} most-starred first
 */
export function candidatesFor(name, entries) {
  return entries.filter((e) => e.modNames.includes(name)).sort((a, b) => b.stars - a.stars);
}

/**
 * Folder names already installed from a listing, given the source records.
 * @returns {Record<string, string>} modName in the listing -> installed folder
 */
export function installedFrom(entry, sources) {
  const key = entryKey(entry);
  const out = {};
  for (const [folder, s] of Object.entries(sources ?? {})) if (s?.key === key) out[s.modName] = folder;
  return out;
}

/**
 * `name`, or `name-2`, `name-3`, ... whichever isn't taken.
 * @param {string} name
 * @param {Set<string>} taken
 */
export function freeName(name, taken) {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name}-${i}`)) return `${name}-${i}`;
}

/** Escapes text for use inside a RegExp. */
function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A mod's source with its own name changed, the way Herdr's mod.clone does:
 * its `mods/<name>/` asset paths and the overlays it opens on itself.
 * @param {string} text file contents
 * @param {string} from old folder name
 * @param {string} to new folder name
 */
export function renameInText(text, from, to) {
  if (from === to) return text;
  const f = escape(from);
  return text
    .replace(new RegExp(`(^|[^A-Za-z0-9_-])mods/${f}/`, "g"), `$1mods/${to}/`)
    .replace(new RegExp(`mod\\.open:${f}(?![A-Za-z0-9_-])`, "g"), `mod.open:${to}`)
    .replace(new RegExp(`(["'\`]mod\\.open["'\`]\\s*,\\s*\\{\\s*name\\s*:\\s*)(["'\`])${f}\\2`, "g"), `$1$2${to}$2`);
}

/**
 * A keys.json section map with a mod's commands pointed at its new name.
 * @param {Record<string, Record<string, string>>} keys
 */
export function renameInKeys(keys, from, to) {
  if (from === to) return keys;
  const out = {};
  for (const [section, scope] of Object.entries(keys ?? {})) {
    if (!scope || typeof scope !== "object") {
      out[section] = scope;
      continue;
    }
    out[section] = {};
    for (const [key, command] of Object.entries(scope)) {
      let c = command;
      if (typeof c === "string") {
        if (c === `mod.open:${from}`) c = `mod.open:${to}`;
        else if (c.startsWith(`${from}.`)) c = `${to}.${c.slice(from.length + 1)}`;
      }
      out[section][key] = c;
    }
  }
  return out;
}

/**
 * Adds a mod's keys to the person's, never replacing one they already use.
 * @param {Record<string, any>} mine parsed home keys.json
 * @param {Record<string, any>} theirs the mod's keys.json
 * @returns {{ merged: Record<string, any>, added: string[], conflicts: { section: string, key: string, mine: string, theirs: string }[] }}
 */
export function mergeKeys(mine, theirs) {
  const merged = JSON.parse(JSON.stringify(mine ?? {}));
  const added = [];
  const conflicts = [];
  for (const [section, scope] of Object.entries(theirs ?? {})) {
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) continue;
    const into = (merged[section] ??= {});
    if (typeof into !== "object" || Array.isArray(into)) continue;
    for (const [key, command] of Object.entries(scope)) {
      if (typeof command !== "string") continue;
      if (!(key in into)) {
        into[key] = command;
        added.push(`${key} → ${command}`);
      } else if (into[key] !== command) {
        conflicts.push({ section, key, mine: String(into[key]), theirs: command });
      }
    }
  }
  return { merged, added, conflicts };
}

/**
 * What a mod's code reaches beyond drawing itself, found by reading it:
 * shown before installing, as Herdr's AGENTS.md asks.
 * @param {string} text concatenated .js sources
 * @param {string} name the mod's folder name
 * @returns {string[]} plain-language notes
 */
export function riskNotes(text, name) {
  const notes = [];
  if (/\bfetch\s*\(|WebSocket|["'`]websocket["'`]|\bcurl\b|\bwget\b/.test(text)) notes.push("Reaches the network");
  if (/\bexec\s*\(|\bhc\s*\(|from\s+["'](child_process|process)["']/.test(text)) notes.push("Runs programs (exec / hc)");
  const own = new RegExp(`mods/${escape(name)}/`);
  const fileCalls = text.match(/\bfs\.(readFile|writeFile|readdir|rm|rmdir|unlink|rename|mkdir|appendFile)\s*\([^)]*/g) ?? [];
  if (fileCalls.some((call) => !own.test(call)) || /\b(appHome|home)\s*\(\s*\)/.test(text)) notes.push("Reads or writes files outside its own folder");
  return notes;
}
