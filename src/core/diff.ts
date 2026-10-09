/**
 * Parser for `git diff` unified output.
 *
 * Diff text is handled as latin1 strings so that every byte round-trips unchanged when staged content
 * is rebuilt. Paths are converted back to UTF-8.
 */

export type LineType = ' ' | '-' | '+';

export interface DiffLine {
	type: LineType;
	/** Line content without the diff marker. Includes the trailing "\n" unless the file ends without one. */
	text: string;
	/** 1-based line number on the old side. 0 for '+' lines. */
	oldLine: number;
	/** 1-based line number on the new side. 0 for '-' lines. */
	newLine: number;
}

export interface Hunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: DiffLine[];
}

export interface FileDiff {
	/** Old path, or null when the file was added. */
	oldPath: string | null;
	/** New path, or null when the file was deleted. */
	newPath: string | null;
	/** Path that identifies the file: new path, or old path for deletions. */
	path: string;
	oldMode?: string;
	newMode?: string;
	oldSha?: string;
	newSha?: string;
	binary: boolean;
	hunks: Hunk[];
}

function latin1ToUtf8(s: string): string {
	return Buffer.from(s, 'latin1').toString('utf8');
}

/** Removes C-style quoting that git applies to unusual paths. */
function unquotePath(raw: string): string {
	if (!raw.startsWith('"')) {
		return raw;
	}

	const bytes: number[] = [];
	for (let i = 1; i < raw.length - 1; i++) {
		const c = raw[i];
		if (c !== '\\') {
			bytes.push(raw.charCodeAt(i) & 0xff);
			continue;
		}

		const n = raw[++i];
		const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
		if (n in simple) {
			bytes.push(simple[n]);
		} else if (/[0-7]/.test(n)) {
			bytes.push(parseInt(raw.substr(i, 3), 8));
			i += 2;
		}
	}
	return Buffer.from(bytes).toString('latin1');
}

function stripPrefix(path: string): string {
	return path.replace(/^[ab]\//, '');
}

function parsePathLine(line: string, prefixLength: number): string | null {
	let value = line.substring(prefixLength);
	// git appends a tab when the path contains spaces.
	if (value.endsWith('\t')) {
		value = value.slice(0, -1);
	}

	value = unquotePath(value);
	if (value === '/dev/null') {
		return null;
	}

	return latin1ToUtf8(stripPrefix(value));
}

/** Extracts the path from "diff --git a/X b/X" when no other header names it. */
function pathFromGitHeader(header: string): string {
	const rest = header.substring('diff --git '.length);
	if (rest.startsWith('"')) {
		const end = rest.indexOf('"', 1);
		return latin1ToUtf8(stripPrefix(unquotePath(rest.substring(0, end + 1))));
	}

	// Both halves are the same length when the path did not change.
	const half = (rest.length - 1) / 2;
	return latin1ToUtf8(stripPrefix(rest.substring(0, Math.floor(half))));
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses multi-file unified diff output (decoded as latin1). */
export function parseDiff(output: string): FileDiff[] {
	const files: FileDiff[] = [];
	const lines = output.split('\n');
	if (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}

	let file: FileDiff | null = null;
	let header = '';
	let hunk: Hunk | null = null;
	let oldLine = 0;
	let newLine = 0;

	const finishFile = () => {
		if (!file) {
			return;
		}

		file.path = file.newPath ?? file.oldPath ?? pathFromGitHeader(header);
		files.push(file);
		file = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith('diff --git ')) {
			finishFile();
			header = line;
			const p = pathFromGitHeader(line);
			file = { oldPath: p, newPath: p, path: p, binary: false, hunks: [] };
			hunk = null;
			continue;
		}

		if (!file) {
			continue;
		}

		if (hunk) {
			const marker = line[0];
			if (marker === ' ' || marker === '-' || marker === '+') {
				const text = line.substring(1) + '\n';
				const entry: DiffLine = { type: marker, text, oldLine: 0, newLine: 0 };
				if (marker !== '+') {
					entry.oldLine = oldLine++;
				}
				if (marker !== '-') {
					entry.newLine = newLine++;
				}
				hunk.lines.push(entry);
				continue;
			}

			if (marker === '\\') {
				// "\ No newline at end of file" applies to the preceding line.
				const prev = hunk.lines[hunk.lines.length - 1];
				if (prev && prev.text.endsWith('\n')) {
					prev.text = prev.text.slice(0, -1);
				}
				continue;
			}

			if (!line.startsWith('@@')) {
				hunk = null;
			}
		}

		const m = HUNK_HEADER.exec(line);
		if (m) {
			hunk = {
				oldStart: parseInt(m[1], 10),
				oldCount: m[2] === undefined ? 1 : parseInt(m[2], 10),
				newStart: parseInt(m[3], 10),
				newCount: m[4] === undefined ? 1 : parseInt(m[4], 10),
				lines: []
			};
			oldLine = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
			newLine = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
			file.hunks.push(hunk);
			continue;
		}

		if (line.startsWith('--- ')) {
			file.oldPath = parsePathLine(line, 4);
		} else if (line.startsWith('+++ ')) {
			file.newPath = parsePathLine(line, 4);
		} else if (line.startsWith('rename from ')) {
			file.oldPath = latin1ToUtf8(unquotePath(line.substring(12)));
		} else if (line.startsWith('rename to ')) {
			file.newPath = latin1ToUtf8(unquotePath(line.substring(10)));
		} else if (line.startsWith('new file mode ')) {
			file.oldPath = null;
			file.newMode = line.substring(14);
		} else if (line.startsWith('deleted file mode ')) {
			file.newPath = null;
			file.oldMode = line.substring(18);
		} else if (line.startsWith('old mode ')) {
			file.oldMode = line.substring(9);
		} else if (line.startsWith('new mode ')) {
			file.newMode = line.substring(9);
		} else if (line.startsWith('index ')) {
			const im = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?/.exec(line);
			if (im) {
				file.oldSha = im[1];
				file.newSha = im[2];
				if (im[3]) {
					file.oldMode ??= im[3];
					file.newMode ??= im[3];
				}
			}
		} else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
			file.binary = true;
		}
	}

	finishFile();
	return files;
}

