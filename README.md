# 🧡 Claude Deck

A cute stream deck for your Claude Code sessions. It runs on your laptop, and you control it from your phone or iPad.

## What it does

**A little Claude spark mascot**
- spins while Claudes are cooking, sleeps when nothing is open, wiggles when a session needs you, sweats near your budget
- tap it for a squish and hearts; its eyes follow your finger
- celebrates with confetti, a chime and a buzz when a session finishes
- levels up as you write tokens: 🎀 at Lv 3, 🥳 at Lv 6, 👑 at Lv 10 (and a nightcap after midnight)
- daily 🔥 streak and an XP bar

**Usage**
- **live session and weekly limits** from your Claude plan, plus today, 7 days, live tok/min, 24h sparkline, daily bars
- spend by project
- figures are API-equivalent $ estimates, read from `~/.claude/projects/*.jsonl`

**Sessions**: every open `claude`, with
- live status and current tool, context bar, last prompt and reply
- a **“Claude needs you”** panel when a session waits on a question or permission, with 📸 **Peek** to screenshot the window onto your phone
- keys: Focus · Yes · Continue · Stop · /compact · Mode · Git · Enter
- **quick prompts** you can edit (run tests, commit, review…), type-to-Claude, and hold-to-talk 🎙️ (https/localhost only)
- 📜 **live feed** of the conversation

**Deck**
- new Claude in any `~/Projects` dir, screenshot, mute, night light, DND, stay awake, browser, lock
- 🍅 focus timer that pings both laptop and phone

**Laptop**: CPU, RAM, temperature, battery gauges, plus a list of **dev servers** (tap to open LAN ones on your phone).

**Push** (optional): “Claude is done / needs you” pings through [ntfy](https://ntfy.sh), even when the page is closed.

## Run
    node server.js        # or: ln -s $PWD/bin/claude-deck ~/.local/bin/ && claude-deck
Open `http://localhost:4747/pair` on the laptop and scan the QR. On iOS, use **Share → Add to Home Screen**.

## Config
`config.json` is created on first run and gitignored, because it holds your pairing token. Most settings can also be changed from ⚙️ in the app.
- `blockBudgetUsd`: what counts as 100% of the 5h ring
- `pricing`: $/M tokens per model family
- `macros`: quick prompts
- `deck`: buttons `{ id, label, emoji, cmd }`; `cmd` runs via `hyprctl dispatch exec`
- `ntfy`: push settings
- delete `token` to un-pair every device

## Requirements
Linux + Hyprland + Ghostty, Node 18+, `wl-clipboard`, `grim` and `hypridle`. There are no npm dependencies.

How it reaches into your sessions: it focuses the session's window, pastes text with Shift+Insert through
Hyprland's `sendshortcut`, presses Enter, then gives focus straight back and restores your clipboard.
- It waits for a 1-second pause in your keyboard and mouse use first (a private `hypridle`), so it never grabs focus
  while you're typing on the laptop. If you keep typing for 6 seconds, it gives up and tells you.
- It refuses while hyprlock is up, or if the window didn't really get focus.
- Live plan limits come from the same endpoint as `/usage`, using your Claude login. Without a login, the ring falls back to an estimate.

Anyone with the pairing link can control your sessions, so keep it on your own network.

## Test
    python3 test/ui_test.py    # Playwright: clicks through everything, fails on any console error
