// Pure logic for the Mods screen: which mods a layout uses, how to take one
// out of a layout without breaking it, and how to put it back.
//
// Kept free of `herdr` imports so it can be tested with plain Node.

/** This mod's own folder name; it can never be disabled from itself. */
export const SELF = "mod-manager";

/** Folder (under the app home) where disabled mods are parked. */
export const DISABLED_DIR = "mods-disabled";

/** State file inside DISABLED_DIR recording what each disable changed. */
export const STATE_FILE = ".mod-manager.json";

/**
 * Names Herdr ships (and rewrites on every start), from `installed.json`.
 * @param {Record<string, unknown>} installed parsed installed.json
 * @returns {{ mods: Set<string>, layouts: Set<string> }}
 */
export function shippedFrom(installed) {
  const mods = new Set();
  const layouts = new Set();
  for (const key of Object.keys(installed ?? {})) {
    if (key.startsWith("layout:")) layouts.add(key.slice("layout:".length));
    else mods.add(key);
  }
  return { mods, layouts };
}

/**
 * Whether a folder name under mods-disabled/ is a parked mod (not a
 * hidden file and not a stale copy kept aside as `<name>.old-<time>`).
 * @param {string} name
 */
export function isParkedName(name) {
  return !name.startsWith(".") && !/\.old-\d+$/.test(name);
}

/**
 * Visits every object node of a layout tree, depth first, with its key path.
 * @param {unknown} node
 * @param {(obj: Record<string, any>, path: (string|number)[]) => void} fn
 * @param {(string|number)[]} [path]
 */
function walk(node, fn, path = []) {
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, fn, [...path, i]));
    return;
  }
  if (!node || typeof node !== "object") return;
  fn(node, path);
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === "object") walk(value, fn, [...path, key]);
  }
}

/**
 * Every place a layout uses a mod: block content, a stack header, the
 * root terminal menu.
 * @param {object} layout parsed layout JSON
 * @param {string} name mod folder name
 * @returns {{ kind: "block" | "header" | "terminal_menu", id: string | null, path: (string|number)[] }[]}
 */
export function referencesIn(layout, name) {
  const refs = [];
  walk(layout, (obj, path) => {
    if (obj.content && typeof obj.content === "object" && obj.content.mod === name) {
      refs.push({ kind: "block", id: obj.id ?? null, path });
    }
    if (obj.header === name) refs.push({ kind: "header", id: obj.id ?? null, path });
    if (path.length === 0 && obj.terminal_menu === name) refs.push({ kind: "terminal_menu", id: obj.id ?? null, path });
  });
  return refs;
}

/**
 * All mod names a layout uses.
 * @param {object} layout
 * @returns {Set<string>}
 */
export function modsUsedBy(layout) {
  const used = new Set();
  walk(layout, (obj, path) => {
    if (obj.content && typeof obj.content === "object" && typeof obj.content.mod === "string") used.add(obj.content.mod);
    if (typeof obj.header === "string" && obj.header !== "tabs") used.add(obj.header);
    if (path.length === 0 && typeof obj.terminal_menu === "string") used.add(obj.terminal_menu);
  });
  return used;
}

/**
 * The mod a disabled block falls back to: the one it was cloned from, else
 * a mod named like the block's id (block `files` -> mod `files`), if that
 * mod is installed and enabled. Null means: hide the block.
 * @param {string} name the mod being disabled
 * @param {{ cloned_from?: { name?: string } } | null} manifest its mod.json
 * @param {string | null} nodeId the block's id
 * @param {Set<string>} available installed, enabled mod names
 * @returns {string | null}
 */
export function fallbackFor(name, manifest, nodeId, available) {
  const cloned = manifest?.cloned_from?.name;
  if (cloned && cloned !== name && available.has(cloned)) return cloned;
  if (nodeId && nodeId !== name && available.has(nodeId)) return nodeId;
  return null;
}

