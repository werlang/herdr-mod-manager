// Mods: a settings screen that turns installed mods on and off.
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

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { appHome, exec, theme, props, closeOverlay, notify, shared } from "herdr";
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

const I = (name) => `mods/${SELF}/${name}.svg`;

/** Parsed JSON at a path, or null when missing or invalid. */
async function readJson(path) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
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

/** Moves a folder; rejects with the command's error text. */
async function move(from, to) {
  const r = await exec("mv", [from, to]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `mv exited ${r.code}`).trim());
}

export default class ModManager extends View {
  init(_props, cx) {
    this.home = appHome();
    this.mods = null; // entries, once scanned
    this.busy = {}; // name -> true while toggling
    this.errors = {}; // name -> last error text
    this.showShipped = false;
    this.query = "";
    this.input = InputState.new({ placeholder: "Filter mods" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      cx.notify();
    });
    this.inputFocused = false;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.rescan(cx);
  }

  get modsDir() { return `${this.home}/mods`; }
  get parkDir() { return `${this.home}/${DISABLED_DIR}`; }
  get layoutsDir() { return `${this.home}/layouts`; }
  get statePath() { return `${this.parkDir}/${STATE_FILE}`; }

  rescan(cx) {
    cx.spawn(async (cx) => {
      try {
        await this.scan();
      } catch (e) {
        this.scanError = String(e?.message ?? e);
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
    this.mods = all;
    this.scanError = null;
  }

  async writeState() {
    await fs.mkdir(this.parkDir, { recursive: true });
    await fs.writeFile(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  async writeLayout(name, json) {
    await fs.writeFile(`${this.layoutsDir}/${name}.json`, `${JSON.stringify(json, null, 2)}\n`);
  }

  /** A folder already sitting at `path` is kept aside as `<path>.old-<time>`. */
  async setAside(path) {
    if (await fs.exists(path)) await move(path, `${path}.old-${Date.now()}`);
  }

  /** Takes the mod out of personal layouts, then parks its folder. */
  async disable(mod) {
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
    notify({ title: `${mod.title} disabled`, body: n ? `Taken out of ${Object.keys(changed).join(", ")}.` : "Its folder is parked in mods-disabled.", level: "info", timeout: 3500 });
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

  toggle(mod, cx) {
    if (mod.shipped || mod.self || this.busy[mod.name]) return;
    this.busy[mod.name] = true;
    delete this.errors[mod.name];
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (mod.enabled) await this.disable(mod);
        else await this.enable(mod);
      } catch (e) {
        this.errors[mod.name] = String(e?.message ?? e);
      }
      delete this.busy[mod.name];
      await this.scan().catch(() => null);
      cx.notify();
    });
  }

  close() {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  key(e, cx) {
    if (e.key === "escape") {
      this.close();
      cx.stop_propagation();
    }
  }

  matches(mod) {
    const q = this.query.trim().toLowerCase();
    if (!q) return true;
    return [mod.name, mod.title, mod.description].some((s) => String(s).toLowerCase().includes(q));
  }

  // ---- UI -----------------------------------------------------------------

  /** The on/off switch: a pill with a knob, drawn from divs. */
  switch(t, mod) {
    const on = mod.enabled;
    const locked = mod.shipped || mod.self;
    const busy = Boolean(this.busy[mod.name]);
    if (busy) {
      return h_flex().w(34).justify_center().child(svg(I("spinner")).size(14).text_color(t.working).spin(900));
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

  row(t, mod) {
    const facts = [];
    if (mod.layouts.length) facts.push(`Layout: ${mod.layouts.join(", ")}`);
    if (mod.usedBy.length) facts.push(`Used by ${mod.usedBy.join(", ")}`);
    if (mod.keys.length) facts.push(`Keys: ${mod.keys.join(", ")}`);
    const error = this.errors[mod.name];
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
                  .when(mod.self, (el) => el.child(this.badge(t, "this screen")))
                  .when(!mod.enabled, (el) => el.child(this.badge(t, "off", t.blocked))),
              )
              .when(Boolean(mod.description), (el) => el.child(div().text_size(12).text_color(t.dim).truncate().child(mod.description)))
              .when(facts.length > 0, (el) => el.child(div().text_size(11.5).text_color(t.dim).truncate().child(facts.join("  ·  ")))),
          )
          .child(this.switch(t, mod)),
      )
      .when(Boolean(error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(error)));
  }

  section(t, label) {
    return div().flex_none().px(10).pt(12).pb(4).text_size(11.5).font_medium().text_color(t.dim).child(label);
  }

  render() {
    const t = theme();
    const mods = this.mods ?? [];
    const yours = mods.filter((m) => !m.shipped && this.matches(m));
    const herdrs = mods.filter((m) => m.shipped && this.matches(m));
    const off = mods.filter((m) => !m.enabled).length;
    const layout = shared("layout");

    const list = [];
    if (this.mods === null) {
      list.push(div().px(10).py(8).text_size(12.5).text_color(t.dim).child(this.scanError ?? "Reading mods…"));
    } else {
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
    }

    return v_flex()
      .id("mod-manager")
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
          .child(div().flex_1().text_size(15).font_semibold().child("Mods"))
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
      .child(
        div()
          .flex_none()
          .pt(6)
          .text_size(12.5)
          .line_height("18px")
          .text_color(t.muted)
          .child(`Turn mods on and off. Off mods wait in ${DISABLED_DIR}/ and leave your layouts${layout ? ` (now: ${layout})` : ""}, which fall back to Herdr's own pieces until you turn them back on.`),
      )
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
      .child(
        v_flex()
          .id("mm-list")
          .flex_1()
          .min_h(0)
          .pt(4)
          .overflow_y_scroll()
          .children(list),
      )
      .child(
        div()
          .flex_none()
          .pt(10)
          .text_size(11.5)
          .text_color(t.dim)
          .child("A repo's ./sync.sh copies its mods back into mods/ and turns them on again."),
      );
  }
}
