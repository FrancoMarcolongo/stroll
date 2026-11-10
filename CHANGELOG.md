# Changelog

Stroll shows the new sections here once, after an update. **Settings › Updates › What's new** shows them all again.

## 0.8.0 — 2026-11-10

### Trails
- **A trail keeps shared notes for sessions about the same piece of work**, like a to-do's notes but for as many sessions as the work takes. Every session started on a trail gets its title and notes as context. A resumed session gets the notes as they are now.
- **Sessions suggest what the next one should know.** When Claude learns something worth keeping (a decision, where something lives, a gotcha), it suggests a line for the notes. Accept it, edit it first, or dismiss it on the trail. A badge in the sidebar counts the suggestions waiting. If you ask Claude to "add this to the trail", it writes it right away.
- **To-dos can belong to a trail.** Sessions and hand-offs started from one get the trail's notes too, and to-dos Claude adds from a session on a trail land in that trail.
- Start one with **+** in the new Trails section, or with **Add to trail** in a session's header (also on right-click). A trail can hand off a background run and set the folder its sessions start in. Archive a trail when the work is done.

### What's new
- After an update, Stroll shows what changed, once.

## 0.7.0 — 2026-11-03
- A violet dot marks a session whose turn is over but that still runs something in the background (a shell, an agent, a monitor). A counter next to its title shows how many.

## 0.6.1 — 2026-11-03
- Closed sessions fold under their own **Closed** title.

## 0.6.0 — 2026-11-02
- Linux support.
- File links Claude prints are clickable: they open in Zed at the right line when it's on your PATH, otherwise in your text editor. A file is never run.

## 0.5.1 — 2026-10-29
- Sidebar sections collapse when you click their title and move when you drag it.

## 0.5.0 — 2026-10-29
- **Workflows** for recurring work: save a session you run every week with the blanks it needs, start it in one click, or schedule it.

## 0.4.0 — 2026-10-29
- **Allow all** for a background run: no more questions for that run. Edits, pushes, PRs and sending messages stay blocked.

## 0.3.1 — 2026-10-28
- Sessions in your home folder answer Claude Code's "trust this folder" prompt for you.
- Ctrl+Tab cycles through live sessions.
- **Go to** on a to-do opens the session or run already working on it.

## 0.3.0 — 2026-10-28
- Background runs ask you before anything outside their read-only list, instead of failing. **Always allow** saves the rule for future runs.
