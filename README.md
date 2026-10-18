# 🧡 Claude Deck

A cute stream deck for your Claude Code sessions. It runs on your laptop, and you control it from your phone or iPad.

## What it does

**A little Claude spark mascot**
- spins while Claudes are cooking, sleeps when nothing is open, wiggles when a session needs you, sweats near your budget
- tap it for a squish and hearts; its eyes follow your finger
- celebrates with confetti, a chime and a buzz when a session finishes
- levels up as you write tokens: 🎀 at Lv 3, 🥳 at Lv 6, 👑 at Lv 10 (and a nightcap after midnight)
- daily 🔥 streak and an XP bar
- 🎨 name your pet and pick its color; new colors unlock as you level up (🌈 at Lv 10)

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
- per-session stats: 💸 cost, turns, edits, commands, reads, plus the files Claude touched
- 🔀 **diff viewer**: review the session's uncommitted changes on your phone (finds the repo Claude is actually editing)

**💬 Chat with Claude in the browser**
- **Browser chats**: start a full Claude Code session right from the page, with no terminal window. Replies stream in live,
  tool calls show as they run, and you can follow up, ✋ stop, or move it to a terminal. Pick 🛡️ edits-only or ⚡ full access, and the model.
  Under the hood: one `claude -p --input-format stream-json` process per chat, revived with `--resume`.
- **Chat screen for terminal sessions**: tap 💬 Chat on any card for a full-screen conversation view with a message box,
  quick prompts, and the “needs you” answer panel.

**Recent sessions**: closed sessions with ▶ **Resume**, which reopens them on the laptop with `claude --resume`
- 🔎 **search past chats** (“where did I talk about…?”) with highlighted snippets and Resume
- 🚀 **start a task from your phone**: type what you want, pick a project, and a new Claude opens already working on it
- 👋 close a session (tap twice to confirm)

**Deck**
- new Claude in any `~/Projects` dir, screenshot, mute, night light, DND, stay awake, browser, lock
- 🍅 focus timer that pings both laptop and phone
- 📺 **live screen**: watch the laptop screen from your phone (refreshes every 2s)
- 🎮 **Token Catcher**: a tiny game for while Claude cooks; catch 🪙, dodge 🐛, with a shared high score

**Laptop**
- CPU, RAM, temperature and battery gauges
- 🎵 media controls and volume
- 📋 **clipboard bridge**: grab the laptop clipboard, or send text or a link to it (🔗 opens on the laptop)
- a list of **dev servers** (tap to open LAN ones on your phone)

**Activity log** of sessions starting, finishing and needing you, and a **Today** recap.

**Push** (optional): “Claude is done / needs you” pings through [ntfy](https://ntfy.sh), even when the page is closed.

**⌨️ Keyboard shortcuts** (iPad with a keyboard): `1`–`9` pick a session, `o` open its chat, `b` new browser chat, `f` focus, `p` peek, `d` diff, `/` type, `n` new task, `s` screen, `k` search, `?` help.

**🔥 Laptop hotkey**: `bin/claude-deck-toggle` opens the deck as an app window, hides it, and brings it back. Bind it in Hyprland:

    bindd = SUPER SHIFT, K, Claude Deck, exec, ~/Projects/claude-deck/bin/claude-deck-toggle

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
