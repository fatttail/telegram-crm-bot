# Security

## What this software can do

The bridge (`bridge/tg_gtm.py`) is logged in **as you**. With that login it can read every chat you can
read, and the commands `send`, `leave`, `create` and `invite` change your Telegram account. The plugin only
runs those with `--confirm` after you click the button in a confirmation dialog; without `--confirm` they
print what they would do and stop.

## Where your data lives

| What | Where | Sensitive? |
|---|---|---|
| Telegram login | `bridge/<SESSION_NAME>.session` | **Yes, like a password.** Gives full access to your account |
| API keys | `bridge/config.py` | Yes, keep private |
| Contacts, chat history, dashboard data | `bridge/exports/` | Yes, personal data of other people |
| Categories, drafts, Claude summaries | `<vault>/.obsidian/plugins/tg-gtm/data.json` | Yes, can contain chat content |
| Contacts note, saved follow-ups | your vault (Notes folder setting) | Yes |

All of these are covered by `.gitignore`. Keep the bridge folder out of your vault and out of cloud sync.

## Network

* The bridge connects only to Telegram's servers, through Telethon.
* The plugin makes no network requests itself. It starts two local programs: Python (the bridge) and,
  only when you ask for a summary, the `claude` CLI.
* For a summary, the transcript of that one chat is passed to `claude -p --tools ""` on standard input.
  With tools disabled, Claude can't run commands, read files or browse; it only returns text.

## If something leaks

* Session file: Telegram → Settings → Devices → terminate the session, then delete the file.
* API keys: delete the app at https://my.telegram.org and create a new one.

## Reporting a problem

Open a GitHub issue **without** any session file, config, export or chat content. For anything that could
put accounts at risk, use GitHub's private "Report a vulnerability" on this repository instead of a public issue.
