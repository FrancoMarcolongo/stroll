# Changelog

Stroll shows the new sections here once, after an update. **Settings › Updates › What's new** shows them all again.

## 0.15.0 — 2026-11-25

### Three columns
- **A side panel with the trail of what's open.** Next to a session (or a run, to-do or workflow) on a trail: its notes, and what sessions suggest for them, to touch up and add or dismiss without leaving the session. ⌘O, or the button at the top right, shows and hides it.
- **Hide the menu** with ⌘\ or the button at its top, and bring it back the same way.
- **Drag a column's border** to make it wider or narrower; double-click it to put it back. Claude Code always keeps about 90 columns in the middle, so in a narrow window the side panel waits until there's room.

## 0.14.0 — 2026-11-25

### Trails on the phone
- **The phone's home page lists your active trails,** each with its dot and how many suggestions are waiting for its notes. Tap one to open its page.
- **A trail's page** has **Go to session** and **New session**, the suggestions (touch one up in its box, then **Add to notes** or **Dismiss**; a correction shows the line it takes the place of), a shorter draft of the notes to take or dismiss, the notes themselves with **Condense** and **Undo condense**, and the trail's to-dos, live sessions, workflows and runs.
- **New session has a Trail field.** Opened from a trail, it comes with the trail picked and its folder.
- The notes are read on the phone and edited on the computer, where the editor knows the files they reference. Deleting and archiving a trail stay on the computer too.

Nothing to install on the phone: the app loads the new version the next time it's opened.

## 0.13.1 — 2026-11-19

### Dictation on the phone, in your languages
- **Choose the languages you dictate in.** A phone's recogniser hears one language at a time and can't tell which you're speaking, so until now it listened in the phone's own language only. **Change language**, on the line above the message box while it listens, lists them: tick the ones you speak.
- **One tap switches between them** while you dictate, keeping what's already in the box. The microphone shows which one it will hear (EN, ES).
- The last lines of the phone's home page say the languages chosen, with **Change**.

## 0.13.0 — 2026-11-19

### On the phone
- **Dictate a message.** A session's message box and **New session** have a microphone: tap it, talk, and the words land in the box as you say them. It keeps listening through pauses until you tap it again or send. Nothing goes to Claude until you press Send.
- **It hears in the phone's languages.** With more than one, the line above the box switches between them and remembers the last.
- **The speech is recognised by the phone's browser, not by Stroll.** In Chrome that means the audio goes to Google's speech service; the app says so the first time. The text then travels to your computer encrypted, like anything typed.
- **A session scrolls like the rest of the phone.** The text follows your finger to the pixel, a flick glides on and slows down, and a touch stops it. Before, it moved two lines at a time and stopped the moment you let go.
- With Claude Code in full-screen mode the computer still redraws each line you scroll to, so on a slow connection the lines coming into view arrive a moment after the rest has moved.

Nothing to install on the phone: the app loads the new version the next time it's opened.

## 0.12.0 — 2026-11-18

### Markdown editors and @ file references
- **Notes, first messages and instructions are markdown editors** (to-dos, trails, Start, Hand off, workflows). The text stays plain markdown, styled as you type: headings, bold, lists, checklists, code. Enter continues a list, Tab indents it, ⌘B/⌘I/⌘E format, and **Structure** inserts an outline for a prompt.
- **Type `@` to reference a file or folder,** with completion over the working directory and a preview. Dropping files on an editor, or **Browse…**, adds them too. A path with spaces or brackets goes in quotes, `@"docs/my notes.md"`; completion writes them for you.
- **References turn green when they exist and red when they don't,** and the files a to-do's or trail's notes reference go to Claude as a list to read. Each is looked up in the note's own working directory first, then in the folder the session starts in.

### To-dos that start on their own
- **A to-do has a first message:** what Claude gets when it starts. Start and Hand off fill it in.
- **Start it automatically:** give it a time and Stroll starts it then, as a session or a background run, and tells you (on your phone too).
- **A session started this way runs as if you had pressed Start,** with your usual Claude Code permissions and nobody watching it. So it only ever starts in the to-do's own working directory, or its trail's: without one it can't be scheduled, and if the folder is gone it doesn't start.
- **It starts once.** Starting the to-do yourself first cancels the scheduled start. It fires only while Stroll is open and the computer awake; a missed time, or a start that failed, waits in Needs you with **Start now**.
- Only Stroll's window on the computer can schedule a start. Claude sessions and the phone can't.

## 0.11.0 — 2026-11-18

### Search the sidebar
- **⌘F (Ctrl+Shift+F on Linux) searches everything in the sidebar:** to-dos, trails, sessions, background runs, workflows and sessions started elsewhere. It looks in titles and in what's behind them (notes, prompts, previews, folders), and shows where it matched.
- **↑ and ↓ move through the matches, Enter opens one, Esc clears.** Collapsed sections, Done, Closed and Archived open while you search and go back as they were after.

### Linux
- `install.sh` adds Stroll to the app menu, with its icon. If you installed before this, run `./install.sh` once more to get it.

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
