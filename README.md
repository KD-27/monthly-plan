# Monthly Plan

A single-page, offline daily discipline tracker — modeled on the "System" from *Solo Leveling*. Every day is a quest with assigned tasks, the day locks in at midnight, and failing a task **costs points** instead of just earning none. It's not a neutral habit checklist; the penalty is the point.

## Purpose

Monthly Plan exists to keep one person (its only user) honest about a daily routine — diet, gym, water, sleep, spending, and weight — by scoring each day and turning the run into a visible rank, level, and set of titles. It was built after the previous version's log was silently wiped by Chrome clearing local storage, so the whole architecture is designed around one hard rule: **opening the app must never require a manual step**, or the log goes cold and the habit dies with it.

## Make it yours

You need **Windows**, **Python 3** (from python.org — the server uses only the standard library) and **Chrome** or **Edge**.

1. Fork or download this repository.
2. Copy `config.example.js` to `config.local.js` and edit it:
   - `START` — your day one (`m` is 0-based: January = 0).
   - `TASKS` — your own tasks, icons, groups and points. Each task needs a unique `id`; once you've logged days, keep the ids stable and give new tasks a `since:'YYYY-MM-DD'` date.
   - `WEIGHT_START` / `WEIGHT_TARGET`, `MONEY_BUDGET` — your numbers.
   `config.local.js` is git-ignored, so your settings stay on your machine. Without it the app runs on the examples.
3. Double-click `Monthly Plan.bat` (make a desktop shortcut to it if you like). It starts the local server and opens the app full screen — **F11** switches to a window.
4. Try `index.html?demo=1` to look around with made-up data; it never touches your log.

The currency is LKR — to change it, search `index.html` for `LKR`. On macOS or Linux there's no launcher: run `python3 server.py` and open `http://127.0.0.1:8731/index.html`. Your log is written to `data/data.json`, which is git-ignored too.

## Folder layout

```
Monthly Plan/
├── Monthly Plan.bat      launcher (the desktop shortcut runs this)
├── server.py             local server that reads and writes the log
├── index.html            the whole app
├── config.example.js     template for your own settings — copy it to config.local.js
├── config.local.js       (local only — never committed) your day one, tasks, points, targets
├── LICENSE               MIT
├── README.md
├── CLAUDE.md             rules for changing the app safely (read by Claude Code)
├── .gitignore            keeps data/ and every copy of the log out of git
├── .gitattributes        keeps the .bat on Windows line endings
├── data/                 (local only — never committed)
│   ├── data.json         your log — the single source of truth
│   └── data.backup.json  the previous save, refreshed every time
└── icon/
    ├── icon.ico          app + desktop-shortcut icon
    ├── icon-192.png      large app icon
    └── favicon-16/32/48.png  window / tab icons
```

Only the app is tracked in git. Your log (`data/`) and your settings (`config.local.js`) are
git-ignored, so they never leave your machine through git. GitHub Pages is not a good host: it
can't run `server.py`, so the app would fall back to browser-only storage.

## How it runs

- `Monthly Plan.bat` finds a windowless Python (`pyw -3`, then known `pythonw.exe` paths), launches a tiny stdlib-only Python server (`server.py`) on `http://127.0.0.1:8731`, waits for the port, and opens the app full screen (`--start-fullscreen`; F11 toggles back to a window) in its own Chrome (or Edge) app window with a dedicated profile at `%LocalAppData%\MonthlyPlan\chrome` — isolated from normal browsing, so clearing browser data can never touch it.
- `data/data.json` is the single source of truth — written atomically (temp file + replace) with a rolling backup copy beside it. The page pings the server every 20 s; the server shuts itself down 90 s after the pings stop (i.e. once the window closes). If the server is already running, a second launch just reuses it.
- Server API: `GET /api/data` (the log, or `{}` on first run; `503` if the file is locked), `POST /api/data` (atomic overwrite, must be a JSON object), `GET /api/ping` (heartbeat), `POST /api/quit`. Everything else is served as static files from the app folder.
- The page also mirrors the log to `localStorage` (`monthlyPlan.v1`). On load the file on disk wins; the browser copy is only used when the server is unreachable, or once — to seed an empty `data.json` on the first run after the move to disk.
- Older versions kept the log next to `server.py`. On startup the server moves any `data.json` still found there into `data/` if it's newer (the copy it replaces becomes the backup), or keeps it aside as `data/data.old-root-<timestamp>.json` if it's older — nothing is ever deleted.
- If Python or the server isn't available, the app falls back to opening as a plain `file://` page backed by `localStorage`, so it still works, just without durable file storage.

