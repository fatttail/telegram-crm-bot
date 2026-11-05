# TG: Telegram GTM inside Obsidian

**Your Telegram, run like a CRM, from Obsidian.** If your deals, partners and investors live in Telegram
chats, TG turns them into something you can manage: tag every chat by partnership type (Fund, VC,
Exchange…), see at a glance who's waiting on your reply and which relationships are going cold, message
a whole category in one go without looking like spam, and let Claude tell you where each conversation
stands and what to do next.

It works with your **own** Telegram account (not a bot), runs entirely on your computer, and keeps your
data in your vault. No server, no subscription, no telemetry.

| Page | What it does |
|---|---|
| **Dashboard** | Messages you sent today / this week / this month, unread notifications grouped by category, who's waiting on your reply, median reply time, category coverage, chats going cold |
| **Follow up** | Flag a chat with ⚡ and Claude sums it up: where things stand, open threads, what to do next, a draft reply |
| **Chats** | *Browse & sort*: every chat you scan, with its conversation and a category (Fund, VC, Exchange…). *Send to a category*: one message to every chat in a category, paced like a person, with each chat's conversation and Claude summary next to it |
| **Contacts** | Everyone in the groups you scan, saved to CSV / SQLite / an A–Z note in your vault |
| **Leave groups** | Tick groups to leave (never DMs, never groups you own) |
| **Set up** | **Scan** (which chats the plugin looks at, by words in the title), **Categories** (your partnership types), **New group** (create a group with a photo and people, or add people to an existing one) |

Everything that changes Telegram (send, leave, create, add people) has a **Dry run** and a confirmation dialog.

---

## How it fits together

```
 Obsidian (this plugin) ──runs──▶  bridge/tg_gtm.py  ──MTProto──▶  Telegram
        │                         (Python + Telethon, on your computer,
        │                          logged in as you)
        └──runs (optional)──────▶  claude  (Claude Code CLI)  ──▶  Anthropic
                                   only for summaries, with tools disabled
```

* The **plugin** is plain JavaScript (`main.js`, no build step, no minification), so you can read all of it.
* The **bridge** is one Python file. The plugin starts it for each task and reads what it prints.
  It's also a normal command-line tool (`python tg_gtm.py --help`).
* **Claude** is optional. It's only used when you ask for a summary.

There's no server, no account and no telemetry. Data only goes to Telegram (your own client, exactly like
the Telegram app) and, if you use summaries, to Anthropic through your own Claude Code login.

---

## Read this first: safety

1. **This logs in as you.** The bridge is a "userbot": it uses your account through Telegram's official
   API, like any third-party Telegram app. Telegram allows that, but **spam gets accounts limited or
   banned**. Bundle messages are paced on purpose (25–60 s apart, "typing…" first, a 4–8 min break every
   12 chats, stops automatically if Telegram complains). Don't message people who don't know you.
2. **The `.session` file is your login.** The first login creates `bridge/<name>.session`. Anyone who gets
   that file can use your Telegram without your password. So:
   * keep the bridge folder **outside your vault** and outside cloud-synced folders (OneDrive, iCloud, Dropbox),
   * never commit it (the `.gitignore` already blocks `*.session` and `config.py`),
   * if you think it leaked: Telegram → Settings → Devices → end that session.
3. **The plugin's `data.json` can contain chat content.** Categories, drafts and Claude summaries are
   saved in `<vault>/.obsidian/plugins/tg-gtm/data.json`. If your vault syncs or is shared, so is that file.
4. **Summaries send that chat's text to Anthropic.** When you click Summarize, the last messages of that
   one chat (400 by default) go to Claude via your Claude Code login. Claude runs with **all tools disabled**
   (`--tools ""`), so it can only read the text and write a reply. Nothing is sent to Claude unless you ask.
5. **Review before you trust it.** It's two readable files. Look at what `send`, `leave`, `create` and
   `invite` do in `bridge/tg_gtm.py` before you use them.

More in [SECURITY.md](SECURITY.md).

---

## What you need

