import { FileDiff, Hunk, LineRange, mapLine, mapRange } from './diff';
import { Workspace } from './workspace';
import { Review, ReviewSection } from './review';
import { hunksInRanges } from './stager';

/** pending: has unstaged changes. staged: all its changes are staged. context: no changes at all. */
export type SectionStatus = 'pending' | 'staged' | 'context';

/** Index lines that correspond to a section: kept old lines plus already-staged new lines. */
export function indexRanges(repo: Workspace, section: ReviewSection, newRange: LineRange | undefined): LineRange[] {
	const result: LineRange[] = [];
	const staged = repo.staged.get(section.file)?.hunks ?? [];
	const unstaged = repo.unstaged.get(section.file)?.hunks ?? [];
	if (section.oldRange) {
		result.push(...mapRange(staged, section.oldRange, 'old'));
	}
	if (newRange) {
		result.push(...mapRange(unstaged, newRange, 'new'));
	}
	return result;
}

export function sectionStatus(repo: Workspace, section: ReviewSection, newRange: LineRange | undefined, changedFiles: ReadonlySet<string>): SectionStatus {
	const entry = repo.status.find((e) => e.path === section.file);
	if (entry?.kind === 'untracked') {
		return 'pending';
	}

	const unstaged = repo.unstaged.get(section.file);
	if (unstaged) {
		if (newRange && hunksInRanges(unstaged.hunks, [newRange], 'new').length > 0) {
			return 'pending';
		}
		if (section.oldRange) {
			const staged = repo.staged.get(section.file)?.hunks ?? [];
			const inIndex = mapRange(staged, section.oldRange, 'old');
			if (inIndex.length > 0 && hunksInRanges(unstaged.hunks, inIndex, 'old').length > 0) {
				return 'pending';
			}
		}
	}

	return changedFiles.has(section.file) ? 'staged' : 'context';
}

/**
 * Finds the HEAD lines that correspond to a working tree range, using a HEAD -> working tree diff.
 * Range ends that fall on added lines extend to the edge of their hunk. Returns undefined for pure additions.
 */
export function deriveOldRange(hunks: readonly Hunk[], newRange: LineRange): LineRange | undefined {
	const hunkAt = (line: number) => hunks.find((h) => h.newCount > 0 && line >= h.newStart && line < h.newStart + h.newCount);
	const edge = (line: number, end: boolean): number => {
		const mapped = mapLine(hunks, line, 'new');
		if (mapped > 0) {
			return mapped;
		}
		const h = hunkAt(line);
		if (!h) {
			return line;
		}
		if (h.oldCount > 0) {
			return end ? h.oldStart + h.oldCount - 1 : h.oldStart;
		}
		// Pure insertion: the old range starts after it and ends before it.
		return end ? h.oldStart : h.oldStart + 1;
	};

	const start = edge(newRange.start, false);
	const end = edge(newRange.end, true);
	return end >= start ? { start, end } : undefined;
}

/**
 * Changed lines inside a section, from a HEAD -> working tree diff: added lines within its new range, plus
 * removed lines within its old range or in hunks that touch its new range.
 */
export function changedLines(diff: FileDiff | undefined, newRange: LineRange | undefined, oldRange: LineRange | undefined): { added: number; removed: number } {
	if (!diff) {
		return { added: 0, removed: 0 };
	}
	if (diff.oldPath === null && diff.hunks.length === 0) {
		// Untracked file: every line of the range is new.
		return { added: newRange ? newRange.end - newRange.start + 1 : 0, removed: 0 };
	}
	const inRange = (n: number, r: LineRange | undefined) => !!r && n >= r.start && n <= r.end;
	let added = 0;
	let removed = 0;
	for (const h of diff.hunks) {
		const touchesNew = !!newRange && hunksInRanges([h], [newRange], 'new').length > 0;
		for (const l of h.lines) {
			if (l.type === '+' && inRange(l.newLine, newRange)) {
				added++;
			} else if (l.type === '-' && (touchesNew || inRange(l.oldLine, oldRange))) {
				removed++;
			}
		}
	}
	return { added, removed };
}

export interface UncoveredChange {
	file: string;
	/** Working tree line where the change sits. */
	line: number;
	added: number;
	removed: number;
	/** Working tree lines of the change; missing for pure removals. Covers the whole file for untracked and binary files. */
	newRange?: LineRange;
	/** HEAD lines the change removes or replaces. */
	oldRange?: LineRange;
}

function hunkCovered(h: Hunk, sections: ReviewSection[], newRangeOf: (s: ReviewSection) => LineRange | undefined): boolean {
	return sections.some((s) => {
		const nr = newRangeOf(s);
		if (nr && hunksInRanges([h], [nr], 'new').length > 0) {
			return true;
		}
		return !!s.oldRange && h.oldCount > 0 && hunksInRanges([h], [s.oldRange], 'old').length > 0;
	});
}

/** Lists changes (HEAD -> working tree) that no review section covers. */
export function findUncovered(review: Review, fullDiffs: ReadonlyMap<string, FileDiff>, newRangeOf: (s: ReviewSection) => LineRange | undefined): UncoveredChange[] {
	const byFile = new Map<string, ReviewSection[]>();
	for (const c of review.categories) {
		for (const s of c.sections) {
			byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
		}
	}

	const result: UncoveredChange[] = [];
	for (const [file, diff] of fullDiffs) {
		const sections = byFile.get(file) ?? [];
		if (diff.hunks.length === 0) {
			// Untracked or binary: covered when any section mentions the file.
			if (sections.length === 0) {
				result.push({ file, line: 1, added: 0, removed: 0, newRange: { start: 1, end: Number.MAX_SAFE_INTEGER } });
			}
			continue;
		}

		for (const h of diff.hunks) {
			if (!hunkCovered(h, sections, newRangeOf)) {
				result.push({
					file,
					line: Math.max(1, h.newCount === 0 ? h.newStart + 1 : h.newStart),
					added: h.newCount,
					removed: h.oldCount,
					newRange: h.newCount > 0 ? { start: h.newStart, end: h.newStart + h.newCount - 1 } : undefined,
					oldRange: h.oldCount > 0 ? { start: h.oldStart, end: h.oldStart + h.oldCount - 1 } : undefined
				});
			}
		}
	}
	return result;
}
