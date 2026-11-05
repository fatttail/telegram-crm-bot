"use strict";
// TG: your Telegram, from Obsidian. Plain CommonJS, no build step.
// The Telegram work is done by bridge/tg_gtm.py (Telethon, your own account) on your computer;
// this view spawns it and streams its output. Summaries come from the Claude Code CLI (`claude -p`).
// Everything you pick, write or get back lives in this plugin's data.json.
//
// Layout: a sidebar of PAGES grouped in sections. To add a feature, add one entry to PAGES and a
// matching render<Name>(el) method on TGView. Shared building blocks (people picker, group picker,
// result card, confirm dialog) live in the "components" part of the view.

const { Plugin, ItemView, Notice, Modal, PluginSettingTab, Setting, normalizePath, setIcon, addIcon, MarkdownRenderer } = require("obsidian");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ================================================================== config
const VIEW_TYPE = "tg-gtm-view";
const SCRIPT = "tg_gtm.py";
const LOCAL_CLAUDE = path.join(os.homedir(), ".local", "bin", "claude.exe");
const DEFAULTS = {
  botDir: "", python: "python", noteDir: "TG", page: "dashboard",
  follow: {}, summaries: {}, claude: fs.existsSync(LOCAL_CLAUDE) ? LOCAL_CLAUDE : "claude", claudeModel: "", historyLimit: 400,
  created: [],                                                          // groups made from New group
  // Scan: which chats the bot works with. Group titles containing a keyword, minus `off`, plus `add`.
  scan: { keywords: [], off: [], add: [], dms: false },
  // chats, categories, messaging
  categories: [], chatCat: {}, chatMeta: {},                            // partnership types, chat id → category id, titles
  message: "", msgCat: null, msgOff: {}, delivered: {}, catLog: {},     // draft, target, unticked per cat, text hash → {chat: time}
  leavePick: [], leaveFilter: "all", left: {},                          // groups ticked to leave, chat id → time left
};
const ROW_LIMIT = 500;

// Category = the kind of relationship a chat is (Fund, VC, Exchange…), not where it came from.
const COLORS = { blue: "#2a8bd6", teal: "#13a3a3", green: "#2fa84f", yellow: "#d9a90b", orange: "#e8840c", red: "#e0453a", pink: "#e0529c", purple: "#8a5cf5", gray: "#8a8a8f" };
const PRESETS = [
  ["Fund", "green", "Capital allocators, hedge funds, treasuries"], ["VC", "purple", "Venture funds and angels"],
  ["Market maker", "teal", "MMs and OTC desks"], ["Exchange", "blue", "CEXs and DEXs"], ["Protocol", "orange", "DeFi protocols and integrations"],
  ["Infra", "gray", "Oracles, wallets, custody, RPC"], ["KOL / Media", "pink", "Influencers, podcasts, media"], ["Service provider", "yellow", "Audits, legal, agencies"],
];

