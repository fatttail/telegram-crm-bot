"""
tg_gtm.py – the Telegram side of the TG Obsidian plugin. Runs on your computer, logs in as *you*
(a Telegram "userbot" via Telethon), and does what the plugin asks. Nothing here talks to any server
other than Telegram.

First time:   python tg_gtm.py login      # asks for your phone number, the code Telegram sends, and 2FA password
Check:        python tg_gtm.py whoami     # read-only, prints who you're logged in as

Everything the plugin does is a command here, so you can also run it by hand:
    chats                                  # every group / channel / DM as JSON (read-only)
    dashboard                              # unread state + your sent messages, for the Dashboard (read-only)
    history <chat_id> [--json]             # recent messages of one chat (read-only)
    export [--ids-file f.json]             # save the members of those groups to exports/ (read-only on Telegram)
    send message.txt --ids-file f.json [--confirm]     # one message to many chats, paced (dry run without --confirm)
    leave --ids-file f.json [--confirm]                # leave groups (never DMs, never groups you own)
    create --title "X <> You" [--users-file p.json] [--photo img.png] [--confirm]
    invite <group_id> --users-file p.json [--confirm]
Anything that changes Telegram is a dry run unless you add --confirm.
"""
import argparse, asyncio, csv, json, os, random, re, sqlite3, sys

try:
    import telethon  # noqa: F401
except ImportError:                                   # say it plainly (and as JSON for the plugin's setup check)
    hint = "Telethon isn't installed: run  pip install -r requirements.txt  in the bridge folder."
    print(json.dumps({"ok": False, "error": "telethon", "hint": hint}) if sys.argv[1:2] == ["whoami"] else hint)
    sys.exit(0 if sys.argv[1:2] == ["whoami"] else 1)
from datetime import datetime, timedelta, timezone
from pathlib import Path

from telethon import TelegramClient
from telethon.errors import (
    FloodWaitError, ChatAdminRequiredError, ChatWriteForbiddenError,
    UserBannedInChannelError, SlowModeWaitError,
)
from telethon.tl.functions.contacts import GetContactsRequest
from telethon.tl.functions.channels import CreateChannelRequest, EditPhotoRequest, InviteToChannelRequest
from telethon.tl.functions.messages import AddChatUserRequest, ExportChatInviteRequest
from telethon.tl.types import Channel, InputChatUploadedPhoto, PeerUser, User
from telethon.utils import get_peer_id

from telethon.errors import PeerFloodError, UserAlreadyParticipantError

# config.py (copy config.example.py) or environment variables TG_API_ID / TG_API_HASH
try:
    import config as _cfg
except ImportError:
    _cfg = None
API_ID = getattr(_cfg, "API_ID", None) or os.environ.get("TG_API_ID")
API_HASH = getattr(_cfg, "API_HASH", None) or os.environ.get("TG_API_HASH")
SESSION_NAME = getattr(_cfg, "SESSION_NAME", None) or "tg_gtm"
KEYWORDS = list(getattr(_cfg, "KEYWORDS", []) or [])     # optional: title words for `scan` / `export` without --ids-file

# Pacing for the goodbye message, slow on purpose so Telegram doesn't read it as spam:
# a random 25–60 s gap, a few seconds of "typing…" before each send, and a 4–8 min break
# after every 12 groups. ~308 groups ≈ 4–5 hours; Obsidian / the terminal must stay open.
GAP_MIN, GAP_MAX     = 25, 60
TYPING_MIN, TYPING_MAX = 3, 8
BATCH, BREAK_MIN, BREAK_MAX = 12, 240, 480

# Group titles matching any KEYWORDS (whole words for short ones), used when no --ids-file is given
TITLE_PATTERN = re.compile("|".join(r"(?<![a-z0-9])" + re.escape(k.lower()).replace(r"\ ", r"\s*") + r"(?![a-z0-9])"
                                    for k in KEYWORDS) or r"(?!x)x", re.I)

HERE    = Path(__file__).parent
EXPORTS = HERE / "exports"
DB      = EXPORTS / "contacts.db"


# ── helpers ───────────────────────────────────────────────────────────────────

