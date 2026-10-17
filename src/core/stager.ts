import { DiffLine, Hunk, LineRange, splitLines } from './diff';

/**
 * Builds index content with a subset of diff lines applied or reverted. All diffs here are -U0 diffs,
 * so every hunk is exactly one contiguous block of '-' lines followed by '+' lines.
 */

function blockLines(hunk: Hunk): { olds: DiffLine[]; news: DiffLine[] } {
	return {
		olds: hunk.lines.filter((l) => l.type === '-'),
		news: hunk.lines.filter((l) => l.type === '+')
	};
}

/** Appends a line, terminating the previous line first if it lacked a newline. */
function push(out: string[], line: string): void {
	const last = out.length - 1;
	if (last >= 0 && !out[last].endsWith('\n')) {
		out[last] += '\n';
	}
	out.push(line);
}

/**
 * Applies selected lines of an old->new diff to `base` (the old side).
 *
 * Unselected '-' lines stay, selected '-' lines are removed, selected '+' lines are inserted. Removed and
 * inserted lines are interleaved pairwise so that a partially staged replacement lands in place.
 */
export function applyForward(base: string, hunks: readonly Hunk[], selected: ReadonlySet<DiffLine>): string {
	const baseLines = splitLines(base);
	const out: string[] = [];
	let next = 0;

	for (const hunk of [...hunks].sort((a, b) => a.oldStart - b.oldStart)) {
		const regionStart = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
		while (next < regionStart) {
			push(out, baseLines[next++]);
		}

		const { olds, news } = blockLines(hunk);
		for (let i = 0; i < Math.max(olds.length, news.length); i++) {
			if (i < olds.length && !selected.has(olds[i])) {
				push(out, baseLines[next]);
			}
			if (i < olds.length) {
				next++;
			}
			if (i < news.length && selected.has(news[i])) {
				push(out, news[i].text);
			}
		}
	}

	while (next < baseLines.length) {
		push(out, baseLines[next++]);
	}
	return out.join('');
}

/**
 * Reverts selected lines of an old->new diff from `base` (the new side).
 *
 * Selected '+' lines are removed, unselected '+' lines stay, selected '-' lines are restored.
 */
export function applyReverse(base: string, hunks: readonly Hunk[], selected: ReadonlySet<DiffLine>): string {
	const baseLines = splitLines(base);
	const out: string[] = [];
	let next = 0;

	for (const hunk of [...hunks].sort((a, b) => a.newStart - b.newStart)) {
		const regionStart = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
		while (next < regionStart) {
			push(out, baseLines[next++]);
		}

		const { olds, news } = blockLines(hunk);
		for (let i = 0; i < Math.max(olds.length, news.length); i++) {
			if (i < olds.length && selected.has(olds[i])) {
				push(out, olds[i].text);
			}
			if (i < news.length && !selected.has(news[i])) {
				push(out, baseLines[next]);
			}
			if (i < news.length) {
				next++;
			}
		}
	}

	while (next < baseLines.length) {
		push(out, baseLines[next++]);
	}
	return out.join('');
}

/**
 * Computes the diff that remains after `selected` lines were applied, without running git.
 *
 * forward: the old side was rewritten by applyForward (old = new index, new = unchanged working tree).
 * reverse: the new side was rewritten by applyReverse (old = unchanged HEAD, new = new index).
 * Returns null when a hunk touches a line without a final newline; callers then ask git instead.
 */
export function remainingHunks(hunks: readonly Hunk[], selected: ReadonlySet<DiffLine>, direction: 'forward' | 'reverse'): Hunk[] | null {
	const result: Hunk[] = [];
	let delta = 0;

	for (const hunk of [...hunks].sort((a, b) => a.oldStart - b.oldStart)) {
		if (hunk.lines.some((l) => !l.text.endsWith('\n'))) {
			return null;
		}

		const { olds, news } = blockLines(hunk);
		let oldIdx = (hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1) + (direction === 'forward' ? delta : 0);
		let newIdx = (hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1) + (direction === 'reverse' ? delta : 0);
		let curOld: DiffLine[] = [];
		let curNew: DiffLine[] = [];

		const flush = () => {
			if (curOld.length === 0 && curNew.length === 0) {
				return;
			}
			const oldStart0 = oldIdx - curOld.length;
			const newStart0 = newIdx - curNew.length;
			result.push({
				oldStart: curOld.length ? oldStart0 + 1 : oldStart0,
				oldCount: curOld.length,
				newStart: curNew.length ? newStart0 + 1 : newStart0,
				newCount: curNew.length,
				lines: [
					...curOld.map((l, j): DiffLine => ({ type: '-', text: l.text, oldLine: oldStart0 + 1 + j, newLine: 0 })),
					...curNew.map((l, j): DiffLine => ({ type: '+', text: l.text, oldLine: 0, newLine: newStart0 + 1 + j }))
				]
			});
			curOld = [];
			curNew = [];
		};
		const common = () => {
			flush();
			oldIdx++;
			newIdx++;
		};

		for (let i = 0; i < Math.max(olds.length, news.length); i++) {
			const o = olds[i];
			const n = news[i];
			if (direction === 'forward') {
				// Unselected removals are still pending; selected additions are now shared by both sides.
				if (o && !selected.has(o)) {
					curOld.push(o);
					oldIdx++;
				}
				if (n && selected.has(n)) {
					common();
				} else if (n) {
					curNew.push(n);
					newIdx++;
				}
			} else {
				// Selected removals were restored, so both sides share them; unselected additions stay staged.
				if (o && selected.has(o)) {
					common();
				} else if (o) {
					curOld.push(o);
					oldIdx++;
				}
				if (n && !selected.has(n)) {
					curNew.push(n);
					newIdx++;
				}
			}
		}
		flush();

		const selOld = olds.filter((l) => selected.has(l)).length;
		const selNew = news.filter((l) => selected.has(l)).length;
		delta += direction === 'forward' ? selNew - selOld : selOld - selNew;
	}
	return result;
}