## Daily tasks and points

Every scored task adds its points when done and **subtracts** them when missed. Gym days and rest days cap at the same total. The tasks below are the built-in examples (−77 to +77) — your own list, points and dates go in `config.local.js` (see **Make it yours**).

| Group | Task | Points | Notes |
|---|---|---|---|
| All day | Water | 8 | Entered in ml; scored on a curve toward a **3.0 L** target (0 ml = −8, 3000 ml+ = +8) |
| All day | Weigh-in | — | Mondays only; unscored, earns a title instead |
| All day | Money spent | — | Unscored, earns a title instead; big purchases tracked separately |
| Morning | Went to gym | 0 | Checkbox; picks the gym/rest label of tasks with variants and counts toward the weekly gym quota |
| Morning | Morning wash · Brush teeth | 1 each | Hygiene — the A and S rank gates count these |
| Morning | Healthy breakfast | 5 | "Protein before the gym" on gym days |
| Morning | Read for 20 minutes | 5 | |
| Morning | No sugary snacks (morning) | 6 | |
| Morning | Coffee before noon only | 0 | Tracked only — no points either way |
| Afternoon | Balanced lunch | 5 | |
| Afternoon | No sugary snacks (afternoon) | 6 | |
| Afternoon | Walk 8,000 steps | 6 | |
| Evening | Light dinner before 8 PM | 6 | |
| Evening | No junk food | 8 | |
| Night | Night wash · Brush teeth | 1 each | Hygiene |
| Night | No phone in bed | 6 | |
| Night | Sleep 6–8 hours | 12 | Scored on a curve; full points inside 6–8 h, falling off outside it |

Score zones: **Good** 60+, **Moderate** 20–59, **Bad** below 20.

Tasks added mid-run carry a start date (`since`). On days before it they show faded with "—", can't be ticked, and don't count toward that day's score — so adding a task never rewrites past scores.

## Core features

