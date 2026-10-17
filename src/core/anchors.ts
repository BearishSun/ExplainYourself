import { LineRange } from './diff';

/**
 * Line correspondence between two versions of a file: the version a review was written against and the
 * current one. Built from a line diff, so positions follow line contents, not only line numbers.
 */
export class LineMap {
	/** 1-based: new line of each old line, 0 when the old line was removed or changed. */
	private readonly toNew: Int32Array;

	private constructor(toNew: Int32Array, readonly newCount: number) {
		this.toNew = toNew;
	}

	/** Diffs `before` against `after`. Returns null when the versions differ too much to map reliably. */
	static build(before: string, after: string, maxEdits = 2000): LineMap | null {
		const a = lines(before);
		const b = lines(after);
		const pairs = matchLines(a, b, maxEdits);
		if (!pairs) {
			return null;
		}
		const toNew = new Int32Array(a.length + 2);
		for (const [i, j] of pairs) {
			toNew[i + 1] = j + 1;
		}
		toNew[a.length + 1] = b.length + 1;
		return new LineMap(toNew, b.length);
	}

	/** The new position of an old line. A changed or removed line maps to the start of what replaced it. */
	line(old: number): number {
		const n = this.toNew[this.clampOld(old)];
		return this.clampNew(n || this.previousMatch(old) + 1);
	}

	/**
	 * The new position of an old range. A boundary line that changed moves to the edge of its replacement,
	 * so the range keeps covering the rewritten code. A range whose lines were all removed shrinks to one line.
	 */
	range(old: LineRange): LineRange {
		const start = this.toNew[this.clampOld(old.start)] || this.previousMatch(old.start) + 1;
		const end = this.toNew[this.clampOld(old.end)] || this.nextMatch(old.end) - 1;
		return end >= start ? { start: this.clampNew(start), end: this.clampNew(end) } : { start: this.clampNew(start), end: this.clampNew(start) };
	}

	/**
	 * The edits between the two versions, in order: each replaces old lines with new lines. Either side can be
	 * empty; an empty side holds no lines and sits between its `end` and its `start`, which is `end` + 1.
	 */
	blocks(): { old: LineRange; new: LineRange }[] {
		const result: { old: LineRange; new: LineRange }[] = [];
		let oldPrev = 0;
		let newPrev = 0;
		for (let i = 1; i < this.toNew.length; i++) {
			const j = this.toNew[i];
			if (!j) {
				continue;
			}
			if (i > oldPrev + 1 || j > newPrev + 1) {
				result.push({ old: { start: oldPrev + 1, end: i - 1 }, new: { start: newPrev + 1, end: j - 1 } });
			}
			oldPrev = i;
			newPrev = j;
		}
		return result;
	}

	/** New line of the closest unchanged old line above `old`, or 0. */
	private previousMatch(old: number): number {
		for (let i = Math.min(this.clampOld(old), this.toNew.length - 2) - 1; i >= 1; i--) {
			if (this.toNew[i]) {
				return this.toNew[i];
			}
		}
		return 0;
	}

	/** New line of the closest unchanged old line below `old`, or the line after the end. */
	private nextMatch(old: number): number {
		for (let i = this.clampOld(old) + 1; i < this.toNew.length; i++) {
			if (this.toNew[i]) {
				return this.toNew[i];
			}
		}
		return this.newCount + 1;
	}

	private clampOld(line: number): number {
		return Math.max(1, Math.min(line, this.toNew.length - 2));
	}

	private clampNew(line: number): number {
		return Math.max(1, Math.min(line, Math.max(1, this.newCount)));
	}
}

/** Lines without terminators. Line endings and trailing whitespace do not count as changes. */
/** Lines of a text, without line endings or trailing whitespace. */
export function lines(content: string): string[] {
	const result = content.split('\n').map((l) => l.trimEnd());
	if (result.length > 0 && result[result.length - 1] === '' && content.endsWith('\n')) {
		result.pop();
	}
	return result;
}

/**
 * Pairs of equal lines (0-based indexes into a and b) from a shortest edit script (Myers). Returns null when
 * the script needs more than `maxEdits` insertions and deletions.
 */
export function matchLines(a: readonly string[], b: readonly string[], maxEdits: number): [number, number][] | null {
	// Compare numbers instead of strings.
	const ids = new Map<string, number>();
	const id = (s: string) => {
		let v = ids.get(s);
		if (v === undefined) {
			v = ids.size;
			ids.set(s, v);
		}
		return v;
	};
	const x = Int32Array.from(a, id);
	const y = Int32Array.from(b, id);

	// Common prefix and suffix need no search.
	let prefix = 0;
	while (prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (suffix < x.length - prefix && suffix < y.length - prefix && x[x.length - 1 - suffix] === y[y.length - 1 - suffix]) {
		suffix++;
	}
	const n = x.length - prefix - suffix;
	const m = y.length - prefix - suffix;
	const pairs: [number, number][] = [];
	for (let i = 0; i < prefix; i++) {
		pairs.push([i, i]);
	}

	const middle = myers(x.subarray(prefix, prefix + n), y.subarray(prefix, prefix + m), maxEdits);
	if (!middle) {
		return null;
	}
	for (const [i, j] of middle) {
		pairs.push([prefix + i, prefix + j]);
	}
	for (let i = 0; i < suffix; i++) {
		pairs.push([x.length - suffix + i, y.length - suffix + i]);
	}
	return pairs;
}

function myers(a: Int32Array, b: Int32Array, maxEdits: number): [number, number][] | null {
	const n = a.length;
	const m = b.length;
	if (n === 0 || m === 0) {
		return n + m <= maxEdits ? [] : null;
	}
	const max = Math.min(n + m, maxEdits);
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	// trace[d] holds v[-d..d] as it was before step d.
	const trace: Int32Array[] = [];
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice(offset - d, offset + d + 1));
		for (let k = -d; k <= d; k += 2) {
			let i = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
			let j = i - k;
			while (i < n && j < m && a[i] === b[j]) {
				i++;
				j++;
			}
			v[offset + k] = i;
			if (i >= n && j >= m) {
				return backtrack(trace, n, m);
			}
		}
	}
	return null;
}

function backtrack(trace: Int32Array[], n: number, m: number): [number, number][] {
	const pairs: [number, number][] = [];
	let i = n;
	let j = m;
	for (let d = trace.length - 1; d >= 0; d--) {
		const v = trace[d];
		const at = (k: number) => v[k + d];
		const k = i - j;
		const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
		// Step 0 starts at the origin.
		const prevI = d === 0 ? 0 : at(prevK);
		const prevJ = d === 0 ? 0 : prevI - prevK;
		while (i > prevI && j > prevJ) {
			i--;
			j--;
			pairs.push([i, j]);
		}
		i = prevI;
		j = prevJ;
	}
	return pairs.reverse();
}