* **Obsidian desktop** (Windows, macOS or Linux). The plugin is desktop-only because it starts local programs.
* **Python 3.10+** ([python.org](https://www.python.org/downloads/); on Windows tick *"Add python.exe to PATH"*).
* A **Telegram account**.
* *Optional, for summaries:* **Claude Code** with a Claude subscription or Anthropic account.

---

## Install, step by step

### 1. Get the files

```bash
git clone https://github.com/<you>/obsidian-tg-gtm.git
```

or **Code → Download ZIP** on GitHub and unzip it.

### 2. Put the plugin in your vault

1. In your vault, open the hidden folder `.obsidian/plugins/` (create `plugins` if it doesn't exist).
   On macOS press `Cmd+Shift+.` in Finder to show hidden folders; on Windows tick *View → Hidden items*.
2. Create a folder named **`tg-gtm`** in it and copy **`main.js`, `manifest.json` and `styles.css`** into it.
   ```
   <your vault>/.obsidian/plugins/tg-gtm/main.js
   <your vault>/.obsidian/plugins/tg-gtm/manifest.json
   <your vault>/.obsidian/plugins/tg-gtm/styles.css
   ```
3. Obsidian → **Settings → Community plugins** → turn off *Restricted mode* if it's on → click the refresh
   icon → enable **TG**. A Telegram icon appears in the left ribbon.

> Using [BRAT](https://github.com/TfTHacker/obsidian42-brat)? *BRAT → Add beta plugin* → paste this repo's URL.
> That works once the repo has a GitHub release with those three files attached.

### 3. Set up the Telegram bridge

Put the **`bridge`** folder somewhere private on your computer, **not in your vault** (it will hold your
login). For example `C:\Users\you\tg-bridge` or `~/tg-bridge`.

**a. Install the Telegram library.** Open a terminal *in that folder*:

```bash
pip install -r requirements.txt          # macOS / Linux: pip3 install -r requirements.txt
```

**b. Get your API keys.** Telegram requires every app to have an `api_id` and `api_hash`:

1. Go to **https://my.telegram.org** and log in with your phone number (the code arrives in your Telegram app).
2. Click **API development tools**.
3. Fill *App title* and *Short name* (anything, e.g. "my obsidian"), platform **Desktop**, then **Create application**.
4. Copy **App api_id** (a number) and **App api_hash** (a long hex string).

**c. Write `config.py`.** Copy `config.example.py` to `config.py` and paste the two values:

```python
API_ID = 1234567
API_HASH = "0123456789abcdef0123456789abcdef"
SESSION_NAME = "tg_gtm"
```

(Prefer environment variables? Set `TG_API_ID` and `TG_API_HASH` instead and skip `config.py`.)

**d. Log in once**, still in that folder:

```bash
python tg_gtm.py login                   # macOS / Linux: python3 tg_gtm.py login
```

It asks for your phone number in international format (`+33612345678`), then the code Telegram sends to
your app, then your two-step verification password if you have one. You'll see
`✓ logged in as <your name>`, and a `tg_gtm.session` file appears. You won't need to log in again.

Check it any time (read-only):

```bash
python tg_gtm.py whoami
```

### 4. Connect Obsidian to the bridge

Obsidian → **Settings → TG**:

| Setting | What to put |
|---|---|
| **Bridge folder** | The full path of the folder with `tg_gtm.py`, e.g. `C:\Users\you\tg-bridge` or `/Users/you/tg-bridge` |
| **Python command** | `python` (Windows) or `python3` (macOS / Linux), or the full path to it |
| **Notes folder** | Vault folder for the contacts note and saved follow-ups (default `TG`) |

Then click **Run check** at the bottom. You want four green ticks: *Python*, *Bridge folder*,
*Telegram (Logged in as …)* and, if you set it up, *Claude*. Each red line tells you what to fix.

### 5. Connect Claude (optional, for summaries)

The plugin doesn't need an API key. It calls the **Claude Code** command-line tool, which uses your own Claude login.

1. Install Claude Code ([official guide](https://docs.claude.com/en/docs/claude-code/setup)), for example:
   * Windows (PowerShell): `irm https://claude.ai/install.ps1 | iex`
   * macOS / Linux: `curl -fsSL https://claude.ai/install.sh | bash`
   * or with Node.js: `npm install -g @anthropic-ai/claude-code`
2. Run `claude` once in a terminal and log in.
3. Find where it's installed: `where claude` (Windows) or `which claude` (macOS / Linux).
4. In **Settings → TG → Claude command**, put that full path, e.g. `C:\Users\you\.local\bin\claude.exe`.
   Obsidian often doesn't see the same PATH as your terminal, so the full path is the safe choice.
5. Optional: **Claude model** (`sonnet`, `opus`, `haiku`; empty = your default) and **Messages to read** per summary.

Click **Run check** again: the *Claude* line should turn green.

---

## First 10 minutes

1. Open TG from the ribbon icon.
2. **Set up → Scan.** Add words that appear in the titles of groups you care about (a company name,
   `<>`, `Fund`…), then tick or untick single groups. Turn on *Also scan all my DMs* if you want DMs in.
3. **Set up → Categories.** Click the common ones (Fund, VC, Market maker, Exchange…) or create your own.
4. **Chats → Browse & sort.** Give chats a category, one by one or several at once
   (tick them, then *Set category…*). Click any chat to read it.
5. **Dashboard → Load my messages.** Takes a few seconds, read-only.
6. **Chats → Send to a category** when you want to message, say, every Fund. Always try **Dry run** first.

---

## Troubleshooting

| What you see | Fix |
|---|---|
| *Set the bridge folder in TG settings first* | Settings → TG → Bridge folder |
| Check: *Python didn't run* | Install Python, or set the full path (`where python` / `which python3`) |
| Check: *Telethon isn't installed* | `pip install -r requirements.txt` in the bridge folder, with the **same** Python the plugin uses |
| Check: *No API keys* | Create `config.py` from `config.example.py` (step 3c) |
| Check / log: *Not logged in* | `python tg_gtm.py login` in a terminal (step 3d) |
| *the Telegram session is busy* | Another program is using the same `.session` file. Close it, or give it its own `SESSION_NAME` |
| *Claude CLI not found* | Use the full path to `claude` in settings (step 5) |
| Sending stopped with *PeerFlood* | Telegram thinks it's spam. Stop for 24 h, send less, and only to people who know you |
| Some people "couldn't be added" | Their privacy settings block it. The plugin gives you an invite link to send them instead |

The **Log** bar at the bottom of the TG view shows exactly what the bridge printed.

---

## Updating and uninstalling

* **Update:** replace `main.js`, `manifest.json`, `styles.css` in `.obsidian/plugins/tg-gtm/` and
  `tg_gtm.py` in your bridge folder, then reload the plugin. Your settings and login stay.
* **Uninstall:** disable and delete the plugin in Obsidian, delete the bridge folder (including the
  `.session` file), and end the session in Telegram → Settings → Devices.

## Command-line reference

```bash
python tg_gtm.py whoami                          # who am I logged in as (never prompts)
python tg_gtm.py chats                           # all chats as JSON (read-only)
python tg_gtm.py dashboard                       # writes exports/dashboard.json (read-only)
python tg_gtm.py history <chat_id> [--json]      # recent messages of one chat (read-only)
python tg_gtm.py export --ids-file groups.json   # members of those groups → exports/contacts.csv
python tg_gtm.py send msg.txt --ids-file chats.json [--confirm]
python tg_gtm.py leave --ids-file groups.json [--confirm]
python tg_gtm.py create --title "Acme <> You" [--users-file people.json] [--photo logo.png] [--confirm]
python tg_gtm.py invite <group_id> --users-file people.json [--confirm]
```

`*.json` id files are plain lists, e.g. `[-1001234567890, 123456789]`; people files are `["@username", "123456789"]`.
Without `--confirm`, every command that would change Telegram only prints what it would do.

## Disclaimer

Not affiliated with Telegram or Anthropic. Use it in line with
[Telegram's Terms of Service](https://telegram.org/tos) and API terms. You're responsible for what you send
from your account. MIT licensed: see [LICENSE](LICENSE).
