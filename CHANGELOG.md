# Changelog

Stroll shows the new sections here once, after an update. **Settings › Updates › What's new** shows them all again.

## 0.10.0 — 2026-11-18

### Stroll on your phone
- **Pair an Android phone and follow your work from anywhere.** Turn on **Settings › Phone access**, press **Pair a phone** and scan the code with the phone's camera. Nothing runs on the phone: it's remote access to this computer, which has to be on and awake.
- **Sessions on the phone:** the live terminal, a row of keys for prompts (Esc, arrows, Enter) and a message box. You can start a new session from the phone too. The same session stays open on the computer, and a click in its window takes the terminal's size back.
- **Answer what needs you:** read a run's report, allow or deny what it asks for, tick to-dos, start workflows.
- **Notifications on the phone** when something needs you, by default only when you're not at Stroll on the computer. **Notify phones** in Settings changes that.
- **Private:** the phone and the computer talk through a relay that can't read what it carries. Remove a phone in Settings and it's disconnected at once.
- While phone access is on and something is working, Stroll keeps the computer from going to sleep on its own. Closing the lid still stops everything.

## 0.9.0 — 2026-11-18

### Workflows on trails
- **A workflow can belong to a trail.** Pick the trail under the workflow's **Setup**, or connect a workflow from the trail, which now lists its workflows. Everything the workflow starts goes on that trail and gets its notes: sessions, background runs, and a scheduled prep.
- **The start form has a Trail field**, to start a workflow on another trail for that one time.
- A workflow saved from a session or a run on a trail stays on that trail. A trail shows a yellow dot when one of its workflows is due.

### Background runs that keep their own records
- **A workflow can name folders its background runs may write in**, under **Setup**. A run can't edit files, so a routine that saves its report or notes when it last ran used to end with that step left for you. With a folder set (say `~/.config/tech-digest`), its runs create and edit files there without asking, and a scheduled one finishes on its own. Everywhere else, edits stay blocked.

### Trail notes that stay short
- **Condense** on a trail has Claude draft a shorter version of its notes: lines that repeat each other merged, facts that were replaced and progress that's finished dropped. The draft waits on the trail. Edit it, then **Replace notes** or **Dismiss**. **Undo condense** puts the old notes back.
- **When a trail's notes pass 800 words, Stroll asks for that draft on its own.** The notes change only if you take it. Change the limit or turn it off in **Settings › Trails**.
- **A suggestion can replace a line instead of adding one.** When something in the notes has changed, Claude suggests the corrected line in its place, and the trail shows the line it replaces.

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
