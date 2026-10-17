import { DiffLine, FileDiff, Hunk, LineRange, mapLine, mapRange } from './diff';
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
 * Changed lines inside a section, from a HEAD -> working tree diff with zero context. A section owns each
 * added line in its new range together with the removed lines it replaces, as staging pairs them, plus
 * removals inside its old range or at its new range. `changed` counts an edited line once: a replaced
 * line is one change, not one removal and one addition.
 */
export function changedLines(diff: FileDiff | undefined, newRange: LineRange | undefined, oldRange: LineRange | undefined): { added: number; removed: number; changed: number } {
	if (!diff) {
		return { added: 0, removed: 0, changed: 0 };
	}
	if (diff.oldPath === null && diff.hunks.length === 0) {
		// Untracked file: every line of the range is new.
		const added = newRange ? newRange.end - newRange.start + 1 : 0;
		return { added, removed: 0, changed: added };
	}
	const inRange = (n: number, r: LineRange | undefined) => !!r && n >= r.start && n <= r.end;
	let added = 0;
	let removed = 0;
	let changed = 0;
	for (const h of diff.hunks) {
		for (const unit of changeUnits(h)) {
			const owned = unit.added
				? inRange(unit.added.newLine, newRange)
				: !!newRange && hunksInRanges([h], [newRange], 'new').length > 0;
			if (owned || unit.removed.some((l) => inRange(l.oldLine, oldRange))) {
				added += unit.added ? 1 : 0;
				removed += unit.removed.length;
				changed += Math.max(unit.added ? 1 : 0, unit.removed.length);
			}
		}
	}
	return { added, removed, changed };
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

/** Changes at most this many lines away from a section belong to it: usually lines its range just misses. */
const NEAR_LINES = 2;

export interface Coverage {
	/** Changes that no section covers or takes in. */
	uncovered: UncoveredChange[];
	/**
	 * Small changes taken in by the nearest section of their file, by section id: whitespace-only changes,
	 * and changes next to the section. Staging the section stages them too.
	 */
	attached: Map<string, UncoveredChange[]>;
}

/** A new line of a zero-context hunk with the old lines `selectLines` pairs with it, or a pure removal. */
interface ChangeUnit {
	added?: DiffLine;
	removed: DiffLine[];
}

function changeUnits(h: Hunk): ChangeUnit[] {
	const olds = h.lines.filter((l) => l.type === '-');
	const news = h.lines.filter((l) => l.type === '+');
	if (news.length === 0) {
		return [{ removed: olds }];
	}
	// The last new line carries any surplus old lines.
	return news.map((added, i) => ({ added, removed: i === news.length - 1 ? olds.slice(i) : olds.slice(i, i + 1) }));
}

function unitCovered(h: Hunk, unit: ChangeUnit, sections: ReviewSection[], newRangeOf: (s: ReviewSection) => LineRange | undefined): boolean {
	return sections.some((s) => {
		const nr = newRangeOf(s);
		if (nr && (unit.added ? unit.added.newLine >= nr.start && unit.added.newLine <= nr.end : hunksInRanges([h], [nr], 'new').length > 0)) {
			return true;
		}
		return !!s.oldRange && unit.removed.some((l) => l.oldLine >= s.oldRange!.start && l.oldLine <= s.oldRange!.end);
	});
}

function toChange(file: string, h: Hunk, units: ChangeUnit[]): UncoveredChange {
	const added = units.flatMap((u) => (u.added ? [u.added] : []));
	const removed = units.flatMap((u) => u.removed);
	return {
		file,
		line: added.length > 0 ? added[0].newLine : Math.max(1, h.newStart + 1),
		added: added.length,
		removed: removed.length,
		newRange: added.length > 0 ? { start: added[0].newLine, end: added[added.length - 1].newLine } : undefined,
		oldRange: removed.length > 0 ? { start: removed[0].oldLine, end: removed[removed.length - 1].oldLine } : undefined
	};
}

/** True when the change only adds, removes or edits whitespace, such as blank lines or indentation. */
function whitespaceOnly(units: ChangeUnit[]): boolean {
	const text = (lines: DiffLine[]) => lines.map((l) => l.text).join('').replace(/\s+/g, '');
	return text(units.flatMap((u) => (u.added ? [u.added] : []))) === text(units.flatMap((u) => u.removed));
}

/** Lines between a change and a section range, on the working tree side. 0 when they touch. */
function gap(change: UncoveredChange, r: LineRange): number {
	// A pure removal sits between the lines before and after it.
	const [start, end] = change.newRange ? [change.newRange.start, change.newRange.end] : [change.line - 0.5, change.line - 0.5];
	return Math.max(0, Math.ceil(Math.max(r.start - end - 1, start - r.end - 1)));
}

/**
 * Finds the changes (HEAD -> working tree) that no review section covers, line by line, so the part of a
 * hunk that a section range cuts off counts too. Whitespace-only changes, and changes within NEAR_LINES of
 * a section, go to the nearest section of their file instead.
 */
export function findCoverage(review: Review, fullDiffs: ReadonlyMap<string, FileDiff>, newRangeOf: (s: ReviewSection) => LineRange | undefined): Coverage {
	const byFile = new Map<string, ReviewSection[]>();
	for (const c of review.categories) {
		for (const s of c.sections) {
			byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
		}
	}

	const result: Coverage = { uncovered: [], attached: new Map() };
	for (const [file, diff] of fullDiffs) {
		const sections = byFile.get(file) ?? [];
		if (diff.hunks.length === 0) {
			// Untracked or binary: covered when any section mentions the file.
			if (sections.length === 0) {
				result.uncovered.push({ file, line: 1, added: 0, removed: 0, newRange: { start: 1, end: Number.MAX_SAFE_INTEGER } });
			}
			continue;
		}

		for (const h of diff.hunks) {
			// Runs of uncovered units become one change each.
			const runs: ChangeUnit[][] = [];
			let run: ChangeUnit[] = [];
			for (const unit of changeUnits(h)) {
				if (unitCovered(h, unit, sections, newRangeOf)) {
					run = [];
				} else {
					if (run.length === 0) {
						runs.push(run);
					}
					run.push(unit);
				}
			}

			for (const units of runs) {
				const change = toChange(file, h, units);
				let nearest: { section: ReviewSection; gap: number } | undefined;
				for (const s of sections) {
					const nr = newRangeOf(s);
					const g = nr ? gap(change, nr) : Infinity;
					if (g < (nearest?.gap ?? Infinity)) {
						nearest = { section: s, gap: g };
					}
				}
				if (nearest && (nearest.gap <= NEAR_LINES || whitespaceOnly(units))) {
					result.attached.set(nearest.section.id, [...(result.attached.get(nearest.section.id) ?? []), change]);
				} else {
					result.uncovered.push(change);
				}
			}
		}
	}
	return result;
}

/** True for lines without code: blank lines and comment lines. */
function isCommentOrBlank(text: string): boolean {
	return /^\s*($|\/\/|\/\*|\*|#|--)/.test(text);
}

/**
 * Moves section edges that fall inside a block of added lines over the lines next to them that no other
 * section covers. The agent sometimes miscounts lines in a long diff, and a section that starts inside, for
 * example, the documentation comment of the method it covers shows its summary in the middle of the block.
 * - An end moves over at most NEAR_LINES lines, such as a closing brace, up to the next section or a comment:
 *   a comment after the end usually belongs to the next declaration.
 * - A start moves up over the comment and blank lines above it, or over at most NEAR_LINES lines of any kind.
 * Ends move first, so a closing brace stays with its method. Returns one message per moved edge.
 */
export function snapSections(review: Review, diffs: ReadonlyMap<string, FileDiff>): string[] {
	const sections = review.categories.flatMap((c) => c.sections);
	const messages: string[] = [];
	const covered = (s: ReviewSection, line: number) =>
		sections.some((o) => o !== s && o.file === s.file && !!o.newRange && line >= o.newRange.start && line <= o.newRange.end);
	/** Added lines of the block of added lines that holds `line`. */
	const blockAt = (s: ReviewSection, line: number): DiffLine[] => {
		const h = diffs.get(s.file)?.hunks.find((b) => b.newCount > 0 && line >= b.newStart && line < b.newStart + b.newCount);
		return h ? h.lines.filter((l) => l.type === '+') : [];
	};
	const isComment = (l: DiffLine) => /^\s*(\/\/|\/\*|\*|#|--)/.test(l.text);

	for (const s of sections) {
		const r = s.newRange;
		const block = r ? blockAt(s, r.end) : [];
		const free: DiffLine[] = [];
		for (const l of block.filter((x) => x.newLine > r!.end)) {
			if (covered(s, l.newLine) || isComment(l)) {
				break;
			}
			free.push(l);
		}
		if (r && free.length > 0 && free.length <= NEAR_LINES) {
			messages.push(`${s.file}: section "${s.title}" ends at line ${free[free.length - 1].newLine} instead of ${r.end}, with the rest of its block of added lines.`);
			r.end = free[free.length - 1].newLine;
		}
	}

	for (const s of sections) {
		const r = s.newRange;
		const block = r ? blockAt(s, r.start) : [];
		const free: DiffLine[] = [];
		for (const l of block.filter((x) => x.newLine < r!.start).reverse()) {
			if (covered(s, l.newLine)) {
				break;
			}
			free.unshift(l);
		}
		// The comment and blank lines right above the start; with more than NEAR_LINES free lines, only those.
		const firstCode = free.map((l) => isCommentOrBlank(l.text)).lastIndexOf(false);
		const take = free.length <= NEAR_LINES ? free : free.slice(firstCode + 1);
		if (r && take.length > 0) {
			messages.push(`${s.file}: section "${s.title}" starts at line ${take[0].newLine} instead of ${r.start}, with the lines above it in its block of added lines.`);
			r.start = take[0].newLine;
		}
	}
	return messages;
}