// Turn the scan keywords into one matcher. Short keywords like "ai" only match as a whole word.
function keywordMatcher(words) {
  const parts = words.map((w) => w.trim().toLowerCase()).filter(Boolean)
    .map((w) => "(?<![a-z0-9])" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*") + "(?![a-z0-9])");
  if (!parts.length) return () => false;
  const re = new RegExp(parts.join("|"), "i");
  return (title) => re.test(title || "");
}

// Sidebar. section → pages, in order. badge(view) is the small count on the right.
const PAGES = [
  { id: "dashboard", section: "Workspace", label: "Dashboard", icon: "layout-dashboard", render: "renderDashboard",
    desc: "Your Telegram GTM at a glance: what you sent, who is waiting on you, and how each category is doing.",
    badge: (v) => (v.dash ? v.dashStats().waiting.length || "" : "") },
  { id: "follow", section: "Workspace", label: "Follow up", icon: "zap", render: "renderFollow",
    desc: "Groups you flagged with ⚡. Click one and Claude sums up the chat and what to follow up on.",
    badge: (v) => Object.keys(v.s.follow).length || "" },
  { id: "chats", section: "Workspace", label: "Chats", icon: "messages-square", render: "renderChatsPage",
    desc: "Browse and sort your chats into categories, or send one message to a whole category.",
    badge: (v) => (v.chats ? fmt(v.chatBase().length) : "") },
  { id: "contacts", section: "Workspace", label: "Contacts", icon: "users", render: "renderContacts",
    desc: "Everyone in the groups you scan, plus your Telegram address book, saved to a table.",
    badge: (v) => (v.contacts ? fmt(v.contacts.length) : "") },
  { id: "leave", section: "Workspace", label: "Leave groups", icon: "log-out", render: "renderLeave",
    desc: "Tick the groups you want to leave. Groups you created, ⚡ groups and DMs always stay.",
    badge: (v) => v.s.leavePick.length || "" },
  { id: "scan", section: "Set up", label: "Scan", icon: "scan-search", render: "renderScan",
    desc: "Choose which chats the bot works with: by words in the group title, then tick or untick single groups.",
    badge: (v) => (v.chats ? v.scope().length : "") },
  { id: "categories", section: "Set up", label: "Categories", icon: "tags", render: "renderCategories",
    desc: "The kinds of partnership your chats are, in one table. Message a whole category in one go.",
    badge: (v) => v.s.categories.length || "" },
  { id: "create", section: "Set up", label: "New group", icon: "plus-circle", render: "renderGroupsSetup",
    desc: "Create a private group you own, or add people to a group you're already in." },
];

// Short stable key for a message text, so a resend of the same text skips chats that already got it.
function hashText(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

function relDate(iso) {
  if (!iso) return "";
  const d = new Date(iso), days = Math.floor((Date.now() - d) / 864e5);
  if (days < 1 && d.getDate() === new Date().getDate()) return d.toTimeString().slice(0, 5);
  if (days < 7) return d.toLocaleDateString("en-GB", { weekday: "short" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "2-digit" });
}

const relAgo = (iso) => { const m = Math.round((Date.now() - new Date(iso)) / 6e4); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const fmtMin = (m) => (m < 60 ? `${Math.round(m)} min` : m < 1440 ? `${(m / 60).toFixed(m < 600 ? 1 : 0)} h` : `${(m / 1440).toFixed(1)} days`);

// What Claude is asked for each follow-up group; the transcript goes in on stdin.
const FOLLOW_PROMPT = (title) => `Below is the recent Telegram history of the chat "${title}". I run partnerships / go-to-market on Telegram; my own messages are marked "me". I want to know where things stand with the people in this chat and what to follow up on.

Reply in Markdown with exactly these sections, short and factual, using only what is in the chat:

## Summary
3 to 5 bullets: who the other side is, what was discussed, where things stand. Include dates.

## Open threads
Anything unanswered, promised or pending: who owes what, since when. Write "Nothing pending" if so.

## Follow up
1 to 3 concrete next actions for me, each naming who to contact (with @username when the chat shows one).

## Draft message
A short, friendly message I could send now (2 to 4 sentences, no subject line).

If the chat is empty or too thin to judge, say so in one line instead.`;

// Telegram mark (24×24): the round badge, and the paper plane on its own for the coloured logo
const TG_ICON = "tgx-telegram";
const TG_PLANE = "M16.906 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z";
const TG_BADGE = `<path fill="currentColor" fill-rule="evenodd" transform="scale(4.1667)" d="M12 0a12 12 0 1 0 0 24a12 12 0 1 0 0-24z${TG_PLANE}"/>`;
const TG_LOGO = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="tgx-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2AABEE"/><stop offset="1" stop-color="#229ED9"/></linearGradient></defs><circle cx="12" cy="12" r="12" fill="url(#tgx-g)"/><path fill="#fff" d="${TG_PLANE}"/></svg>`;

// ================================================================== helpers
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return head ? body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""]))) : [];
}

const fmt = (n) => Number(n).toLocaleString("en-US");
const now = () => new Date().toISOString().slice(0, 16).replace("T", " ");
const personName = (c) => `${c.first_name} ${c.last_name}`.trim() || c.username || `id ${c.user_id}`;

// round initial with a hue picked from the name, like Telegram's placeholder avatars
function avatar(parent, name, cls = "") {
  const clean = (name || "?").replace(/[^\p{L}\p{N}]/gu, "");
  let h = 0; for (const ch of name || "") h = (h * 31 + ch.charCodeAt(0)) % 360;
  const a = parent.createSpan({ cls: "tgx-ava " + cls, text: (clean[0] || "?").toUpperCase() });
  a.style.setProperty("--h", String(h));
  return a;
}

function iconBtn(parent, icon, text, cls = "") {
  const b = parent.createEl("button", { cls: "tgx-btn " + cls });
  setIcon(b.createSpan({ cls: "tgx-btn-ic" }), icon);
  if (text) b.createSpan({ text });
  return b;
}

function field(parent, label, hint) {
  const f = parent.createDiv({ cls: "tgx-field" });
  const l = f.createEl("label", { text: label });
  if (hint) l.createSpan({ cls: "tgx-dim", text: " · " + hint });
  return f;
}

// Plain yes / no: what will happen, the affected items, Cancel or go. Red unless danger: false.
class ConfirmModal extends Modal {
  constructor(app, { title, body, items, icon, cta, danger = true, onOk }) { super(app); Object.assign(this, { title, body, items, icon, cta, danger, onOk }); }
  onOpen() {
    this.modalEl.addClass("tgx-modal-wrap");
    const c = this.contentEl; c.addClass("tgx", "tgx-modal");
    const head = c.createDiv({ cls: "tgx-modal-head" });
    setIcon(head.createDiv({ cls: "tgx-modal-ic" + (this.danger ? "" : " safe") }), this.icon || "alert-triangle");
    head.createEl("h3", { text: this.title });
    for (const line of this.body) c.createEl("p", { text: line });
    if (this.items && this.items.length) {
      const list = c.createDiv({ cls: "tgx-modal-list" });
      for (const t of this.items.slice(0, 60)) list.createDiv({ text: t });
      if (this.items.length > 60) list.createDiv({ cls: "tgx-dim", text: `+ ${this.items.length - 60} more` });
    }
    const row = c.createDiv({ cls: "tgx-row tgx-end" });
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const ok = row.createEl("button", { text: this.cta, cls: this.danger ? "mod-warning" : "mod-cta" });
    ok.onclick = () => { this.close(); this.onOk(); };
    setTimeout(() => cancel.focus(), 30);                  // Enter cancels; going ahead takes a click
  }
  onClose() { this.contentEl.empty(); }
}

// ================================================================== view
class TGView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf); this.plugin = plugin;
    this.chats = null; this.members = {}; this.contacts = null; this.exportedAt = "";
    this.search = { chats: "", contacts: "", scan: "" }; this.chatFilter = "all"; this.chatSel = new Set();
    this.chatsView = "scan"; this.scanView = "in";
    this.dash = undefined; this.dashFilter = "unread"; this.dashRange = 30; this.dashMuted = false;
    this.convo = {}; this.convoLoading = null; this.convSel = null; this.convDraw = null; this.catOpen = null; this.sending = null;
    this.proc = null; this.progress = null; this.log = []; this.logOpen = false;
    this.fuSel = null; this.ai = null; this.aiStage = ""; this.aiProc = null;
    this.form = { title: "", about: "" }; this.pick = { create: [], invite: [] }; this.inviteTo = null;
    this.results = { create: null, invite: null };
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "TG"; }
  getIcon() { return TG_ICON; }

  get s() { return this.plugin.settings; }
  get exportDir() { return path.join(this.s.botDir, "exports"); }
  get page() { return PAGES.find((p) => p.id === this.s.page) || PAGES[0]; }
  go(id) { this.s.page = id; this.plugin.saveSettings(); this.render(); }
  isFollow(id) { return !!this.s.follow[String(id)]; }

  async onOpen() {
    this.root = this.contentEl.createDiv({ cls: "tgx" });
    this.contentEl.addClass("tgx-host");
    this.loadExport();
    this.render();
    if (!this.chats && this.s.botDir) this.loadChats();
  }
  async onClose() { if (this.proc) this.proc.kill(); if (this.aiProc) this.aiProc.kill(); }

  // ---------------------------------------------------------------- python bridge
  run(args, { quiet = false } = {}) {
    return new Promise((resolve) => {
      if (this.proc) { new Notice("Something is already running."); return resolve({ code: -1, out: "" }); }
      const script = path.join(this.s.botDir, SCRIPT);
      if (!fs.existsSync(script)) { new Notice(this.s.botDir ? `${SCRIPT} not found in ${this.s.botDir}` : "Set the bridge folder in TG settings first."); return resolve({ code: -1, out: "" }); }
      let out = "";
      const p = spawn(this.s.python, ["-u", SCRIPT, ...args], {
        cwd: this.s.botDir, windowsHide: true, env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" }),
      });
      this.proc = p; this.progress = null; p.stdin.end();   // no stdin: a login prompt fails fast instead of hanging
      if (!quiet) { this.logOpen = true; this.pushLog(`$ python ${SCRIPT} ${args.join(" ")}`); }
      const onData = (buf) => {
        const t = buf.toString("utf8"); out += t;
        if (!quiet) for (const line of t.split(/\r?\n/)) if (line.trim()) this.onLine(line);
      };
      p.stdout.on("data", onData); p.stderr.on("data", onData);
      p.on("error", (e) => { this.pushLog(`✗ ${e.message}`); });
      p.on("close", (code) => {
        this.proc = null;
        if (code && /database is locked/.test(out)) this.pushLog("✗ the Telegram session is busy: close any other program using it and try again.");
        if (code && /phone|EOF when reading/i.test(out)) this.pushLog("✗ Not logged in to Telegram: run `python tg_gtm.py login` once in a terminal (see the README).");
        this.pushLog(code ? `exit ${code}` : "done");
        const m = out.match(/^RESULT (.+)$/m);
        this.render(); resolve({ code, out, result: m ? JSON.parse(m[1]) : null });
      });
      this.render();
    });
  }

  onLine(line) {
    if (line.startsWith("RESULT ")) return;                                   // read by the caller
    const m = line.match(/✓ \[(\d+)\/(\d+)\] (-?\d+) (left )?/);
    if (m && (m[4] || this.sending)) {
      const bucket = m[4] ? this.s.left : (this.s.delivered[this.sending] = this.s.delivered[this.sending] || {});
      bucket[m[3]] = now();
      this.plugin.saveSettings();
    }
    const p = line.match(/[✓✗] \[(\d+)\/(\d+)\]/);
    if (p) { this.progress = { done: +p[1], total: +p[2] }; this.paintProgress(); }
    if (/^\s*-?\d{6,}\s+(group|supergroup|channel)\s/.test(line)) return;     // skip the long group listing
    this.pushLog(line);
  }

  pushLog(line) {
    this.log.push(line); if (this.log.length > 400) this.log.shift();
    if (this.logEl) { this.logEl.setText(this.log.join("\n")); this.logEl.scrollTop = this.logEl.scrollHeight; }
    if (this.logLast) this.logLast.setText(line);
  }

  paintProgress() {
    if (!this.progEl || !this.progress) return;
    const { done, total } = this.progress;
    this.progEl.parentElement.addClass("on");
    this.progEl.style.width = `${Math.round((done / total) * 100)}%`;
    if (this.statusText) this.statusText.setText(`running · ${done} / ${total}`);
  }

  async loadChats() {
    const { code, out } = await this.run(["chats"], { quiet: true });
    if (code) { this.pushLog(out.trim().split("\n").slice(-3).join("\n")); return this.render(); }
    try {
      this.chats = JSON.parse(out.trim().split("\n").pop());
    } catch (e) { this.pushLog("✗ could not read the chat list"); }
    this.render();
  }

  loadExport() {
    const gf = path.join(this.exportDir, "groups.csv"), cf = path.join(this.exportDir, "contacts.csv");
    if (fs.existsSync(gf)) for (const r of parseCsv(fs.readFileSync(gf, "utf8"))) this.members[r.group_id] = r;
    if (fs.existsSync(cf)) {
      this.contacts = parseCsv(fs.readFileSync(cf, "utf8"));
      this.exportedAt = (this.contacts[0] || {}).exported_at || fs.statSync(cf).mtime.toISOString().slice(0, 16).replace("T", " ");
    }
  }

  writeJson(name, data) {
    fs.mkdirSync(this.exportDir, { recursive: true });
    const f = path.join(this.exportDir, name);
    fs.writeFileSync(f, JSON.stringify(data));
    return f;
  }
  writeIds(name, groups) { return this.writeJson(name, groups.map((g) => g.id)); }

  // ---------------------------------------------------------------- claude bridge
  // `claude -p` with no tools: reads the prompt + transcript and prints Markdown. Uses your Claude Code login.
  askClaude(prompt, input) {
    return new Promise((resolve, reject) => {
      const args = ["-p", prompt, "--tools", "", "--no-session-persistence", "--output-format", "text"];
      if (this.s.claudeModel) args.push("--model", this.s.claudeModel);
      fs.mkdirSync(this.exportDir, { recursive: true });
      const p = spawn(this.s.claude, args, { cwd: this.exportDir, windowsHide: true });
      this.aiProc = p;
      let out = "", err = "";
      const timer = setTimeout(() => { p.kill(); reject(new Error("Claude took longer than 4 minutes")); }, 240000);
      p.stdout.on("data", (b) => (out += b.toString("utf8")));
      p.stderr.on("data", (b) => (err += b.toString("utf8")));
      p.on("error", (e) => { clearTimeout(timer); this.aiProc = null; reject(e.code === "ENOENT" ? new Error(`Claude CLI not found at "${this.s.claude}": set it in the plugin settings`) : e); });
      p.on("close", (code) => {
        clearTimeout(timer); this.aiProc = null;
        code ? reject(new Error((err || out).trim().split("\n").slice(-2).join(" ") || `exit ${code}`)) : resolve(out);
      });
      p.stdin.end(input, "utf8");
    });
  }

  // ================================================================ shell
  render() {
    const r = this.root; if (!r) return;
    const keepScroll = this.bodyEl ? this.bodyEl.scrollTop : 0;
    r.empty();
    const page = this.page;

    // sidebar
    const side = r.createDiv({ cls: "tgx-side" });
    const brand = side.createDiv({ cls: "tgx-brand" });
    brand.createDiv({ cls: "tgx-logo" }).innerHTML = TG_LOGO;
    brand.createDiv({ cls: "tgx-brand-t", text: "TG" });
    let section = null;
    for (const p of PAGES) {
      if (p.section !== section) { section = p.section; side.createDiv({ cls: "tgx-nav-sec", text: section }); }
      const it = side.createEl("button", { cls: "tgx-nav" + (p.id === page.id ? " on" : "") + (p.id === "follow" ? " follow" : ""), attr: { "aria-label": p.label } });
      setIcon(it.createSpan({ cls: "tgx-nav-ic" }), p.icon);
      it.createSpan({ cls: "tgx-nav-l", text: p.label });
      const b = p.badge ? p.badge(this) : "";
      if (b !== "") it.createSpan({ cls: "tgx-nav-b", text: String(b) });
      it.onclick = () => this.go(p.id);
    }
    side.createDiv({ cls: "tgx-spacer" });
    const foot = side.createDiv({ cls: "tgx-side-foot" });
    const st = foot.createDiv({ cls: "tgx-status" + (this.proc || this.ai ? " on" : "") });
    st.createSpan({ cls: "tgx-dot" });
    this.statusText = st.createSpan({ cls: "tgx-status-t", text: this.ai ? "Claude is writing…" : this.proc ? (this.chats ? "running…" : "loading chats…") : "ready" });
    const gear = foot.createEl("button", { cls: "tgx-icon-btn", attr: { "aria-label": "Settings" } });
    setIcon(gear, "settings");
    gear.onclick = () => { this.app.setting.open(); this.app.setting.openTabById(this.plugin.manifest.id); };

    // main
    const main = r.createDiv({ cls: "tgx-main" });
    const head = main.createDiv({ cls: "tgx-head" });
    const ht = head.createDiv();
    ht.createDiv({ cls: "tgx-crumb", text: page.section });
    ht.createEl("h2", { text: page.label });
    ht.createEl("p", { cls: "tgx-sub", text: page.desc });
    const prog = main.createDiv({ cls: "tgx-progress" });
    this.progEl = prog.createDiv();
    if (this.proc && this.progress) this.paintProgress();

    this.bodyEl = main.createDiv({ cls: "tgx-body" });
    if (!this.s.botDir || !fs.existsSync(path.join(this.s.botDir, SCRIPT))) {
      this.emptyState(this.bodyEl, "plug", "Finish setting up TG",
        "Connect the Telegram bridge: install it, log in once, then set its folder in Settings → TG and click Run check. The README walks you through it.",
        { icon: "settings", text: "Open TG settings", onClick: () => { this.app.setting.open(); this.app.setting.openTabById(this.plugin.manifest.id); } });
    } else this[page.render](this.bodyEl);
    this.bodyEl.scrollTop = keepScroll;

    // log
    const lg = main.createDiv({ cls: "tgx-log" + (this.logOpen ? " open" : "") });
    const lh = lg.createDiv({ cls: "tgx-log-head" });
    const tog = lh.createEl("button", { cls: "tgx-log-toggle" });
    setIcon(tog.createSpan(), this.logOpen ? "chevron-down" : "chevron-right");
    tog.createSpan({ text: this.proc ? "Running" : "Log" });
    this.logLast = tog.createSpan({ cls: "tgx-dim tgx-log-last", text: this.logOpen ? "" : this.log[this.log.length - 1] || "" });
    tog.onclick = () => { this.logOpen = !this.logOpen; this.render(); };
    lh.createDiv({ cls: "tgx-spacer" });
    if (this.proc) iconBtn(lh, "square", "Stop", "mod-warning").onclick = () => { this.proc.kill(); this.pushLog("stopped"); };
    else if (this.log.length && this.logOpen) lh.createEl("button", { text: "Clear", cls: "tgx-link" }).onclick = () => { this.log = []; this.render(); };
    this.logEl = lg.createEl("pre", { text: this.log.join("\n") || "nothing yet" });
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  busy(btn) { if (this.proc) btn.disabled = true; return btn; }

  // ================================================================ components
  searchBox(parent, placeholder, value, onInput) {
    const w = parent.createDiv({ cls: "tgx-search" });
    setIcon(w.createSpan({ cls: "tgx-search-ic" }), "search");
    const q = w.createEl("input", { type: "text", attr: { placeholder }, value });
    q.oninput = () => onInput(q.value);
    return q;
  }

  emptyState(el, icon, title, text, action) {
    const e = el.createDiv({ cls: "tgx-empty-state" });
    setIcon(e.createDiv({ cls: "tgx-empty-ic" }), icon);
    e.createEl("strong", { text: title });
    if (text) e.createEl("p", { text });
    if (action) iconBtn(e, action.icon, action.text).onclick = action.onClick;
    return e;
  }

  // People picker: chips of picked people + a search over saved contacts. Typing @name adds anyone.
  // list holds {key, label, sub}; key is "@username" or a numeric user id, as tg_gtm.py expects.
  peoplePicker(el, list, onChange) {
    const box = el.createDiv({ cls: "tgx-picker" });
    const field = box.createDiv({ cls: "tgx-picker-field" });
    const drop = box.createDiv({ cls: "tgx-drop" });
    let input;
    const changed = () => { drawChips(); onChange && onChange(); };
    const add = (p) => { if (!list.some((x) => x.key === p.key)) list.push(p); input.value = ""; changed(); drawDrop(); input.focus(); };
    const drawChips = () => {
      field.querySelectorAll(".tgx-pchip").forEach((n) => n.remove());
      for (const p of list) {
        const c = createSpan({ cls: "tgx-pchip" });
        avatar(c, p.label, "xs"); c.createSpan({ text: p.label });
        const x = c.createEl("button", { cls: "tgx-pchip-x", attr: { "aria-label": "Remove" } }); setIcon(x, "x");
        x.onclick = () => { list.splice(list.indexOf(p), 1); changed(); };
        field.insertBefore(c, input);
      }
      input.placeholder = list.length ? "Add more…" : "Search a name or type @username";
    };
    const matches = (q) => {
      const s = q.toLowerCase().replace(/^@/, "");
      if (!s) return [];
      const out = [];
      for (const c of this.contacts || []) {
        if (c.is_bot === "1") continue;
        const key = c.username || c.user_id;
        if (list.some((x) => x.key === key)) continue;
        if ([personName(c), c.username].join(" ").toLowerCase().includes(s)) out.push({ key, label: personName(c), sub: c.username || "no username", c });
        if (out.length >= 8) break;
      }
      const raw = "@" + q.replace(/^@/, "").trim();
      if (/^@[A-Za-z0-9_]{4,}$/.test(raw) && !out.some((o) => o.key.toLowerCase() === raw.toLowerCase()))
        out.push({ key: raw, label: raw, sub: "add by username" });
      return out;
    };
    let hits = [];
    const drawDrop = () => {
      drop.empty(); hits = matches(input.value);
      drop.toggleClass("on", hits.length > 0);
      hits.forEach((h, i) => {
        const it = drop.createDiv({ cls: "tgx-drop-it" + (i === 0 ? " first" : "") });
        avatar(it, h.label, "sm");
        const t = it.createDiv(); t.createDiv({ cls: "tgx-title", text: h.label }); t.createDiv({ cls: "tgx-meta", text: h.sub + (h.c && h.c.in_my_contacts === "1" ? " · ★ in your contacts" : "") });
        it.onmousedown = (e) => { e.preventDefault(); add({ key: h.key, label: h.label, sub: h.sub }); };
      });
    };
    input = field.createEl("input", { type: "text", cls: "tgx-picker-in" });
    input.oninput = drawDrop;
    input.onfocus = drawDrop;
    input.onblur = () => setTimeout(() => drop.removeClass("on"), 120);
    input.onkeydown = (e) => {
      if (e.key === "Enter" && hits[0]) { e.preventDefault(); add({ key: hits[0].key, label: hits[0].label, sub: hits[0].sub }); }
      if (e.key === "Backspace" && !input.value && list.length) { list.pop(); changed(); }
    };
    field.onclick = () => input.focus();
    drawChips();
    if (!this.contacts) box.createDiv({ cls: "tgx-meta tgx-picker-note", text: "No saved contacts yet, so only @usernames work. Save them in Contacts to search by name." });
  }

  // Group picker: search over every chat you're in. filter(chat) narrows it (e.g. can_invite).
  groupPicker(el, { placeholder, filter, onPick }) {
    const box = el.createDiv({ cls: "tgx-picker" });
    const w = box.createDiv({ cls: "tgx-search" });
    setIcon(w.createSpan({ cls: "tgx-search-ic" }), "search");
    const input = w.createEl("input", { type: "text", attr: { placeholder: this.chats ? placeholder : "Loading your chats…" } });
    if (!this.chats) input.disabled = true;
    const drop = box.createDiv({ cls: "tgx-drop" });
    const draw = () => {
      drop.empty();
      const s = input.value.toLowerCase().trim();
      const hits = (this.chats || []).filter((c) => (!filter || filter(c)) && (!s || c.title.toLowerCase().includes(s))).slice(0, 12);
      drop.toggleClass("on", hits.length > 0);
      for (const c of hits) {
        const it = drop.createDiv({ cls: "tgx-drop-it" });
        avatar(it, c.title, "sm");
        const t = it.createDiv(); t.createDiv({ cls: "tgx-title", text: c.title });
        t.createDiv({ cls: "tgx-meta", text: [c.type, c.role === "creator" ? "you own it" : c.role, c.members ? `${fmt(c.members)} members` : ""].filter(Boolean).join(" · ") });
        it.onmousedown = (e) => { e.preventDefault(); input.value = ""; drop.removeClass("on"); onPick(c); };
      }
    };
    input.oninput = draw; input.onfocus = draw;
    input.onblur = () => setTimeout(() => drop.removeClass("on"), 120);
  }

  // What came back from create / invite: who got in, who didn't and why, and an invite link for the rest.
  resultCard(el, r, onClose) {
    const ok = r.failed.length === 0;
    const card = el.createDiv({ cls: "tgx-card tgx-result " + (ok ? "ok" : "partial") });
    const head = card.createDiv({ cls: "tgx-result-head" });
    setIcon(head.createDiv({ cls: "tgx-result-ic" }), ok ? "check" : "alert-circle");
    const t = head.createDiv({ cls: "tgx-grow" });
    t.createEl("strong", { text: r.created ? `Created “${r.title}”` : `“${r.title}”` });
    t.createDiv({ cls: "tgx-meta", text: `${r.added.length} added${r.failed.length ? ` · ${r.failed.length} couldn't be added` : ""}` });
    const x = head.createEl("button", { cls: "tgx-icon-btn", attr: { "aria-label": "Dismiss" } }); setIcon(x, "x"); x.onclick = onClose;
    if (r.added.length) card.createDiv({ cls: "tgx-result-list ok", text: "✓ " + r.added.join(" · ") });
    if (r.failed.length) {
      const fl = card.createDiv({ cls: "tgx-result-list" });
      for (const f of r.failed) { const row = fl.createDiv(); row.createSpan({ cls: "tgx-title", text: f.user }); row.createSpan({ cls: "tgx-dim", text: " · " + f.reason }); }
    }
    if (r.link) {
      const l = card.createDiv({ cls: "tgx-linkrow" });
      setIcon(l.createSpan({ cls: "tgx-btn-ic" }), "link");
      l.createEl("code", { text: r.link });
      l.createDiv({ cls: "tgx-spacer" });
      iconBtn(l, "copy", "Copy").onclick = () => { navigator.clipboard.writeText(r.link); new Notice("Invite link copied"); };
      iconBtn(l, "external-link", "Open").onclick = () => window.open(r.link);
      if (r.failed.length) card.createDiv({ cls: "tgx-meta", text: "Send this link to the people who couldn't be added: they can join with one tap." });
    }
  }

  // ================================================================ pages · Workspace
  // ---------------------------------------------------------------- dashboard
  // Data comes from `tg_gtm.py dashboard` (exports/dashboard.json): every chat's unread state and last
  // message, and for chats active in the window, when you sent messages and how fast you replied in DMs.
  loadDashFile() {
    const f = path.join(this.exportDir, "dashboard.json");
    if (!fs.existsSync(f)) return null;
    try { this.dash = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { this.dash = null; }
    this._dstats = null;
    return this.dash;
  }

  async loadDashboard() {
    const { code } = await this.run(["dashboard", "--days", "62"]);
    if (code) return new Notice("Couldn't load your messages: see the log.");
    this.loadDashFile(); this.render();
  }

  dashStats() {
    if (this._dstats && this._dstats.src === this.dash && this._dstats.cats === JSON.stringify(this.s.chatCat)) return this._dstats;
    const D = this.dash, now = new Date(), day = 864e5;
    const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const wk = new Date(sod - ((sod.getDay() + 6) % 7) * day);                       // Monday
    const mo = new Date(now.getFullYear(), now.getMonth(), 1);
    const pmo = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const windowStart = new Date(new Date(D.loaded) - D.days * day);
    const catOf = (r) => this.s.chatCat[String(r.id)] || "";
    const sent = [];
    for (const r of D.chats) for (const t of r.sent) sent.push({ t: new Date(t), r });
    const count = (a, b, f) => sent.filter((x) => x.t >= a && x.t < b && (!f || f(x.r))).length;
    const since = (n) => new Date(now - n * day);
    const lastDate = (r) => (r.last ? new Date(r.last.date) : null);
    const waitingOf = (r) => r.last && !r.last.out && r.type !== "channel" && !r.muted && (r.type === "dm" || catOf(r)) && new Date(r.last.date) >= since(30);   // they wrote last, within a month
    const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const ret = {
      src: this.dash, cats: JSON.stringify(this.s.chatCat), now, windowStart,
      today: count(sod, now), yesterday: count(new Date(sod - day), sod),
      week: count(wk, now), lastWeek: count(new Date(wk - 7 * day), new Date(now - 7 * day)),
      month: count(mo, now), lastMonth: pmo >= windowStart ? count(pmo, new Date(pmo.getTime() + (now - mo))) : null,
      d30: count(since(30), now), activeDays30: new Set(sent.filter((x) => x.t >= since(30)).map((x) => x.t.toDateString())).size,
      bundles: Object.values(this.s.delivered).reduce((n, m) => n + Object.values(m).filter((t) => new Date(t.replace(" ", "T") + "Z") >= mo).length, 0),
      unread: D.chats.filter((r) => r.unread && !r.muted), mutedUnread: D.chats.filter((r) => r.unread && r.muted),
      mentions: D.chats.reduce((n, r) => n + (r.mentions || 0), 0),
      waiting: D.chats.filter(waitingOf).sort((a, b) => lastDate(a) - lastDate(b)),
      replyMed: median(D.chats.flatMap((r) => r.reply_min)),
      active7: D.chats.filter((r) => r.sent.some((t) => new Date(t) >= since(7))).length,
      cold: D.chats.filter((r) => catOf(r) && (!lastDate(r) || lastDate(r) < since(30))).sort((a, b) => (lastDate(a) || 0) - (lastDate(b) || 0)),
      series: (n) => Array.from({ length: n }, (_, i) => {
        const a = new Date(sod - (n - 1 - i) * day), b = new Date(a.getTime() + day);
        return { a, dm: count(a, b, (r) => r.type === "dm"), group: count(a, b, (r) => r.type !== "dm") };
      }),
      catOf, waitingOf, lastDate, median, count, since,
    };
    ret.perCat = [...this.cats.map((c) => c.id), ""].map((id) => {
      const rows = D.chats.filter((r) => catOf(r) === id);
      const touched = rows.filter((r) => r.sent.some((t) => new Date(t) >= since(30)));
      const last = rows.map(lastDate).filter(Boolean).sort((a, b) => b - a)[0];
      return { id, cat: this.cat(id), rows, n: rows.length, active: rows.filter((r) => lastDate(r) && lastDate(r) >= since(30)).length,
        coverage: rows.length ? touched.length / rows.length : 0, sent30: count(since(30), now, (r) => catOf(r) === id),
        waiting: rows.filter(waitingOf).length, unread: rows.filter((r) => r.unread && !r.muted).reduce((n, r) => n + r.unread, 0),
        reply: median(rows.flatMap((r) => r.reply_min)), last };
    });
    return (this._dstats = ret);
  }

  renderDashboard(el) {
    if (this.dash === undefined) this.loadDashFile();
    const bar = el.createDiv({ cls: "tgx-toolbar" });
    this.busy(iconBtn(bar, "refresh-cw", this.dash ? "Refresh" : "Load my messages", "mod-cta")).onclick = () => this.loadDashboard();
    if (this.dash) bar.createSpan({ cls: "tgx-meta", text: `Updated ${relAgo(this.dash.loaded)} · ${fmt(this.dash.chats.length)} chats · your messages from the last ${this.dash.days} days` });
    if (!this.dash) {
      this.emptyState(el, "layout-dashboard", "Load your messages to see the dashboard",
        "Reads your chat list, unread notifications and the messages you sent in the last 2 months. Read-only, takes under a minute.");
      return;
    }
    const S = this.dashStats();

    // KPIs
    const kpis = el.createDiv({ cls: "tgx-kpis" });
    const kpi = (icon, label, value, sub, tone = "", onClick) => {
      const k = kpis.createDiv({ cls: "tgx-card tgx-kpi " + tone + (onClick ? " tgx-click" : "") });
      const h = k.createDiv({ cls: "tgx-kpi-h" }); setIcon(h.createSpan({ cls: "tgx-kpi-ic" }), icon); h.createSpan({ text: label });
      k.createDiv({ cls: "tgx-kpi-v", text: value });
      if (sub) { const s = k.createDiv({ cls: "tgx-kpi-s" }); if (typeof sub === "string") s.setText(sub); else sub(s); }
      if (onClick) k.onclick = onClick;
    };
    const delta = (cur, prev, label) => (s) => {
      if (prev == null) return s.setText(label + ": no data yet");
      const d = cur - prev;
      s.createSpan({ cls: "tgx-delta " + (d > 0 ? "up" : d < 0 ? "down" : ""), text: d === 0 ? "=" : (d > 0 ? "▲ " : "▼ ") + Math.abs(d) });
      s.createSpan({ text: ` vs ${label} (${prev})` });
    };
    kpi("send", "Sent today", fmt(S.today), delta(S.today, S.yesterday, "yesterday"));
    kpi("calendar-days", "This week", fmt(S.week), delta(S.week, S.lastWeek, "same time last week"));
    kpi("calendar", "This month", fmt(S.month), delta(S.month, S.lastMonth, "same time last month"));
    kpi("activity", "Daily average", S.activeDays30 ? (S.d30 / 30).toFixed(1) : "0", `${S.activeDays30} of the last 30 days active${S.bundles ? ` · ${S.bundles} sent by bundles this month` : ""}`);
    kpi("bell", "Unread", fmt(S.unread.reduce((n, r) => n + r.unread, 0)), `in ${S.unread.length} chats${S.mentions ? ` · ${S.mentions} @mentions` : ""}${S.mutedUnread.length ? ` · ${S.mutedUnread.length} muted hidden` : ""}`, S.unread.length ? "acc" : "", () => { this.dashFilter = "unread"; this.render(); });
    const oldest = S.waiting[0] ? Math.floor((S.now - S.lastDate(S.waiting[0])) / 864e5) : 0;
    kpi("hourglass", "Waiting on you", fmt(S.waiting.length), S.waiting.length ? `they wrote last · oldest ${oldest} day${oldest === 1 ? "" : "s"} (last 30 days)` : "inbox zero", S.waiting.length > 5 ? "warn" : "", () => { this.dashFilter = "waiting"; this.render(); });
    kpi("timer", "Median reply time", S.replyMed == null ? "–" : fmtMin(S.replyMed), "in DMs, last 2 months");
    kpi("snowflake", "Going cold", fmt(S.cold.length), this.cats.length ? "categorised chats quiet for 30+ days" : "give chats a category to track this", S.cold.length ? "cold" : "");

    // chart + by category
    const row = el.createDiv({ cls: "tgx-dash-row" });
    const chart = row.createDiv({ cls: "tgx-card tgx-chart-card" });
    const ch = chart.createDiv({ cls: "tgx-row" });
    ch.createEl("h4", { text: "Messages you sent" });
    ch.createDiv({ cls: "tgx-spacer" });
    const lg = ch.createDiv({ cls: "tgx-legend" }); lg.createSpan({ cls: "dm", text: "DMs" }); lg.createSpan({ cls: "gr", text: "Groups" });
    const seg = ch.createDiv({ cls: "tgx-seg" });
    for (const n of [7, 30, 60]) { const b = seg.createEl("button", { cls: (this.dashRange || 30) === n ? "on" : "", text: `${n}d` }); b.onclick = () => { this.dashRange = n; this.render(); }; }
    const series = S.series(this.dashRange || 30);
    const max = Math.max(1, ...series.map((d) => d.dm + d.group));
    const bars = chart.createDiv({ cls: "tgx-bars" + (series.length > 40 ? " dense" : "") });
    series.forEach((d, i) => {
      const col = bars.createDiv({ cls: "tgx-bar", attr: { title: `${d.a.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}: ${d.dm + d.group} sent (${d.dm} DMs, ${d.group} groups)` } });
      if (d.a.getDay() === 1) col.addClass("mon");
      const stack = col.createDiv({ cls: "tgx-bar-stack" });
      stack.style.height = `${((d.dm + d.group) / max) * 100}%`;
      if (d.group) stack.createDiv({ cls: "gr" }).style.flex = String(d.group);
      if (d.dm) stack.createDiv({ cls: "dm" }).style.flex = String(d.dm);
      const showLabel = series.length <= 7 || d.a.getDay() === 1 || i === series.length - 1;
      col.createDiv({ cls: "tgx-bar-l", text: showLabel ? (series.length <= 7 ? d.a.toLocaleDateString("en-GB", { weekday: "short" }) : `${d.a.getDate()}/${d.a.getMonth() + 1}`) : "" });
    });
    chart.createDiv({ cls: "tgx-meta", text: `Peak ${max} on one day · ${series.reduce((n, d) => n + d.dm + d.group, 0)} in this range` });

    const byCat = row.createDiv({ cls: "tgx-card tgx-bycat" });
    byCat.createEl("h4", { text: "Sent by category · 30 days" });
    const cmax = Math.max(1, ...S.perCat.map((c) => c.sent30));
    for (const c of S.perCat.filter((c) => c.sent30 || c.cat).sort((a, b) => b.sent30 - a.sent30)) {
      const r = byCat.createDiv({ cls: "tgx-hbar" });
      const l = r.createDiv({ cls: "tgx-hbar-l" });
      if (c.cat) this.catDot(l, c.cat); l.createSpan({ text: c.cat ? c.cat.name : "No category" });
      const track = r.createDiv({ cls: "tgx-hbar-track" });
      const fill = track.createDiv({ cls: "tgx-hbar-fill" });
      fill.style.width = `${(c.sent30 / cmax) * 100}%`; fill.style.background = c.cat ? COLORS[c.cat.color] : "var(--text-faint)";
      r.createDiv({ cls: "tgx-hbar-v", text: String(c.sent30) });
    }

    this.renderInbox(el, S);
    this.renderCatHealth(el, S);
    if (S.cold.length) this.renderCold(el, S);
  }

  // notifications, grouped by category
  renderInbox(el, S) {
    const card = el.createDiv({ cls: "tgx-card tgx-inbox" });
    const head = card.createDiv({ cls: "tgx-row tgx-inbox-head" });
    head.createEl("h3", { text: "Notifications" });
    head.createDiv({ cls: "tgx-spacer" });
    const D = this.dash;
    const recent = D.chats.filter((r) => r.last && new Date(r.last.date) >= S.since(7));
    const sets = { unread: S.unread.concat(this.dashMuted ? S.mutedUnread : []), waiting: S.waiting, mentions: D.chats.filter((r) => r.mentions), recent };
    const f = this.dashFilter && sets[this.dashFilter] ? this.dashFilter : "unread";
    const seg = head.createDiv({ cls: "tgx-seg" });
    for (const [k, label] of [["unread", "Unread"], ["waiting", "Waiting on you"], ["mentions", "@ Mentions"], ["recent", "Active this week"]]) {
      const b = seg.createEl("button", { cls: f === k ? "on" : "" }); b.createSpan({ text: label }); b.createSpan({ cls: "tgx-seg-n", text: String(sets[k].length) });
      b.onclick = () => { this.dashFilter = k; this.render(); };
    }
    const mc = head.createEl("label", { cls: "tgx-check" });
    const mi = mc.createEl("input", { type: "checkbox" }); mi.checked = !!this.dashMuted; mc.createSpan({ text: "Muted" });
    mi.onchange = () => { this.dashMuted = mi.checked; this.render(); };

    const rows = sets[f];
    if (!rows.length) { this.emptyState(card, "check-circle", f === "unread" ? "No unread messages" : f === "waiting" ? "Nobody is waiting on you" : "Nothing here", ""); return; }
    const groups = [...this.cats.map((c) => c.id), ""].map((id) => ({ id, cat: this.cat(id), rows: rows.filter((r) => S.catOf(r) === id) })).filter((g) => g.rows.length);
    const t = card.createDiv({ cls: "tgx-table-wrap tgx-inbox-wrap" }).createEl("table", { cls: "tgx-table tgx-inbox-table" });
    const h = t.createEl("thead").createEl("tr");
    ["Chat", "Last message", "When", "Status", ""].forEach((x) => h.createEl("th", { text: x }));
    const b = t.createEl("tbody");
    this.dashCollapsed = this.dashCollapsed || new Set();
    for (const g of groups) {
      const closed = this.dashCollapsed.has(g.id);
      const gh = b.createEl("tr", { cls: "tgx-group-row" });
      const td = gh.createEl("td", { attr: { colspan: "5" } });
      const w = td.createDiv({ cls: "tgx-who" });
      setIcon(w.createSpan({ cls: "tgx-caret" }), closed ? "chevron-right" : "chevron-down");
      if (g.cat) this.catDot(w, g.cat).addClass("lg");
      w.createSpan({ cls: "tgx-title", text: g.cat ? g.cat.name : "No category" });
      w.createSpan({ cls: "tgx-meta", text: `${g.rows.length} chat${g.rows.length === 1 ? "" : "s"}` + (g.rows.some((r) => r.unread) ? ` · ${g.rows.reduce((n, r) => n + r.unread, 0)} unread` : "") });
      gh.onclick = () => { closed ? this.dashCollapsed.delete(g.id) : this.dashCollapsed.add(g.id); this.render(); };
      if (closed) continue;
      const sorted = f === "waiting" ? g.rows : [...g.rows].sort((a, b2) => (b2.mentions - a.mentions) || (b2.unread - a.unread) || (S.lastDate(b2) - S.lastDate(a)));
      for (const r of sorted) {
        const tr = b.createEl("tr");
        tr.onclick = () => new ConversationModal(this.app, this, r).open();
        const who = tr.createEl("td").createDiv({ cls: "tgx-who" });
        avatar(who, r.title, "sm");
        const wt = who.createDiv({ cls: "tgx-grow" });
        wt.createDiv({ cls: "tgx-title tgx-ellipsis", text: r.title });
        wt.createDiv({ cls: "tgx-meta", text: [r.type === "dm" ? "DM" : r.type, r.username ? "@" + r.username : "", r.muted ? "muted" : ""].filter(Boolean).join(" · ") });
        const lm = tr.createEl("td", { cls: "tgx-last" });
        if (r.last) { lm.createSpan({ cls: "tgx-last-from", text: (r.last.out ? "You" : r.type === "dm" ? "" : r.last.from) + (r.last.out || r.type !== "dm" ? ": " : "") }); lm.createSpan({ text: r.last.text || "…" }); }
        tr.createEl("td", { cls: "tgx-dim tgx-small tgx-nowrap", text: r.last ? relDate(r.last.date) : "" });
        const st = tr.createEl("td", { cls: "tgx-nowrap" });
        if (r.mentions) st.createSpan({ cls: "tgx-pill-s mention", text: `@${r.mentions}` });
        if (r.unread) st.createSpan({ cls: "tgx-pill-s unread", text: `${r.unread > 99 ? "99+" : r.unread} unread` });
        if (S.waitingOf(r)) {
          const dd = Math.floor((S.now - S.lastDate(r)) / 864e5);
          st.createSpan({ cls: "tgx-pill-s " + (dd >= 7 ? "late" : dd >= 2 ? "wait" : "fresh"), text: dd ? `waiting ${dd}d` : "waiting today" });
        } else if (r.last && r.last.out && !r.unread) st.createSpan({ cls: "tgx-pill-s done", text: "you replied" });
        const op = tr.createEl("td", { cls: "tgx-open-col" }).createEl("button", { cls: "tgx-icon-btn", attr: { "aria-label": "Open conversation" } });
        setIcon(op, "message-square");
      }
    }
  }

  // how each category is doing
  renderCatHealth(el, S) {
    const card = el.createDiv({ cls: "tgx-card tgx-health" });
    const hh = card.createDiv({ cls: "tgx-row" });
    hh.createEl("h3", { text: "Category health" });
    hh.createSpan({ cls: "tgx-meta", text: "Coverage = share of a category's chats you messaged in the last 30 days" });
    if (!this.cats.length) {
      card.createDiv({ cls: "tgx-empty", text: "No categories yet. Create Fund, VC, Exchange… in Set up → Categories to see how each one is doing." });
      return;
    }
    const t = card.createDiv({ cls: "tgx-table-wrap" }).createEl("table", { cls: "tgx-table" });
    const h = t.createEl("thead").createEl("tr");
    ["Category", "Chats", "Active 30d", "Coverage", "Sent 30d", "Waiting", "Unread", "Median reply", "Last activity"].forEach((x) => h.createEl("th", { text: x }));
    const b = t.createEl("tbody");
    for (const c of S.perCat) {
      if (!c.cat && !c.n) continue;
      const tr = b.createEl("tr");
      if (c.cat) tr.onclick = () => { this.s.msgCat = c.id; this.chatsMode = "send"; this.go("chats"); };
      const nm = tr.createEl("td").createDiv({ cls: "tgx-who" });
      if (c.cat) this.catDot(nm, c.cat).addClass("lg");
      nm.createSpan({ cls: "tgx-title", text: c.cat ? c.cat.name : "No category" });
      tr.createEl("td", { cls: "tgx-num-cell", text: fmt(c.n) });
      tr.createEl("td", { cls: "tgx-num-cell", text: fmt(c.active) });
      const cv = tr.createEl("td").createDiv({ cls: "tgx-cov" });
      const tr2 = cv.createDiv({ cls: "tgx-cov-track" }); const fill = tr2.createDiv({ cls: "tgx-cov-fill" });
      fill.style.width = `${Math.round(c.coverage * 100)}%`; fill.style.background = c.cat ? COLORS[c.cat.color] : "var(--text-faint)";
      cv.createSpan({ cls: "tgx-small", text: `${Math.round(c.coverage * 100)}%` });
      tr.createEl("td", { cls: "tgx-num-cell", text: fmt(c.sent30) });
      tr.createEl("td", { cls: "tgx-num-cell" + (c.waiting ? " tgx-warn-t" : ""), text: fmt(c.waiting) });
      tr.createEl("td", { cls: "tgx-num-cell", text: fmt(c.unread) });
      tr.createEl("td", { cls: "tgx-num-cell", text: c.reply == null ? "–" : fmtMin(c.reply) });
      tr.createEl("td", { cls: "tgx-dim tgx-small tgx-nowrap", text: c.last ? relDate(c.last.toISOString()) : "–" });
    }
  }

  renderCold(el, S) {
    const card = el.createDiv({ cls: "tgx-card" });
    const hh = card.createDiv({ cls: "tgx-row" });
    hh.createEl("h3", { text: "Going cold" });
    hh.createSpan({ cls: "tgx-meta", text: "Categorised chats with no message for 30+ days: worth a nudge" });
    const list = card.createDiv({ cls: "tgx-cold" });
    for (const r of S.cold.slice(0, 12)) {
      const it = list.createDiv({ cls: "tgx-cold-it" });
      it.onclick = () => new ConversationModal(this.app, this, r).open();
      avatar(it, r.title, "sm");
      const t = it.createDiv({ cls: "tgx-grow" });
      const tl = t.createDiv({ cls: "tgx-title tgx-ellipsis" });
      const c = this.cat(S.catOf(r)); if (c) this.catDot(tl, c);
      tl.createSpan({ text: " " + r.title });
      const ld = S.lastDate(r);
      t.createDiv({ cls: "tgx-meta", text: ld ? `${Math.floor((S.now - ld) / 864e5)} days ago · ${r.last.out ? "you wrote last" : "they wrote last"}` : "no messages" });
    }
    if (S.cold.length > 12) card.createDiv({ cls: "tgx-meta", text: `+ ${S.cold.length - 12} more` });
  }

  // ---------------------------------------------------------------- follow up
  renderFollow(el) {
    const bar = el.createDiv({ cls: "tgx-toolbar" });
    this.groupPicker(bar, {
      placeholder: "Add any chat to Follow up…", filter: (c) => !this.isFollow(c.id),
      onPick: (c) => { this.toggleFollow(c); this.fuSel = String(c.id); this.render(); },
    });
    const ids = Object.keys(this.s.follow).sort((a, b) => this.s.follow[a].title.localeCompare(this.s.follow[b].title));
    if (!ids.length) {
      this.emptyState(el, "zap", "Nothing to follow up yet",
        "Search a chat above, or tap ⚡ next to a chat in Chats. Claude then sums up the chat and tells you what to follow up on.");
      return;
    }
    if (!this.fuSel || !this.s.follow[this.fuSel]) this.fuSel = ids[0];
    const inChats = new Set((this.chats || []).map((g) => String(g.id)));

    const wrap = el.createDiv({ cls: "tgx-fu" });
    const list = wrap.createDiv({ cls: "tgx-fu-list" });
    for (const id of ids) {
      const f = this.s.follow[id];
      const it = list.createDiv({ cls: "tgx-fu-item" + (id === this.fuSel ? " on" : "") });
      avatar(it, f.title);
      const t = it.createDiv({ cls: "tgx-grow" });
      t.createDiv({ cls: "tgx-title tgx-ellipsis", text: f.title });
      t.createDiv({ cls: "tgx-meta", text: this.ai === id ? "summarizing…" : f.summary ? `summary · ${f.summarizedAt.slice(5)}` : "no summary yet" });
      if (this.ai === id) setIcon(it.createSpan({ cls: "tgx-spin" }), "loader");
      else if (!f.summary) it.createSpan({ cls: "tgx-fu-dot" });
      it.onclick = () => {
        this.fuSel = id; this.render();
        if (!f.summary && !this.ai && !this.proc) this.summarize(id);   // first click: Claude reads it straight away
      };
    }

    const f = this.s.follow[this.fuSel], id = this.fuSel;
    const pane = wrap.createDiv({ cls: "tgx-card tgx-fu-pane" });
    const head = pane.createDiv({ cls: "tgx-fu-head" });
    avatar(head, f.title, "lg");
    const ht = head.createDiv({ cls: "tgx-grow" });
    ht.createEl("h3", { text: f.title });
    const meta = [f.type || "group", `flagged ${f.added}`];
    if (f.summarizedAt) meta.push(`summed up ${f.summarizedAt} from ${f.msgs} messages`);
    if (this.chats && !inChats.has(id)) meta.push("not in your chats any more");
    ht.createDiv({ cls: "tgx-meta", text: meta.join(" · ") });
    const acts = pane.createDiv({ cls: "tgx-row tgx-fu-acts" });
    const again = iconBtn(acts, "sparkles", f.summary ? "Summarize again" : "Summarize with Claude", "mod-cta");
    if (this.ai || this.proc) again.disabled = true;
    again.onclick = () => this.summarize(id);
    if (f.summary) {
      iconBtn(acts, "copy", "Copy").onclick = () => { navigator.clipboard.writeText(f.summary); new Notice("Copied"); };
      iconBtn(acts, "file-text", "Save as note").onclick = () => this.saveFollowNote(id);
    }
    acts.createDiv({ cls: "tgx-spacer" });
    iconBtn(acts, "zap-off", "Remove", "tgx-link").onclick = () => { delete this.s.follow[id]; this.fuSel = null; this.plugin.saveSettings(); this.render(); };

    const body = pane.createDiv({ cls: "tgx-fu-body" });
    if (this.ai === id) {
      const l = body.createDiv({ cls: "tgx-fu-loading" });
      setIcon(l.createSpan({ cls: "tgx-spin" }), "sparkles");
      l.createSpan({ text: this.aiStage });
      for (const w of [92, 78, 85, 60]) body.createDiv({ cls: "tgx-skel" }).style.width = `${w}%`;
    } else if (f.summary) {
      MarkdownRenderer.render(this.app, f.summary, body.createDiv({ cls: "tgx-md markdown-rendered" }), "", this);
    } else {
      body.createEl("p", { cls: "tgx-dim", text: "Claude reads the latest messages of this group and writes a summary, what's still open, who to follow up with, and a draft message." });
    }
  }

  // Claude summaries live in settings.summaries (chat id → {summary, summarizedAt, msgs}), shared by
  // Follow up and Chats → Send. Older Follow up entries kept their summary on the follow record.
  summaryOf(id) {
    id = String(id);
    const f = this.s.follow[id];
    return this.s.summaries[id] || (f && f.summary ? { summary: f.summary, summarizedAt: f.summarizedAt, msgs: f.msgs } : null);
  }

  async summarize(id, title, { quiet = false } = {}) {
    id = String(id);
    if (this.ai) { if (!quiet) new Notice("Claude is already on another chat."); return false; }
    if (this.proc) { if (!quiet) new Notice("Wait for the current task to finish."); return false; }
    const f = this.s.follow[id];
    title = title || (f && f.title) || (this.chatById(id) || {}).title || "this chat";
    const prefix = this.sumQueue ? `(${this.sumQueue.done + 1}/${this.sumQueue.total}) ` : "";
    this.ai = id; this.aiStage = prefix + "Reading the chat from Telegram…"; this.render();
    const { code } = await this.run(["history", id, "--limit", String(this.s.historyLimit || 400)], { quiet });
    const file = path.join(this.exportDir, "history", `${id}.txt`);
    if (code || !fs.existsSync(file)) {
      this.ai = null; this.render();
      if (!quiet) new Notice(this.summaryOf(id) ? "Couldn't read the chat (left already?). Showing the last summary." : "Couldn't read the chat: see the log.");
      return false;
    }
    const transcript = fs.readFileSync(file, "utf8");
    const msgs = +((transcript.match(/^Messages: (\d+)/m) || [])[1] || 0);
    this.aiStage = prefix + `Claude is reading ${msgs} messages…`; this.render();
    let ok = false;
    try {
      const md = await this.askClaude(FOLLOW_PROMPT(title), transcript);
      const rec = { summary: md.trim(), summarizedAt: now(), msgs };
      this.s.summaries[id] = rec;
      if (f) Object.assign(f, rec);
      await this.plugin.saveSettings();
      ok = true;
    } catch (e) {
      this.pushLog(`✗ claude: ${e.message}`); if (!quiet) new Notice(`Claude: ${e.message}`);
    }
    this.ai = null; this.render();
    return ok;
  }

  // One after the other; stoppable from the button that started it.
  async summarizeAll(chats) {
    if (this.ai || this.proc) return new Notice("Wait for the current task to finish.");
    this.sumQueue = { total: chats.length, done: 0, stop: false };
    for (const c of chats) {
      if (this.sumQueue.stop) break;
      await this.summarize(c.id, c.title, { quiet: true });
      this.sumQueue.done++;
    }
    const { done, total, stop } = this.sumQueue;
    this.sumQueue = null; this.render();
    new Notice(stop ? `Stopped after ${done} of ${total} summaries.` : `Claude summed up ${done} chats.`);
  }

  // Claude's summary of one chat, with Summarize / again, Copy. Starts by itself the first time.
  summaryPane(el, chat) {
    const id = String(chat.id), s = this.summaryOf(id);
    const box = el.createDiv({ cls: "tgx-sum" });
    const head = box.createDiv({ cls: "tgx-conv-head" });
    avatar(head, chat.title, "sm");
    const ht = head.createDiv({ cls: "tgx-grow" });
    ht.createDiv({ cls: "tgx-title tgx-ellipsis", text: chat.title });
    ht.createDiv({ cls: "tgx-meta", text: s ? `summed up ${relAgo(s.summarizedAt.replace(" ", "T") + "Z")} from ${s.msgs} messages` : "no summary yet" });
    if (s) { const cp = head.createEl("button", { cls: "tgx-icon-btn", attr: { "aria-label": "Copy" } }); setIcon(cp, "copy"); cp.onclick = () => { navigator.clipboard.writeText(s.summary); new Notice("Copied"); }; }
    const again = iconBtn(head, "sparkles", s ? "Again" : "Summarize", s ? "" : "mod-cta");
    if (this.ai || this.proc) again.disabled = true;
    again.onclick = () => this.summarize(id, chat.title);
    const body = box.createDiv({ cls: "tgx-sum-body" });
    if (this.ai === id) {
      const l = body.createDiv({ cls: "tgx-fu-loading" });
      setIcon(l.createSpan({ cls: "tgx-spin" }), "sparkles");
      l.createSpan({ text: this.aiStage });
      for (const w of [92, 78, 85, 60, 70]) body.createDiv({ cls: "tgx-skel" }).style.width = `${w}%`;
    } else if (s) {
      MarkdownRenderer.render(this.app, s.summary, body.createDiv({ cls: "tgx-md markdown-rendered" }), "", this);
    } else {
      body.createDiv({ cls: "tgx-conv-note", text: this.ai || this.proc ? "Claude will sum this chat up when the current task is done." : (this.sumTried && this.sumTried.has(id)) ? "No summary yet. Click Summarize to ask Claude." : "Asking Claude…" });
      this.sumTried = this.sumTried || new Set();                    // auto-start once; a failure shows a button instead
      if (!this.ai && !this.proc && !this.sumTried.has(id)) { this.sumTried.add(id); setTimeout(() => this.summarize(id, chat.title), 0); }
    }
  }

  toggleFollow(g) {
    const id = String(g.id);
    if (this.s.follow[id]) delete this.s.follow[id];
    else this.s.follow[id] = Object.assign({ title: g.title, type: g.type, added: new Date().toISOString().slice(0, 10) }, this.summaryOf(id));
    this.plugin.saveSettings(); this.render();
  }

  async saveFollowNote(id) {
    const f = this.s.follow[id]; if (!f || !f.summary) return;
    const dir = normalizePath(`${this.s.noteDir || "TG"}/Follow-ups`);
    const file = normalizePath(`${dir}/${f.title.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim()}.md`);
    const a = this.app.vault.adapter;
    if (!(await a.exists(dir))) await a.mkdir(dir);
    await a.write(file, ["---", "tags: [follow-up, telegram]", `group: "${f.title.replace(/"/g, "'")}"`, `summarized: ${f.summarizedAt}`, `messages: ${f.msgs || 0}`, "---", "",
      `# ${f.title}`, "", f.summary, ""].join("\n"));
    new Notice(`Saved to ${file}`);
    this.app.workspace.openLinkText(file, "", true);
  }

  // ---------------------------------------------------------------- contacts
  renderContacts(el) {
    const card = el.createDiv({ cls: "tgx-card tgx-hero" });
    setIcon(card.createDiv({ cls: "tgx-hero-ic" }), this.contacts ? "users" : "user-plus");
    const txt = card.createDiv({ cls: "tgx-grow" });
    if (this.contacts) {
      txt.createEl("strong", { text: `${fmt(this.contacts.length)} people saved` });
      txt.createEl("p", { cls: "tgx-dim tgx-small", text: `Exported ${this.exportedAt} · everyone in your scanned groups plus your address book · CSV, SQLite and a vault note` });
    } else {
      txt.createEl("strong", { text: "Save your contacts first" });
      txt.createEl("p", { cls: "tgx-dim tgx-small", text: "Everyone in the groups you scan (and your Telegram address book) goes into a table." });
    }
    const acts = card.createDiv({ cls: "tgx-row" });
    if (this.contacts) {
      iconBtn(acts, "file-spreadsheet", "Open CSV").onclick = () => require("electron").shell.openPath(path.join(this.exportDir, "contacts.csv"));
      this.busy(iconBtn(acts, "file-text", "Vault note")).onclick = () => this.writeNote();
    }
    this.busy(iconBtn(acts, "download", this.contacts ? "Export again" : "Save all contacts", "mod-cta")).onclick = async () => {
      const groups = this.scope().filter((c) => c.type !== "dm");
      if (this.chats && !groups.length) return new Notice("No scanned groups yet: pick some in Scan first.");
      await this.run(this.chats ? ["export", "--ids-file", this.writeIds("export_groups.json", groups)] : ["export"]);
      this.loadExport(); this.render();
    };
    if (!this.contacts) return;

    const bar = el.createDiv({ cls: "tgx-toolbar" });
    const wrap = el.createDiv({ cls: "tgx-table-wrap" });
    const draw = () => {
      wrap.empty();
      const s = this.search.contacts.toLowerCase().trim();
      const rows = this.contacts.filter((c) => !s || [c.first_name, c.last_name, c.username, c.groups, c.phone].join(" ").toLowerCase().includes(s));
      if (!rows.length) { wrap.createEl("p", { cls: "tgx-empty", text: "Nobody matches." }); return; }
      const t = wrap.createEl("table", { cls: "tgx-table" });
      const h = t.createEl("thead").createEl("tr");
      ["Person", "Phone", "Groups", "Shared groups"].forEach((x) => h.createEl("th", { text: x }));
      const b = t.createEl("tbody");
      for (const c of rows.slice(0, ROW_LIMIT)) {
        const tr = b.createEl("tr");
        const name = personName(c);
        const who = tr.createEl("td").createDiv({ cls: "tgx-who" });
        avatar(who, name);
        const wt = who.createDiv();
        const nl = wt.createDiv({ cls: "tgx-title", text: name });
        if (c.in_my_contacts === "1") nl.createSpan({ cls: "tgx-star", text: " ★", attr: { title: "in your address book" } });
        if (c.username) wt.createEl("a", { text: c.username, href: `https://t.me/${c.username.slice(1)}`, cls: "tgx-ext tgx-meta" });
        tr.createEl("td", { text: c.phone ? "+" + c.phone : "", cls: "tgx-dim tgx-mono" });
        tr.createEl("td", { text: c.group_count, cls: "tgx-num-cell" });
        tr.createEl("td", { text: c.groups.split(" | ").join(" · "), cls: "tgx-dim tgx-clip", attr: { title: c.groups } });
      }
      if (rows.length > ROW_LIMIT) wrap.createEl("p", { cls: "tgx-empty", text: `Showing ${ROW_LIMIT} of ${fmt(rows.length)}. Search to narrow, or open the CSV.` });
    };
    this.searchBox(bar, "Search name, @username, phone, group…", this.search.contacts, (v) => { this.search.contacts = v; draw(); });
    draw();
  }

  async writeNote() {
    // A–Z note with letter sections, built by `tg_gtm.py note` so CLI and plugin match
    const file = normalizePath(`${this.s.noteDir || "TG"}/Telegram Contacts.md`);
    const abs = path.join(this.app.vault.adapter.getBasePath(), file);
    const { code } = await this.run(["note", abs]);
    if (code) return new Notice("Could not write the contacts note: see the log.");
    new Notice(`Saved ${this.contacts.length} contacts to ${file}`);
    setTimeout(() => this.app.workspace.openLinkText(file, "", true), 400);
  }

  // ---------------------------------------------------------------- new group (+ add people)
  // One page, two tabs: create a group, or add people to one you're in.
  renderGroupsSetup(el) {
    const seg = el.createDiv({ cls: "tgx-seg tgx-seg-lg" });
    for (const [k, icon, label] of [["create", "plus-circle", "Create a group"], ["invite", "user-plus", "Add people to a group"]]) {
      const b = seg.createEl("button", { cls: (this.groupMode || "create") === k ? "on" : "" });
      setIcon(b.createSpan({ cls: "tgx-btn-ic" }), icon); b.createSpan({ text: label });
      b.onclick = () => { this.groupMode = k; this.render(); };
    }
    (this.groupMode === "invite" ? this.renderInvite : this.renderCreate).call(this, el);
  }

  renderCreate(el) {
    if (this.results.create) this.resultCard(el, this.results.create, () => { this.results.create = null; this.render(); });
    const card = el.createDiv({ cls: "tgx-card tgx-form" });
    // photo + name side by side, like Telegram's own "new group" screen
    const top = card.createDiv({ cls: "tgx-create-top" });
    const ph = top.createDiv({ cls: "tgx-photo" + (this.form.photoUrl ? " set" : ""), attr: { "aria-label": "Group photo" } });
    if (this.form.photoUrl) ph.createEl("img", { attr: { src: this.form.photoUrl, alt: "" } });
    else { setIcon(ph.createSpan({ cls: "tgx-photo-ic" }), "camera"); ph.createSpan({ cls: "tgx-photo-t", text: "Add photo" }); }
    const file = top.createEl("input", { type: "file", attr: { accept: "image/png,image/jpeg,image/webp" } });
    file.style.display = "none";
    ph.onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files && file.files[0]; if (!f) return;
      fs.mkdirSync(this.exportDir, { recursive: true });
      const dest = path.join(this.exportDir, "group_photo" + (path.extname(f.name) || ".jpg").toLowerCase());
      fs.writeFileSync(dest, Buffer.from(await f.arrayBuffer()));          // a copy the script can upload
      if (this.form.photoUrl) URL.revokeObjectURL(this.form.photoUrl);
      Object.assign(this.form, { photo: dest, photoUrl: URL.createObjectURL(f), photoName: f.name });
      this.render();
    };
    const nf = top.createDiv({ cls: "tgx-grow tgx-form" });
    const name = field(nf, "Group name").createEl("input", { type: "text", attr: { placeholder: "e.g. Acme <> You" }, value: this.form.title });
    if (this.form.photo) {
      const pr = nf.createDiv({ cls: "tgx-meta tgx-row" });
      pr.createSpan({ text: `Photo: ${this.form.photoName}` });
      pr.createEl("button", { text: "Change", cls: "tgx-link" }).onclick = () => file.click();
      pr.createEl("button", { text: "Remove", cls: "tgx-link" }).onclick = () => { URL.revokeObjectURL(this.form.photoUrl); Object.assign(this.form, { photo: null, photoUrl: null, photoName: null }); this.render(); };
    }
    const about = field(card, "Description", "optional").createEl("textarea", { attr: { rows: 2, placeholder: "What this group is for" } });
    about.value = this.form.about;
    const pf = field(card, "People", "they're added straight away");
    const bar = el.createDiv({ cls: "tgx-row tgx-actions" });
    const cta = this.busy(iconBtn(bar, "plus-circle", "Create group", "mod-cta"));
    const paint = () => {
      { const n = this.pick.create.length; cta.lastChild.setText(n ? `Create with ${n} ${n === 1 ? "person" : "people"}` : "Create group"); }
      cta.disabled = !!this.proc || !this.form.title.trim();
    };
    name.oninput = () => { this.form.title = name.value; paint(); };
    about.oninput = () => { this.form.about = about.value; };
    this.peoplePicker(pf, this.pick.create, paint);
    card.createEl("p", { cls: "tgx-hint", text: "Creates a private group (supergroup) with you as owner. People whose privacy settings block being added are listed afterwards, with an invite link you can send them." });

    const people = () => this.pick.create.map((p) => p.key);
    const run = async (confirm) => {
      const args = ["create", "--title", this.form.title.trim(), "--about", this.form.about.trim()];
      if (this.form.photo) args.push("--photo", this.form.photo);
      if (people().length) args.push("--users-file", this.writeJson("create_people.json", people()));
      const { code, result } = await this.run([...args, ...(confirm ? ["--confirm"] : [])]);
      if (!confirm) return;
      if (code || !result) return new Notice("Couldn't create the group: see the log.");
      this.results.create = Object.assign(result, { created: true });
      this.s.created.unshift({ id: result.id, title: result.title, link: result.link, at: now(), people: result.added.length });
      if (this.form.photoUrl) URL.revokeObjectURL(this.form.photoUrl);
      this.form = { title: "", about: "" }; this.pick.create = [];
      await this.plugin.saveSettings();
      this.loadChats();
    };
    bar.createDiv({ cls: "tgx-spacer" });
    this.busy(iconBtn(bar, "eye", "Dry run")).onclick = () => run(false);
    bar.appendChild(cta);
    cta.onclick = () => new ConfirmModal(this.app, {
      icon: "plus-circle", danger: false, title: `Create “${this.form.title.trim()}”?`,
      body: [(this.form.photo ? "With the photo you picked. " : "") + (this.pick.create.length ? `A new private group, owned by you, with these ${this.pick.create.length} people added (a few seconds between each).` : "A new private group, owned by you. You can add people later in Add people.")],
      items: this.pick.create.map((p) => `${p.label}${p.sub && p.sub !== p.label ? "  ·  " + p.sub : ""}`), cta: "Create group", onOk: () => run(true),
    }).open();
    paint();

    if (this.s.created.length) {
      el.createEl("h4", { cls: "tgx-h4-gap", text: "Created from here" });
      const list = el.createDiv({ cls: "tgx-card tgx-list" });
      for (const g of this.s.created.slice(0, 12)) {
        const row = list.createDiv({ cls: "tgx-list-row" });
        avatar(row, g.title, "sm");
        const t = row.createDiv({ cls: "tgx-grow" }); t.createDiv({ cls: "tgx-title", text: g.title }); t.createDiv({ cls: "tgx-meta", text: `${g.at} · ${g.people} added` });
        iconBtn(row, "user-plus", "Add people").onclick = () => { this.inviteTo = g.id; this.groupMode = "invite"; this.render(); };
        if (g.link) iconBtn(row, "copy", "Link").onclick = () => { navigator.clipboard.writeText(g.link); new Notice("Invite link copied"); };
      }
    }
  }

  // ---------------------------------------------------------------- add people
  renderInvite(el) {
    if (this.results.invite) this.resultCard(el, this.results.invite, () => { this.results.invite = null; this.render(); });
    const card = el.createDiv({ cls: "tgx-card tgx-form" });
    const gf = field(card, "Group");
    const g = (this.chats || []).find((c) => String(c.id) === String(this.inviteTo));
    if (g) {
      const sel = gf.createDiv({ cls: "tgx-selected" });
      avatar(sel, g.title);
      const t = sel.createDiv({ cls: "tgx-grow" }); t.createDiv({ cls: "tgx-title", text: g.title });
      t.createDiv({ cls: "tgx-meta", text: [g.type, g.role === "creator" ? "you own it" : g.role, g.members ? `${fmt(g.members)} members` : ""].filter(Boolean).join(" · ") });
      sel.createEl("button", { text: "Change", cls: "tgx-link" }).onclick = () => { this.inviteTo = null; this.render(); };
    } else {
      this.groupPicker(gf, { placeholder: "Search a group you can add people to…", filter: (c) => c.can_invite, onPick: (c) => { this.inviteTo = c.id; this.render(); } });
      if (this.inviteTo && this.chats) gf.createDiv({ cls: "tgx-meta", text: "That group isn't in your chats any more." });
    }
    const pf = field(card, "People");
    const bar = el.createDiv({ cls: "tgx-row tgx-actions" });
    const cta = this.busy(iconBtn(bar, "user-plus", "Add people", "mod-cta"));
    const paint = () => {
      const n = this.pick.invite.length;
      cta.lastChild.setText(n ? `Add ${n} ${n === 1 ? "person" : "people"}` : "Add people");
      cta.disabled = !!this.proc || !g || !n;
    };
    this.peoplePicker(pf, this.pick.invite, paint);
    card.createEl("p", { cls: "tgx-hint", text: "People are added one at a time, a few seconds apart. Telegram limits how many strangers you can add per day; if it says stop, the rest are listed so you can try later or send the invite link." });

    const run = async (confirm) => {
      const file = this.writeJson("invite_people.json", this.pick.invite.map((p) => p.key));
      const { code, result } = await this.run(["invite", String(g.id), "--users-file", file, ...(confirm ? ["--confirm"] : [])]);
      if (!confirm) return;
      if (code || !result) return new Notice("Couldn't add people: see the log.");
      this.results.invite = result; this.pick.invite = [];
      this.render();
    };
    bar.createDiv({ cls: "tgx-spacer" });
    const dry = this.busy(iconBtn(bar, "eye", "Dry run")); dry.onclick = () => g && this.pick.invite.length && run(false);
    bar.appendChild(cta);
    cta.onclick = () => new ConfirmModal(this.app, {
      icon: "user-plus", danger: false, title: `Add ${this.pick.invite.length} to “${g.title}”?`,
      body: ["They're added to the group straight away and see its message history (if the group shows history to new members)."],
      items: this.pick.invite.map((p) => `${p.label}${p.sub && p.sub !== p.label ? "  ·  " + p.sub : ""}`), cta: "Add them", onOk: () => run(true),
    }).open();
    paint();
  }

  // ================================================================ pages · chats, scan, categories, message
  // ---------------------------------------------------------------- scan: data
  // The scan is the set of chats the bot works with (Chats, Contacts export, Leave groups):
  // groups whose title contains one of your keywords, minus the ones you untick, plus the ones you add by hand.
  matcher() {
    const key = this.s.scan.keywords.join("\u0001");
    if (this._mkey !== key) { this._mkey = key; this._match = keywordMatcher(this.s.scan.keywords); }
    return this._match;
  }
  matchedBy(title) {
    return this.s.scan.keywords.find((w) => keywordMatcher([w])(title));
  }
  inScope(c) {
    const id = String(c.id), sc = this.s.scan;
    if (c.type === "dm") return sc.dms;
    if (sc.add.includes(id)) return true;
    return this.matcher()(c.title) && !sc.off.includes(id);
  }
  scope() { return (this.chats || []).filter((c) => this.inScope(c)); }
  chatBase() { return this.chatsView === "all" ? this.chats || [] : this.scope(); }

  setInScope(c, on) {
    const id = String(c.id), sc = this.s.scan;
    sc.off = sc.off.filter((x) => x !== id); sc.add = sc.add.filter((x) => x !== id);
    const matched = this.matcher()(c.title);
    if (matched && !on) sc.off.push(id);
    if (!matched && on) sc.add.push(id);
    this.plugin.saveSettings();
  }

  // ---------------------------------------------------------------- scan
  renderScan(el) {
    const sc = this.s.scan;
    const card = el.createDiv({ cls: "tgx-card tgx-form" });
    const kf = field(card, "Group titles containing", "any of these words");
    const box = kf.createDiv({ cls: "tgx-picker-field" });
    for (const w of sc.keywords) {
      const chip = box.createSpan({ cls: "tgx-pchip tgx-kw" }); chip.createSpan({ text: w });
      const x = chip.createEl("button", { cls: "tgx-pchip-x", attr: { "aria-label": "Remove" } }); setIcon(x, "x");
      x.onclick = () => { sc.keywords = sc.keywords.filter((k) => k !== w); this.plugin.saveSettings(); this.render(); };
    }
    const input = box.createEl("input", { type: "text", cls: "tgx-picker-in", attr: { placeholder: sc.keywords.length ? "Add a word, press Enter" : "e.g. Fund, DAO, <> Me" } });
    input.onkeydown = (e) => {
      const v = input.value.trim().replace(/,$/, "");
      if ((e.key === "Enter" || e.key === ",") && v) {
        e.preventDefault();
        if (!sc.keywords.some((k) => k.toLowerCase() === v.toLowerCase())) sc.keywords.push(v);
        this.plugin.saveSettings(); this.render();
        setTimeout(() => this.root.querySelector(".tgx-kw-in")?.focus(), 20);
      }
      if (e.key === "Backspace" && !input.value && sc.keywords.length) { sc.keywords.pop(); this.plugin.saveSettings(); this.render(); }
    };
    input.addClass("tgx-kw-in");
    box.onclick = () => input.focus();
    const dm = card.createEl("label", { cls: "tgx-check" });
    const dmc = dm.createEl("input", { type: "checkbox" }); dmc.checked = sc.dms;
    dm.createSpan({ text: "Also scan all my DMs" });
    dmc.onchange = () => { sc.dms = dmc.checked; this.plugin.saveSettings(); this.render(); };
    card.createEl("p", { cls: "tgx-hint", text: "Not case sensitive. Short words match whole words only, so “ai” matches “Acme AI <> Us” but not “Mainnet”. Tick or untick any group below to override the words." });

    if (!this.chats) { this.emptyState(el, "loader", "Loading your Telegram chats…"); return; }
    const groups = this.chats.filter((c) => c.type !== "dm");
    const inN = groups.filter((c) => this.inScope(c)).length;
    const views = [["in", `In scan`, inN], ["out", "Not scanned", groups.length - inN], ["all", "All groups", groups.length]];
    const bar = el.createDiv({ cls: "tgx-toolbar tgx-gap-top" });
    const pills = bar.createDiv({ cls: "tgx-pills" });
    for (const [k, label, n] of views) {
      const p = pills.createEl("button", { cls: "tgx-pill" + (this.scanView === k ? " on" : "") });
      p.createSpan({ text: label }); p.createSpan({ cls: "tgx-pill-n", text: String(n) });
      p.onclick = () => { this.scanView = k; this.render(); };
    }
    bar.createDiv({ cls: "tgx-spacer" });
    this.searchBox(bar, "Search groups…", this.search.scan, (v) => { this.search.scan = v; draw(); });
    this.busy(iconBtn(bar, "refresh-cw", "Rescan")).onclick = () => this.loadChats();

    const wrap = el.createDiv({ cls: "tgx-table-wrap" });
    const draw = () => {
      wrap.empty();
      const q = (this.search.scan || "").toLowerCase().trim();
      const rows = groups.filter((c) => (this.scanView === "all" || (this.scanView === "in") === this.inScope(c)) && (!q || c.title.toLowerCase().includes(q)));
      if (!rows.length) { wrap.createEl("p", { cls: "tgx-empty", text: this.scanView === "in" ? "Nothing matches your words yet. Add a word above, or tick groups in “Not scanned”." : "No group here." }); return; }
      const t = wrap.createEl("table", { cls: "tgx-table" });
      const h = t.createEl("thead").createEl("tr");
      ["", "Group", "Why", "Members", "Last message"].forEach((x) => h.createEl("th", { text: x, cls: x ? "" : "tgx-cb" }));
      const b = t.createEl("tbody");
      for (const c of rows) {
        const on = this.inScope(c), id = String(c.id);
        const tr = b.createEl("tr", { cls: on ? "" : "off" });
        tr.onclick = () => { this.setInScope(c, !on); this.render(); };
        const cb = tr.createEl("td", { cls: "tgx-cb" }).createEl("input", { type: "checkbox" }); cb.checked = on;
        const who = tr.createEl("td").createDiv({ cls: "tgx-who" });
        avatar(who, c.title);
        const wt = who.createDiv({ cls: "tgx-grow" }); wt.createDiv({ cls: "tgx-title tgx-ellipsis", text: c.title }); wt.createDiv({ cls: "tgx-meta", text: c.type });
        const kw = this.matchedBy(c.title);
        const why = tr.createEl("td");
        if (sc.add.includes(id)) why.createSpan({ cls: "tgx-tag sent", text: "added by hand" });
        else if (kw && sc.off.includes(id)) why.createSpan({ cls: "tgx-tag gone", text: `“${kw}”, unticked` });
        else if (kw) why.createSpan({ cls: "tgx-tag kw", text: `matches “${kw}”` });
        tr.createEl("td", { text: c.members ? fmt(c.members) : "", cls: "tgx-num-cell" });
        tr.createEl("td", { text: relDate(c.last), cls: "tgx-dim tgx-small tgx-nowrap" });
      }
    };
    draw();
  }

  // ---------------------------------------------------------------- categories: data
  // A category is {id, name, color, about}: the kind of partnership (Fund, VC, Exchange…).
  get cats() { return this.s.categories; }
  cat(id) { return this.cats.find((c) => c.id === id); }
  chatById(id) { return (this.chats || []).find((c) => String(c.id) === String(id)); }

  catChats(catId) {
    return Object.entries(this.s.chatCat).filter(([, k]) => k === catId)
      .map(([id]) => this.chatById(id) || Object.assign({ id: +id, gone: true, type: "group", role: "" }, this.s.chatMeta[id]));
  }

  setCat(chat, catId) {
    const id = String(chat.id);
    if (catId) { this.s.chatCat[id] = catId; this.s.chatMeta[id] = { title: chat.title, type: chat.type }; }
    else { delete this.s.chatCat[id]; delete this.s.chatMeta[id]; }
    this.plugin.saveSettings();
  }

  addCategory(c) {
    const cat = Object.assign({ id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), created: new Date().toISOString().slice(0, 10) }, c);
    this.s.categories.push(cat); this.plugin.saveSettings();
    return cat;
  }

  editCategory(existing, onSaved) {
    new CategoryModal(this.app, existing, (c) => {
      let cat = existing;
      if (existing) { Object.assign(existing, c); this.plugin.saveSettings(); } else cat = this.addCategory(c);
      onSaved && onSaved(cat);
      this.render();
    }).open();
  }

  catDot(parent, c) {
    const d = parent.createSpan({ cls: "tgx-cat-dot" });
    d.style.background = COLORS[c.color] || COLORS.gray;
    return d;
  }

  catPills(el, current, onPick) {
    const pills = el.createDiv({ cls: "tgx-pills" });
    for (const c of this.cats) {
      const n = this.catChats(c.id).length;
      const p = pills.createEl("button", { cls: "tgx-pill tgx-pill-cat" + (current === c.id ? " on" : "") });
      p.style.setProperty("--cat", COLORS[c.color] || COLORS.gray);
      this.catDot(p, c); p.createSpan({ text: c.name }); p.createSpan({ cls: "tgx-pill-n", text: String(n) });
      p.onclick = () => onPick(c.id);
    }
    const add = pills.createEl("button", { cls: "tgx-pill tgx-pill-add" });
    setIcon(add.createSpan({ cls: "tgx-pill-ic" }), "plus"); add.createSpan({ text: "New category" });
    add.onclick = () => this.editCategory(null, (c) => onPick(c.id));
  }

  // ---------------------------------------------------------------- conversation view
  async loadConvo(id, force = false) {
    id = String(id);
    if (this.convoLoading || (this.convo[id] && !force)) return this.convo[id];
    if (this.proc) return null;                                    // Telegram session busy (e.g. a send in progress)
    this.convoLoading = id;
    const { code, out } = await this.run(["history", id, "--limit", "60", "--json"], { quiet: true });
    this.convoLoading = null;
    let messages = null;
    if (!code) try { messages = JSON.parse(out.trim().split("\n").pop()); } catch (e) { /* shown as error below */ }
    this.convo[id] = { at: now(), messages: messages || [], error: messages ? null : (out.trim().split("\n").pop() || "couldn't read the chat") };
    this.render();
    return this.convo[id];
  }

  // Telegram-style bubbles for one chat. draft() returns text to show as a not-yet-sent bubble.
  // Returns a redraw function (used to refresh the draft bubble while typing).
  chatView(el, chat, { draft } = {}) {
    const box = el.createDiv({ cls: "tgx-conv" });
    const head = box.createDiv({ cls: "tgx-conv-head" });
    avatar(head, chat.title, "sm");
    const ht = head.createDiv({ cls: "tgx-grow" });
    ht.createDiv({ cls: "tgx-title tgx-ellipsis", text: chat.title });
    ht.createDiv({ cls: "tgx-meta", text: [chat.type === "dm" ? "direct message" : chat.type, chat.username ? "@" + chat.username : "", chat.members ? `${fmt(chat.members)} members` : ""].filter(Boolean).join(" · ") });
    const re = head.createEl("button", { cls: "tgx-icon-btn", attr: { "aria-label": "Reload" } }); setIcon(re, "refresh-cw");
    const body = box.createDiv({ cls: "tgx-conv-body" });
    const id = String(chat.id);
    const draw = () => {
      body.empty();
      const c = this.convo[id];
      if (!c) {
        const l = body.createDiv({ cls: "tgx-conv-note" });
        if (this.convoLoading === id) { setIcon(l.createSpan({ cls: "tgx-spin" }), "loader"); l.createSpan({ text: "Loading the conversation…" }); }
        else if (this.proc) l.setText("Telegram is busy with another task. The conversation loads when it's done.");
        else { l.setText("Loading…"); this.loadConvo(id).then(draw); }
        return;
      }
      if (c.error) body.createDiv({ cls: "tgx-conv-note", text: "Couldn't load this chat: " + c.error });
      else if (!c.messages.length) body.createDiv({ cls: "tgx-conv-note", text: "No messages yet." });
      let day = "";
      for (const m of c.messages) {
        const d = new Date(m.date);
        const dk = d.toDateString();
        if (dk !== day) { day = dk; body.createDiv({ cls: "tgx-day", text: d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }) }); }
        const b = body.createDiv({ cls: "tgx-msg " + (m.me ? "me" : "them") });
        if (!m.me && chat.type !== "dm") {
          const who = b.createDiv({ cls: "tgx-msg-from", text: m.from });
          let h = 0; for (const ch of m.from || "") h = (h * 31 + ch.charCodeAt(0)) % 360;
          who.style.color = `hsl(${h} 55% 45%)`;
        }
        if (m.text) b.createDiv({ cls: "tgx-msg-t", text: m.text });
        if (m.media) b.createDiv({ cls: "tgx-msg-media", text: m.media });
        b.createDiv({ cls: "tgx-msg-time", text: d.toTimeString().slice(0, 5) });
      }
      const text = draft && draft();
      if (text) {
        const b = body.createDiv({ cls: "tgx-msg me pending" });
        b.createDiv({ cls: "tgx-msg-t", text });
        b.createDiv({ cls: "tgx-msg-time", text: "draft · not sent" });
      }
      body.scrollTop = body.scrollHeight;
    };
    re.onclick = () => this.loadConvo(id, true).then(draw);
    draw();
    return draw;
  }

  // ---------------------------------------------------------------- chats
  // One page, two modes: Browse (sort chats into categories) and Send (message a whole category).
  renderChatsPage(el) {
    const seg = el.createDiv({ cls: "tgx-seg tgx-seg-lg" });
    for (const [k, icon, label] of [["browse", "list", "Browse & sort"], ["send", "send", "Send to a category"]]) {
      const b = seg.createEl("button", { cls: (this.chatsMode || "browse") === k ? "on" : "" });
      setIcon(b.createSpan({ cls: "tgx-btn-ic" }), icon); b.createSpan({ text: label });
      b.onclick = () => { this.chatsMode = k; this.render(); };
    }
    (this.chatsMode === "send" ? this.renderMessage : this.renderChats).call(this, el);
  }

  renderChats(el) {
    const bar = el.createDiv({ cls: "tgx-toolbar" });
    const seg = bar.createDiv({ cls: "tgx-seg" });
    for (const [k, label] of [["scan", "Scanned"], ["all", "All chats"]]) {
      const b = seg.createEl("button", { cls: (this.chatsView || "scan") === k ? "on" : "", text: label });
      b.onclick = () => { this.chatsView = k; this.chatSel.clear(); this.render(); };
    }
    this.searchBox(bar, "Search chats…", this.search.chats, (v) => { this.search.chats = v; this.renderChatTable(); });
    this.busy(iconBtn(bar, "refresh-cw", "Rescan")).onclick = () => this.loadChats();
    if (!this.chats) {
      this.emptyState(el, "loader", this.proc ? "Loading your Telegram chats…" : "No chats loaded yet", "", this.proc ? null : { icon: "refresh-cw", text: "Load", onClick: () => this.loadChats() });
      return;
    }
    const base = this.chatBase();
    if (this.chatsView !== "all" && !base.length) {
      this.emptyState(el, "scan-search", "Nothing scanned yet", "Choose which groups the bot works with in Scan, or switch to All chats.", { icon: "scan-search", text: "Open Scan", onClick: () => this.go("scan") });
      return;
    }
    const kinds = [["all", "All"], ["groups", "Groups"], ["dm", "DMs"], ["channel", "Channels"], ["none", "No category"], ["follow", "Follow up"]];
    const pills = el.createDiv({ cls: "tgx-pills" });
    for (const [k, label] of kinds) {
      const n = base.filter((c) => this.chatKind(c, k)).length;
      if (!n && k !== "all" && this.chatFilter !== k) continue;
      const p = pills.createEl("button", { cls: "tgx-pill" + (this.chatFilter === k ? " on" : "") + (k === "follow" ? " follow" : "") });
      if (k === "follow") setIcon(p.createSpan({ cls: "tgx-pill-ic" }), "zap");
      p.createSpan({ text: label }); p.createSpan({ cls: "tgx-pill-n", text: String(n) });
      p.onclick = () => { this.chatFilter = k; this.chatSel.clear(); this.render(); };
    }
    for (const c of this.cats) {
      const n = base.filter((x) => this.s.chatCat[String(x.id)] === c.id).length; if (!n) continue;
      const p = pills.createEl("button", { cls: "tgx-pill tgx-pill-cat" + (this.chatFilter === c.id ? " on" : "") });
      p.style.setProperty("--cat", COLORS[c.color] || COLORS.gray);
      this.catDot(p, c); p.createSpan({ text: c.name }); p.createSpan({ cls: "tgx-pill-n", text: String(n) });
      p.onclick = () => { this.chatFilter = c.id; this.chatSel.clear(); this.render(); };
    }
    // bulk: tick rows, then give them a category in one go
    this.bulkEl = el.createDiv({ cls: "tgx-bulk" });
    this.tableEl = el.createDiv({ cls: "tgx-table-wrap" });
    this.renderChatTable();
  }

  chatKind(c, k) {
    if (k === "all") return true;
    if (k === "groups") return c.type === "group" || c.type === "supergroup";
    if (k === "none") return !this.s.chatCat[String(c.id)];
    if (k === "follow") return this.isFollow(c.id);
    if (k === "dm" || k === "channel") return c.type === k;
    return this.s.chatCat[String(c.id)] === k;                          // a category id
  }

  catSelect(parent, chat, onChange) {
    const sel = parent.createEl("select", { cls: "dropdown tgx-cat-select" });
    sel.createEl("option", { value: "", text: "—" });
    for (const c of this.cats) sel.createEl("option", { value: c.id, text: c.name });
    sel.createEl("option", { value: "__new", text: "＋ New category…" });
    const cur = this.s.chatCat[String(chat.id)] || "";
    sel.value = cur;
    const k = this.cat(cur); if (k) sel.style.setProperty("--cat", COLORS[k.color]);
    sel.toggleClass("set", !!k);
    sel.onclick = (e) => e.stopPropagation();
    sel.onchange = () => {
      if (sel.value === "__new") { sel.value = cur; return this.editCategory(null, (c) => { this.setCat(chat, c.id); onChange && onChange(); }); }
      this.setCat(chat, sel.value); onChange && onChange();
    };
    return sel;
  }

  renderChatTable() {
    const el = this.tableEl; if (!el) return; el.empty();
    const q = (this.search.chats || "").toLowerCase().trim();
    const rows = this.chatBase().filter((c) => this.chatKind(c, this.chatFilter) && (!q || c.title.toLowerCase().includes(q) || (c.username || "").toLowerCase().includes(q)));
    this.renderBulk(rows);
    if (!rows.length) { el.createEl("p", { cls: "tgx-empty", text: "No chat matches." }); return; }
    const t = el.createEl("table", { cls: "tgx-table" });
    const h = t.createEl("thead").createEl("tr");
    const hc = h.createEl("th", { cls: "tgx-cb" }).createEl("input", { type: "checkbox" });
    const shown = rows.slice(0, ROW_LIMIT);
    hc.checked = shown.length > 0 && shown.every((c) => this.chatSel.has(String(c.id)));
    hc.indeterminate = !hc.checked && shown.some((c) => this.chatSel.has(String(c.id)));
    hc.onchange = () => { shown.forEach((c) => (hc.checked ? this.chatSel.add(String(c.id)) : this.chatSel.delete(String(c.id)))); this.renderChatTable(); };
    setIcon(h.createEl("th", { cls: "tgx-zap-col", attr: { title: "Follow up" } }), "zap");
    ["Chat", "Category", "Last message", "Members", ""].forEach((x) => h.createEl("th", { text: x }));
    const b = t.createEl("tbody");
    for (const c of shown) {
      const id = String(c.id);
      const tr = b.createEl("tr", { cls: this.chatSel.has(id) ? "sel" : "" });
      tr.onclick = () => new ConversationModal(this.app, this, c).open();
      const cbt = tr.createEl("td", { cls: "tgx-cb" }); cbt.onclick = (e) => e.stopPropagation();
      const cb = cbt.createEl("input", { type: "checkbox" }); cb.checked = this.chatSel.has(id);
      cb.onchange = () => { cb.checked ? this.chatSel.add(id) : this.chatSel.delete(id); tr.toggleClass("sel", cb.checked); this.renderBulk(rows); };
      const zap = tr.createEl("td", { cls: "tgx-zap-col" }).createEl("button", { cls: "tgx-zap" + (this.isFollow(c.id) ? " on" : ""), attr: { "aria-label": this.isFollow(c.id) ? "Remove from Follow up" : "Add to Follow up" } });
      setIcon(zap, "zap");
      zap.onclick = (e) => { e.stopPropagation(); this.toggleFollow(c); };
      const name = tr.createEl("td").createDiv({ cls: "tgx-who" });
      avatar(name, c.title);
      const nt = name.createDiv({ cls: "tgx-grow" });
      const tl = nt.createDiv({ cls: "tgx-title tgx-ellipsis", text: c.title });
      if (c.unread) tl.createSpan({ cls: "tgx-unread", text: String(c.unread) });
      nt.createDiv({ cls: "tgx-meta", text: [c.type === "dm" ? "DM" : c.type, c.username ? "@" + c.username : "", c.role === "creator" ? "you own it" : c.role === "admin" ? "admin" : ""].filter(Boolean).join(" · ") });
      this.catSelect(tr.createEl("td"), c, () => this.render());
      tr.createEl("td", { text: relDate(c.last), cls: "tgx-dim tgx-small tgx-nowrap" });
      tr.createEl("td", { text: c.members ? fmt(c.members) : "", cls: "tgx-num-cell" });
      const open = tr.createEl("td", { cls: "tgx-open-col" }).createEl("button", { cls: "tgx-icon-btn", attr: { "aria-label": "Open conversation" } });
      setIcon(open, "message-square");
    }
    if (rows.length > ROW_LIMIT) el.createEl("p", { cls: "tgx-empty", text: `Showing ${ROW_LIMIT} of ${fmt(rows.length)}. Search or filter to narrow.` });
  }

  renderBulk(rows) {
    const el = this.bulkEl; if (!el) return; el.empty();
    const ids = [...this.chatSel];
    el.toggleClass("on", ids.length > 0);
    if (!ids.length) return;
    el.createSpan({ cls: "tgx-title", text: `${ids.length} selected` });
    const sel = el.createEl("select", { cls: "dropdown" });
    sel.createEl("option", { value: "", text: "Set category…" });
    for (const c of this.cats) sel.createEl("option", { value: c.id, text: c.name });
    sel.createEl("option", { value: "__new", text: "＋ New category…" });
    sel.createEl("option", { value: "__none", text: "Remove category" });
    const apply = (catId) => {
      for (const id of ids) { const c = this.chatById(id); if (c) this.setCat(c, catId); }
      new Notice(catId ? `${ids.length} chats set to ${this.cat(catId).name}` : `${ids.length} chats have no category now`);
      this.chatSel.clear(); this.render();
    };
    sel.onchange = () => {
      if (sel.value === "__new") return this.editCategory(null, (c) => apply(c.id));
      if (sel.value === "__none") return apply("");
      if (sel.value) apply(sel.value);
    };
    el.createDiv({ cls: "tgx-spacer" });
    el.createEl("button", { text: "Clear", cls: "tgx-link" }).onclick = () => { this.chatSel.clear(); this.renderChatTable(); };
  }

  // ---------------------------------------------------------------- categories
  renderCategories(el) {
    const bar = el.createDiv({ cls: "tgx-toolbar" });
    bar.createEl("p", { cls: "tgx-hint tgx-grow", text: "A category is the kind of partnership: give each chat one in Chats (or here), then message a whole category from Chats → Send to a category." });
    iconBtn(bar, "plus", "New category", "mod-cta").onclick = () => this.editCategory(null);

    const missing = PRESETS.filter(([n]) => !this.cats.some((c) => c.name.toLowerCase() === n.toLowerCase()));
    if (missing.length) {
      const q = el.createDiv({ cls: "tgx-presets" });
      q.createSpan({ cls: "tgx-meta", text: this.cats.length ? "Add a common one:" : "Start with some common ones:" });
      for (const [name, color, about] of missing) {
        const p = q.createEl("button", { cls: "tgx-pill tgx-pill-add" });
        const d = p.createSpan({ cls: "tgx-cat-dot" }); d.style.background = COLORS[color];
        p.createSpan({ text: name });
        p.onclick = () => { this.addCategory({ name, color, about }); this.render(); };
      }
    }
    if (!this.cats.length) {
      this.emptyState(el, "tags", "No categories yet", "Create your own, or click a common one above. Fund, VC, Exchange: whatever kind of partnership a chat is.");
      return;
    }

    const t = el.createDiv({ cls: "tgx-table-wrap" }).createEl("table", { cls: "tgx-table tgx-cat-table" });
    const h = t.createEl("thead").createEl("tr");
    ["Category", "Description", "Chats", "Last message", ""].forEach((x) => h.createEl("th", { text: x }));
    const b = t.createEl("tbody");
    for (const c of this.cats) {
      const chats = this.catChats(c.id);
      const open = this.catOpen === c.id;
      const tr = b.createEl("tr", { cls: open ? "open" : "" });
      tr.onclick = () => { this.catOpen = open ? null : c.id; this.render(); };
      const nm = tr.createEl("td").createDiv({ cls: "tgx-who" });
      setIcon(nm.createSpan({ cls: "tgx-caret" }), open ? "chevron-down" : "chevron-right");
      this.catDot(nm, c).addClass("lg");
      nm.createSpan({ cls: "tgx-title", text: c.name });
      tr.createEl("td", { cls: "tgx-dim tgx-small", text: c.about || "" });
      const dms = chats.filter((x) => x.type === "dm").length;
      tr.createEl("td", { cls: "tgx-small tgx-nowrap", text: `${chats.length}` + (chats.length ? ` · ${chats.length - dms} groups, ${dms} DMs` : "") });
      const log = this.s.catLog[c.id];
      tr.createEl("td", { cls: "tgx-dim tgx-small tgx-nowrap", text: log ? `${log.at} · ${log.n} chats` : "never" });
      const acts = tr.createEl("td", { cls: "tgx-row-acts" });
      acts.onclick = (e) => e.stopPropagation();
      const msg = acts.createEl("button", { cls: "tgx-icon-btn", attr: { "aria-label": "Message this category" } }); setIcon(msg, "send");
      msg.onclick = () => { this.s.msgCat = c.id; this.chatsMode = "send"; this.go("chats"); };
      const ed = acts.createEl("button", { cls: "tgx-icon-btn", attr: { "aria-label": "Edit" } }); setIcon(ed, "pencil");
      ed.onclick = () => this.editCategory(c);
      const del = acts.createEl("button", { cls: "tgx-icon-btn danger", attr: { "aria-label": "Delete" } }); setIcon(del, "trash-2");
      del.onclick = () => new ConfirmModal(this.app, {
        icon: "trash-2", title: `Delete “${c.name}”?`, cta: "Delete category",
        body: [`The ${chats.length} chats in it stay in Telegram; they just won't have a category any more.`],
        onOk: () => {
          this.s.categories = this.s.categories.filter((x) => x !== c);
          for (const [id, k] of Object.entries(this.s.chatCat)) if (k === c.id) { delete this.s.chatCat[id]; delete this.s.chatMeta[id]; }
          this.plugin.saveSettings(); this.render();
        },
      }).open();
      if (open) {
        const dr = b.createEl("tr", { cls: "tgx-cat-detail" });
        const td = dr.createEl("td", { attr: { colspan: "5" } });
        this.groupPicker(td, { placeholder: `Add a chat to ${c.name}…`, filter: (x) => this.s.chatCat[String(x.id)] !== c.id, onPick: (x) => { this.setCat(x, c.id); this.render(); } });
        const chips = td.createDiv({ cls: "tgx-chip-list" });
        if (!chats.length) chips.createSpan({ cls: "tgx-dim tgx-small", text: "Empty: add chats above or from Chats." });
        for (const x of chats) {
          const ch = chips.createSpan({ cls: "tgx-pchip" + (x.gone ? " gone" : "") });
          avatar(ch, x.title, "xs"); ch.createSpan({ text: x.title + (x.gone ? " (not in your chats)" : "") });
          const rm = ch.createEl("button", { cls: "tgx-pchip-x", attr: { "aria-label": "Remove" } }); setIcon(rm, "x");
          rm.onclick = () => { this.setCat(x, ""); this.render(); };
        }
      }
    }
  }

  // ---------------------------------------------------------------- message
  renderMessage(el) {
    if (!this.cats.length) {
      this.emptyState(el, "tags", "Make a category first", "You message a whole category at once, e.g. every chat tagged Fund. Create one, then give chats that category in Chats.",
        { icon: "tags", text: "Open Categories", onClick: () => this.go("categories") });
      return;
    }
    const catId = this.cat(this.s.msgCat) ? this.s.msgCat : this.cats[0].id;
    const cat = this.cat(catId);
    const off = new Set(this.s.msgOff[catId] || []);
    const chats = this.catChats(catId).filter((c) => !c.gone);
    const ticked = chats.filter((c) => !off.has(String(c.id)));
    const key = hashText(this.s.message.trim());
    const done = this.s.delivered[key] || {};
    const fresh = ticked.filter((c) => !done[String(c.id)]);
    // matches tg_gtm.py pacing: ~48 s per chat (gap + typing) and a ~6 min break every 12
    const mins = Math.ceil((fresh.length * 48 + Math.floor(fresh.length / 12) * 360) / 60);
    const eta = mins >= 90 ? `~${(mins / 60).toFixed(1)} h` : `~${mins} min`;

    el.createEl("h4", { text: "Send to" });
    this.catPills(el, catId, (id) => { this.s.msgCat = id; this.convSel = null; this.plugin.saveSettings(); this.render(); });

    const grid = el.createDiv({ cls: "tgx-msg-grid" });
    const left = grid.createDiv({ cls: "tgx-card tgx-recips" });
    const lh = left.createDiv({ cls: "tgx-row tgx-recips-head" });
    lh.createSpan({ cls: "tgx-title", text: `${ticked.length} of ${chats.length} chats` });
    lh.createDiv({ cls: "tgx-spacer" });
    const setAll = (on) => { this.s.msgOff[catId] = on ? [] : chats.map((c) => String(c.id)); this.plugin.saveSettings(); this.render(); };
    lh.createEl("button", { text: "All", cls: "tgx-link" }).onclick = () => setAll(true);
    lh.createEl("button", { text: "None", cls: "tgx-link" }).onclick = () => setAll(false);
    // Claude: sum up every chat of this category that has no summary yet
    const missing = chats.filter((c) => !this.summaryOf(c.id));
    const sb = left.createDiv({ cls: "tgx-sum-all" });
    if (this.sumQueue) {
      sb.createSpan({ cls: "tgx-meta", text: `Claude: ${this.sumQueue.done} of ${this.sumQueue.total} summed up…` });
      sb.createEl("button", { text: "Stop", cls: "tgx-link" }).onclick = () => { this.sumQueue.stop = true; new Notice("Stopping after the current chat."); };
    } else if (chats.length) {
      const b = iconBtn(sb, "sparkles", missing.length ? `Summarize ${missing.length === chats.length ? "all" : "the other " + missing.length}` : "All summed up", "tgx-sum-btn");
      b.disabled = !missing.length || !!this.ai || !!this.proc;
      b.onclick = () => { this.msgPane = "sum"; this.summarizeAll(missing); };
    }
    const list = left.createDiv({ cls: "tgx-recips-list" });
    if (!chats.length) list.createDiv({ cls: "tgx-conv-note", text: `No chat is tagged ${cat.name} yet. Set it in Chats, or add chats in Categories.` });
    if (!this.convSel || !chats.some((c) => String(c.id) === this.convSel)) this.convSel = chats[0] ? String(chats[0].id) : null;
    for (const c of chats) {
      const id = String(c.id);
      const it = list.createDiv({ cls: "tgx-recip" + (id === this.convSel ? " on" : "") + (off.has(id) ? " off" : "") });
      const cb = it.createEl("input", { type: "checkbox" }); cb.checked = !off.has(id);
      cb.onclick = (e) => e.stopPropagation();
      cb.onchange = () => { const s = new Set(this.s.msgOff[catId] || []); cb.checked ? s.delete(id) : s.add(id); this.s.msgOff[catId] = [...s]; this.plugin.saveSettings(); this.render(); };
      avatar(it, c.title, "sm");
      const t = it.createDiv({ cls: "tgx-grow" });
      t.createDiv({ cls: "tgx-title tgx-ellipsis", text: c.title });
      const meta = t.createDiv({ cls: "tgx-meta" });
      meta.createSpan({ text: done[id] ? `✓ sent ${done[id].slice(5)}` : (c.type === "dm" ? "DM" : c.type) });
      if (this.ai === id) meta.createSpan({ cls: "tgx-sum-dot busy", text: " · ✨ summarizing" });
      else if (this.summaryOf(id)) meta.createSpan({ cls: "tgx-sum-dot", text: " · ✨ summary" });
      it.onclick = () => { this.convSel = id; this.render(); };
    }
    // right: the conversation or Claude's summary of the selected chat
    const right = grid.createDiv({ cls: "tgx-card tgx-conv-card" });
    const sel = chats.find((c) => String(c.id) === this.convSel);
    this.convDraw = null;
    if (sel) {
      const tabs = right.createDiv({ cls: "tgx-seg tgx-pane-tabs" });
      for (const [k, icon, label] of [["conv", "message-square", "Conversation"], ["sum", "sparkles", "Claude summary"]]) {
        const b = tabs.createEl("button", { cls: (this.msgPane || "conv") === k ? "on" : "" });
        setIcon(b.createSpan({ cls: "tgx-btn-ic" }), icon); b.createSpan({ text: label });
        b.onclick = () => { this.msgPane = k; this.render(); };
      }
      if (this.msgPane === "sum") this.summaryPane(right, sel);
      else this.convDraw = this.chatView(right, sel, { draft: () => this.s.message.trim() });
    } else right.createDiv({ cls: "tgx-conv-note", text: "Pick a chat to see the conversation." });

    const comp = el.createDiv({ cls: "tgx-card tgx-composer" });
    const ta = comp.createEl("textarea", { attr: { rows: 4, placeholder: `Write one message for every ${cat.name} chat…` } });
    ta.value = this.s.message;
    const foot = comp.createDiv({ cls: "tgx-row tgx-composer-foot" });
    const info = foot.createSpan({ cls: "tgx-meta" });
    const paintInfo = () => info.setText(`${ta.value.length} characters · ${fresh.length} chats to go${fresh.length ? ` · ${eta}` : ""} · 25–60 s apart, “typing…” first, a break every 12`);
    paintInfo();
    let t, d;
    ta.oninput = () => {
      this.s.message = ta.value; paintInfo();
      clearTimeout(t); t = setTimeout(() => this.plugin.saveSettings(), 400);
      clearTimeout(d); d = setTimeout(() => this.convDraw && this.convDraw(), 150);
    };
    ta.onblur = () => { if (hashText(ta.value.trim()) !== key) this.render(); };      // new text → recount who's still to go
    foot.createDiv({ cls: "tgx-spacer" });
    const go = async (confirm) => {
      const text = this.s.message.trim();
      if (!text) return new Notice("Write the message first.");
      const k = hashText(text);
      const todo = ticked.filter((c) => !(this.s.delivered[k] || {})[String(c.id)]);
      fs.mkdirSync(this.exportDir, { recursive: true });
      const msg = path.join(this.exportDir, "message.txt");
      fs.writeFileSync(msg, text, "utf8");
      const ids = this.writeIds("send_targets.json", todo);
      this.sending = confirm ? k : null;
      await this.run(["send", msg, "--ids-file", ids, ...(confirm ? ["--confirm"] : [])]);
      if (confirm) { this.s.catLog[catId] = { at: now(), n: Object.keys(this.s.delivered[k] || {}).length }; this.plugin.saveSettings(); }
      this.sending = null; this.render();
    };
    this.busy(iconBtn(foot, "eye", "Dry run")).onclick = () => go(false);
    const send = this.busy(iconBtn(foot, "send", fresh.length ? `Send to ${fresh.length}` : "Send", "mod-cta"));
    if (!fresh.length || !this.chats) send.disabled = true;
    send.onclick = () => {
      if (!this.s.message.trim()) return new Notice("Write the message first.");
      new ConfirmModal(this.app, {
        icon: "send", title: `Send to ${fresh.length} ${cat.name} chats?`,
        body: [`Your message goes out from your own account, one chat at a time, over ${eta}. It can't be unsent in bulk.`,
          "If Telegram rate-limits you, it stops by itself. Chats that already got this exact message are skipped next time."],
        items: fresh.map((g) => g.title), cta: `Send to ${fresh.length}`, onOk: () => go(true),
      }).open();
    };
  }

  // ================================================================ pages · Workspace (cont.)
  // ---------------------------------------------------------------- leave groups
  renderLeave(el) {
    if (!this.chats) { this.emptyState(el, "loader", "Loading your Telegram chats…"); return; }
    const pick = new Set(this.s.leavePick);
    const all = this.chats.filter((c) => c.type !== "dm" && !this.s.left[c.id]);          // DMs are never left
    const views = [["all", "Scanned"], ["every", "All groups"], ...this.cats.map((c) => [c.id, c.name, c])];
    const f = views.some(([k]) => k === this.s.leaveFilter) ? this.s.leaveFilter : "all";
    const shown = all.filter((c) => f === "every" ? true : f === "all" ? this.inScope(c) : this.s.chatCat[String(c.id)] === f);
    const locked = (g) => g.role === "creator" || this.isFollow(g.id);                 // owned and ⚡ groups are never left
    const tgt = all.filter((g) => pick.has(String(g.id)) && !locked(g));

    if (!this.contacts) {
      const c = el.createDiv({ cls: "tgx-callout warn" }); setIcon(c.createSpan({ cls: "tgx-callout-ic" }), "lock");
      c.createSpan({ text: "Save your contacts first (Contacts). Leaving is locked until the export exists." });
    }
    const bar = el.createDiv({ cls: "tgx-toolbar" });
    const pills = bar.createDiv({ cls: "tgx-pills" });
    for (const [k, label, cat] of views) {
      const n = all.filter((c) => k === "every" ? true : k === "all" ? this.inScope(c) : this.s.chatCat[String(c.id)] === k).length;
      if (cat && !n) continue;
      const p = pills.createEl("button", { cls: "tgx-pill" + (cat ? " tgx-pill-cat" : "") + (f === k ? " on" : "") });
      if (cat) { p.style.setProperty("--cat", COLORS[cat.color]); this.catDot(p, cat); }
      p.createSpan({ text: label }); p.createSpan({ cls: "tgx-pill-n", text: String(n) });
      p.onclick = () => { this.s.leaveFilter = k; this.plugin.saveSettings(); this.render(); };
    }
    bar.createDiv({ cls: "tgx-spacer" });
    const setShown = (on) => { for (const g of shown) if (!locked(g)) on ? pick.add(String(g.id)) : pick.delete(String(g.id)); this.s.leavePick = [...pick]; this.plugin.saveSettings(); this.render(); };
    iconBtn(bar, "check-square", "Tick shown").onclick = () => setShown(true);
    iconBtn(bar, "square", "Untick shown").onclick = () => setShown(false);

    const cards = el.createDiv({ cls: "tgx-stats" });
    const card = (cls, icon, n, label) => {
      const s = cards.createDiv({ cls: "tgx-card tgx-stat " + cls });
      setIcon(s.createDiv({ cls: "tgx-stat-ic" }), icon);
      const t = s.createDiv(); t.createDiv({ cls: "tgx-stat-v", text: String(n) }); t.createDiv({ cls: "tgx-small", text: label });
    };
    card("danger", "log-out", tgt.length, "ticked to leave");
    card("keep", "crown", shown.filter((g) => g.role === "creator").length, "kept: you created them");
    card("keep", "zap", shown.filter((g) => g.role !== "creator" && this.isFollow(g.id)).length, "kept: in Follow up");
    card("info", "shield", tgt.filter((g) => g.role === "admin").length, "you're admin (will be left)");

    if (shown.length) {
      const list = el.createDiv({ cls: "tgx-card tgx-list" });
      for (const g of shown) {
        const id = String(g.id), lock = locked(g), on = !lock && pick.has(id);
        const row = list.createDiv({ cls: "tgx-list-row tgx-click" + (on ? " pick" : " off") });
        const cb = row.createEl("input", { type: "checkbox" }); cb.checked = on; cb.disabled = lock;
        const toggle = () => { if (lock) return; on ? pick.delete(id) : pick.add(id); this.s.leavePick = [...pick]; this.plugin.saveSettings(); this.render(); };
        cb.onclick = (e) => e.stopPropagation(); cb.onchange = toggle; row.onclick = toggle;
        avatar(row, g.title, "sm");
        const t = row.createDiv({ cls: "tgx-grow" }); t.createDiv({ cls: "tgx-title", text: g.title });
        const cat = this.cat(this.s.chatCat[id]);
        t.createDiv({ cls: "tgx-meta", text: [g.type, g.members ? `${fmt(g.members)} members` : "", cat ? cat.name : ""].filter(Boolean).join(" · ") });
        if (g.role === "creator") row.createSpan({ cls: "tgx-badge creator", text: "you created" });
        else if (this.isFollow(g.id)) row.createSpan({ cls: "tgx-tag keep", text: "⚡ kept" });
        else if (g.role === "admin") row.createSpan({ cls: "tgx-badge admin", text: "admin" });
      }
    } else el.createDiv({ cls: "tgx-empty", text: f === "all" ? "No scanned groups. Pick some in Scan, or switch to All groups." : "No groups here." });
    el.createEl("p", { cls: "tgx-hint", text: "Nothing is left unless you tick it. DMs are never touched. To leave a group you created, transfer ownership in Telegram, then Rescan." });

    const go = async (confirm) => {
      const ids = this.writeIds("leave_targets.json", tgt);
      await this.run(["leave", "--ids-file", ids, ...(confirm ? ["--confirm"] : [])]);
      if (confirm) { this.s.leavePick = this.s.leavePick.filter((id) => !this.s.left[id]); this.plugin.saveSettings(); await this.loadChats(); }
    };
    const act = el.createDiv({ cls: "tgx-row tgx-actions" });
    act.createDiv({ cls: "tgx-spacer" });
    const dry = this.busy(iconBtn(act, "eye", "Dry run"));
    dry.onclick = () => go(false);
    const leave = this.busy(iconBtn(act, "log-out", `Leave ${tgt.length} ${tgt.length === 1 ? "group" : "groups"}`, "mod-warning"));
    if (!this.contacts || !tgt.length) { leave.disabled = true; dry.disabled = !this.contacts || !!this.proc || !tgt.length; }
    leave.onclick = () => new ConfirmModal(this.app, {
      icon: "log-out", title: `Leave ${tgt.length} groups?`,
      body: ["You'll be removed from these groups. To get back in, someone has to re-add you.", `Contacts saved: ${fmt(this.contacts.length)} (${this.exportedAt}).`],
      items: tgt.map((g) => g.title), cta: `Leave ${tgt.length} groups`, onOk: () => go(true),
    }).open();
  }
}

