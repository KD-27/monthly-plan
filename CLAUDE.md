# Monthly Plan — working notes for Claude

A single-user daily discipline tracker in daily live use since 17 Aug 2026. See README.md for
features, scoring, and folder layout. This file is the rules for changing it safely.

## Real data is live
- `data/data.json` is the user's actual log. It is git-ignored — never commit it, never
  hand-edit it without first copying it to a backup, and never test against it.
- Personal settings (day one, `TASKS`, points, rule dates, weight, budget) live in
  `config.local.js` — git-ignored, never commit it. `index.html` holds only neutral examples.
  Change the user's tasks or points in `config.local.js`, never in `index.html`, and keep
  the never-rewrite-history rules below when you do.
- Test only with `index.html?demo=1` (separate storage key; nothing touches disk). Real-data
  checks must be read-only.
- The log is also live in Firestore (`users/{uid}/db`), synced to the user's phone. A bad write
  there reaches every device — test sync only with a fake (`window.MP_CLOUD_TEST`, see README)
  or `?demo=1&cloud=1` (sample data, kept under `users/{uid}/demo`).
- The app is served by `server.py` on `127.0.0.1:8731` (started by `Monthly Plan.bat`). After
  changing `server.py`, the running server keeps the old code until the app window is closed
  and reopened — tell the user.

## Verifying changes
- UI changes: drive headless Chrome over DevTools (`--remote-debugging-port`) against
  `?demo=1`, use a throwaway `--user-data-dir`, measure, screenshot, then close it.
- Phone: under 640 px the PHONE layout takes over (S25 ≈ 360×780 CSS px). Check phone changes
  at that size, in both themes, with touch emulation.
- The user's display is 125% scaled: viewport ≈ 1536×795 CSS px. The day sheet must fit that
  without scrolling.
- Syntax-check the inline script after edits (extract `<script>` and `new Function(...)`).

## Design rules the user has set
- Daily friction is the constraint: one row per thing, fewest taps, no import/confirm steps.
- Penalties are the point (Solo Leveling "System"): missed tasks subtract; don't soften that.
- Never rewrite history. A task added mid-run gets `since:'YYYY-MM-DD'` (faded and unscored
  before it); rank rules changed on a date apply only from that date.
- Money never enters the score. All money entry and reading lives in the 🏦 drawer.
- Charts: validated categorical colours only (see `FIN_COLORS`); no dual axes.
- Two themes: light (the original) and dark (`:root[data-theme="dark"]`). Style with the CSS
  variables (`--surface`, `--ink`, `--good-ink`, `--hover`, `--on-ink`, …), not fixed hex; anything
  that must carry its own colour needs a matching rule in the DARK THEME block. Check both.

## Code gotchas
- `DB` is keyed by `YYYY-MM-DD` day entries plus reserved keys `_finance`, `_deposits`, `_deadlines`, `_notes`, `_mindmaps` and `_prefs`.
  Anything that walks `Object.keys(DB)` must skip non-day keys with `isDayKey(k)`.
- `e.water` is millilitres (converted from 700 ml bottles on 14 Sep 2026).
- Per-day max score comes from that day's scored parts, not the global `MAX_POINTS`.
- Keep the README current when behaviour changes.