/** Reads the value at a key path, or undefined. */
function at(root, path) {
  let cur = root;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Finds the node a recorded change applies to: by id when it has one (ids
 * survive other edits that shift array indexes), else by its path.
 */
function locate(layout, change) {
  if (change.id) {
    let found = null;
    walk(layout, (obj) => {
      if (!found && obj.id === change.id) found = obj;
    });
    if (found) return found;
  }
  const node = at(layout, change.path);
  return node && typeof node === "object" ? node : null;
}

/**
 * Takes a mod out of a layout, in place. Blocks switch to a fallback mod or
 * hide; a stack header goes back to the plain `tabs` strip; a terminal
 * menu goes back to Herdr's.
 * @param {object} layout parsed layout JSON (mutated)
 * @param {string} name mod being disabled
 * @param {(nodeId: string | null) => string | null} fallback
 * @returns {object[]} changes, to give back to restoreLayout
 */
export function disableInLayout(layout, name, fallback) {
  const changes = [];
  for (const ref of referencesIn(layout, name)) {
    const node = at(layout, ref.path);
    if (ref.kind === "terminal_menu") {
      delete node.terminal_menu;
      changes.push({ kind: ref.kind, id: ref.id, path: ref.path, before: name });
    } else if (ref.kind === "header") {
      node.header = "tabs";
      changes.push({ kind: ref.kind, id: ref.id, path: ref.path, before: name, after: "tabs" });
    } else {
      const to = fallback(ref.id);
      const isPaneHeader = ref.path[ref.path.length - 1] === "header";
      if (to) {
        node.content.mod = to;
        changes.push({ kind: "block", id: ref.id, path: ref.path, before: name, after: to });
      } else if (isPaneHeader) {
        // A pane frame's header ({ content: { mod }, height, ... }) can't be
        // hidden; drop it so panes draw bare, and keep it to put back.
        const parent = at(layout, ref.path.slice(0, -1));
        delete parent.header;
        changes.push({ kind: "drop", id: null, path: ref.path.slice(0, -1), before: name, value: node });
      } else {
        changes.push({ kind: "hide", id: ref.id, path: ref.path, before: name, hidden: node.hidden ?? null });
        node.hidden = true;
      }
    }
  }
  return changes;
}

/**
 * Puts a mod back where disableInLayout took it out, in place. A change the
 * person has since overridden (another mod in that block, the block shown
 * again by hand) is left as they made it.
 * @param {object} layout parsed layout JSON (mutated)
 * @param {object[]} changes from disableInLayout
 * @returns {number} how many changes were restored
 */
export function restoreLayout(layout, changes) {
  let restored = 0;
  for (const change of changes ?? []) {
    if (change.kind === "terminal_menu") {
      if (layout.terminal_menu == null) {
        layout.terminal_menu = change.before;
        restored++;
      }
      continue;
    }
    const node = locate(layout, change);
    if (!node) continue;
    if (change.kind === "drop") {
      if (node.header == null) {
        node.header = change.value;
        restored++;
      }
    } else if (change.kind === "header") {
      if (node.header === change.after) {
        node.header = change.before;
        restored++;
      }
    } else if (change.kind === "block") {
      if (node.content?.mod === change.after) {
        node.content.mod = change.before;
        restored++;
      }
    } else if (change.kind === "hide") {
      if (node.content?.mod === change.before && node.hidden === true) {
        if (change.hidden == null) delete node.hidden;
        else node.hidden = change.hidden;
        restored++;
      }
    }
  }
  return restored;
}

/**
 * Other mods whose code names this one (an overlay they open, an asset
 * path, a presence check), from their source text.
 * @param {string} name
 * @param {Record<string, string>} sources mod name -> concatenated .js text
 * @returns {string[]}
 */
export function usedByMods(name, sources) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(["'\`/])${escaped}(["'\`/.])`);
  return Object.entries(sources)
    .filter(([other, text]) => other !== name && pattern.test(text))
    .map(([other]) => other)
    .sort();
}

/**
 * Key bindings that run this mod's commands (`<name>.<command>`) or open it
 * (`mod.open:<name>`).
 * @param {string} name
 * @param {Record<string, Record<string, string>>} keys parsed keys.json
 * @returns {string[]} the bound keys
 */
export function keysFor(name, keys) {
  const bound = [];
  for (const scope of Object.values(keys ?? {})) {
    if (!scope || typeof scope !== "object") continue;
    for (const [key, command] of Object.entries(scope)) {
      if (typeof command !== "string") continue;
      if (command.startsWith(`${name}.`) || command === `mod.open:${name}`) bound.push(key);
    }
  }
  return bound;
}
