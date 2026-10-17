import { promises as fs } from 'fs';
import { LineMap, lines } from './anchors';
import { ChangeSet, renderHunks } from './changes';
import { LineRange } from './diff';
import { UpdatedFile } from './prompt';
import { DELETED, loadSnapshot, Review, ReviewSection } from './review';
import { hunksInRanges } from './stager';
import { Workspace } from './workspace';

/** One edit since the review: reviewed-version lines and the current lines that replace them. */
export interface Edit {
	/** Lines of the reviewed version. Empty (end = start - 1) for code added since the review. */
	old: LineRange;
	/** Current working tree lines. Empty (end = start - 1) for code removed since the review. */
	new: LineRange;
	removed: string[];
	added: string[];
}

/** What changed in one file since the review. */
export interface FileDelta {
	file: string;
	reason: UpdatedFile['reason'];
	/** Set when the file is reviewed again in full, because the edits since the review are unknown. Says why. */
	whole?: string;
	edits: Edit[];
}

export interface UpdatePlan {
	/** The previous review with section positions moved to the current files, without the sections of files that left the change set. */
	base: Review;
	deltas: FileDelta[];
	/** Sections the agent has to look at: touched by edits, or in a file reviewed again in full. */
	affected: Set<string>;
	/** Edited code that no section covers and that differs from HEAD. */
	uncovered: { file: string; range: LineRange }[];
	/** Sections removed with their files. */
	removed: ReviewSection[];
	/** Files reviewed again in full. */
	wholeFiles: Set<string>;
}

const isEmpty = (r: LineRange) => r.end < r.start;

/** True when an edit's current lines overlap a range; a removal counts when it sits inside or at an edge of it. */
function touches(edit: LineRange, r: LineRange): boolean {
	return isEmpty(edit) ? edit.start >= r.start && edit.end <= r.end : edit.start <= r.end && edit.end >= r.start;
}

async function readText(file: string): Promise<string | null> {
	try {
		return await fs.readFile(file, 'utf8');
	} catch {
		return null;
	}
}

/**
 * Works out what an update has to re-review. For each changed file, diffs the reviewed copy of the file
 * against its current text: sections those edits touch are affected, the others only move. Files without a
 * reviewed copy, or whose HEAD version moved, are reviewed again in full.
 */
export async function planUpdate(repo: Workspace, previous: Review, files: UpdatedFile[], changes: ChangeSet): Promise<UpdatePlan> {
	const base: Review = JSON.parse(JSON.stringify(previous)) as Review;
	const plan: UpdatePlan = { base, deltas: [], affected: new Set(), uncovered: [], removed: [], wholeFiles: new Set() };
	const sectionsOf = (file: string) => base.categories.flatMap((c) => c.sections.filter((s) => s.file === file));

	for (const f of files) {
		if (f.reason === 'removed') {
			for (const c of base.categories) {
				plan.removed.push(...c.sections.filter((s) => s.file === f.path));
				c.sections = c.sections.filter((s) => s.file !== f.path);
			}
			plan.deltas.push({ file: f.path, reason: f.reason, edits: [] });
			continue;
		}

		const fp = previous.fingerprints[f.path];
		const snapshot = f.reason === 'modified' && !f.headMoved && fp && fp !== DELETED ? await loadSnapshot(repo.gitDir, fp) : null;
		const current = await readText(repo.absPath(f.path));
		const map = snapshot !== null && current !== null ? LineMap.build(snapshot, current) : null;
		if (!map || snapshot === null || current === null) {
			const whole =
				f.reason === 'added'
					? 'it is new in the change set'
					: f.headMoved
						? 'its HEAD version changed through a commit'
						: current === null
							? 'it was deleted'
							: snapshot === null
								? 'no copy of the reviewed version exists'
								: 'it changed too much to compare';
			plan.deltas.push({ file: f.path, reason: f.reason, whole, edits: [] });
			plan.wholeFiles.add(f.path);
			sectionsOf(f.path).forEach((s) => plan.affected.add(s.id));
			continue;
		}

		const before = lines(snapshot);
		const after = lines(current);
		const edits: Edit[] = map.blocks().map((b) => ({
			old: b.old,
			new: b.new,
			removed: before.slice(b.old.start - 1, b.old.end),
			added: after.slice(b.new.start - 1, b.new.end)
		}));
		plan.deltas.push({ file: f.path, reason: f.reason, edits });

		const sections = sectionsOf(f.path);
		for (const s of sections) {
			if (s.newRange) {
				s.newRange = map.range(s.newRange);
			}
			if (s.notes) {
				s.notes = s.notes.map((n) => ({ ...n, line: map.line(n.line) }));
			}
			if (s.newRange && edits.some((e) => touches(e.new, s.newRange!))) {
				plan.affected.add(s.id);
			}
		}

		// Edits outside every section matter only where the code still differs from HEAD.
		const hunks = changes.diffs.get(f.path)?.hunks ?? [];
		for (const e of edits) {
			if (sections.some((s) => s.newRange && touches(e.new, s.newRange))) {
				continue;
			}
			const at = isEmpty(e.new) ? { start: Math.max(1, e.new.end), end: e.new.start } : e.new;
			if (hunksInRanges(hunks, [at], 'new').length > 0) {
				plan.uncovered.push({ file: f.path, range: at });
			}
		}
	}
	return plan;
}