/** Returns true when the sha consists of zeros (git's marker for "no object"). */
export function isNullSha(sha: string | undefined): boolean {
	return !sha || /^0+$/.test(sha);
}

/** Splits content into lines that keep their "\n" terminator. The last line may lack one. */
export function splitLines(content: string): string[] {
	const result: string[] = [];
	let start = 0;
	for (;;) {
		const nl = content.indexOf('\n', start);
		if (nl < 0) {
			if (start < content.length) {
				result.push(content.substring(start));
			}
			return result;
		}
		result.push(content.substring(start, nl + 1));
		start = nl + 1;
	}
}

/**
 * Maps a 1-based line from one side of a diff to the other side. Returns 0 when the line was removed
 * or added by the diff and so has no counterpart.
 */
export function mapLine(hunks: readonly Hunk[], line: number, from: 'old' | 'new'): number {
	let delta = 0;
	for (const h of hunks) {
		const [start, count, otherCount] = from === 'old' ? [h.oldStart, h.oldCount, h.newCount] : [h.newStart, h.newCount, h.oldCount];
		// Zero-count hunks sit after line `start`; non-empty hunks cover [start, start + count).
		const first = count === 0 ? start + 1 : start;
		if (line < first) {
			break;
		}
		if (count > 0 && line < start + count) {
			// Context lines inside a hunk still have a counterpart.
			const hit = h.lines.find((l) => l.type === ' ' && (from === 'old' ? l.oldLine : l.newLine) === line);
			return hit ? (from === 'old' ? hit.newLine : hit.oldLine) : 0;
		}
		delta += otherCount - count;
	}
	return line + delta;
}

export interface LineRange {
	/** 1-based first line. */
	start: number;
	/** 1-based last line, inclusive. */
	end: number;
}

/** Maps a range across a diff, dropping lines without a counterpart. Returns the surviving runs. */
export function mapRange(hunks: readonly Hunk[], range: LineRange, from: 'old' | 'new'): LineRange[] {
	const result: LineRange[] = [];
	for (let line = range.start; line <= range.end; line++) {
		const mapped = mapLine(hunks, line, from);
		if (mapped === 0) {
			continue;
		}
		const last = result[result.length - 1];
		if (last && last.end === mapped - 1) {
			last.end = mapped;
		} else {
			result.push({ start: mapped, end: mapped });
		}
	}
	return result;
}
