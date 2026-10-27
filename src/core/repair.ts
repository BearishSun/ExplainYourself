import { ChangeSet, decode } from './changes';
import { findCoverage, UncoveredChange } from './coverage';
import { LineRange } from './diff';
import { Review } from './review';

/** Most diff lines shown per uncovered change; the agent reads the rest from the file. */
const MAX_GAP_LINES = 60;

/**
 * Changes of the change set that no section of a new review covers. Whitespace-only changes and small
 * changes next to a section count as covered, as they are staged with it. Binary files are left out.
 */
export function coverageGaps(review: Review, changes: ChangeSet): UncoveredChange[] {
	return findCoverage(review, changes.diffs, (s) => s.newRange).uncovered.filter((u) => !changes.diffs.get(u.file)?.binary);
}

function rangeText(r: LineRange): string {
	return r.start === r.end ? `line ${r.start}` : `lines ${r.start}-${r.end}`;
}

/**
 * Describes the coverage gaps for the agent: the categories of the review by id, and per file the changed
 * lines no section covers, with the file's sections so the agent can extend one of them.
 */
export function renderCoverage(review: Review, gaps: UncoveredChange[], changes: ChangeSet): string {
	const out: string[] = ['Categories of the review:'];
	review.categories.forEach((c) => out.push(`- ${c.id}: "${c.title}"`));
	out.push('');

	for (const file of [...new Set(gaps.map((g) => g.file))]) {
		out.push(`=== FILE: ${file}`);
		const sections = review.categories
			.flatMap((c) => c.sections.filter((s) => s.file === file).map((s) => ({ c, s })))
			.sort((a, b) => (a.s.newRange?.start ?? 0) - (b.s.newRange?.start ?? 0));
		if (sections.length > 0) {
			out.push('Its sections:');
			sections.forEach(({ c, s }) =>
				out.push(`- ${s.id} in category ${c.id}: "${s.title}", ${s.newRange ? rangeText(s.newRange) : `old ${rangeText(s.oldRange!)}`}`)
			);
		} else {
			out.push('No section covers this file yet.');
		}

		const hunks = changes.diffs.get(file)?.hunks ?? [];
		// Untracked files are read as UTF-8 already; git diffs as latin1.
		const text = changes.files.find((f) => f.path === file)?.status === 'untracked' ? (t: string) => t : decode;
		for (const gap of gaps.filter((g) => g.file === file)) {
			const where = [gap.newRange ? rangeText(gap.newRange) : '', gap.oldRange ? `old ${rangeText(gap.oldRange)}` : ''].filter(Boolean).join(', ');
			out.push('', `Not covered: ${where} (+${gap.added} -${gap.removed}). Old line, new line, marker, text:`);
			const inRange = (n: number, r?: LineRange) => !!r && n >= r.start && n <= r.end;
			const lines = hunks.flatMap((h) => h.lines).filter((l) => (l.type === '+' ? inRange(l.newLine, gap.newRange) : inRange(l.oldLine, gap.oldRange)));
			for (const l of lines.slice(0, MAX_GAP_LINES)) {
				const oldNo = l.oldLine ? String(l.oldLine).padStart(6) : '      ';
				const newNo = l.newLine ? String(l.newLine).padStart(6) : '      ';
				out.push(`${oldNo} ${newNo} ${l.type}| ${text(l.text.replace(/\r?\n$/, ''))}`);
			}
			if (lines.length > MAX_GAP_LINES) {
				out.push(`(${lines.length - MAX_GAP_LINES} more lines; read the file for the rest)`);
			}
		}
		out.push('');
	}
	return out.join('\n');
}