def _client() -> TelegramClient:
    if not API_ID or not API_HASH:
        sys.exit("No Telegram API keys: copy config.example.py to config.py and fill API_ID / API_HASH (see README).")
    return TelegramClient(str(HERE / SESSION_NAME), int(API_ID), API_HASH)


async def _connect() -> TelegramClient:
    client = _client()
    await client.start()
    return client


def _active(d) -> bool:
    e = d.entity
    return not (getattr(e, "left", False) or getattr(e, "kicked", False) or getattr(e, "deactivated", False))


def _is_dm(d) -> bool:
    return (d.is_user and not getattr(d.entity, "bot", False) and not getattr(d.entity, "is_self", False)
            and d.entity.id != 777000)                   # 777000 = Telegram's own service notifications


async def _pick_chats(client, skip=(), only=None, dms=False):
    """Groups whose title matches KEYWORDS, or, with only=ids (from the plugin), exactly those chats of any name.
    DMs are only included when dms=True (sending), never for leave."""
    dialogs = await client.get_dialogs(limit=None)
    if only is not None:
        groups = [d for d in dialogs if d.id in only and
                  (((d.is_group or d.is_channel) and _active(d)) or (dms and _is_dm(d)))]
    else:
        groups = [d for d in dialogs
                  if (d.is_group or d.is_channel) and d.title and TITLE_PATTERN.search(d.title) and _active(d)]
    return [d for d in groups if d.id not in set(skip)]


def _only(args):
    """--ids-file: JSON list of group ids to act on (written by the Obsidian plugin)."""
    if not getattr(args, "ids_file", None):
        return None
    return set(int(i) for i in json.loads(Path(args.ids_file).read_text(encoding="utf-8")))


def _kind(d) -> str:
    e = d.entity
    if isinstance(e, Channel):
        return "channel" if e.broadcast else "supergroup"
    return "group"


def _role(d) -> str:
    e = d.entity
    if getattr(e, "creator", False):
        return "creator"
    if getattr(e, "admin_rights", None):
        return "admin"
    return "member"


def _print_groups(groups):
    print(f"\n{len(groups)} chats:\n")
    print(f"  {'id':<16} {'type':<11} {'role':<8} title")
    for d in groups:
        print(f"  {d.id:<16} {_kind(d):<11} {_role(d):<8} {d.title}")
    creators = [d.title for d in groups if _role(d) == "creator"]
    if creators:
        print("\n  ! you created: " + ", ".join(creators) +
              "\n    leaving does not delete them; transfer ownership first if needed.")


# ── commands ──────────────────────────────────────────────────────────────────

async def cmd_scan(client, args):
    groups = await _pick_chats(client)
    if args.json:
        print(json.dumps([{"id": d.id, "title": d.title, "type": _kind(d), "role": _role(d)}
                          for d in groups], ensure_ascii=False))
        return
    _print_groups(groups)


