# Stroll

A desktop session manager for [Claude Code](https://claude.com/claude-code). The main pane is the real `claude` terminal UI, exactly as in your terminal, with your settings, skills, hooks and MCP servers. Around it, Stroll adds:

- **Sessions you can see at a glance.** Every session keeps running while you look at another. A dot shows which ones need you: green means working, yellow means it needs you (a permission prompt, a question or a plan to approve), blue means it's your turn and you haven't looked yet. Each row shows a one-line preview.
- **A to-do list you can act on.** Start a session from a to-do (Claude gets it as context), or **hand it off** to a background run. A to-do with a live session shows **In progress**.
- **Background runs.** Hand off research or prep work. A run investigates and drafts, never changes anything, and pings you when it's ready. You can continue it as a normal session.

macOS only.

## Install

You need:
- macOS
- Node.js 20 or newer (`node -v`)
- Xcode Command Line Tools (`xcode-select --install`)
- Claude Code, installed and logged in once in a terminal (`claude`)

```sh
git clone <this repo> ~/stroll
cd ~/stroll
./install.sh
stroll
```

`install.sh` checks those prerequisites, installs dependencies (it compiles the terminal module for Electron, about a minute) and links `stroll` into `~/.local/bin`.

Stroll runs from this checkout on purpose: an unsigned packaged `.app` would be blocked by macOS Gatekeeper.

## Update

Stroll checks for new versions on its own and shows **Update available**; one click pulls and restarts. From a terminal: `stroll update`.

Restarting ends open sessions. When Stroll comes back, **Resume all** brings them back with their conversations.

## Using it

| | |
| --- | --- |
| ⌘K | Add a to-do |
| ⌘N | New session |
| ⌘J | Jump to the next thing that needs you |
| ⌘0 | Overview |
| ⌘1–9 | Jump to a live session |
| ⌘, | Settings |
| Shift+Enter | New line in Claude's prompt |
| Esc | Interrupt Claude (as in the terminal) |

- **To-dos:** **Start** opens a session for the to-do. **Hand off** sends it to a background run. ⌘-click several to start or hand off them together. Reminders fire as notifications. Marking a to-do done while it has open sessions asks whether to end them.
- **Inside a session started from Stroll,** Claude can manage your list: "add a to-do to …", "hand this off", "what's on my list?". That's the `stroll` MCP server.
- **Right-click a session** to mark it read or unread, or to mute its notifications.
- **Drag files or screenshots** onto a session to paste their paths, as in iTerm. Claude Code picks up image paths.
- **Elsewhere** lists recent sessions started in other terminals; click one to continue it in Stroll.
- **Closed** sessions and finished runs can be cleared from their lists. Old ones are cleaned up automatically.

## Background runs are read-only

A background run is a headless `claude -p`. To be safe to leave unattended:

- **It loads none of your Claude Code settings** (`--setting-sources ""`). Neither your personal allow rules nor a repo's "don't ask again" approvals apply.
- **Tools come from a fixed list:**
  - It can read files, search, browse the web, read git history and read GitHub PRs and issues.
  - It can't edit files, commit, push, open PRs, run scripts or send messages.
- **Slack, Gmail and Drive reading** is off by default; turn it on in Settings.
- **It ends with a report:** What I did / Findings / Drafts / Needs you.

Each run uses your Claude plan like any other Claude Code session.

## Data

Everything Stroll keeps is in `~/.stroll`, readable only by you:

| File | What it holds |
| --- | --- |
| `state.json` | To-dos, sessions and runs |
| `config.json` | Only the settings you changed in Settings |
| `runs/*.jsonl` | The raw output of each background run (deleted with the run) |
| `stroll.log` | The app log |

## Development

```sh
npm start                                        # run from source
STROLL_HOME=/tmp/stroll-test npm start           # separate data folder (runs next to your real Stroll)
node_modules/.bin/electron scripts/render-icon.js   # re-render assets/icon.png from assets/icon.svg
```

Debug variables (with `STROLL_HOME`):

| Variable | Effect |
| --- | --- |
| `STROLL_DEBUG_OPEN=session:<cwd>` | Open that view at start. Also accepts `todo-session:<n>`, `run:<id>` and `todo:<id>` |
| `STROLL_DEBUG_JS=<code>` | Run a snippet in the renderer after load |
| `STROLL_SNAPSHOT=<file.png>` | Save a PNG of the window at start |
| `STROLL_SNAPSHOT_QUIT=1` | Quit after saving the snapshot |

### Layout

| Path | Contents |
| --- | --- |
| `src/main/` | Electron main process: sessions (PTYs), runs, the local hook/API server, state, config |
| `src/renderer/` | The UI (vanilla JS and xterm.js) |
| `src/mcp/stroll-mcp.js` | The `stroll` MCP server |
| `bin/stroll` | The launcher |
