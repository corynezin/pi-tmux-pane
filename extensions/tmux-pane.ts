/**
 * tmux-pane: lets the agent work in a tmux pane that the user can also see.
 *
 * When pi runs inside tmux it finds its own pane from $TMUX_PANE and targets the
 * first *other* pane in its window by default. Tools:
 *   - tmux_list_panes  list panes in pi's window (pi's own pane is marked)
 *   - tmux_send        type literal text (+Enter) and named keys, then wait for
 *                      a regex match, idle screen, or timeout, and return only new output
 *   - tmux_read        read the pane without sending input (optionally only new output)
 *
 * The main feature is diffing. A snapshot of each pane (history lines, screen lines,
 * history_size, whether the history is full, alternate screen on/off) is kept under
 * separate keys for the normal and alternate screens. After a send, the new screen is
 * compared with the snapshot using an LCS line match, and the lines from the first
 * unmatched line down are returned. The growth of history_size tells how many rows
 * scrolled off the top.
 *
 * Gotchas handled, many from existing extensions (pi-tmux-harness, @getpipher/term,
 * @ogulcancelik/pi-tmux, offline-ant/pi-tmux) and checked against tmux 3.5a:
 *   - tmux treats an argv element ending in ';' as a command separator, even with
 *     `send-keys -l`: "echo a;" arrives as "echo a" and a lone ";" disappears. A final
 *     ';' has to be sent as "\;".
 *   - Text is sent with `-l --` so text that starts with '-' isn't parsed as a flag
 *     (pi-tmux-harness).
 *   - Key names are checked: no ; { } and no control bytes, since tmux would treat
 *     them as command separators (pi-tmux-harness).
 *   - Text and named keys are sent as separate send-keys calls, so a key name like
 *     "Enter" isn't typed as the literal word (@getpipher/term, @ogulcancelik/pi-tmux).
 *   - A pane in copy mode swallows send-keys. The user may be scrolling, so wait
 *     briefly, then cancel copy mode (offline-ant/pi-tmux).
 *   - capture-pane pads the screen with blank rows, and -J keeps trailing spaces.
 *     Trailing whitespace and trailing blank lines are trimmed.
 *   - history_size counts physical rows and stops growing once history_limit is
 *     reached. When the history is full, the scrolled-row count is unknown, so the
 *     extension falls back to an LCS over history tail + screen.
 *   - Output can arrive between display-message and capture-pane, so a capture is
 *     retried if history_size or the alternate-screen flag changed during it.
 *   - The text and the Enter are sent as separate calls with a short pause between
 *     them. This is my own choice, not taken from the extensions above: some TUIs
 *     treat a fast burst as a paste and turn the Enter into a newline.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const POLL_MS = 300;
const MAX_OUTPUT_CHARS = 40_000;
const HISTORY_TAIL = 300; // history lines kept in every snapshot
const FULL_HISTORY_CAPTURE = 3000; // history lines compared when history is full
const MAX_SCROLL_CAPTURE = 5000; // max scrolled-off rows captured for one diff
const DEFAULT_SCROLLBACK = 200;
const DEFAULT_TIMEOUT_S = 30;
const DEFAULT_IDLE_MS = 1000;
const ENTER_DELAY_MS = 80;
const COPY_MODE_WAIT_MS = 2000;

interface PaneMeta {
	historySize: number;
	historyLimit: number;
	alt: boolean;
	width: number;
	height: number;
	inMode: boolean;
	dead: boolean;
	command: string;
}

interface Snapshot {
	paneId: string;
	history: string[]; // tail of the history (up to HISTORY_TAIL lines)
	screen: string[];
	historySize: number;
	historyFull: boolean;
	alt: boolean;
	time: number;
}

interface DiffResult {
	text: string;
	changed: boolean;
	notes: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cleanLines(raw: string): string[] {
	const lines = raw.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function tailChars(text: string, max = MAX_OUTPUT_CHARS): string {
	if (text.length <= max) return text;
	const cut = text.length - max;
	let body = text.slice(cut);
	const nl = body.indexOf("\n");
	if (nl >= 0 && nl < 200) body = body.slice(nl + 1); // start on a line boundary
	return `[... ${text.length - body.length} earlier characters cut ...]\n${body}`;
}

/** tmux turns a trailing ';' in an argv element into a command separator; "\;" yields a literal ';'. */
function escapeTrailingSemicolon(s: string): string {
	return s.endsWith(";") ? `${s.slice(0, -1)}\\;` : s;
}