async def cmd_export(client, args):
    groups = await _pick_chats(client, only=_only(args))      # --ids-file: the chats you chose to scan
    _print_groups(groups)
    EXPORTS.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")

    contacts: dict[int, dict] = {}                 # user id -> row
    group_rows = []
    for d in groups:
        try:
            members = await client.get_participants(d.entity, limit=None)
            note = ""
        except (ChatAdminRequiredError, Exception) as e:
            members, note = [], f"members hidden ({type(e).__name__})"
        group_rows.append({"group_id": d.id, "title": d.title, "type": _kind(d),
                           "my_role": _role(d), "members": len(members), "note": note})
        print(f"  {len(members):>5} members  {d.title} {note}")
        for u in members:
            if not isinstance(u, User) or u.is_self:
                continue
            row = contacts.setdefault(u.id, {
                "user_id": u.id,
                "username": f"@{u.username}" if u.username else "",
                "first_name": u.first_name or "",
                "last_name": u.last_name or "",
                "phone": u.phone or "",
                "is_bot": int(bool(u.bot)),
                "in_my_contacts": int(bool(u.contact)),
                "groups": [],
            })
            row["groups"].append(d.title)

    # also your own Telegram address book, so nothing is lost
    for u in (await client(GetContactsRequest(hash=0))).users:
        row = contacts.setdefault(u.id, {
            "user_id": u.id, "username": f"@{u.username}" if u.username else "",
            "first_name": u.first_name or "", "last_name": u.last_name or "",
            "phone": u.phone or "", "is_bot": int(bool(u.bot)), "in_my_contacts": 1,
            "groups": [],
        })
        row["in_my_contacts"] = 1

    rows = sorted(contacts.values(), key=lambda r: (-len(r["groups"]), r["first_name"].lower()))
    for r in rows:
        r["group_count"] = len(r["groups"])
        r["groups"] = " | ".join(r["groups"])
        r["exported_at"] = stamp

    c_fields = ["user_id", "username", "first_name", "last_name", "phone", "is_bot",
                "in_my_contacts", "group_count", "groups", "exported_at"]
    g_fields = ["group_id", "title", "type", "my_role", "members", "note"]
    with open(EXPORTS / "contacts.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, c_fields); w.writeheader(); w.writerows(rows)
    with open(EXPORTS / "groups.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, g_fields); w.writeheader(); w.writerows(group_rows)

    con = sqlite3.connect(DB)
    con.execute("DROP TABLE IF EXISTS contacts"); con.execute("DROP TABLE IF EXISTS groups")
    con.execute(f"CREATE TABLE contacts ({', '.join(c_fields)})")
    con.execute(f"CREATE TABLE groups ({', '.join(g_fields)})")
    con.executemany(f"INSERT INTO contacts VALUES ({', '.join('?' * len(c_fields))})",
                    [[r[k] for k in c_fields] for r in rows])
    con.executemany(f"INSERT INTO groups VALUES ({', '.join('?' * len(g_fields))})",
                    [[r[k] for k in g_fields] for r in group_rows])
    con.commit(); con.close()

    print(f"\n✓ {len(rows)} contacts, {len(group_rows)} groups saved to {EXPORTS}")
    print("  contacts.csv · groups.csv · contacts.db")


async def cmd_send(client, args):
    text = Path(args.message_file).read_text(encoding="utf-8").strip()
    if not text:
        sys.exit("message file is empty")
    groups = await _pick_chats(client, args.skip, _only(args), dms=True)
    _print_groups(groups)
    print(f"\nmessage:\n---\n{text}\n---")
    if not args.confirm:
        print(f"\n[DRY RUN] would send to {len(groups)} groups. Add --confirm to send.")
        return
    sent, failed = 0, []
    random.shuffle(groups)                      # not in dialog order
    for i, d in enumerate(groups, 1):
        if i > 1:
            if (i - 1) % BATCH == 0:
                pause = random.uniform(BREAK_MIN, BREAK_MAX)
                print(f"  … break {pause / 60:.0f} min after {i - 1} groups")
            else:
                pause = random.uniform(GAP_MIN, GAP_MAX)
            await asyncio.sleep(pause)
        try:
            async with client.action(d.entity, "typing"):
                await asyncio.sleep(random.uniform(TYPING_MIN, TYPING_MAX))
            await client.send_message(d.entity, text)
            sent += 1
            print(f"  ✓ [{i}/{len(groups)}] {d.id} {d.title}")
        except PeerFloodError:
            print("  ✗ Telegram flagged the sends as spam (PeerFlood). Stopped: wait a day before resuming.")
            break
        except FloodWaitError as e:
            print(f"  … flood wait {e.seconds}s"); await asyncio.sleep(e.seconds + 5)
            try:
                await client.send_message(d.entity, text); sent += 1
                print(f"  ✓ [{i}/{len(groups)}] {d.id} {d.title}")
            except Exception as e2:
                failed.append((d.title, str(e2)))
        except (ChatWriteForbiddenError, UserBannedInChannelError, SlowModeWaitError, Exception) as e:
            failed.append((d.title, type(e).__name__))
            print(f"  ✗ [{i}/{len(groups)}] {d.title}: {type(e).__name__}")
    print(f"\nsent {sent}/{len(groups)}")
    for t, r in failed:
        print(f"  failed: {t} → {r}")


async def cmd_leave(client, args):
    if not (EXPORTS / "contacts.csv").exists():
        sys.exit("run `python tg_gtm.py export` first, so the contacts are saved.")
    groups = await _pick_chats(client, args.skip, _only(args))
    owned = [d for d in groups if _role(d) == "creator"]
    groups = [d for d in groups if _role(d) != "creator"]   # never leave a group you still own
    _print_groups(groups)
    if owned:
        print(f"\n  kept {len(owned)} groups you created (hand them over first): " +
              ", ".join(d.title for d in owned))
    if not args.confirm:
        print(f"\n[DRY RUN] would leave {len(groups)} groups. Add --confirm to leave.")
        return
    left = 0
    for i, d in enumerate(groups, 1):
        try:
            await client.delete_dialog(d.entity)      # leaves the group / channel
            left += 1
            print(f"  ✓ [{i}/{len(groups)}] {d.id} left {d.title}")
        except FloodWaitError as e:
            print(f"  … flood wait {e.seconds}s"); await asyncio.sleep(e.seconds + 5)
            try:
                await client.delete_dialog(d.entity); left += 1
                print(f"  ✓ [{i}/{len(groups)}] {d.id} left {d.title}")
            except Exception as e2:
                print(f"  ✗ [{i}/{len(groups)}] {d.title}: {type(e2).__name__}")
        except Exception as e:
            print(f"  ✗ [{i}/{len(groups)}] {d.title}: {type(e).__name__}")
        await asyncio.sleep(random.uniform(3, 7))
    print(f"\nleft {left}/{len(groups)}")


async def _resolve_group(client, group_id):
    try:
        return await client.get_entity(group_id)
    except Exception:                                 # not cached, or a stale access hash
        d = next((d for d in await client.get_dialogs(limit=None) if d.id == group_id), None)
        if d is None:
            sys.exit(f"group {group_id} not found: already left, or not in your chats.")
        return d.entity


async def cmd_history(client, args):
    """Write a group's recent messages as a plain transcript, oldest first (read-only)."""
    entity = await _resolve_group(client, args.group_id)
    me = await client.get_me()

    def who(u):
        if u is None:
            return "unknown"
        if getattr(u, "id", None) == me.id:
            return "me"
        name = getattr(u, "title", None) or f"{u.first_name or ''} {u.last_name or ''}".strip() or "unknown"
        return f"{name} (@{u.username})" if getattr(u, "username", None) else name

    def body(m):
        text = (m.message or "").strip()
        if m.media and not text:
            return f"[{type(m.media).__name__.replace('MessageMedia', '').lower() or 'media'}]"
        return text

    rows, items = [], []
    async for m in client.iter_messages(entity, limit=args.limit):
        if m.action or not (m.message or m.media):
            continue                                  # skip joins, pins, title changes
        sender = await m.get_sender()
        rows.append(f"[{m.date:%Y-%m-%d %H:%M}] {who(sender)}"
                    f"{' (reply)' if m.is_reply else ''}: {body(m)}")
        if args.json:
            mine = getattr(sender, "id", None) == me.id
            items.append({"id": m.id, "date": m.date.isoformat(), "me": mine,
                          "from": "me" if mine else who(sender).split(" (@")[0],
                          "username": getattr(sender, "username", None),
                          "text": (m.message or "").strip(), "media": body(m) if m.media and not m.message else None,
                          "reply": m.is_reply})
    rows.reverse(); items.reverse()
    if args.json:                                     # for the plugin's conversation view
        print(json.dumps(items, ensure_ascii=False))
        return
    title = getattr(entity, "title", str(args.group_id))
    out = EXPORTS / "history" / f"{args.group_id}.txt"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(f"Group: {title}\nMessages: {len(rows)} (most recent {args.limit} max)\n\n" + "\n".join(rows),
                   encoding="utf-8")
    print(f"✓ history {len(rows)} messages → {out}")


# ── workspace: any chat ──────────────────────────────────────────

def _can_invite(e) -> bool:
    if getattr(e, "deactivated", False) or getattr(e, "migrated_to", None):
        return False
    if getattr(e, "creator", False):
        return True
    rights = getattr(e, "admin_rights", None)
    if rights:
        return bool(rights.invite_users)
    if isinstance(e, Channel) and e.broadcast:
        return False
    banned = getattr(e, "default_banned_rights", None)
    return not (banned and banned.invite_users)


async def cmd_chats(client, args):
    """Every group, channel and DM you have, as one JSON line (read-only)."""
    out = []
    for d in await client.get_dialogs(limit=None):
        e = d.entity
        last = d.date.isoformat() if d.date else None
        if _is_dm(d):
            out.append({"id": d.id, "title": d.name or "Deleted account", "type": "dm", "role": "",
                        "username": getattr(e, "username", None), "match": False, "can_invite": False,
                        "members": None, "last": last, "unread": d.unread_count})
            continue
        if not (d.is_group or d.is_channel) or not d.title or not _active(d):
            continue                                  # basic groups you left still sit in the dialog list
        out.append({"id": d.id, "title": d.title, "type": _kind(d), "role": _role(d),
                    "username": getattr(e, "username", None),
                    "match": bool(TITLE_PATTERN.search(d.title)), "can_invite": _can_invite(e),
                    "members": getattr(e, "participants_count", None), "last": last, "unread": d.unread_count})
    print(json.dumps(out, ensure_ascii=False))


def _users_arg(args):
    """--users-file: JSON list of "@username" or numeric user ids (written by the Obsidian plugin)."""
    return [str(u).strip() for u in json.loads(Path(args.users_file).read_text(encoding="utf-8-sig")) if str(u).strip()]


async def _resolve_user(client, ref):
    ref = ref.strip()
    if ref.lstrip("-").isdigit():
        return await client.get_entity(PeerUser(int(ref)))   # works for anyone seen before (e.g. via export)
    return await client.get_entity(ref.lstrip("@").replace("https://t.me/", ""))


INVITE_ERRORS = {
    "UserPrivacyRestrictedError": "their privacy settings don't allow it",
    "UserNotMutualContactError": "not a mutual contact",
    "UserChannelsTooMuchError": "they're in too many groups",
    "UserKickedError": "they were removed from this group before",
    "UserBannedInChannelError": "you're limited by Telegram right now",
    "ChatAdminRequiredError": "you need admin rights here",
    "InputUserDeactivatedError": "account deleted",
    "UserBotError": "bots can't be added this way",
    "UsersTooMuchError": "the group is full",
}


async def _invite_all(client, group, refs):
    """Add people one by one with a short pause; returns (added, failed). Stops if Telegram limits you."""
    added, failed = [], []
    for i, ref in enumerate(refs, 1):
        try:
            user = await _resolve_user(client, ref)
        except Exception:
            failed.append({"user": ref, "reason": "couldn't find this account"})
            print(f"  ✗ [{i}/{len(refs)}] {ref}: not found"); continue
        label = f"@{user.username}" if user.username else (f"{user.first_name or ''} {user.last_name or ''}".strip() or ref)
        try:
            if isinstance(group, Channel):
                r = await client(InviteToChannelRequest(group, [user]))
            else:
                r = await client(AddChatUserRequest(group.id, user, fwd_limit=100))
            if getattr(r, "missing_invitees", None):
                failed.append({"user": label, "reason": INVITE_ERRORS["UserPrivacyRestrictedError"]})
                print(f"  ✗ [{i}/{len(refs)}] {label}: privacy")
            else:
                added.append(label); print(f"  ✓ [{i}/{len(refs)}] added {label}")
        except UserAlreadyParticipantError:
            added.append(label); print(f"  ✓ [{i}/{len(refs)}] {label} already in")
        except PeerFloodError:
            failed += [{"user": r_, "reason": "not tried: Telegram limited adding for now"} for r_ in [label, *refs[i:]]]
            print("  ! Telegram says too many adds: stopping. Try the rest in a few hours."); break
        except FloodWaitError as e:
            if e.seconds > 300:
                failed += [{"user": r_, "reason": f"not tried: Telegram asks to wait {e.seconds // 60} min"} for r_ in [label, *refs[i:]]]
                print(f"  ! flood wait {e.seconds}s: stopping."); break
            print(f"  … flood wait {e.seconds}s"); await asyncio.sleep(e.seconds + 3)
            failed.append({"user": label, "reason": "rate limited, try again"})
        except Exception as e:
            reason = INVITE_ERRORS.get(type(e).__name__, type(e).__name__)
            failed.append({"user": label, "reason": reason}); print(f"  ✗ [{i}/{len(refs)}] {label}: {reason}")
        if i < len(refs):
            await asyncio.sleep(random.uniform(4, 9))
    return added, failed


async def _invite_link(client, group):
    try:
        return (await client(ExportChatInviteRequest(group))).link
    except Exception:
        return None


def _result(**kw):
    print("RESULT " + json.dumps(kw, ensure_ascii=False))     # last line, read by the Obsidian plugin


async def cmd_create(client, args):
    """Create a private supergroup (you own it) and add people to it."""
    refs = _users_arg(args) if args.users_file else []
    if args.photo and not Path(args.photo).exists():
        sys.exit(f"photo not found: {args.photo}")
    if not args.confirm:
        print(f"[DRY RUN] would create “{args.title}”{' with a photo' if args.photo else ''}"
              f" and add {len(refs)} people: {', '.join(refs) or 'nobody yet'}")
        return
    r = await client(CreateChannelRequest(title=args.title, about=args.about or "", megagroup=True))
    group = r.chats[0]
    gid = get_peer_id(group)
    print(f"✓ created “{args.title}” ({gid})")
    if args.photo:
        try:
            await client(EditPhotoRequest(group, InputChatUploadedPhoto(await client.upload_file(args.photo))))
            print("  ✓ group photo set")
        except Exception as e:
            print(f"  ✗ couldn't set the photo: {type(e).__name__}")
    added, failed = await _invite_all(client, group, refs)
    _result(id=gid, title=args.title, added=added, failed=failed, link=await _invite_link(client, group))


async def cmd_invite(client, args):
    """Add people to a group you're in."""
    group = await _resolve_group(client, args.group_id)
    refs = _users_arg(args)
    if not args.confirm:
        print(f"[DRY RUN] would add {len(refs)} people to “{getattr(group, 'title', args.group_id)}”: {', '.join(refs)}")
        return
    added, failed = await _invite_all(client, group, refs)
    _result(id=args.group_id, title=getattr(group, "title", ""), added=added, failed=failed,
            link=await _invite_link(client, group) if failed else None)


# ── dashboard ─────────────────────────────────────────────────────────────────

async def cmd_dashboard(client, args):
    """Read-only snapshot for the plugin's Dashboard: every chat's unread state and last message, plus,
    for chats active in the last --days, when you sent messages and (DMs) how fast you replied."""
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=args.days)

    def name(u):
        if u is None:
            return ""
        return getattr(u, "title", None) or f"{getattr(u, 'first_name', '') or ''} {getattr(u, 'last_name', '') or ''}".strip()

    def preview(m):
        text = (m.message or "").strip().replace("\n", " ")
        if not text and m.media:
            text = f"[{type(m.media).__name__.replace('MessageMedia', '').lower() or 'media'}]"
        return text[:180]

    rows, active = [], []
    for d in await client.get_dialogs(limit=None):
        if _is_dm(d):
            kind = "dm"
        elif (d.is_group or d.is_channel) and d.title and _active(d):
            kind = _kind(d)
        else:
            continue
        mute = getattr(getattr(d.dialog, "notify_settings", None), "mute_until", None)
        m = d.message
        last = None
        if m is not None:
            last = {"date": m.date.isoformat(), "out": bool(m.out),
                    "from": "me" if m.out else (name(m.sender) if kind != "dm" else d.name), "text": preview(m)}
        row = {"id": d.id, "title": d.name or d.title or "Deleted account", "type": kind, "role": _role(d) if kind != "dm" else "",
               "username": getattr(d.entity, "username", None), "unread": d.unread_count,
               "mentions": d.unread_mentions_count, "muted": bool(mute and mute > now), "last": last,
               "sent": [], "recv": 0, "reply_min": []}
        rows.append(row)
        if d.date and d.date >= cutoff:
            active.append((d, row))

    active = active[:args.max]
    for i, (d, row) in enumerate(active, 1):
        try:
            if row["type"] == "dm":
                msgs = []
                async for m in client.iter_messages(d.entity, limit=args.per_chat):
                    if m.date < cutoff:
                        break
                    if not m.action:
                        msgs.append((m.date, bool(m.out)))
                msgs.reverse()
                waiting_since = None                       # first message of theirs you haven't answered yet
                for date, out in msgs:
                    if out:
                        row["sent"].append(date.isoformat())
                        if waiting_since:
                            row["reply_min"].append(round((date - waiting_since).total_seconds() / 60))
                            waiting_since = None
                    else:
                        row["recv"] += 1
                        waiting_since = waiting_since or date
            else:
                async for m in client.iter_messages(d.entity, from_user="me", limit=args.per_chat):
                    if m.date < cutoff:
                        break
                    row["sent"].append(m.date.isoformat())
            print(f"  ✓ [{i}/{len(active)}] {d.id} {row['title']}")
        except FloodWaitError as e:
            print(f"  … flood wait {e.seconds}s"); await asyncio.sleep(e.seconds + 2)
        except Exception as e:
            print(f"  ✗ [{i}/{len(active)}] {row['title']}: {type(e).__name__}")

    EXPORTS.mkdir(exist_ok=True)
    out = EXPORTS / "dashboard.json"
    out.write_text(json.dumps({"loaded": now.isoformat(), "days": args.days, "chats": rows}, ensure_ascii=False), encoding="utf-8")
    _result(file=str(out), chats=len(rows), active=len(active))


# ── login ─────────────────────────────────────────────────────────────────────

async def cmd_login(client, args):
    me = await client.get_me()
    print(f"✓ logged in as {me.first_name or ''} {me.last_name or ''}".rstrip() + (f" (@{me.username})" if me.username else ""))
    print(f"  session saved in {HERE / (SESSION_NAME + '.session')}: keep that file private, it is your login.")


async def whoami():
    """Never prompts: tells the plugin's setup check whether the login works."""
    try:
        import telethon  # noqa: F401
    except ImportError:
        return {"ok": False, "error": "telethon", "hint": "Telethon isn't installed: run  pip install -r requirements.txt  in the bridge folder."}
    if not API_ID or not API_HASH:
        return {"ok": False, "error": "config", "hint": "No API keys: copy config.example.py to config.py and fill API_ID / API_HASH."}
    client = _client()
    try:
        await client.connect()
        if not await client.is_user_authorized():
            return {"ok": False, "error": "login", "hint": "Not logged in yet: open a terminal in the bridge folder and run  python tg_gtm.py login"}
        me = await client.get_me()
        return {"ok": True, "name": f"{me.first_name or ''} {me.last_name or ''}".strip(), "username": me.username}
    except Exception as e:
        return {"ok": False, "error": type(e).__name__, "hint": str(e)[:200]}
    finally:
        await client.disconnect()


# ── entry ─────────────────────────────────────────────────────────────────────

def cmd_note(args):
    """Write the saved contacts as an A–Z Markdown note (no Telegram connection needed)."""
    import unicodedata
    from collections import defaultdict
    src = EXPORTS / "contacts.csv"
    if not src.exists():
        sys.exit("run `python tg_gtm.py export` first.")
    rows = list(csv.DictReader(open(src, encoding="utf-8-sig")))
    cell = lambda s: str(s or "").replace("|", "/").replace("\n", " ").strip()
    name = lambda r: cell(f"{r['first_name']} {r['last_name']}") or cell(r["username"]) or f"id {r['user_id']}"
    def key(r):
        k = unicodedata.normalize("NFKD", name(r)).encode("ascii", "ignore").decode().lower()
        return re.sub(r"^[^a-z0-9]+", "", k) or "~"
    letter = lambda r: key(r)[0].upper() if key(r)[0].isalpha() else "Other"

    people = sorted([r for r in rows if r["is_bot"] != "1"], key=key)
    bots = sorted([r for r in rows if r["is_bot"] == "1"], key=key)
    sections = defaultdict(list)
    for r in people:
        sections[letter(r)].append(r)
    order = sorted(sections, key=lambda l: (l == "Other", l))

    def groups(r):
        g = [x.strip() for x in r["groups"].split(" | ") if x.strip()]
        return ", ".join(cell(x) for x in g[:3]) + (f" *+{len(g) - 3} more*" if len(g) > 3 else "")

    def table(rs):
        out = ["| Name | Telegram | Phone | Shared groups | Groups |", "| :-- | :-- | :-- | --: | :-- |"]
        for r in rs:
            u = r["username"]
            tg = f"[{u}](https://t.me/{u[1:]})" if u else ""
            star = " ⭐" if r["in_my_contacts"] == "1" else ""
            phone = f"+{r['phone']}" if r["phone"] else ""
            out.append(f"| **{name(r)}**{star} | {tg} | {phone} | {r['group_count']} | {groups(r)} |")
        return out

    stamp = rows[0]["exported_at"] if rows else ""
    lines = ["---", "tags: [contacts, telegram]", f"exported: {stamp}", f"contacts: {len(people)}",
             "source: tg_gtm.py exports/contacts.csv", "---", "", "# Telegram Contacts", "",
             f"> [!info] {len(people)} people from your scanned Telegram groups, A to Z · saved {stamp}",
             f"> ⭐ = in your Telegram address book · {sum(1 for r in people if r['username'])} with a username"
             f" · {sum(1 for r in people if r['phone'])} with a phone · {len(bots)} bots listed at the end",
             "", "**Jump to:** " + " · ".join(f"[[#{l}]]" for l in order), ""]
    for l in order:
        lines += [f"## {l}", "", *table(sections[l]), ""]
    if bots:
        lines += ["## Bots", "", *table(bots), ""]
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"✓ {len(people)} contacts A–Z → {out}")


