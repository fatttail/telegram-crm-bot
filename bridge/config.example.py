# Copy this file to config.py (same folder) and fill it in. config.py is git-ignored: never share it.
#
# Get API_ID and API_HASH at https://my.telegram.org → "API development tools" → create an app
# (any title / short name, platform "Desktop"). They identify the app, not your account,
# but keep them private anyway.

API_ID = 1234567                      # a number
API_HASH = "0123456789abcdef0123456789abcdef"

# Name of the login file Telethon creates next to this script (<name>.session).
# That file IS your Telegram login: anyone who has it can use your account. Don't sync or share it.
SESSION_NAME = "tg_gtm"

# Optional: title words used when you run `scan` / `export` by hand without --ids-file.
# The Obsidian plugin has its own list (Set up → Scan), so you can leave this empty.
KEYWORDS = []