// ================================================================== dialogs
class CategoryModal extends Modal {
  constructor(app, existing, onSave) { super(app); this.existing = existing; this.onSave = onSave; }
  onOpen() {
    this.modalEl.addClass("tgx-modal-wrap");
    const c = this.contentEl; c.addClass("tgx", "tgx-modal");
    const e = this.existing || {};
    let color = e.color || "blue";
    const head = c.createDiv({ cls: "tgx-modal-head" });
    const ic = head.createDiv({ cls: "tgx-modal-ic safe" }); setIcon(ic, "tag");
    head.createEl("h3", { text: this.existing ? "Edit category" : "New category" });
    const form = c.createDiv({ cls: "tgx-form" });
    const name = field(form, "Name").createEl("input", { type: "text", attr: { placeholder: "e.g. Investors" }, value: e.name || "" });
    const sw = field(form, "Colour").createDiv({ cls: "tgx-swatches" });
    const paint = () => sw.querySelectorAll(".tgx-swatch").forEach((s) => s.toggleClass("on", s.dataset.c === color));
    for (const k of Object.keys(COLORS)) {
      const s = sw.createEl("button", { cls: "tgx-swatch", attr: { "aria-label": k, "data-c": k } });
      s.style.background = COLORS[k];
      s.onclick = () => { color = k; paint(); };
    }
    paint();
    const about = field(form, "Description", "optional").createEl("input", { type: "text", attr: { placeholder: "Who's in it" }, value: e.about || "" });
    const row = c.createDiv({ cls: "tgx-row tgx-end" });
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const ok = row.createEl("button", { text: this.existing ? "Save" : "Create category", cls: "mod-cta" });
    const save = () => {
      const n = name.value.trim(); if (!n) return name.focus();
      this.close(); this.onSave({ name: n, color, about: about.value.trim() });
    };
    ok.onclick = save;
    name.onkeydown = (ev) => { if (ev.key === "Enter") save(); };
    setTimeout(() => name.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

class ConversationModal extends Modal {
  constructor(app, view, chat) { super(app); this.view = view; this.chat = chat; }
  onOpen() {
    this.modalEl.addClass("tgx-modal-wrap", "tgx-conv-modal");
    const c = this.contentEl; c.addClass("tgx", "tgx-modal");
    this.view.chatView(c, this.chat);
    const row = c.createDiv({ cls: "tgx-row tgx-conv-modal-foot" });
    this.view.catSelect(row, this.chat, () => this.view.render());
    row.createDiv({ cls: "tgx-spacer" });
    const z = iconBtn(row, "zap", this.view.isFollow(this.chat.id) ? "In Follow up" : "Follow up");
    z.onclick = () => { this.view.toggleFollow(this.chat); z.lastChild.setText(this.view.isFollow(this.chat.id) ? "In Follow up" : "Follow up"); };
    if (this.chat.username) iconBtn(row, "external-link", "Open in Telegram").onclick = () => window.open(`https://t.me/${this.chat.username}`);
  }
  onClose() { this.contentEl.empty(); }
}

// ================================================================== setup check
function capture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = "";
    let p;
    try { p = spawn(cmd, args, Object.assign({ windowsHide: true, env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" }) }, opts)); }
    catch (e) { return resolve({ code: -1, out: e.message }); }
    p.stdout.on("data", (b) => (out += b.toString("utf8"))); p.stderr.on("data", (b) => (out += b.toString("utf8")));
    p.on("error", (e) => resolve({ code: -1, out: e.code === "ENOENT" ? "not found" : e.message }));
    p.on("close", (code) => resolve({ code, out: out.trim() }));
    if (p.stdin) p.stdin.end();
    setTimeout(() => { try { p.kill(); } catch (e) { /* already done */ } }, 60000);
  });
}

async function runSetupCheck(s, el) {
  el.empty();
  const row = (ok, title, detail) => {
    const r = el.createDiv({ cls: "tgx-check-row " + (ok ? "ok" : "bad") });
    r.createSpan({ cls: "tgx-check-ic", text: ok ? "✓" : "✗" });
    const t = r.createDiv(); t.createDiv({ cls: "tgx-title", text: title }); if (detail) t.createDiv({ cls: "tgx-meta", text: detail });
  };
  el.createDiv({ cls: "tgx-meta", text: "Checking…" });
  const py = await capture(s.python, ["--version"]);
  el.empty();
  row(py.code === 0, "Python", py.code === 0 ? py.out : `"${s.python}" didn't run. Install Python 3.10+ and/or set the Python command above.`);
  const script = s.botDir && fs.existsSync(path.join(s.botDir, SCRIPT));
  row(!!script, "Bridge folder", script ? s.botDir : "Set the bridge folder above: the folder that contains tg_gtm.py.");
  if (py.code === 0 && script) {
    const w = await capture(s.python, ["-u", SCRIPT, "whoami"], { cwd: s.botDir });
    let j = null; try { j = JSON.parse(w.out.split("\n").pop()); } catch (e) { /* not JSON: shown raw */ }
    if (!j) row(false, "Telegram", w.out.split("\n").slice(-2).join(" ") || "no answer");
    else if (j.ok) row(true, "Telegram", `Logged in as ${j.name}${j.username ? " (@" + j.username + ")" : ""}`);
    else row(false, "Telegram", j.hint || j.error);
  }
  const cl = await capture(s.claude, ["--version"]);
  row(cl.code === 0, "Claude (optional, for summaries)", cl.code === 0 ? cl.out : "Claude Code CLI not found. Summaries won't work until you install it and set the Claude command above.");
}

// ================================================================== settings
class TGSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const c = this.containerEl; c.empty();
    const s = this.plugin.settings, save = () => this.plugin.saveSettings();
    new Setting(c).setName("Telegram").setHeading();
    new Setting(c).setName("Bridge folder").setDesc("The folder with tg_gtm.py and your config.py (the bridge folder of this repo, wherever you put it).")
      .addText((t) => t.setPlaceholder("C:\\Users\\you\\tg-bridge").setValue(s.botDir).onChange(async (v) => { s.botDir = v.trim(); await save(); }));
    new Setting(c).setName("Python command").setDesc("python, py, or a full path to python.exe.")
      .addText((t) => t.setValue(s.python).onChange(async (v) => { s.python = v.trim() || "python"; await save(); }));
    new Setting(c).setName("Notes folder").setDesc("Vault folder for the contacts note and saved follow-ups.")
      .addText((t) => t.setValue(s.noteDir).onChange(async (v) => { s.noteDir = v.trim() || "TG"; await save(); }));
    new Setting(c).setName("Claude").setHeading();
    new Setting(c).setName("Claude command").setDesc("Claude Code CLI used for Follow up summaries (claude, or a full path to claude.exe). Uses your Claude login.")
      .addText((t) => t.setValue(s.claude).onChange(async (v) => { s.claude = v.trim() || "claude"; await save(); }));
    new Setting(c).setName("Claude model").setDesc("Optional: sonnet, opus, haiku… Leave empty for your default.")
      .addText((t) => t.setValue(s.claudeModel).onChange(async (v) => { s.claudeModel = v.trim(); await save(); }));
    new Setting(c).setName("Messages to read").setDesc("How many of the latest messages Claude reads per group.")
      .addText((t) => t.setValue(String(s.historyLimit)).onChange(async (v) => { s.historyLimit = Math.max(20, parseInt(v, 10) || 400); await save(); }));
    new Setting(c).setName("Check").setHeading();
    const out = c.createDiv({ cls: "tgx tgx-check-out" });
    new Setting(c).setName("Check my setup").setDesc("Tests Python, Telethon, your Telegram login and the Claude CLI. Read-only.")
      .addButton((b) => b.setButtonText("Run check").setCta().onClick(() => runSetupCheck(s, out)));
    c.appendChild(out);
  }
}

class TGPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.migrate();
    addIcon(TG_ICON, TG_BADGE);
    this.registerView(VIEW_TYPE, (leaf) => new TGView(leaf, this));
    this.addRibbonIcon(TG_ICON, "TG", () => this.activate());
    this.addCommand({ id: "open", name: "Open TG", callback: () => this.activate() });
    for (const p of PAGES)
      this.addCommand({ id: "open-" + p.id, name: `Open ${p.label}`, callback: async () => { this.settings.page = p.id; await this.activate(); this.view()?.render(); } });
    this.addSettingTab(new TGSettings(this.app, this));
  }
  // Fill in anything a newer version added, and fall back to the Dashboard if the saved page is gone.
  migrate() {
    const s = this.settings;
    s.scan = Object.assign({}, DEFAULTS.scan, s.scan);
    if (s.page === "invite") s.page = "create";
    if (s.page === "message") s.page = "chats";
    if (!PAGES.some((p) => p.id === s.page)) s.page = "dashboard";
  }
  view() { const l =this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]; return l && l.view instanceof TGView ? l.view : null; }
  async activate() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = ws.getLeaf("tab"); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    ws.revealLeaf(leaf);
  }
  async saveSettings() { await this.saveData(this.settings); }
}

module.exports = TGPlugin;
