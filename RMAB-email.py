#!/usr/bin/env python3
"""
RMAB "your audiobook is ready" emailer (any SMTP provider).

Reads available audiobook requests from RMAB's Postgres (read-only), and emails
each requesting user ONE summary of everything newly available since the last run.

Usage:
    python3 rmab_notify.py              # normal run (cron every 10-15 min)
    python3 rmab_notify.py --dry-run    # print what would be sent, change nothing
"""
import argparse
import fcntl
import json
import smtplib
import subprocess
import sys
from collections import defaultdict
from email.message import EmailMessage
from email.utils import formataddr
from pathlib import Path

# ============================== CONFIG ==============================
# RMAB container + embedded Postgres. These are RMAB's defaults; only change them if you
# set POSTGRES_USER / POSTGRES_DB yourself in your compose/Portainer environment.
CONTAINER = "readmeabook"
PGUSER = "readmeabook"
PGDB = "readmeabook"

# State and lock files live next to this script
SCRIPT_DIR = Path(__file__).resolve().parent
STATE_FILE = SCRIPT_DIR / "notified.json"   # remembers which requests were already emailed
LOCK_FILE = SCRIPT_DIR / "notify.lock"

# ---- Outgoing email (works with any SMTP provider) ----
# Examples:
#   Gmail     smtp.gmail.com            587 starttls   (needs 2-Step Verification + an App Password)
#   Outlook   smtp.office365.com        587 starttls
#   Yahoo     smtp.mail.yahoo.com       465 ssl        (App Password)
#   Fastmail  smtp.fastmail.com         465 ssl        (App Password)
#   Your own  mail.example.com          25  none       (internal relay, no login: leave SMTP_USER empty)
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587
SMTP_SECURITY = "starttls"          # "starttls" (usually port 587), "ssl" (usually port 465) or "none"
SMTP_USER = "YOUR-USER@gmail.com"         # login name; leave empty if the server needs no login
SMTP_PASSWORD = "YOUR-PASSWORD"   # sent exactly as written; for Gmail use an App Password
SMTP_TIMEOUT = 30                   # seconds

FROM_ADDRESS = "YOUR-USER@gmail.com"      # "send as" address shown to recipients (must be allowed by your provider)
FROM_NAME = "ReadMeABook"     # display name; leave empty to show just the address
REPLY_TO = "YOUR-USER@gmail.com"                       # optional: where replies go; leave empty to use FROM_ADDRESS

# RMAB username (case-insensitive) -> one or more recipient addresses.
# Everyone in a user's list gets the same email.
USERS = {
    "alice": ["alice@gmail.com"],
    "bob": ["bob@example.com", "bobs.wife@example.com"],   
}

# If a user isn't listed above, fall back to the email stored in RMAB (if any).
USE_DB_EMAIL_FALLBACK = True
# =====================================================================

SQL = """
SELECT COALESCE(json_agg(t), '[]') FROM (
  SELECT r.id, u.plex_username AS username, u.plex_email AS email,
         a.title, a.author
  FROM requests r
  JOIN users u ON u.id = r.user_id
  JOIN audiobooks a ON a.id = r.audiobook_id
  WHERE r.status = 'available'
    AND r.type = 'audiobook'
    AND r.deleted_at IS NULL
  ORDER BY a.title
) t;
"""


def query():
    out = subprocess.run(
        ["docker", "exec", CONTAINER, "psql", "-U", PGUSER, "-d", PGDB, "-At", "-c", SQL],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)


def load_state():
    if not STATE_FILE.exists():
        return None
    return set(json.loads(STATE_FILE.read_text()))


def save_state(done):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(sorted(done)))
    tmp.replace(STATE_FILE)


def connect_smtp():
    security = SMTP_SECURITY.strip().lower()
    if security == "ssl":
        smtp = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=SMTP_TIMEOUT)
    else:
        smtp = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=SMTP_TIMEOUT)
        if security == "starttls":
            smtp.starttls()
    if SMTP_USER:
        smtp.login(SMTP_USER, SMTP_PASSWORD)
    return smtp


def recipients(username, db_email):
    users = {k.lower(): v for k, v in USERS.items()}
    to = users.get((username or "").lower())
    if to:
        return [to] if isinstance(to, str) else list(to)
    if USE_DB_EMAIL_FALLBACK and db_email:
        return [db_email]
    return []


def build_message(to_list, username, books):
    m = EmailMessage()
    m["From"] = formataddr((FROM_NAME, FROM_ADDRESS)) if FROM_NAME else FROM_ADDRESS
    if REPLY_TO:
        m["Reply-To"] = REPLY_TO
    m["To"] = ", ".join(to_list)
    if len(books) == 1:
        m["Subject"] = f"Now available: {books[0]['title']}"
    else:
        m["Subject"] = f"{len(books)} audiobooks are now available"
    lines = [f"Hi {username},", ""]
    lines.append("Your requested audiobook is ready in the library:" if len(books) == 1
                 else "Your requested audiobooks are ready in the library:")
    lines.append("")
    for b in books:
        lines.append(f"  - {b['title']} by {b['author']}")
    lines.append("")
    lines.append("Enjoy!")
    m.set_content("\n".join(lines))
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="print emails, send nothing, change no state")
    args = ap.parse_args()

    # Prevent overlapping runs (e.g. cron firing while a previous run is still going)
    lock = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("Another run is in progress; exiting.")
        return 0

    if SMTP_SECURITY.strip().lower() not in ("starttls", "ssl", "none"):
        print(f'SMTP_SECURITY must be "starttls", "ssl" or "none" (got "{SMTP_SECURITY}")', file=sys.stderr)
        return 2
    if not args.dry_run and (not SMTP_HOST or not FROM_ADDRESS):
        print("SMTP_HOST and FROM_ADDRESS must be set at the top of the script.", file=sys.stderr)
        return 2

    rows = query()
    done = load_state()

    if done is None:
        # First run: record everything already available so nobody gets flooded
        if args.dry_run:
            print(f"First run would record {len(rows)} existing available requests without emailing.")
        else:
            save_state({r["id"] for r in rows})
            print(f"First run: recorded {len(rows)} existing available requests, no emails sent.")
        return 0

    by_user = defaultdict(list)
    for r in rows:
        if r["id"] not in done:
            by_user[r["username"]].append(r)

    if not by_user:
        return 0

    smtp = None
    exit_code = 0
    try:
        for username, books in by_user.items():
            to_list = recipients(username, books[0].get("email"))
            if not to_list:
                print(f"No email for '{username}'; will retry next run ({len(books)} pending).", file=sys.stderr)
                continue

            msg = build_message(to_list, username, books)

            if args.dry_run:
                print(f"--- would send to {msg['To']} ---\nSubject: {msg['Subject']}\n{msg.get_content()}")
                continue

            try:
                if smtp is None:
                    smtp = connect_smtp()
                smtp.send_message(msg)
            except Exception as e:  # leave these unmarked so they're retried next run
                print(f"Failed to email '{username}': {e}", file=sys.stderr)
                exit_code = 1
                continue

            done.update(b["id"] for b in books)
            save_state(done)  # save after each user so a crash never causes re-sends
            print(f"Emailed {msg['To']}: {len(books)} book(s).")
    finally:
        if smtp is not None:
            try:
                smtp.quit()
            except Exception:
                pass
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
