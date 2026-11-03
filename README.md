# RMAB Email Notifications

`RMAB-email.py` sends email when an audiobook request becomes available in ReadMeABook (RMAB). It is a standalone polling script: schedule it on a machine that can run Docker commands against the RMAB container and reach an SMTP server.

## Requirements

- Python 3; no third-party Python packages are required.
- Docker CLI access to the RMAB container.
- SMTP access for the configured mail provider.
- A POSIX environment such as Linux or macOS. The script uses `fcntl` for its run lock and does not run natively on Windows.

## Configuration

Edit the constants near the top of `RMAB-email.py`:

- **Database container:** `CONTAINER`, `PGUSER`, and `PGDB` must match the RMAB container and its PostgreSQL settings. The script runs `docker exec ... psql` to query the database.
- **SMTP:** Set `SMTP_HOST`, `SMTP_PORT`, and `SMTP_SECURITY` (`starttls`, `ssl`, or `none`), plus `SMTP_USER` and `SMTP_PASSWORD` if authentication is required. Set `FROM_ADDRESS`, and optionally `FROM_NAME` and `REPLY_TO`. Use an app password when your provider requires one.
- **Recipients:** Map case-insensitive RMAB usernames to one or more addresses in `USERS`. If a username is not mapped, `USE_DB_EMAIL_FALLBACK = True` allows the script to use that user's email stored in RMAB.

The script has no environment-variable or separate configuration-file support; values are set directly in the script. Replace the example placeholders before running. Keep real SMTP credentials private and restrict access to the script file.

## Run

```sh
python3 RMAB-email.py --dry-run
python3 RMAB-email.py
```

`--dry-run` queries the database and prints messages that would be sent, without sending email or changing `notified.json`. The script still creates/uses its lock file. Schedule normal runs every 10–15 minutes, for example with cron:

```cron
*/10 * * * * /usr/bin/python3 /path/to/RMAB-email.py >> /path/to/rmab-email.log 2>&1
```

## How it works

1. A non-blocking lock (`notify.lock`, beside the script) prevents overlapping runs.
2. The script queries non-deleted audiobook requests with status `available`, joining each request to its requester and audiobook.
3. On the first normal run, it records all currently available request IDs in `notified.json` and sends nothing. This avoids sending a backlog of old notifications. A first-run dry run reports the count but does not create the state file.
4. Later runs compare available request IDs with `notified.json`, group new ones by username, and send each user one summary email listing their newly available books.
5. After a user's email succeeds, that user's request IDs are saved immediately. Missing recipient addresses and send failures are left unmarked so a later run can retry them.

`notified.json` and `notify.lock` are created beside the script and should remain writable and persistent between scheduled runs. Removing `notified.json` resets the first-run behavior: the next normal run records all currently available requests without emailing them.