function validateKeys(keys: string[]): void {
	for (const k of keys) {
		if (typeof k !== "string" || k.length === 0) throw new Error("Invalid empty key name");
		if (/[;{}]/.test(k))
			throw new Error(`Key '${k}' contains ; { or } which tmux treats as command syntax. Send it via 'text' instead.`);
		if (/[\x00-\x1f\x7f]/.test(k))
			throw new Error(`Key ${JSON.stringify(k)} contains control characters; use tmux names like 'C-c', 'Enter', 'Escape'.`);
	}
}

// ---------------------------------------------------------------------------
// LCS line matching
// ---------------------------------------------------------------------------

/** Returns matched index pairs [i in a, j in b] of a longest common subsequence. */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
	// Strip common prefix/suffix first; keeps the DP table small in the common case.
	let pre = 0;
	while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
	let suf = 0;
	while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
	const A = a.slice(pre, a.length - suf);
	const B = b.slice(pre, b.length - suf);
	const n = A.length;
	const m = B.length;
	const pairs: Array<[number, number]> = [];
	for (let i = 0; i < pre; i++) pairs.push([i, i]);
	if (n > 0 && m > 0) {
		const w = m + 1;
		const dp = new Int32Array((n + 1) * w);
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				dp[i * w + j] =
					A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (A[i] === B[j]) {
				pairs.push([pre + i, pre + j]);
				i++;
				j++;
			} else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
			else j++;
		}
	}
	for (let k = 0; k < suf; k++) pairs.push([a.length - suf + k, b.length - suf + k]);
	return pairs;
}