/** True when the update needs the agent: some sections or new code have to be reviewed. */
export function needsAgent(plan: UpdatePlan): boolean {
	return plan.affected.size > 0 || plan.uncovered.length > 0 || plan.wholeFiles.size > 0;
}

/** Most lines of edits shown per file; the agent reads the rest from the file. */
const MAX_EDIT_LINES = 400;

function rangeText(r: LineRange): string {
	return isEmpty(r) ? `between lines ${r.end} and ${r.start}` : r.start === r.end ? `line ${r.start}` : `lines ${r.start}-${r.end}`;
}

/** Describes the update for the agent: per file, the edits since the review, the sections they touch and the current diff around them. */
export function renderUpdate(plan: UpdatePlan, changes: ChangeSet): string {
	const out: string[] = [];
	const located = plan.base.categories.flatMap((c) => c.sections.map((s) => ({ c, s })));
	const describe = (s: ReviewSection, c: { id: string; title: string }) =>
		`- ${s.id} in category ${c.id} "${c.title}": "${s.title}", now ${s.newRange ? rangeText(s.newRange) : `old ${rangeText(s.oldRange!)}`}${s.notes?.length ? `, with ${s.notes.length} notes` : ''}\n  Summary: ${s.summary}`;

	for (const d of plan.deltas) {
		out.push(`=== FILE: ${d.file}`);
		if (d.reason === 'removed') {
			const gone = plan.removed.filter((s) => s.file === d.file);
			out.push(`No longer part of the change set.${gone.length ? ` Its sections were removed: ${gone.map((s) => `${s.id} "${s.title}"`).join(', ')}.` : ''}`, '');
			continue;
		}

		const sections = located.filter(({ s }) => s.file === d.file);
		if (d.whole) {
			out.push(`Review this file again in full, because ${d.whole}. Its diff against HEAD is under "=== FILE: ${d.file}" in the annotated diff.`);
			if (sections.length > 0) {
				out.push('Its sections so far (their line numbers may be outdated). Give the id of each one you keep, with its current lines; sections you leave out are removed:');
				sections.forEach(({ s, c }) => out.push(describe(s, c)));
			}
			out.push('');
			continue;
		}

		out.push('Edits since the review ("-": lines removed since the review, "+": lines added, with their current line numbers):');
		let shown = 0;
		for (const e of d.edits) {
			if (shown > MAX_EDIT_LINES) {
				out.push(`(more edits; read the file for the rest)`);
				break;
			}
			out.push(`@@ now ${rangeText(e.new)}, reviewed version ${rangeText(e.old)}`);
			e.removed.forEach((l) => out.push(`       -| ${l}`));
			e.added.forEach((l, i) => out.push(`${String(e.new.start + i).padStart(6)} +| ${l}`));
			shown += e.removed.length + e.added.length + 1;
		}

		const affected = sections.filter(({ s }) => plan.affected.has(s.id));
		if (affected.length > 0) {
			out.push('', 'Sections these edits touch (current positions):');
			affected.forEach(({ s, c }) => out.push(describe(s, c)));
		}
		const uncovered = plan.uncovered.filter((u) => u.file === d.file);
		if (uncovered.length > 0) {
			out.push('', `Edited code that no section covers: ${uncovered.map((u) => rangeText(u.range)).join(', ')}.`);
		}

		// The current diff against HEAD where the edits are, so new and changed sections can be placed.
		const diff = changes.contextDiffs.get(d.file);
		const around = [...affected.map(({ s }) => s.newRange!).filter(Boolean), ...uncovered.map((u) => u.range)];
		const hunks = diff && around.length > 0 ? renderHunks(diff, around) : '';
		if (hunks) {
			out.push('', 'Current diff against HEAD around them (old line, new line, marker, text):', hunks);
		}
		out.push('');
	}
	return out.join('\n');
}