- **Calendar view** — a full month grid, each day colored by score zone (or marked in progress), with the month's stat tiles in a column on the right (below the card on narrow windows). The cell size is fitted for a six-week month and doesn't depend on the tiles, so every month draws at the same size and position.
- **Day sheet** — tap any day to check off tasks grouped into All day / Morning / Afternoon / Evening / Night, with a live score bar showing the day's total against its max.
- **Journal (📖)** — a book button beside the 🏦 opens a spiral notepad that slides in from the right, one page per day from `JOURNAL_SINCE` (day one by default) to today. Each page has the date, 14 numbered ruled lines for a few sentences (a full page refuses more text), and a "The day" strip with the score, gym/rest, water and sleep, plus "Open day →". It saves as you type and is never scored. Going forward the page curls up from the bottom and over the spiral, shading as it turns and showing its plain back; going back the page curls down onto the pad; the month arrows riffle through the days in between and land on the same date in that month (clamped to the journal's range). ←/→ or PageUp/PageDown turn pages when not typing. The day sheet has a 📖 button left of "Clear day" that opens the journal on that day (faded and unclickable before the journal's first page). "Clear day" resets the ticks but keeps the note.
- **Water tracker** — a single row: the day's total in ml is directly editable, and a "+ ml" field next to it adds to the running total each time (Enter or +). Bottle icons show progress at **1 bottle = 1 L**, filling fractionally — 2.75 L shows as two full bottles and a three-quarters-full third.
- **Big purchases** — one-off spends logged under Money, outside the daily budget. Click a purchase to edit its amount or note in place; ✕ removes it.
- **Finances drawer (🏦)** — a bank button beside "Day N" in the top bar opens the single place for money, kept apart from the score and from Analytics. It has three tabs; the first two share one month selector (from day one's month through next month), so switching tabs stays on the same month:
  - **Income & card** — log any number of dated income entries (click one to edit, ✕ to remove) and the credit card amount due that month.
  - **Statement** — Income / Out / Left tiles; a "Where it went" bar splitting outflow into daily spending, big purchases, and credit card; the daily spending chart against the `MONEY_BUDGET` line; and a dated statement of income (+) and big purchases (−), with daily spending and the card bill as month-wide lines.
  - **Fixed deposits** — a standing list (not monthly) of bank + amount, with the total across all deposits. Click one to edit, ✕ to remove.
- **Deadlines** — dated to-dos, kept entirely outside the score. On windows 1280 px or wider a 290 px light-yellow rail on the right edge lists the open ones, soonest first, each with its date and "In N days" / "Due today" / "N days overdue" (overdue cards tint red). Tap a card's circle to mark it completed and it slides out; click the card to edit it. The **+** at the top of the rail opens a drawer to add one (title, due date, optional note; Enter adds) and review the **Open / Completed / Cancelled** lists, where any deadline can be edited, cancelled or reopened. Nothing is ever deleted — completing or cancelling only changes the status. A deadline linked to a mind map shows a **◈ Map** chip that opens it.
- **Mind maps** — the lower half of the deadlines rail, one card per map showing just its name. **+** starts a map and opens it in a large window: the title in a centre bubble, branches spreading right then left with curved connectors, one soft colour per main branch. Two modes:
  - **Edit** — type in any box; Enter adds a sibling, Tab a child, the **+** on a box adds a child, **×** deletes (a whole branch takes a second click), Backspace on an empty box removes it. Drag a box onto another to move it (middle = under it, top/bottom edge = before/after it).
  - **View** — the last boxes on each branch (the leaves) have a tick; a ticked leaf fades, and a branch fades once every leaf under it is ticked.
  The knob where a branch's lines start folds it away (showing how many boxes it hides) and opens it again. Drag the background to pan, scroll to zoom, **Fit** to frame it. **Ctrl+Z / Ctrl+Y** undo and redo any change in the window. The **Deadline** dropdown links the map to one deadline, which becomes the map's main topic — its title in the centre and its date on the centre (the only date on a map). The linked deadline's card shows a **◈ Map** chip that opens it. Maps are saved while they exist; **Delete map** (two taps) removes one for good, and a new map closed without any text is discarded. Never scored.
- **Flip clock** — a 24-hour flip clock (13:05, no AM/PM) under the calendar on the left. The minute card's top half falls to reveal each new minute. It sits outside the calendar's fitted height, so it never shrinks the grid; it shows when there's room below (full screen) and hides itself otherwise.
- **Focus (🌲)** — a tile beside the flip clock opens a Forest-style focus timer: the screen turns green with a tree in a ring at the centre. Drag the ring to set 10–120 min (scroll or arrow keys work too) and press **Plant**. Every session grows a different tree (generated from a random seed): a sprout, then a trunk that draws itself upward and thickens, branches splitting off in turn, leaves popping in along them, and pink blossoms at the end — all swaying gently while the ring fills. The window title shows the countdown. **Give up** (two taps) withers it: the leaves fall and a bare tree is left; finishing plays a soft chime. Nothing is recorded — it lives only on screen.
- **Sticky notes** — on windows 1500 px or wider, a 290 px light-orange rail on the left edge holds free-form notes, newest first. **+** starts one; type straight in. A small toolbar (bold, italic, underline, strikethrough, bulleted list) appears while writing, and Ctrl+B/I/U work too. Drag a note by its coloured top bar to move it — the others slide aside to open the slot, and the order is saved. Each note's **···** menu changes its colour (sand, butter, sage, clay, mist) or deletes it (two taps). Notes save as you type; pasting brings in plain text only, and saved HTML is cleaned to those few formatting tags — no images. Never scored.
- **Analytics view** — daily score chart, weekly average with the gym quota table, "Where the points go" per-task breakdown, weight progress, and hydration. (Spending moved to the 🏦 drawer.)
- **Hydration panel** — total water logged all-time and per month, with a line graph of each month's daily ml, a dashed target line (3.0 L), and a dashed line at that month's average.
- **CSV sync** — the log can be linked directly to a `.csv` file on disk (e.g. inside a synced Google Drive folder) via the File System Access API, updating on every change, with manual export/import as a fallback. Water is exported as `water_ml`; the journal text goes in a last `note` column, with line breaks folded to spaces.

## Special features (the design signature of this app)

- **Penalty-based scoring, not just completion.** An unchecked task actively subtracts its weight rather than simply not adding. This is deliberate: it mirrors a game system's daily quest penalty, not a forgiving habit tracker. The only exceptions are the 0-point tracked-only items (such as the gym checkbox).
- **Weekly gym quota with a week-level penalty.** Missing the 4-session/week gym target docks the *week's* average by a flat 5 points, without touching or repainting any individual day's score — one bad week can't retroactively wreck days that were actually fine.
- **Dual rank system (Rank vs. Level).**
  - **Rank** (E → D → C → B → A → S, floors at <0 / 0 / 20 / 40 / 60 / 80) is a rolling 7-day average that can rise *or fall*, with a 3-day confirmation before promotion and a 3-day grace period before demotion — so one great or one bad day can't whipsaw it. The top two ranks are gated — a gate caps the rank shown rather than demoting you, and lifts by itself once met:
    - **A** needs a *full hygiene* day (all four hygiene checks done) on at least 5 of the 7 window days.
    - **S** needs full hygiene on all 7 days **and** last week's 4-session gym quota.
    - If `HYG_SINCE` is set, days before it use the older rule (A and S needed only the gym quota), so ranks earned then aren't rewritten. Leave it empty and the hygiene gates apply from day one.
  - **Level** is the permanent record and never falls. XP is the sum of positive day scores; a bad day earns nothing but takes nothing back. Each level costs 40 XP more than the last, starting at 100.
- **Unscored tracks with titles instead of points.** Weekly body-weight and daily spending are deliberately kept *outside* the score — logged, charted, and totaled, but never penalized. Each earns a title instead:
  - Weight (latest weigh-in, toward `WEIGHT_TARGET`): Unforged → Kindled → Tempered → Ironclad → Ascendant.
  - Spending (average over the last 7 logged days, against `MONEY_BUDGET`): Spendthrift → Steward → Warden → Ironpurse → Vaultkeeper.
- **Everything is a pure function of the log.** No derived state (rank, level, titles) is stored anywhere — it's all recomputed from `data/data.json` on load, so editing a past day is always safe and correctly rewrites everything downstream.
- **Demo mode.** Visiting with `?demo=1` loads sample data from a completely separate storage key — the real log is never read or written while demoing.

## Data & backups

All of these live in the `data/` folder.

- `data.json` — the live log (source of truth). Each day stores its checks, `water` (ml), `sleep` (hours), `money` (LKR), `big` purchases, `gym` (true/false), and `weight` (kg, weigh-in days only), and `note` (the journal page; absent when empty). Monthly income and credit card amounts live under a separate `_finance` key, grouped by month (`"2026-09": { income:[{date, amt, note}], card }`), fixed deposits under `_deposits` (`[{bank, amt}]`), deadlines under `_deadlines` (`[{id, title, due, note?, status: open|done|cancelled, added, closed?}]`), sticky notes under `_notes` (`[{id, html, color, updated}]`), and mind maps under `_mindmaps` (`[{id, root:{id, text, done?, collapsed?, children}, deadline?, updated}]`). Restoring from a CSV keeps all five.
- `data.backup.json` — automatic previous-copy backup, refreshed on every save.
- `data.corrupt-<timestamp>.json` — only if `data.json` contains invalid JSON is it quarantined here, rather than silently discarded. A file that is merely *locked* for a moment (cloud sync, antivirus) is not treated as damaged: the server retries for ~2.5 s, and if it still can't open it the app says so and leaves `data.json` untouched for that session instead of overwriting it with the browser's copy.
- A linked CSV copy (optional, e.g. on Google Drive) serves as a portable, human-readable spare. Importing an old CSV that only has a `water_bottles` column converts it at 700 ml per bottle.

## Code map (for whoever changes this next)

Read `CLAUDE.md` first — it holds the rules for changing the app safely (live data, demo-only testing, the viewport the day sheet must fit, design rules).

`index.html` is one file: CSS (~lines 13–682), markup, then one inline `<script>` (~lines 792–3541). The script is organised in banner-commented sections, in this order:

| Section | What lives there |
|---|---|
| CONFIG | reads `window.MONTHLY_PLAN_CONFIG` from `config.local.js`, else neutral examples: `START`, `HYG_SINCE`, `JOURNAL_SINCE`, `LEGACY_GYM_IDS`, the `TASKS` array (id, group, label, points, `since`, gym/rest variants), `MONEY_BUDGET`, `WEIGHT_START` / `WEIGHT_TARGET`; plus fixed tuning: `WATER_TARGET_ML`, `SLEEP_LO/HI/FALLOFF` (6 / 8 / 1.5 h), `GYM_TARGET` / `GYM_PENALTY` (4 / 5), `ZONE_GOOD` / `ZONE_MID` (60 / 20), `FIN_COLORS` |
| DATE HELPERS | local-time date math (no UTC), `key()` → `YYYY-MM-DD` |
| STORAGE | `load()` / `save()`, disk sync via `/api/data`, heartbeat, `localStorage` mirror, corrupt-blob rescue |
| DEMO SEED | deterministic sample history for `?demo=1` |
| SCORING | `waterScore`, `sleepScore`, `scoreDay`, `gymWeek` (Mon–Sun weeks), `finalScore` (only for days that have ended) |
| RANK & LEVEL | `RANK_FLOOR`, window/confirm/grace constants, hygiene and gym gates, `TITLE_TRACKS` (spending + weight ladders), `levelState` |
| TABS / CALENDAR / DAY SHEET / ANALYTICS | rendering for each view, the 🏦 finances drawer, the 📖 journal notepad (`openJournal`, `jrTurn` page flips), the deadlines rail and manager (`renderDeadlines`, `openDeadlines`), the sticky-notes rail (`renderNotes`, `snClean`), and the rank/title detail drawer |
| CSV | File System Access link (handle kept in IndexedDB `monthlyPlanFS`), export / import |

Other storage keys: `monthlyPlan.demo.v1` (demo log), `<store key>.rank` (last rank seen, used for the one-time "Rank up / Rank down" toast — kept out of the log on purpose).

To add a task: append it to `TASKS` in your `config.local.js` with `since:'YYYY-MM-DD'` (the day it starts counting), then reload. Don't change `pts` on an existing task without a dated rule — past scores are recomputed from the log, so an undated change rewrites history.

## History

| Date | Change |
|---|---|
| 17 Aug 2026 | Day 1 of the plan; daily live use begins. |
| 14 Sep 2026 | Water switched from 700 ml bottles to millilitres (`e.water` is ml); target 3.0 L; bottle icons became 1 L each. |
| 27 Sep 2026 | Four hygiene checks added (score range −82…+82 → −86…+86); A/S rank gates switched to hygiene (+ gym quota for S), applied only from this date. |
| 27 Sep 2026 | Log moved from the app folder into `data/`; folder made a git repo (`main`), with `data/` git-ignored. |
| 1 Oct 2026 | Journal added: 📖 spiral notepad, one page per day from 28 Sep 2026 (`JOURNAL_SINCE`); unscored, stored as `e.note`, exported to CSV as `note`. |
| 2 Oct 2026 | Deadlines added: yellow rail on the right and a ＋ drawer for adding and history; stored under `_deadlines`, never scored. |
| 2 Oct 2026 | Sticky notes added: light-orange rail on the left (≥1500 px), stored under `_notes`, never scored. Calendar cell also fits the room between the rails. |
| 2 Oct 2026 | Side rails widened to 290 px; app opens full screen; 24-hour flip clock under the calendar. |

## License

MIT — see `LICENSE`. Fork it, change it, make it yours.
