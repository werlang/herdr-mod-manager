import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isSafeName,
  parseIndex,
  entryKey,
  entryUrl,
  tarballUrl,
  isStale,
  sourceRecord,
  pendingUpdates,
  candidatesFor,
  installedFrom,
  freeName,
  renameInText,
  renameInKeys,
  mergeKeys,
  riskNotes,
  DAY_MS,
} from "../mods/mod-manager/catalog.js";

const C1 = "a".repeat(40);
const C2 = "b".repeat(40);
const listing = (over = {}) => ({
  owner: "ada",
  repo: "herdr-thing",
  fullName: "ada/herdr-thing",
  defaultBranch: "main",
  headCommit: C2,
  path: "",
  name: "Thing",
  blurb: "Does a thing",
  stars: 3,
  modNames: ["thing"],
  hasKeys: false,
  previewUrl: "https://assets.herdr.dev/previews/x.png",
  ...over,
});

describe("isSafeName", () => {
  it("accepts folder names and refuses paths", () => {
    assert.ok(isSafeName("git-graph"));
    assert.ok(isSafeName("over9k.todo"));
    for (const bad of ["", ".hidden", "a/b", "..", "a..b", "-x", null]) assert.equal(isSafeName(bad), false, String(bad));
  });
});

describe("parseIndex", () => {
  it("keeps valid entries and drops unsafe ones", () => {
    const parsed = parseIndex({
      generatedAt: "2026-11-06T19:00:00Z",
      mods: [
        listing(),
        listing({ path: "herdr/app/" }),
        listing({ modNames: ["../evil"] }),
        listing({ path: "../up" }),
        listing({ headCommit: "main" }),
        listing({ fullName: "a/b/c" }),
        listing({ previewUrl: "https://evil.example/x.png" }),
        null,
      ],
    });
    assert.equal(parsed.generatedAt, "2026-11-06T19:00:00Z");
    assert.equal(parsed.mods.length, 3);
    assert.equal(parsed.mods[1].path, "herdr/app");
    assert.equal(parsed.mods[2].previewUrl, "");
  });
  it("is null for something that isn't an index", () => {
    assert.equal(parseIndex(null), null);
    assert.equal(parseIndex({ mods: "x" }), null);
  });
});

describe("urls and keys", () => {
  it("builds them from the listing", () => {
    const e = listing({ fullName: "Ada/Herdr-Thing", path: "herdr/thing" });
    assert.equal(entryKey(e), "ada/herdr-thing/herdr/thing");
    assert.equal(entryUrl(e), "https://github.com/Ada/Herdr-Thing/tree/main/herdr/thing");
    assert.equal(entryUrl(listing()), "https://github.com/ada/herdr-thing/tree/main");
    assert.equal(tarballUrl(e), `https://codeload.github.com/Ada/Herdr-Thing/tar.gz/${C2}`);
  });
});

describe("isStale", () => {
  it("refreshes after a day or when never fetched", () => {
    assert.equal(isStale(null, 1000), true);
    assert.equal(isStale(1000, 1000 + DAY_MS - 1), false);
    assert.equal(isStale(1000, 1000 + DAY_MS), true);
  });
});

describe("pendingUpdates", () => {
  const entries = [listing()];
  it("lists installed mods whose listing moved on", () => {
    const sources = {
      thing: sourceRecord(listing(), "thing", C1),
      same: sourceRecord(listing(), "thing", C2),
      linked: sourceRecord(listing(), "thing", null),
      gone: { key: "ada/other/", modName: "x", commit: C1 },
      renamed: { ...sourceRecord(listing(), "nope", C1) },
    };
    assert.deepEqual(pendingUpdates(sources, entries).map((u) => u.name), ["linked", "thing"]);
  });
});

describe("candidatesFor and installedFrom", () => {
  it("matches by folder name, most stars first", () => {
    const a = listing({ fullName: "a/x", stars: 1, modNames: ["git-graph"] });
    const b = listing({ fullName: "b/x", stars: 9, modNames: ["git-graph", "other"] });
    assert.deepEqual(candidatesFor("git-graph", [a, b, listing()]).map((e) => e.fullName), ["b/x", "a/x"]);
  });
  it("maps a listing's mod names to installed folders", () => {
    const sources = { "thing-2": sourceRecord(listing(), "thing", C1), mine: { key: "z", modName: "thing" } };
    assert.deepEqual(installedFrom(listing(), sources), { thing: "thing-2" });
  });
});

describe("freeName", () => {
  it("adds a number when taken", () => {
    assert.equal(freeName("x", new Set()), "x");
    assert.equal(freeName("x", new Set(["x", "x-2"])), "x-3");
  });
});

describe("renameInText", () => {
  it("rewrites own asset paths and self-opening overlays only", () => {
    const src = [
      'svg("mods/thing/icon.svg")',
      'image(`mods/thing/${n}.png`)',
      'svg("mods/thing-extra/a.svg")',
      'svg("mods/other-thing/a.svg")',
      'run("mod.open", { name: "thing" })',
      'keys "mod.open:thing" "mod.open:thingy"',
    ].join("\n");
    const out = renameInText(src, "thing", "thing-2");
    assert.match(out, /"mods\/thing-2\/icon\.svg"/);
    assert.match(out, /`mods\/thing-2\/\$\{n\}\.png`/);
    assert.match(out, /mods\/thing-extra\/a\.svg/);
    assert.match(out, /mods\/other-thing\/a\.svg/);
    assert.match(out, /name: "thing-2"/);
    assert.match(out, /mod\.open:thing-2"/);
    assert.match(out, /mod\.open:thingy"/);
  });
});

describe("renameInKeys and mergeKeys", () => {
  it("points commands at the new name", () => {
    const keys = { app: { "cmd-k": "thing.toggle", "cmd-j": "mod.open:thing", "cmd-l": "thingy.go" } };
    assert.deepEqual(renameInKeys(keys, "thing", "t2"), { app: { "cmd-k": "t2.toggle", "cmd-j": "mod.open:t2", "cmd-l": "thingy.go" } });
  });
  it("adds new keys and never replaces the person's", () => {
    const mine = { app: { "cmd-k": "palette" } };
    const { merged, added, conflicts } = mergeKeys(mine, { app: { "cmd-k": "thing.go", "cmd-j": "thing.open" }, terminal: { "ctrl-t": "thing.t" } });
    assert.deepEqual(merged, { app: { "cmd-k": "palette", "cmd-j": "thing.open" }, terminal: { "ctrl-t": "thing.t" } });
    assert.equal(added.length, 2);
    assert.deepEqual(conflicts, [{ section: "app", key: "cmd-k", mine: "palette", theirs: "thing.go" }]);
    assert.deepEqual(mine, { app: { "cmd-k": "palette" } }, "input untouched");
  });
});

describe("riskNotes", () => {
  it("flags network, programs and outside files", () => {
    const text = 'await fetch("https://x"); await exec("git", []); fs.readFile(`${appHome()}/keys.json`)';
    assert.deepEqual(riskNotes(text, "thing"), ["Reaches the network", "Runs programs (exec / hc)", "Reads or writes files outside its own folder"]);
  });
  it("is quiet for a mod that only draws", () => {
    assert.deepEqual(riskNotes('svg("mods/thing/a.svg"); fs.readFile("mods/thing/data.json")', "thing"), []);
  });
});
