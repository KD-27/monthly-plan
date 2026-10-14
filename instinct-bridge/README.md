# Instinct bridge

Lets Instinct — the WhatsApp / iMessage assistant — read and update the
Monthly Plan log from a text or voice message: *"drank 500 ml, went to the gym"*, *"note: call
the bank"*, *"deadline thesis draft 20 Oct"*, *"make a mind map for the trip"*, *"how did I do
this week?"*.

```
You ─WhatsApp─▶ Instinct ─HTTPS + Bearer key─▶ this Worker ─service account─▶ Firestore ─live─▶ the app
```

Instinct can't sign in with Google, so it calls this Cloudflare Worker with a secret key. The
Worker holds a Google service-account key (as encrypted Worker secrets), signs its own
short-lived access token with Web Crypto, and reads and writes the same Firestore documents the
app syncs (`users/{uid}/db/{key}`, the value as JSON text in `j`). The app's listener picks the
change up within a second or two, on the phone and the laptop.

## Status (14 Oct 2026)

Deployed on the real log and **read-only** (`READ_ONLY = "1"`): Instinct answers questions about
the log, and every change is refused at the bridge. Instinct's own tool can only send GET requests
from this account (a request for write access is with its team). To allow changes later, set
`READ_ONLY = "0"` and deploy. The write endpoints below are built and tested, ready for that.

## Safety

- Only someone with the key gets in; the Firebase key never leaves Cloudflare.
- Every write is conditional on the document's last update time, so it can't overwrite a change
  the app made a moment earlier — it re-reads and retries.
- Every change is logged to `users/{uid}/instinct` with the value before it.
  `POST /api/undo` puts the last one back (and refuses if the app has changed it since).
- The app's rules hold: no logging days that haven't happened, deadlines are never deleted (only
  done / cancelled), a journal entry must fit on its page.
- The service account gets **Cloud Datastore User** only — Firestore, nothing else in the project.

## Setup

1. **Service account.** Google Cloud console → project `monthly-plan-b7b30` → IAM & Admin →
   Service accounts → *Create*: name `instinct-bridge`, role **Cloud Datastore User** → Done.
   Open it → Keys → Add key → JSON. Keep that file out of git.
2. **Cloudflare.** A free account, then from this folder: `npx wrangler login`.
3. **Settings.** In `wrangler.toml` set `USER_UID` (Settings → Instinct AI → Account in the app)
   and keep `COLLECTION = "demo"` for a first test. Then:
   ```
   npx wrangler secret put API_SECRET_KEY          # a long random string
   npx wrangler secret put FIREBASE_CLIENT_EMAIL   # client_email from the JSON
   npx wrangler secret put FIREBASE_PRIVATE_KEY    # private_key from the JSON
   npx wrangler deploy
   ```
4. **The app.** Settings → Instinct AI: paste the Worker's address and the key → *Test
   connection* → *Copy prompt for Instinct* → paste it into the Instinct chat. The prompt never
   contains the key: give Instinct the key only through its own secure link, never in the chat.
5. **Go live.** Once the demo test looks right, set `COLLECTION = "db"` and `npx wrangler deploy`.

To cut Instinct off, put a new `API_SECRET_KEY` (and paste the new prompt into Instinct if you
want it back).

## Endpoints

All take and return JSON; every request needs `Authorization: Bearer <API_SECRET_KEY>`.
`GET /api/help` lists them too.

| | |
|---|---|
| `GET /api/health` | ping: which collection, today's date, how many tasks |
| `GET /api/summary` | today's sheet, last-7-day average, open deadlines, counts |
| `GET /api/day?date=` | one day: score, done / not done, water, sleep, money, journal |
| `GET /api/days?from=&to=` | score per day (up to two months) |
| `GET /api/tasks` | the task names to use |
| `POST /api/day` | `{date?, done[], undone[], gym?, water_add_ml?, water_ml?, sleep_hours?, weight_kg?, spent_add?, spent?, big_purchase?:{amount, note}, journal_append?, journal?}` |
| `GET/POST/PATCH/DELETE /api/note(s)` | `{text, color?}` · `{id\|match, text?\|append?}` |
| `GET/POST/PATCH /api/deadline(s)` | `{title, due, note?}` · `{id\|match, status?: done\|cancelled\|open, …}` |
| `GET/POST/PATCH/DELETE /api/mindmap(s)` | `{title, branches, deadline?}` · `{id\|match, add?:{under?, items}, tick?, untick?, rename?, remove?}` |
| `GET /api/log` · `POST /api/undo` | recent changes · take the last one back |

Dates take `today`, `yesterday`, a weekday, `20 Oct` or `YYYY-MM-DD`; "today" is Sri Lanka time
(`TZ_OFFSET_MINUTES`). Tasks are matched loosely by their words; when a phrase could be two
tasks the reply asks back with `did_you_mean`. Scores are worked out exactly as the app does.
