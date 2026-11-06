import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shippedFrom,
  isParkedName,
  referencesIn,
  modsUsedBy,
  fallbackFor,
  disableInLayout,
  restoreLayout,
  usedByMods,
  keysFor,
} from "../mods/mod-manager/manager.js";

const layout = () => ({
  id: "root",
  type: "row",
  terminal_menu: "ref-menu",
  children: [
    { id: "spaces", type: "block", content: { mod: "spaces-plus" } },
    { id: "files", type: "block", content: { mod: "file-editor" } },
    { id: "board", type: "block", content: { mod: "board" }, hidden: false },
    { id: "deck", type: "stack", header: "my-tabs", children: [] },
    {
      id: "main",
      type: "block",
      content: { tab: "active", pane: { gap: 6, header: { content: { mod: "my-pane" }, height: 30 } } },
    },
  ],
});
const available = new Set(["spaces", "files", "tabs", "menu"]);

describe("shippedFrom", () => {
  it("splits mods and layouts", () => {
    const s = shippedFrom({ tabs: {}, "layout:main": {} });
    assert.deepEqual([...s.mods], ["tabs"]);
    assert.deepEqual([...s.layouts], ["main"]);
  });
});

describe("isParkedName", () => {
  it("skips hidden and stale copies", () => {
    assert.equal(isParkedName("tabs-ref"), true);
    assert.equal(isParkedName(".mod-manager.json"), false);
    assert.equal(isParkedName("tabs-ref.old-1730000000000"), false);
  });
});

describe("references", () => {
  it("finds blocks, stack headers, pane headers and the terminal menu", () => {
    const used = modsUsedBy(layout());
    for (const m of ["ref-menu", "spaces-plus", "file-editor", "board", "my-tabs", "my-pane"]) assert.ok(used.has(m), m);
    assert.equal(referencesIn(layout(), "ref-menu")[0].kind, "terminal_menu");
  });
});

describe("fallbackFor", () => {
  it("prefers cloned_from, then the block id, else null", () => {
    assert.equal(fallbackFor("spaces-plus", { cloned_from: { name: "spaces" } }, "x", available), "spaces");
    assert.equal(fallbackFor("file-editor", {}, "files", available), "files");
    assert.equal(fallbackFor("board", {}, "board", available), null);
  });
});

describe("disable and restore", () => {
  for (const [name, check] of [
    ["spaces-plus", (l) => assert.equal(l.children[0].content.mod, "spaces")],
    ["file-editor", (l) => assert.equal(l.children[1].content.mod, "files")],
    ["board", (l) => assert.equal(l.children[2].hidden, true)],
    ["my-tabs", (l) => assert.equal(l.children[3].header, "tabs")],
    ["my-pane", (l) => assert.equal(l.children[4].content.pane.header, undefined)],
    ["ref-menu", (l) => assert.equal(l.terminal_menu, undefined)],
  ]) {
    it(`round-trips ${name}`, () => {
      const l = layout();
      const changes = disableInLayout(l, name, (id) => fallbackFor(name, name === "spaces-plus" ? { cloned_from: { name: "spaces" } } : {}, id, available));
      assert.equal(changes.length, 1);
      check(l);
      // A hidden block keeps its content (it never starts while hidden).
      if (name !== "board") assert.equal(referencesIn(l, name).length, 0);
      const back = JSON.parse(JSON.stringify(l));
      assert.equal(restoreLayout(back, changes), 1);
      assert.deepEqual(back, layout());
    });
  }

  it("finds moved nodes by id", () => {
    const l = layout();
    const changes = disableInLayout(l, "file-editor", (id) => fallbackFor("file-editor", {}, id, available));
    l.children.reverse();
    assert.equal(restoreLayout(l, changes), 1);
    assert.equal(l.children.find((c) => c.id === "files").content.mod, "file-editor");
  });

  it("leaves a block the person changed meanwhile", () => {
    const l = layout();
    const changes = disableInLayout(l, "file-editor", (id) => fallbackFor("file-editor", {}, id, available));
    l.children[1].content.mod = "something-else";
    assert.equal(restoreLayout(l, changes), 0);
    assert.equal(l.children[1].content.mod, "something-else");
  });
});

describe("usedByMods", () => {
  it("matches quoted names and asset paths, not substrings", () => {
    const src = { a: 'openOverlay({ mod: "space-menu" })', b: "mods/space-menu/x.svg", c: '"space-menu-plus"', "space-menu": '"space-menu"' };
    assert.deepEqual(usedByMods("space-menu", src), ["a", "b"]);
  });
});

describe("keysFor", () => {
  it("lists keys running the mod's commands or opening it", () => {
    const keys = { global: { "cmd-w": "tabs-ref.closeTab", "cmd-,": "app.settings", "cmd-shift-,": "mod.open:tabs-ref" } };
    assert.deepEqual(keysFor("tabs-ref", keys), ["cmd-w", "cmd-shift-,"]);
  });
});

describe("werlang layout", () => {
  it("can take every personal mod out and back", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = `${process.env.HOME}/.config/herdr-app/layouts/werlang.json`;
    let original;
    try { original = JSON.parse(await readFile(path, "utf8")); } catch { return; }
    const avail = new Set(["spaces", "agents", "tabs", "files", "changes", "workspace-status", "menu", "workspace-chrome"]);
    const clones = { "spaces-plus": "spaces", "agents-plus": "agents", "tabs-ref": "tabs", "usage-status": "workspace-status", "ref-menu": "menu" };
    for (const name of modsUsedBy(original)) {
      if (avail.has(name)) continue;
      const l = JSON.parse(JSON.stringify(original));
      const changes = disableInLayout(l, name, (id) => fallbackFor(name, { cloned_from: { name: clones[name] } }, id, avail));
      assert.equal(referencesIn(l, name).length, 0, name);
      restoreLayout(l, changes);
      assert.deepEqual(l, original, name);
    }
  });
});