/** Unified-style +/- hunks with @@ headers. */
function unifiedHunks(a: string[], b: string[], pairs: Array<[number, number]>, context = 2): string {
	type Op = { t: " " | "-" | "+"; line: string; ai: number; bi: number };
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
		while (i < pi) ops.push({ t: "-", line: a[i], ai: i++, bi: j });
		while (j < pj) ops.push({ t: "+", line: b[j], ai: i, bi: j++ });
		if (pi < a.length && pj < b.length) ops.push({ t: " ", line: a[i], ai: i++, bi: j++ });
	}
	const out: string[] = [];
	let k = 0;
	while (k < ops.length) {
		if (ops[k].t === " ") {
			k++;
			continue;
		}
		let start = Math.max(0, k - context);
		let end = k;
		// extend the hunk while changes are within 2*context of each other
		while (end < ops.length) {
			if (ops[end].t !== " ") {
				end++;
				continue;
			}
			let run = 0;
			while (end + run < ops.length && ops[end + run].t === " ") run++;
			if (end + run >= ops.length || run > context * 2) {
				end = Math.min(ops.length, end + context);
				break;
			}
			end += run;
		}
		const hunk = ops.slice(start, end);
		const aStart = hunk[0].ai;
		const bStart = hunk[0].bi;
		const aLen = hunk.filter((o) => o.t !== "+").length;
		const bLen = hunk.filter((o) => o.t !== "-").length;
		out.push(`@@ -${aStart + 1},${aLen} +${bStart + 1},${bLen} @@`);
		for (const o of hunk) out.push(`${o.t}${o.line}`);
		k = end;
		start = end;
	}
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const ownPane = process.env.TMUX_PANE;
	// Only register when running inside tmux; otherwise the tools would just add noise.
	if (!process.env.TMUX || !ownPane) return;

	const snapshots = new Map<string, Snapshot>();
	const snapKey = (paneId: string, alt: boolean) => `${paneId}:${alt ? "alt" : "normal"}`;

	async function tmux(args: string[], signal?: AbortSignal): Promise<string> {
		const r = await pi.exec("tmux", args, { signal, timeout: 10_000 });
		if (r.code !== 0) throw new Error(`tmux ${args[0]} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
		return r.stdout;
	}

	async function getMeta(pane: string, signal?: AbortSignal): Promise<PaneMeta> {
		const out = await tmux(
			[
				"display-message",
				"-p",
				"-t",
				pane,
				"#{history_size}\t#{history_limit}\t#{alternate_on}\t#{pane_width}\t#{pane_height}\t#{pane_in_mode}\t#{pane_dead}\t#{pane_current_command}",
			],
			signal,
		);
		const [hs, hl, alt, w, h, mode, dead, ...cmd] = out.replace(/\n$/, "").split("\t");
		return {
			historySize: Number(hs) || 0,
			historyLimit: Number(hl) || 0,
			alt: alt === "1",
			width: Number(w) || 0,
			height: Number(h) || 0,
			inMode: mode === "1",
			dead: dead === "1",
			command: cmd.join("\t"),
		};
	}

	async function captureRange(pane: string, start: number | null, end: number | null, signal?: AbortSignal) {
		const args = ["capture-pane", "-p", "-J", "-t", pane];
		if (start !== null) args.push("-S", String(start));
		if (end !== null) args.push("-E", String(end));
		return cleanLines(await tmux(args, signal));
	}

	/** Consistent capture: retry when output arrives between metadata and capture. */
	async function capture(pane: string, historyLines: number, signal?: AbortSignal) {
		let meta = await getMeta(pane, signal);
		let screen: string[] = [];
		let history: string[] = [];
		for (let attempt = 0; attempt < 3; attempt++) {
			const n = Math.min(historyLines, meta.historySize);
			history = n > 0 ? await captureRange(pane, -n, -1, signal) : [];
			screen = await captureRange(pane, null, null, signal);
			const after = await getMeta(pane, signal);
			const stable = after.historySize === meta.historySize && after.alt === meta.alt;
			meta = after;
			if (stable) break;
		}
		const snap: Snapshot = {
			paneId: pane,
			history,
			screen,
			historySize: meta.historySize,
			// tmux drops history_limit/10 rows at a time once the limit is hit, so a "full"
			// history hovers between 90% and 100% of the limit (and history_size can shrink).
			historyFull: meta.historyLimit > 0 && meta.historySize >= meta.historyLimit - Math.ceil(meta.historyLimit / 10) - 1,
			alt: meta.alt,
			time: Date.now(),
		};
		return { snap, meta };
	}

	// ----- pane resolution -----

	interface PaneRow {
		id: string;
		index: string;
		size: string;
		active: boolean;
		command: string;
	}

	async function listPanes(signal?: AbortSignal): Promise<PaneRow[]> {
		const out = await tmux(
			[
				"list-panes",
				"-t",
				ownPane!,
				"-F",
				"#{pane_id}\t#{pane_index}\t#{pane_width}x#{pane_height}\t#{pane_active}\t#{pane_current_command}",
			],
			signal,
		);
		return out
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => {
				const [id, index, size, active, ...cmd] = l.split("\t");
				return { id, index, size, active: active === "1", command: cmd.join("\t") };
			});
	}

	async function resolvePane(target: string | undefined, signal?: AbortSignal): Promise<string> {
		const panes = await listPanes(signal);
		let id: string | undefined;
		if (!target) {
			id = panes.find((p) => p.id !== ownPane)?.id;
			if (!id)
				throw new Error(
					"No other pane in pi's window. Ask the user to split the window (or run `tmux split-window -h -d` with bash if they agree).",
				);
		} else if (/^\d+$/.test(target)) {
			id = panes.find((p) => p.index === target)?.id;
			if (!id) throw new Error(`No pane with index ${target} in pi's window. Use tmux_list_panes.`);
		} else {
			// pane id (%N) or any tmux target; normalize to a pane id
			id = (await tmux(["display-message", "-p", "-t", target, "#{pane_id}"], signal)).trim();
			if (!id) throw new Error(`Unknown tmux pane '${target}'`);
		}
		return id;
	}

	// ----- diffing -----

	/**
	 * Compare `now` against `base` (same screen kind). Returns the new lines from the first
	 * unmatched line down, or +/- hunks with pure_diff.
	 */
	async function diff(
		pane: string,
		base: Snapshot,
		now: Snapshot,
		opts: { scrollback: number; pureDiff: boolean },
		signal?: AbortSignal,
	): Promise<DiffResult> {
		const notes: string[] = [];
		let oldStream: string[];
		let newStream: string[];
		let scrolledCount: number; // how many leading lines of newStream come from history
		let unknownScroll = false;

		const growth = now.historySize - base.historySize;
		if (now.alt) {
			// alternate screen has no history; compare screens only
			oldStream = base.screen;
			newStream = now.screen;
			scrolledCount = 0;
		} else if (growth < 0 && !base.historyFull) {
			notes.push("history was cleared since the last snapshot");
			oldStream = base.screen;
			newStream = now.screen;
			scrolledCount = 0;
		} else if (!now.historyFull && !base.historyFull) {
			// Exact: history_size grew by `growth` rows since the snapshot.
			const rows = Math.min(growth, MAX_SCROLL_CAPTURE);
			const scrolled = rows > 0 ? await captureRange(pane, -rows, -1, signal) : [];
			if (growth > rows) notes.push(`${growth - rows} rows scrolled off beyond the ${MAX_SCROLL_CAPTURE}-row capture limit`);
			oldStream = base.screen;
			newStream = [...scrolled, ...now.screen];
			scrolledCount = scrolled.length;
		} else {
			// History is full: rows are dropped from the top, so growth is not a reliable count.
			// Align old history tail + screen against the new history tail + screen.
			unknownScroll = true;
			const n = Math.min(FULL_HISTORY_CAPTURE, now.historySize);
			const hist = n > 0 ? await captureRange(pane, -n, -1, signal) : [];
			oldStream = [...base.history, ...base.screen];
			newStream = [...hist, ...now.screen];
			scrolledCount = hist.length;
		}

		const pairs = lcsPairs(oldStream, newStream);

		if (opts.pureDiff) {
			// Hide history-only context: start the diff view at the first changed region.
			const hunks = unifiedHunks(oldStream, newStream, pairs);
			return { text: hunks, changed: hunks.length > 0, notes };
		}

		const matchedNew = new Uint8Array(newStream.length);
		for (const [, j] of pairs) matchedNew[j] = 1;
		let first = newStream.findIndex((_, j) => !matchedNew[j]);
		if (first < 0) return { text: "", changed: false, notes };

		let fromHistory = Math.max(0, scrolledCount - first);
		if (unknownScroll && first === 0 && base.history.length > 0) {
			notes.push("tmux history is full; older output may have been dropped (raise history-limit to keep more)");
		}
		if (fromHistory > opts.scrollback) {
			const extra = fromHistory - opts.scrollback;
			notes.push(`${extra} more lines scrolled off, pass scrollback_lines >= ${fromHistory}`);
			first += extra;
			fromHistory = opts.scrollback;
		}
		return { text: newStream.slice(first).join("\n"), changed: true, notes };
	}

	function header(parts: Array<string | false | undefined>): string {
		return `[${parts.filter(Boolean).join(" | ")}]`;
	}

	function result(text: string, details: Record<string, unknown>) {
		return { content: [{ type: "text" as const, text: tailChars(text) }], details };
	}

	// ----- tools -----

	const paneParam = Type.Optional(
		Type.String({
			description: "Target pane: pane id like '%5' or pane index in pi's window. Default: first other pane in pi's window.",
		}),
	);
	const scrollbackParam = Type.Optional(
		Type.Integer({
			minimum: 0,
			description: `Max number of lines that scrolled off the top to include (default ${DEFAULT_SCROLLBACK}).`,
		}),
	);
	const pureDiffParam = Type.Optional(
		Type.Boolean({ description: "Return +/- hunks with @@ headers instead of the new lines." }),
	);

	pi.registerTool({
		name: "tmux_list_panes",
		label: "tmux list panes",
		description: "List the tmux panes in pi's window with id, index, current command and size. Pi's own pane is marked.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute(_id, _params, signal) {
			const panes = await listPanes(signal);
			const def = panes.find((p) => p.id !== ownPane)?.id;
			const lines = panes.map(
				(p) =>
					`${p.id}\tindex=${p.index}\t${p.command}\t${p.size}${p.id === ownPane ? "\t(pi - this agent)" : ""}${p.id === def ? "\t(default target)" : ""}${p.active ? "\t(active)" : ""}`,
			);
			return result(lines.join("\n"), { panes, ownPane });
		},
	});

	pi.registerTool({
		name: "tmux_send",
		label: "tmux send",
		description:
			"Type into a tmux pane the user can see, then wait and return only the new output. Sends literal `text` (optionally followed by Enter), then named `keys` (tmux names: C-c, C-u, Escape, Enter, Up, Tab, ...). Then polls every 300 ms until `wait_for` (multiline regex) matches the new output, the screen stays unchanged for `idle_ms`, or `timeout_seconds` passes. The first line reports the reason: matched, idle or timeout.",
		promptSnippet: "Type into the user-visible tmux pane and get back only the new output",
		promptGuidelines: [
			"Use bash for one-shot commands; use the tmux_* tools only for work that should happen in the user-visible tmux pane (interactive programs, long-running processes, REPLs, TUIs).",
			"Do not mix tmux_* calls with other tool calls that touch the same pane (or each other) in one response; issue them one at a time.",
			"Send keys ['C-u'] before you type a shell command into the tmux pane, so leftover input on the prompt line is cleared.",
			"For slow tmux commands, pass wait_for with a regex for the shell prompt (or another completion marker) instead of relying on idle detection.",
			"After a tmux_send timeout, poll with tmux_read new_only: true instead of sending the command again.",
			"Ask the user before you run destructive commands in the tmux pane.",
		],
		parameters: Type.Object({
			pane: paneParam,
			text: Type.Optional(Type.String({ description: "Literal text to type. Newlines are sent as Enter." })),
			enter: Type.Optional(Type.Boolean({ description: "Press Enter after the text (default true when text is given)." })),
			keys: Type.Optional(
				Type.Array(Type.String(), { description: "Named tmux keys sent after the text, e.g. ['C-c'], ['Escape'], ['Up', 'Enter']. Use text for literal characters." }),
			),
			wait_for: Type.Optional(
				Type.String({
					description:
						"Regex (multiline flag on) tested against the new output, e.g. a prompt regex like '^\\$ ?$'. Lines are right-trimmed.",
				}),
			),
			idle_ms: Type.Optional(
				Type.Integer({
					minimum: 0,
					description: `Stop once the screen is unchanged this long (default ${DEFAULT_IDLE_MS}; disabled by default when wait_for is set).`,
				}),
			),
			timeout_seconds: Type.Optional(
				Type.Number({ minimum: 0, maximum: 3600, description: `Max time to wait (default ${DEFAULT_TIMEOUT_S}).` }),
			),
			scrollback_lines: scrollbackParam,
			pure_diff: pureDiffParam,
			allow_own_pane: Type.Optional(
				Type.Boolean({
					description:
						"DANGEROUS, default false. Allow sending to pi's own pane. Input there goes to pi itself: text + Enter queues a message to yourself, and C-c/Escape cancels your own run or quits pi. Only use when the user explicitly asks.",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const pane = await resolvePane(params.pane, signal);
			const toOwnPane = pane === ownPane;
			if (toOwnPane && !params.allow_own_pane)
				throw new Error(
					"Refusing to send keys to pi's own pane (input would go to pi itself). Pass allow_own_pane: true only if the user explicitly asked for this.",
				);
			const keys = params.keys ?? [];
			validateKeys(keys);
			let waitRe: RegExp | undefined;
			if (params.wait_for) {
				try {
					waitRe = new RegExp(params.wait_for, "m");
				} catch (e: any) {
					throw new Error(`Invalid wait_for regex: ${e?.message ?? e}`);
				}
			}
			const timeoutMs = (params.timeout_seconds ?? DEFAULT_TIMEOUT_S) * 1000;
			const idleMs = params.idle_ms ?? (waitRe ? undefined : DEFAULT_IDLE_MS);
			const scrollback = params.scrollback_lines ?? DEFAULT_SCROLLBACK;
			const notes: string[] = [];

			// Copy mode swallows input; the user may be scrolling, so give them a moment.
			let meta = await getMeta(pane, signal);
			if (meta.dead) throw new Error(`Pane ${pane} is dead (its process exited).`);
			if (meta.inMode) {
				const until = Date.now() + COPY_MODE_WAIT_MS;
				while (meta.inMode && Date.now() < until) {
					await sleep(250);
					meta = await getMeta(pane, signal);
				}
				if (meta.inMode) {
					await tmux(["send-keys", "-t", pane, "-X", "cancel"], signal);
					notes.push("cancelled copy mode in target pane");
				}
			}

			// Snapshot before sending input.
			const { snap: before } = await capture(pane, HISTORY_TAIL, signal);
			snapshots.set(snapKey(pane, before.alt), before);

			// Send literal text (newlines become Enter), then Enter, then named keys.
			if (params.text) {
				const lines = params.text.split(/\r?\n/);
				for (let i = 0; i < lines.length; i++) {
					if (lines[i]) await tmux(["send-keys", "-t", pane, "-l", "--", escapeTrailingSemicolon(lines[i])], signal);
					const isLast = i === lines.length - 1;
					if (!isLast || params.enter !== false) {
						await sleep(ENTER_DELAY_MS);
						await tmux(["send-keys", "-t", pane, "Enter"], signal);
					}
				}
			}
			if (keys.length) await tmux(["send-keys", "-t", pane, "--", ...keys], signal);

			// Poll until matched / idle / timeout.
			const start = Date.now();
			let reason: "matched" | "idle" | "timeout" | "aborted" = "timeout";
			let lastSig = "";
			let lastChange = start;
			while (true) {
				if (signal?.aborted) {
					reason = "aborted";
					break;
				}
				await sleep(POLL_MS);
				const m = await getMeta(pane, signal);
				const screen = await captureRange(pane, null, null, signal);
				const sig = `${m.alt ? 1 : 0}|${m.historySize}|${screen.join("\n")}`;
				const now = Date.now();
				if (sig !== lastSig) {
					lastSig = sig;
					lastChange = now;
					if (waitRe) {
						const { snap } = await capture(pane, HISTORY_TAIL, signal);
						const base = snap.alt === before.alt ? before : snapshots.get(snapKey(pane, snap.alt));
						const d = base
							? await diff(pane, base, snap, { scrollback: MAX_SCROLL_CAPTURE, pureDiff: false }, signal)
							: { text: snap.screen.join("\n") };
						// Lines are right-trimmed, so a prompt like "$ " shows up as "$". Also try with the
						// trailing space restored on the last line so natural regexes like `\$ $` still match.
						if (waitRe.test(d.text) || waitRe.test(`${d.text} `)) {
							reason = "matched";
							break;
						}
					}
				} else if (idleMs !== undefined && now - lastChange >= idleMs) {
					reason = "idle";
					break;
				}
				if (now - start >= timeoutMs) {
					reason = "timeout";
					break;
				}
			}
			const elapsed = ((Date.now() - start) / 1000).toFixed(1);

			// Final capture and diff.
			const { snap: after, meta: afterMeta } = await capture(pane, HISTORY_TAIL, signal);
			let body: string;
			let changed = true;
			if (after.alt === before.alt) {
				const d = await diff(pane, before, after, { scrollback, pureDiff: !!params.pure_diff }, signal);
				body = d.text;
				changed = d.changed;
				notes.push(...d.notes);
			} else {
				notes.push(after.alt ? "switched to the alternate screen" : "left the alternate screen");
				const base = snapshots.get(snapKey(pane, after.alt));
				if (base) {
					const d = await diff(pane, base, after, { scrollback, pureDiff: !!params.pure_diff }, signal);
					body = d.text;
					changed = d.changed;
					notes.push(...d.notes);
				} else {
					body = after.screen.join("\n");
				}
			}
			snapshots.set(snapKey(pane, after.alt), after);
			if (afterMeta.dead) notes.push("pane process exited");

			const head = header([
				`reason: ${reason}`,
				`pane ${pane} (${afterMeta.command})`,
				`${elapsed}s`,
				after.alt && "alternate screen",
				toOwnPane && "PI'S OWN PANE",
			]);
			const noteText = notes.map((n) => `(${n})`).join("\n");
			const text = [head, noteText, changed ? body : "(no new output)"].filter(Boolean).join("\n");
			return result(text, { pane, reason, elapsedSeconds: Number(elapsed), alt: after.alt, notes });
		},
	});

	pi.registerTool({
		name: "tmux_read",
		label: "tmux read",
		description:
			"Read a tmux pane without sending input. By default returns the visible screen (plus scrollback_lines of history if given). With new_only, returns only what changed since the last tmux_read or tmux_send on that pane.",
		parameters: Type.Object({
			pane: paneParam,
			new_only: Type.Optional(Type.Boolean({ description: "Only show what changed since the last read or send." })),
			scrollback_lines: scrollbackParam,
			pure_diff: pureDiffParam,
		}),
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const pane = await resolvePane(params.pane, signal);
			const { snap, meta } = await capture(pane, HISTORY_TAIL, signal);
			const key = snapKey(pane, snap.alt);
			const base = snapshots.get(key);
			const notes: string[] = [];
			let body: string;
			if (params.new_only && base) {
				const d = await diff(
					pane,
					base,
					snap,
					{ scrollback: params.scrollback_lines ?? DEFAULT_SCROLLBACK, pureDiff: !!params.pure_diff },
					signal,
				);
				notes.push(...d.notes);
				body = d.changed ? d.text : "(no new output)";
			} else {
				if (params.new_only) notes.push("no previous snapshot; showing the full screen");
				const n = Math.min(params.scrollback_lines ?? 0, meta.historySize);
				const hist = n > 0 ? await captureRange(pane, -n, -1, signal) : [];
				body = [...hist, ...snap.screen].join("\n");
			}
			snapshots.set(key, snap);
			if (pane === ownPane) notes.push("this is pi's own pane");
			if (meta.dead) notes.push("pane process exited");
			const head = header([`pane ${pane} (${meta.command})`, snap.alt && "alternate screen", meta.inMode && "copy mode"]);
			const text = [head, notes.map((n) => `(${n})`).join("\n"), body].filter(Boolean).join("\n");
			return result(text, { pane, alt: snap.alt, notes });
		},
	});

	pi.on("session_shutdown", async () => {
		snapshots.clear();
	});
}
