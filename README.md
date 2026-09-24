# Maestro

[![License](https://img.shields.io/github/license/hallygtree/maestro)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-0078D4)](#limitations)

**Maestro pulls the strings of every Claude Code, Codex CLI and Antigravity
session you have open: it shows each one's status and lets you send a prompt
to any of them from one place.**

It reads the state each agent already writes to disk: no hooks, no changes to
the agents' settings, no network calls beyond the update check. Sessions you open through Maestro run
inside it, so it can also type into them and let you jump in and out.

> [!NOTE]
> Maestro is an early prototype (`v0.3.0`). It is used daily on Windows; Linux
> and macOS builds pass the tests but are new (see [Limitations](#limitations)).

## Contents

- [Features](#features)
- [Supported tools](#supported-tools)
- [Quick start](#quick-start)
- [Using Maestro](#using-maestro)
- [Sending a prompt](#sending-a-prompt)
- [Sessions opened elsewhere](#sessions-opened-elsewhere)
- [Plan usage](#plan-usage)
- [How each tool is read](#how-each-tool-is-read)
- [Privacy](#privacy)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## Features

- **Every session in one list.** Claude Code, Codex CLI and Antigravity, with a
  tab per tool.
- **Status at a glance.** Running, finished, or waiting for you, plus the
  session title, working directory and model.
- **One prompt box for all of them.** Write a prompt, pick the tool, then pick
  one of its open sessions (grouped by directory) or start a new one in any
  folder. The box grows as you type and the cursor moves with the arrow keys.
- **Plan usage per tool.** The 5-hour and weekly limits of each plan, with
  reset times, on each tool's tab.
- **Jump in and out.** Enter opens a session full screen; Ctrl+Q or F12 brings
  you back to the dashboard.
- **Nothing to install in the agents.** Sessions you started in other
  terminals show up on their own.
- **One-line install.** No Node.js, npm or clone needed: each release bundles
  its own runtime.

## Supported tools

| Tool | Where Maestro reads from | What you see |
|------|--------------------------|--------------|
| **Claude Code** | `~/.claude/sessions/*.json`, plus the session transcript | title, directory, model, status, and what it is waiting for |
| **Codex CLI** | `~/.codex/thread-writer-locks/`, `~/.codex/sessions/**/rollout-*.jsonl` | thread name, directory, model, running or finished |
| **Antigravity CLI** (`agy`) | `~/.gemini/antigravity-cli/presence/`, `conversation_summaries.db` | conversation title, workspace, status |

## Quick start

Install for your user, with nothing else required. At least one of the
supported CLIs must be on your `PATH`.

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/hallygtree/maestro/main/install.ps1 | iex
```

**Linux and macOS** (x64 and arm64):

```sh
curl -fsSL https://raw.githubusercontent.com/hallygtree/maestro/main/install.sh | sh
```

Then run `maestro` from any folder (on Windows: cmd, PowerShell or Git Bash).
The installer downloads the latest release for your OS and CPU, which carries
its own Node.js, and puts only the `maestro` command on your `PATH`:

| OS | Files | Command | PATH |
|----|-------|---------|------|
| Windows | `%LOCALAPPDATA%\Programs\maestro` | `...\maestro\bin\maestro.cmd` | added to your user `Path` |
| Linux, macOS | `~/.local/share/maestro` | `~/.local/bin/maestro` | added to `~/.zshrc` or `~/.bashrc` if missing |

Maestro updates itself: on launch it checks GitHub for a newer release,
installs it and starts the new version. You can also update by running the
same command again. To uninstall, delete those folders (on
Windows, also remove `...\maestro\bin` from your user `Path`).

Run it in a real terminal (Windows Terminal, the VS Code terminal, Terminal.app,
iTerm2, any Linux terminal). It needs an interactive TTY and exits with a
message otherwise.

## Using Maestro

```text
 ✥ Maestro  All 4  Claude 2  Codex 1  Antigravity 1                 1 running · 1 waiting on you
╭──────────────────────────────────────────────────────────────────────────────────────────────╮
│ ❯ ● Claude      refactor-auth-middleware     ~\code\api            claude-opus-5-5         ◆ │
│   ◐ Claude      fix-flaky-tests              ~\code\web            claude-opus-5-5         ◇ │
│   ✓ Codex       Map unused files             ~\code\api            gpt-6-astra             ◇ │
│   ✓ Antigravity Migrating project configs    ~\notes                                       ◇ │
╰──────────────────────────────────────────────────────────────────────────────────────────────╯
  running  ·  ◆ opened by Maestro (Enter goes in, Ctrl+Q or F12 comes back)
  C:\Users\you\code\api
╭──────────────────────────────────────────────────────────────────────────────────────────────╮
│ › Write a prompt and press Enter to pick the agent…                                          │
╰──────────────────────────────────────────────────────────────────────────────────────────────╯
 Tab tabs · ↑↓ session · ←→ cursor · Enter open/send · Ctrl+Q/F12 leave session · Ctrl+W close session
 Ctrl+N new session · Ctrl+R history · Ctrl+O resume · Esc clear · Ctrl+C quit · ◆ Maestro ◇ external
```

| Mark | Meaning |
|------|---------|
| `●` | running |
| `◐` | waiting for you (a permission prompt or a question) |
| `✓` | finished its turn |
| `◆` | opened by Maestro: you can enter it and send it prompts |
| `◇` | open in another terminal: Maestro can see it but not type into it |

| Key | What it does |
|-----|--------------|
| `Tab` / `Shift+Tab` | Switch between the *All* tab and one tab per tool |
| `↑` `↓` | Select a session |
| type, then `Enter` | Send the prompt (see [Sending a prompt](#sending-a-prompt)). Long prompts wrap and the box grows |
| `←` `→` `Home` `End` | Move the cursor in the prompt box. `Backspace` and `Delete` edit at the cursor |
| `Enter` with an empty prompt | Enter the selected `◆` session full screen. On a `◇` session, resume it here once you close it ([why](#sessions-opened-elsewhere)) |
| `Ctrl+Q` or `F12` | Leave a session and go back to the dashboard. Use F12 in the VS Code terminal, which keeps Ctrl+Q for itself |
| `Ctrl+W` | Close the selected `◆` session (press twice to confirm). It can be reopened with `Ctrl+O` |
| `Ctrl+N` | Start a new, empty session: pick the tool, the directory, then the mode |
| `Ctrl+R` | Pick one of your last 50 prompts and put it back in the prompt box, to send it again (say, after picking the wrong directory). Kept in `~/.maestro/history.json` |
| `Ctrl+O` | Resume a session Maestro opened before, in the same mode, for example after closing Maestro. One option resumes all the sessions that were open when it closed. Kept in `~/.maestro/sessions.json` (last 20) |
| `Esc` | Clear the prompt, close a picker, or cancel a pending resume |
| `Ctrl+C` | Quit. Asks again first if it would close sessions Maestro opened |

The list refreshes every 1.5 seconds. In a narrow window the key hints under
the prompt box wrap onto more lines instead of being cut off. While you are
inside a session, the terminal tab's title ends with *Ctrl+Q or F12 returns to
Maestro*, and the first time you enter one the hint also shows on screen for a
moment.

## Sending a prompt

1. Type the prompt and press `Enter`.
2. **Pick the tool.** On a tool's tab this step is skipped.
3. **Pick the session.** Maestro lists that tool's open sessions with their
   directories, the ones it opened first, then **＋ New session…**.
4. For a new session, **pick the directory.** The folder you started Maestro
   from comes first, then every folder where Claude Code, Codex or Antigravity
   has already run, then **✎ Other path…** to type one.
5. For a new session, **pick the mode** it starts in. Each tool lists only the
   modes its CLI accepts at launch: Claude Code has manual, accept edits, plan,
   auto and bypass; Codex has read-only, auto and bypass; Antigravity has
   accept edits, plan and bypass. The first option passes no flag, so the
   tool's own config decides. Maestro remembers the last mode per tool.

What happens next depends on the session:

- **Opened by Maestro (`◆`):** the prompt is typed into it and submitted. You
  stay on the dashboard and watch its status change.
- **New session:** the tool starts in that directory with your prompt. With no
  prompt (`Ctrl+N`), Maestro opens it full screen right away.
- **Open in another terminal (`◇`):** see the next section.

## Sessions opened elsewhere

There is no reliable way to type into a program running in another terminal window,
and running the same session twice would split its history. So for a session
you started elsewhere, Maestro waits:

1. You pick it (with or without a prompt).
2. You close it in its own terminal (`/exit`).
3. Maestro notices it closed and resumes it inside Maestro, with your prompt if
   you wrote one. From then on it is a `◆` session.

`Esc` cancels the wait. Maestro only resumes after the session has been gone
for two refreshes in a row, so a status file caught mid-write does not trigger
a second copy.

Maestro starts and resumes each tool with its own flags:

| Tool | New session | Resume |
|------|-------------|--------|
| Claude Code | `claude --session-id <new id> [prompt]` | `claude --resume <id> [prompt]` |
| Codex CLI | `codex [prompt]` | `codex resume <id> [prompt]` |
| Antigravity | `agy [-i prompt]` | `agy --conversation <id> [-i prompt]` |

## Plan usage

On each tool's tab, the line under the tabs shows how much of that plan you
have used, with a bar and the reset time. The *All* tab leaves it out:

```text
 5h 67% ▓▓▓▓▓▓▓░░░ resets 14:05  ·  7d 31% ▓▓▓░░░░░░░ resets Tue 09:42
```

Green is below 50%, yellow 50% to 79%, red 80% or more. A window whose reset
time has passed shows `0%`. The numbers are re-read every 30 seconds.

These are the real percentages each provider reports, not estimates. Maestro
reads them from the same places as [Trayce](https://github.com/hallygtree/trayce):

| Tool | Where the numbers come from | Needs Trayce |
|------|-----------------------------|--------------|
| **Codex CLI** | the `rate_limits` snapshot Codex writes to its rollout logs on every turn | no |
| **Claude Code** | `trayce/claude_rate_limits.json`, which Trayce saves from Claude Code's status line (`trayce --setup-claude`) | yes |
| **Antigravity** | `trayce/antigravity_quota.json`, which Trayce saves while the Antigravity desktop app is open | yes |

The `trayce` folder is in `%APPDATA%` on Windows, `~/Library/Application Support`
on macOS and `~/.local/share` (or `$XDG_DATA_HOME`) on Linux.

Without that data, the tab says what to do instead of showing a number.

## How each tool is read

### Claude Code

Claude Code keeps one `~/.claude/sessions/<pid>.json` file per running
session, with its status (`busy`, `idle`, `waiting`), name, directory and what
it is waiting for. Maestro lists the interactive ones whose process is still
alive, and takes the model from the end of the session transcript. Background
jobs are not listed.

### Codex CLI

- **Which sessions are open:** Codex holds a lock on
  `~/.codex/thread-writer-locks/<id>.lock` while a thread is open. Maestro
  checks the lock: on Windows the file can't be read, on Linux the lock is
  listed in `/proc/locks`, and on macOS `lsof` shows the file open.
- **Directory and model:** from the thread's rollout log.
- **Status:** the last turn event in the rollout. A started turn with no
  matching completion means it is running.
- **Title:** the thread name from `session_index.jsonl`, or the first prompt
  from `history.jsonl` until Codex names it.
- Sub-agent threads (for example the approval reviewer) are hidden.

### Antigravity

`agy` holds a lock on `presence/<id>.lock` while a conversation is open,
checked the same way as Codex.
Maestro reads the title, workspace and status of those conversations from
`conversation_summaries.db`, opened read-only.

### Directory suggestions

The folders offered for a new session come from the projects listed in
`~/.claude.json`, the `[projects]` entries in `~/.codex/config.toml`, and the
trusted workspaces in the Antigravity CLI settings.

## Privacy

- **Read-only for the agents.** Maestro only reads the agents' files listed
  above. Its own prompt history and recent sessions go to `~/.maestro/`.
- **No credentials.** It never opens token or login files.
- **One network call.** On launch, Maestro asks GitHub for the latest release
  and downloads it if it is newer. `MAESTRO_NO_UPDATE=1` turns that off.
  Everything else stays on your machine. The agents you run through Maestro
  make their own calls, as they would in any terminal.
- **Clean environment.** When Maestro itself runs inside Claude Code, it strips
  the parent session's markers from the environment, so the agents it starts
  save their own history.

## Limitations

- **Linux and macOS are new.** They pass the same tests as Windows, and Linux
  was run end to end in a container, but not yet with real Codex or
  Antigravity sessions. On macOS, Codex and Antigravity detection relies on
  `lsof`, and F12 may need `Fn`; Ctrl+Q works everywhere.
- **Linux builds need glibc 2.35 or newer** (Ubuntu 22.04, Debian 12, Fedora
  36 and later). Alpine and other musl distros are not supported.
- **Typing into other terminals.** Maestro cannot type into sessions opened
  elsewhere; it resumes them after you close them (see above).
- **Codex approvals.** A Codex session waiting for your approval shows as
  running, because the request is not written to its log.
- **Sessions end with Maestro.** Sessions Maestro opened close when you quit
  it. There is no background process keeping them alive.
- **Coming back from a session.** Maestro redraws the agent by resizing it.
  Terminal modes the agent switched on earlier, such as mouse reporting, are
  not restored when you enter it again.
- **No line breaks in prompts.** Long prompts wrap in the box, but `Enter`
  always sends, and pasted line breaks become spaces.
- **Two new sessions, same folder.** A new Codex or Antigravity session gets its
  ID only after its first turn, and until then it is matched by folder. Two new
  sessions of the same tool in the same folder can swap places.
- **Plan usage.** Claude and Antigravity usage needs Trayce. The numbers are as
  fresh as the tool's last reply (Claude, Codex) or the last time the
  Antigravity desktop app was open.
- **Undocumented formats.** Every file Maestro reads is internal to its tool
  and may change in a future release.
- **Not yet tested:** resuming an Antigravity conversation with `--conversation`
  in interactive mode.

Tested on Windows 11 with Claude Code 2.1.281, Codex CLI 0.154.0 and
Antigravity CLI 1.2.10.

## Development

Needs [Node.js](https://nodejs.org) 24 or newer.

```sh
git clone https://github.com/hallygtree/maestro.git
cd maestro
npm install
npm test     # node:test, no extra dependencies
npm start    # runs this checkout
```

```text
src/
  cli.ts            entry point
  ui.ts             dashboard, tabs and prompt routing (Ink)
  disk.ts           finds live sessions and plan usage from each tool's own files
  pty.ts            sessions Maestro opens (node-pty), enter and leave
  update.ts         self-update from GitHub Releases on launch
  maestro.test.ts   tests for status, keys, launchers, session matching, locks and usage
install.sh          installer for Linux and macOS
install.ps1         installer for Windows
.github/workflows/release.yml
                    tests on the six platforms; a v* tag publishes one
                    tarball per platform (Node + node_modules) to Releases
```

To release, bump `version` in `package.json` and push a `v*` tag.

Built with [Ink](https://github.com/vadimdemedes/ink) and
[node-pty](https://github.com/microsoft/node-pty). Node.js 24 runs the `.ts`
files as they are, and `node:sqlite` reads the Antigravity database, so there
is no build step and no extra dependency for either.

## License

[MIT](LICENSE)
