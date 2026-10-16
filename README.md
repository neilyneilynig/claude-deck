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
- rolling 5h window ring, today, 7 days, live tok/min, 24h sparkline, daily bars
- spend by project
- figures are API-equivalent $ estimates, read from `~/.claude/projects/*.jsonl`

**Sessions**: every open `claude`, with
- live status and current tool, context bar, last prompt and reply
- an **answer prompts from your phone** panel: AskUserQuestion options, plan approval, permission prompts
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
Linux + Hyprland + Ghostty + `wtype`, Node 18+. There are no npm dependencies.

Typing actions refuse to run while hyprlock is up, or when the target window didn't actually get focus, so keystrokes never land somewhere else.
Anyone with the pairing link can control your sessions, so keep it on your own network.
