# pi-tmux-pane

A [pi](https://pi.dev) extension that lets the agent work in a tmux pane you can also see.
The agent types into the pane next to pi, waits for the command to finish, and gets back
**only the new output**, not the whole screen.

```
┌──────────────── pi ───────────────┬──────────── your shell ────────────┐
│ > run the tests in the other pane │ $ npm test                         │
│ tmux_send "npm test" ...          │ ✓ 42 passing                       │
│ [reason: matched | pane %1 | 3.2s]│ $                                  │
└───────────────────────────────────┴────────────────────────────────────┘
```

## Install

```bash
pi install npm:pi-tmux-pane
# or
pi install git:github.com/corynezin/pi-tmux-pane
```

Run pi inside tmux and split the window (`prefix %`). The tools register only when pi runs
inside tmux (`$TMUX_PANE` is set).

## Tools

| Tool | What it does |
|---|---|
| `tmux_list_panes` | Lists the panes in pi's window: id, index, current command, size. Marks pi's own pane and the default target. |
| `tmux_send` | Types literal `text` (with Enter by default), then named `keys` (`C-c`, `Escape`, `Up`, ...). Then polls every 300 ms until `wait_for` (a multiline regex) matches the new output, the screen stays unchanged for `idle_ms`, or `timeout_seconds` runs out. The header line gives the reason: `matched`, `idle` or `timeout`. |
| `tmux_read` | Reads the pane without sending input. With `new_only`, shows only what changed since the last read or send. |

The target pane defaults to the first other pane in pi's window. To pick another one, pass
`pane` with a pane id (`%5`) or a pane index.

### Options

- `scrollback_lines` (default 200): how many lines that scrolled off the top to include. If
  more scrolled off, the result says `N more lines scrolled off, pass scrollback_lines >= N`.
- `pure_diff`: return `+`/`-` hunks with `@@` headers instead of the new lines.
- `idle_ms`: defaults to 1000. When `wait_for` is set, idle detection is off unless you pass
  `idle_ms`, so slow commands wait for the match instead of stopping early.
- `allow_own_pane` (default `false`): allow sending to pi's own pane. Input there goes to pi
  itself: text + Enter queues a message, and `C-c`/`Escape` cancels the run or quits pi.

## How the diffing works

The extension keeps a snapshot of each pane: history lines, screen lines, `history_size`,
whether the history is full, and whether the alternate screen is on. Before sending input it
takes a snapshot. After the wait it compares the new screen with the snapshot using an LCS line
match, and returns the lines from the first unmatched line down. The growth of `history_size`
tells how many lines scrolled off the top.

Normal and alternate screens are stored under separate snapshot keys. If you open vim and quit,
the shell diff is still taken against the shell snapshot from before vim started.

Output is cut to the last 40k characters.

## tmux quirks it works around

- **A trailing `;` is dropped, even with `send-keys -l`.** tmux treats an argument ending in
  `;` as a command separator: `echo a;` arrives as `echo a`, and a lone `;` disappears. The
  extension sends a final `;` as `\;`.
- **Text starting with `-`** is sent after `--`, so tmux doesn't read it as an option.
- **Key names** containing `;`, `{`, `}` or control characters are rejected, because tmux
  treats them as command syntax.
- **Copy mode swallows input.** If the pane is in copy mode (you are scrolling), the extension
  waits 2 s, then cancels copy mode.
- **The history shrinks once it's full.** At `history-limit`, tmux deletes 10% of the history
  at a time, so `history_size` can go down. Near the limit the extension compares the history
  tail plus the screen instead of counting rows.
- **Captures can be torn.** If output arrives between `display-message` and `capture-pane`, the
  capture is retried.
- **Trimmed prompts.** Lines are right-trimmed, so the prompt `$ ` becomes `$`. `wait_for` is
  also tried with the trailing space restored on the last line, so `\$ $` still matches.
- **Paste detection.** Text and Enter are sent separately, with a short pause, because some
  terminal UIs treat a fast burst as a paste and turn the Enter into a newline.

## Guidelines added to the system prompt

- Use bash for one-shot commands.
- Do not mix tmux calls with other calls that touch the pane in one response.
- Send `C-u` before you type a shell command.
- Use `wait_for` with a prompt regex for slow commands.
- After a timeout, poll with `tmux_read new_only`.
- Ask the user before you run destructive commands.

## Prior art

These pi tmux extensions helped with the implementation and some of the quirks above:
[pi-tmux-harness](https://pi.dev/packages/pi-tmux-harness),
[@getpipher/term](https://github.com/getpipher/term),
[@ogulcancelik/pi-tmux](https://www.npmjs.com/package/@ogulcancelik/pi-tmux),
[offline-ant/pi-tmux](https://github.com/offline-ant/pi-tmux).

## License

MIT