/** Returns all changed lines of the given hunks. */
export function selectHunks(hunks: readonly Hunk[]): Set<DiffLine> {
	const result = new Set<DiffLine>();
	for (const h of hunks) {
		for (const l of h.lines) {
			if (l.type !== ' ') {
				result.add(l);
			}
		}
	}
	return result;
}

/**
 * Selects diff lines from line ranges on one side of the diff.
 *
 * Lines on the chosen side are selected directly. Their positional partners on the other side follow
 * them, so selecting the new version of a replaced line also selects the old version it replaces.
 * A block that has no lines on the chosen side is selected when it sits inside or directly after a range.
 */
export function selectLines(hunks: readonly Hunk[], ranges: readonly LineRange[], side: 'old' | 'new'): Set<DiffLine> {
	const result = new Set<DiffLine>();
	const inRange = (n: number) => ranges.some((r) => n >= r.start && n <= r.end);

	for (const hunk of hunks) {
		const { olds, news } = blockLines(hunk);
		const [own, other] = side === 'new' ? [news, olds] : [olds, news];
		const lineOf = (l: DiffLine) => (side === 'new' ? l.newLine : l.oldLine);

		if (own.length === 0) {
			// Pure removal (or pure addition) seen from this side: it sits before line `position`.
			const position = (side === 'new' ? hunk.newStart : hunk.oldStart) + 1;
			if (ranges.some((r) => position >= r.start && position <= r.end + 1)) {
				other.forEach((l) => result.add(l));
			}
			continue;
		}

		own.forEach((l, i) => {
			if (!inRange(lineOf(l))) {
				return;
			}
			result.add(l);
			if (i < other.length) {
				result.add(other[i]);
			}
			// The last own line carries any surplus lines on the other side.
			if (i === own.length - 1) {
				other.slice(own.length).forEach((o) => result.add(o));
			}
		});
	}
	return result;
}

/**
 * Adds blank changed lines that directly neighbour a selected line on the same side of the same hunk.
 * Review sections end at the code they describe, so without this, staging a section leaves behind
 * the blank line added or removed next to it, such as the separator before a new function.
 */
export function withAdjacentBlankLines(hunks: readonly Hunk[], selected: ReadonlySet<DiffLine>): Set<DiffLine> {
	const result = new Set(selected);
	const isBlank = (l: DiffLine) => l.text.trim() === '';
	for (const hunk of hunks) {
		const { olds, news } = blockLines(hunk);
		for (const lines of [olds, news]) {
			// Spread outwards from selected lines, through runs of blank lines.
			for (let i = 1; i < lines.length; i++) {
				if (result.has(lines[i - 1]) && isBlank(lines[i])) {
					result.add(lines[i]);
				}
			}
			for (let i = lines.length - 2; i >= 0; i--) {
				if (result.has(lines[i + 1]) && isBlank(lines[i])) {
					result.add(lines[i]);
				}
			}
		}
	}
	return result;
}

/**
 * Lines that staging sections stages: the changes inside their working tree ranges with the old lines they
 * replace, the removals inside their HEAD ranges, and the blank lines around both. HEAD ranges add removed
 * lines only: `selectLines` on the old side also takes the added lines paired with them, and the last old
 * line of a block takes every surplus added line, which can be the code of the next section.
 */
export function selectSections(hunks: readonly Hunk[], newRanges: readonly LineRange[], oldRanges: readonly LineRange[]): Set<DiffLine> {
	const removed = [...selectLines(hunks, oldRanges, 'old')].filter((l) => l.type === '-');
	return withAdjacentBlankLines(hunks, new Set([...selectLines(hunks, newRanges, 'new'), ...removed]));
}

/** Finds hunks touching any of the ranges on the given side. Pure removals match the line after them. */
export function hunksInRanges(hunks: readonly Hunk[], ranges: readonly LineRange[], side: 'old' | 'new'): Hunk[] {
	return hunks.filter((h) => {
		const [start, count] = side === 'new' ? [h.newStart, h.newCount] : [h.oldStart, h.oldCount];
		const first = count === 0 ? start + 1 : start;
		const last = count === 0 ? start + 1 : start + count - 1;
		return ranges.some((r) => r.start <= last && r.end >= (count === 0 ? start : first));
	});
}