def main():
    ap = argparse.ArgumentParser(description="Telegram side of the TG Obsidian plugin.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sc = sub.add_parser("scan"); sc.add_argument("--json", action="store_true")
    ex = sub.add_parser("export"); ex.add_argument("--ids-file")
    n = sub.add_parser("note"); n.add_argument("out")
    s = sub.add_parser("send"); s.add_argument("message_file")
    l = sub.add_parser("leave")
    h = sub.add_parser("history"); h.add_argument("group_id", type=int); h.add_argument("--limit", type=int, default=400)
    h.add_argument("--json", action="store_true")
    sub.add_parser("chats")
    db = sub.add_parser("dashboard"); db.add_argument("--days", type=int, default=62)
    db.add_argument("--max", type=int, default=400); db.add_argument("--per-chat", type=int, default=400)
    c = sub.add_parser("create"); c.add_argument("--title", required=True); c.add_argument("--about", default="")
    c.add_argument("--photo"); c.add_argument("--users-file"); c.add_argument("--confirm", action="store_true")
    iv = sub.add_parser("invite"); iv.add_argument("group_id", type=int); iv.add_argument("--users-file", required=True)
    iv.add_argument("--confirm", action="store_true")
    for p in (s, l):
        p.add_argument("--confirm", action="store_true")
        p.add_argument("--skip", type=int, action="append", default=[])
        p.add_argument("--ids-file")
    sub.add_parser("login"); sub.add_parser("whoami")
    args = ap.parse_args()
    if args.cmd == "note":
        return cmd_note(args)
    if args.cmd == "whoami":
        return print(json.dumps(asyncio.run(whoami()), ensure_ascii=False))

    async def run():
        client = await _connect()
        try:
            await {"scan": cmd_scan, "export": cmd_export,
                   "send": cmd_send, "leave": cmd_leave, "history": cmd_history,
                   "chats": cmd_chats, "create": cmd_create, "invite": cmd_invite,
                   "dashboard": cmd_dashboard, "login": cmd_login}[args.cmd](client, args)
        finally:
            await client.disconnect()
    asyncio.run(run())


if __name__ == "__main__":
    main()
