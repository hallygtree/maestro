# Maestro

[![License](https://img.shields.io/github/license/hallygtree/maestro)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4)](#limitations)

**Maestro pulls the strings of every Claude Code, Codex CLI and Antigravity
session you have open: it shows each one's status and lets you send a prompt
to any of them from one place.**

It reads the state each agent already writes to disk: no hooks, no changes to
the agents' settings, no network calls. Sessions you open through Maestro run
inside it, so it can also type into them and let you jump in and out.

> [!NOTE]
> Maestro is an early prototype (`v0.1.0`) and runs on Windows only for now.
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
- **No build step.** Node.js 24 runs the TypeScript sources directly.

## Supported tools

| Tool | Where Maestro reads from | What you see |
|------|--------------------------|--------------|
| **Claude Code** | `~/.claude/sessions/*.json`, plus the session transcript | title, directory, model, status, and what it is waiting for |
| **Codex CLI** | `~/.codex/thread-writer-locks/`, `~/.codex/sessions/**/rollout-*.jsonl` | thread name, directory, model, running or finished |
| **Antigravity CLI** (`agy`) | `~/.gemini/antigravity-cli/presence/`, `conversation_summaries.db` | conversation title, workspace, status |

## Quick start

You need [Node.js](https://nodejs.org) 24 or newer and at least one of the
supported CLIs on your `PATH`. `node-pty` ships prebuilt binaries for Windows
x64 and arm64, so no C++ build tools are needed.

```powershell
git clone https://github.com/hallygtree/maestro.git
cd maestro
npm install
npm link      # puts a `maestro` command on your PATH

maestro       # from any folder, in cmd, PowerShell or Git Bash
```

`npm link` points the global command at this folder, so a `git pull` is all an
update takes. To remove the command, run `npm unlink -g maestro`.

Run it in a real terminal (Windows Terminal, the VS Code terminal). It needs an
interactive TTY and exits with a message otherwise.

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
 Tab tabs · ↑↓ session · ←→ cursor · Enter open/send · Ctrl+Q/F12 leave session · Ctrl+N new session
 Ctrl+R history · Ctrl+O resume · Esc clear · Ctrl+C quit · ◆ Maestro ◇ external
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

Windows has no way to type into a program running in another terminal window,
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
| **Claude Code** | `%APPDATA%\trayce\claude_rate_limits.json`, which Trayce saves from Claude Code's status line (`trayce --setup-claude`) | yes |
| **Antigravity** | `%APPDATA%\trayce\antigravity_quota.json`, which Trayce saves while the Antigravity desktop app is open | yes |

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
  checks the lock.
- **Directory and model:** from the thread's rollout log.
- **Status:** the last turn event in the rollout. A started turn with no
  matching completion means it is running.
- **Title:** the thread name from `session_index.jsonl`, or the first prompt
  from `history.jsonl` until Codex names it.
- Sub-agent threads (for example the approval reviewer) are hidden.

### Antigravity

`agy` holds a lock on `presence/<id>.lock` while a conversation is open.
Maestro reads the title, workspace and status of those conversations from
`conversation_summaries.db`, opened read-only.

### Directory suggestions

The folders offered for a new session come from the projects listed in
`~/.claude.json`, the `[projects]` entries in `~/.codex/config.toml`, and the
trusted workspaces in the Antigravity CLI settings.

## Privacy

- **Read-only.** Maestro only reads the files listed above and writes none of
  its own.
- **No credentials.** It never opens token or login files.
- **No network.** Everything stays on your machine. The agents you run through
  Maestro make their own calls, as they would in any terminal.
- **Clean environment.** When Maestro itself runs inside Claude Code, it strips
  the parent session's markers from the environment, so the agents it starts
  save their own history.

## Limitations

- **Windows only.** Codex and Antigravity sessions are detected through Windows
  file locks, and sessions run on ConPTY.
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

```powershell
npm test     # node:test, no extra dependencies
npm start    # runs this checkout without the global command
```

```text
src/
  cli.ts            entry point
  ui.ts             dashboard, tabs and prompt routing (Ink)
  disk.ts           finds live sessions and plan usage from each tool's own files
  pty.ts            sessions Maestro opens (node-pty / ConPTY), enter and leave
  maestro.test.ts   tests for status, keys, launchers, session matching and usage
```

Built with [Ink](https://github.com/vadimdemedes/ink) and
[node-pty](https://github.com/microsoft/node-pty). Node.js 24 runs the `.ts`
files as they are, and `node:sqlite` reads the Antigravity database, so there
is no build step and no extra dependency for either.

## License

[MIT](LICENSE)
