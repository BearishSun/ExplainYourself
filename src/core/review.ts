import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { LineRange } from './diff';

export interface ReviewSection {
	id: string;
	file: string;
	title: string;
	summary: string;
	/** Lines in the working tree version. */
	newRange?: LineRange;
	/** Lines in the HEAD version. */
	oldRange?: LineRange;
	/** Sections with the same group are parts of one entity, such as a method's declaration and its definition. */
	group?: string;
	/** Comments on the parts of a long method, shown in the diff above each part. */
	notes?: SectionNote[];
	/** Review findings about this section. */
	concerns?: Concern[];
}

export interface SectionNote {
	/** Working tree line where the explained part starts, in the version the review was written against. */
	line: number;
	text: string;
}

/** A review finding, such as a code smell, tagged with the rule it breaks. */
export interface Concern {
	/** Short name of the rule, such as "Duplication". Empty for findings from reviews written before tags existed. */
	tag: string;
	text: string;
}


export interface ReviewCategory {
	id: string;
	title: string;
	oldBehavior: string;
	newBehavior: string;
	/** Review findings about the category that no single section holds. */
	concerns?: Concern[];
	sections: ReviewSection[];
}

export type ReviewSourceKind = 'fresh' | 'session' | 'skill';

export interface ReviewSource {
	kind: ReviewSourceKind;
	/** Claude Code session that wrote the changes, when known. */
	sessionId?: string;
	/** Session of the review agent itself; updates resume it. */
	reviewSessionId?: string;
	/** Directory the review agent ran in; resuming must use the same directory. */
	reviewCwd?: string;
	model?: string;
	/** Total cost of generating and updating the review. */
	costUsd?: number;
}

export interface Review {
	version: 1;
	generatedAt: string;
	/** Time of the last incremental update. */
	updatedAt?: string;
	/** HEAD commit the review was generated against. */
	head: string | null;
	source: ReviewSource;
	/** One-line headline of the change set. Missing in reviews written before titles existed. */
	title?: string;
	overview: string;
	categories: ReviewCategory[];
	/** Submodules whose changes the review covers. */
	submodules?: string[];
	/** HEAD commit of each reviewed submodule at generation time. */
	submoduleHeads?: Record<string, string | null>;
	/** Files of the change set (HEAD -> working tree) at generation time. */
	files?: string[];
	/** SHA-1 of each reviewed working tree file at generation time ("deleted" when missing), to detect later edits. */
	fingerprints: Record<string, string>;
}

const CONCERNS_SCHEMA = {
	type: 'array',
	items: {
		type: 'object',
		additionalProperties: false,
		required: ['tag', 'text'],
		properties: {
			tag: { type: 'string', description: 'Tag of the review rule the finding belongs to, such as "Duplication".' },
			text: { type: 'string', description: 'Names the file and function, says why it is a problem, and gives the cleaner alternative.' }
		}
	}
} as const;

const SECTION_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['file', 'title', 'summary'],
	properties: {
		file: { type: 'string', description: 'Repository-relative path with forward slashes.' },
		title: { type: 'string' },
		summary: { type: 'string' },
		newStart: { type: 'integer', description: '1-based first line in the working tree version.' },
		newEnd: { type: 'integer', description: '1-based last line (inclusive) in the working tree version.' },
		oldStart: { type: 'integer', description: '1-based first line in the HEAD version.' },
		oldEnd: { type: 'integer', description: '1-based last line (inclusive) in the HEAD version.' },
		group: {
			type: 'string',
			description: 'Shared by sections that show parts of one entity, such as a declaration in a header and its definition. Use the qualified name, for example "GpuDevice::EndFrame".'
		},
		notes: {
			type: 'array',
			description: 'Only for a method longer than 60 lines with several distinct parts: one note per part, shown as a comment above it in the diff.',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['line', 'text'],
				properties: {
					line: { type: 'integer', description: '1-based working tree line where the part starts. Must lie inside the section.' },
					text: { type: 'string', description: 'One or two sentences on what the part does.' }
				}
			}
		},
		concerns: { ...CONCERNS_SCHEMA, description: 'Review findings about this section, most important first. Omit when there are none.' }
	}
} as const;

/** Update sections change, remove or add single sections. Fields left out of a change keep their value. */
const UPDATE_SECTION_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		id: { type: 'string', description: 'Id of the existing section this entry changes or removes. Omit for a new section.' },
		remove: { type: 'boolean', description: 'With id: removes the section.' },
		before: {
			type: 'string',
			description: 'Id of the section this one should precede in its category. Omit to keep the place of an existing section, or to put a new one after the sections of the same file.'
		},
		...SECTION_SCHEMA.properties
	}
} as const;

const CATEGORY_PROPERTIES = {
	title: { type: 'string' },
	oldBehavior: { type: 'string', description: 'What the affected code did before the change.' },
	newBehavior: { type: 'string', description: 'What the code does after the change, and why.' },
	concerns: { ...CONCERNS_SCHEMA, description: 'Review findings about the category that do not belong to a single section, most important first. Omit when there are none.' },
	sections: { type: 'array', items: SECTION_SCHEMA }
} as const;

/** JSON schema handed to `claude -p --json-schema`. Kept flat because structured output prefers simple schemas. */
export const OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['title', 'overview', 'categories'],
	properties: {
		title: { type: 'string', description: 'One line, at most about 80 characters, naming what the change set does.' },
		overview: { type: 'string', description: 'Two to five sentences describing the change set as a whole.' },
		sourceSession: { type: 'string', description: 'Id of the Claude Code session that produced the changes, if one was identified.' },
		categories: {
			type: 'array',
			items: { type: 'object', additionalProperties: false, required: ['title', 'oldBehavior', 'newBehavior', 'sections'], properties: CATEGORY_PROPERTIES }
		}
	}
} as const;

/** Schema for review updates: categories and sections that change, by id, and new ones. */
export const UPDATE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['categories'],
	properties: {
		title: { type: 'string', description: 'Updated one-line title of the change set. Omit to keep the previous one.' },
		overview: { type: 'string', description: 'Updated overview of the whole change set. Omit to keep the previous one.' },
		categories: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					id: { type: 'string', description: 'Id of the existing category this entry changes or adds sections to. Omit for a new category, which needs title, oldBehavior and newBehavior.' },
					before: { type: 'string', description: 'New categories only: id of the existing category this one should precede in reading order. Omit to add it last.' },
					title: { type: 'string', description: 'Omit to keep the current title.' },
					oldBehavior: { type: 'string', description: 'Omit to keep the current text.' },
					newBehavior: { type: 'string', description: 'Omit to keep the current text.' },
					concerns: { ...CONCERNS_SCHEMA, description: 'All findings of the category after the update. Omit to keep the current ones; give an empty list to remove them.' },
					sections: { type: 'array', items: UPDATE_SECTION_SCHEMA }
				}
			}
		}
	}
} as const;

function str(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
}

function int(v: unknown): number | undefined {
	const n = typeof v === 'string' ? parseInt(v, 10) : v;
	return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function range(start: unknown, end: unknown, nested: unknown): LineRange | undefined {
	if (nested && typeof nested === 'object') {
		const r = nested as Record<string, unknown>;
		return range(r.start, r.end, undefined);
	}

	const s = int(start);
	const e = int(end) ?? s;
	if (s === undefined || e === undefined || s < 1) {
		return undefined;
	}
	return { start: Math.min(s, e), end: Math.max(s, e) };
}

/** Reads findings as tagged items. Also accepts plain strings and Markdown bullet lists, which get no tag. */
function concerns(raw: unknown): Concern[] | undefined {
	const items = typeof raw === 'string' ? raw.split(/\n(?=\s*[-*] )/) : Array.isArray(raw) ? raw : [];
	const result: Concern[] = [];
	for (const item of items) {
		const o = (item && typeof item === 'object' ? item : { text: item }) as Record<string, unknown>;
		const text = str(o.text).replace(/^[-*] /, '');
		if (text) {
			result.push({ tag: str(o.tag), text });
		}
	}
	return result.length > 0 ? result : undefined;
}

/** Validates the notes of a section: each needs text and a line inside the section's new range. */
function notes(raw: unknown, range: LineRange | undefined, label: string, warnings: string[]): SectionNote[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const result: SectionNote[] = [];
	for (const n of raw) {
		const o = (n ?? {}) as Record<string, unknown>;
		const line = int(o.line);
		const text = str(o.text);
		if (line === undefined || !text) {
			continue;
		}
		if (!range || line < range.start || line > range.end) {
			warnings.push(`${label}: the note at line ${line} lies outside the section and was dropped.`);
			continue;
		}
		result.push({ line, text });
	}
	result.sort((a, b) => a.line - b.line);
	return result.length > 0 ? result : undefined;
}

export interface NormalizeResult {
	review: Review;
	errors: string[];
	warnings: string[];
}

export interface NormalizeContext {
	head: string | null;
	source: Review['source'];
	/** Line counts of working tree files, used to clamp ranges. Missing files are reported. */
	lineCount: (file: string) => Promise<number | null>;
}

function record(v: unknown): Record<string, unknown> {
	return (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
}

/** Validates one section of agent output. Returns null, after reporting why, when it is unusable. */
async function parseSection(s: Record<string, unknown>, label: string, ctx: NormalizeContext, errors: string[], warnings: string[]): Promise<Omit<ReviewSection, 'id'> | null> {
	const file = str(s.file).replace(/\\/g, '/').replace(/^\.\//, '');
	if (!file) {
		errors.push(`${label}: missing file.`);
		return null;
	}

	let newRange = range(s.newStart, s.newEnd, s.newRange);
	const oldRange = range(s.oldStart, s.oldEnd, s.oldRange);
	if (!newRange && !oldRange) {
		errors.push(`${label} (${file}): needs newStart/newEnd or oldStart/oldEnd.`);
		return null;
	}

	if (newRange) {
		const count = await ctx.lineCount(file);
		if (count === null) {
			warnings.push(`${label}: ${file} does not exist in the working tree; its new range was dropped.`);
			newRange = undefined;
		} else if (newRange.start > count) {
			warnings.push(`${label}: lines ${newRange.start}-${newRange.end} lie past the end of ${file} (${count} lines).`);
			newRange = undefined;
		} else if (newRange.end > count) {
			newRange.end = count;
		}
	}
	if (!newRange && !oldRange) {
		return null;
	}

	return {
		file,
		title: str(s.title) || path.posix.basename(file),
		summary: str(s.summary),
		newRange,
		oldRange,
		group: str(s.group) || undefined,
		notes: notes(s.notes, newRange, label, warnings),
		concerns: concerns(s.concerns)
	};
}

/** Converts agent output (flat or nested ranges) into a Review, reporting problems instead of throwing. */
export async function normalizeReview(raw: unknown, ctx: NormalizeContext): Promise<NormalizeResult> {
	const errors: string[] = [];
	const warnings: string[] = [];
	const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const rawCategories = Array.isArray(obj.categories) ? obj.categories : [];
	if (rawCategories.length === 0) {
		errors.push('The review has no categories.');
	}

	const categories: ReviewCategory[] = [];
	for (const [ci, rc] of rawCategories.entries()) {
		const c = (rc ?? {}) as Record<string, unknown>;
		const category: ReviewCategory = {
			id: `c${ci + 1}`,
			title: str(c.title) || `Category ${ci + 1}`,
			oldBehavior: str(c.oldBehavior),
			newBehavior: str(c.newBehavior),
			concerns: concerns(c.concerns),
			sections: []
		};

		const rawSections = Array.isArray(c.sections) ? c.sections : [];
		for (const [si, rs] of rawSections.entries()) {
			const section = await parseSection(record(rs), `Category "${category.title}", section ${si + 1}`, ctx, errors, warnings);
			if (section) {
				category.sections.push({ id: `${category.id}s${si + 1}`, ...section });
			}
		}
		categories.push(category);
	}

	const source = { ...ctx.source };
	const sessionId = str(obj.sourceSession);
	if (sessionId && !source.sessionId) {
		source.sessionId = sessionId;
	}

	const review: Review = {
		version: 1,
		generatedAt: new Date().toISOString(),
		head: ctx.head,
		source,
		title: str(obj.title).split('\n')[0].trim() || undefined,
		overview: str(obj.overview),
		categories,
		fingerprints: {}
	};
	return { review, errors, warnings };
}

export function fingerprint(content: Buffer): string {
	return createHash('sha1').update(content).digest('hex');
}

export async function computeFingerprints(root: string, files: Iterable<string>): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const f of new Set(files)) {
		try {
			result[f] = fingerprint(await fs.readFile(path.join(root, f)));
		} catch {
			result[f] = DELETED;
		}
	}
	return result;
}

/** Fingerprint of a file that does not exist in the working tree. */
export const DELETED = 'deleted';

function snapshotDir(gitDir: string): string {
	return path.join(reviewDir(gitDir), 'snapshots');
}

/**
 * Keeps a copy of each reviewed file as the review saw it, named by its fingerprint. Section and note
 * positions refer to these versions; diffing them against the current files moves the positions along
 * with later edits. Removes copies the review no longer uses.
 */
export async function saveSnapshots(gitDir: string, root: string, files: Iterable<string>, fingerprints: Record<string, string>): Promise<void> {
	const dir = snapshotDir(gitDir);
	await fs.mkdir(dir, { recursive: true });
	const keep = new Set<string>();
	for (const file of new Set(files)) {
		const fp = fingerprints[file];
		if (fp && fp !== DELETED && (await adoptSnapshot(gitDir, root, file, fp)) !== null) {
			keep.add(fp);
		}
	}
	for (const name of await fs.readdir(dir)) {
		if (!keep.has(name)) {
			await fs.rm(path.join(dir, name), { force: true });
		}
	}
}

/** The reviewed version of a file, or null when no copy exists. */
export async function loadSnapshot(gitDir: string, fp: string): Promise<string | null> {
	try {
		return await fs.readFile(path.join(snapshotDir(gitDir), fp), 'utf8');
	} catch {
		return null;
	}
}

/**
 * Stores the current file as the snapshot `fp` when its content still matches, and returns that content.
 * Also gives reviews written before snapshots existed a snapshot of every file that has not changed since.
 */
export async function adoptSnapshot(gitDir: string, root: string, file: string, fp: string): Promise<string | null> {
	const existing = await loadSnapshot(gitDir, fp);
	if (existing !== null) {
		return existing;
	}
	try {
		const content = await fs.readFile(path.join(root, file));
		if (fingerprint(content) !== fp) {
			return null;
		}
		await fs.mkdir(snapshotDir(gitDir), { recursive: true });
		await fs.writeFile(path.join(snapshotDir(gitDir), fp), content);
		return content.toString('utf8');
	} catch {
		return null;
	}
}

/**
 * Merges an incremental update into the previous review. Sections of `changed` files are replaced by the
 * update; everything else is kept. Update categories with a known id update that category, others are added.
 * Categories left without sections are dropped.
 */
/**
 * Applies update output to `base`, the previous review with its positions moved to the current files.
 * Entries with an id change or remove that category or section; fields they leave out keep their value.
 * Entries without an id add categories and sections. In `wholeFiles`, files the update reviewed again in
 * full, sections that the output does not mention are removed. Categories left without sections are removed.
 */
export async function mergeUpdate(base: Review, raw: unknown, wholeFiles: ReadonlySet<string>, ctx: NormalizeContext): Promise<NormalizeResult> {
	const errors: string[] = [];
	const warnings: string[] = [];
	const obj = record(raw);
	const categories: ReviewCategory[] = base.categories.map((c) => ({ ...c, sections: [...c.sections] }));
	let nextCategory = Math.max(0, ...categories.map((c) => parseInt(c.id.substring(1), 10) || 0)) + 1;
	const ids = new Set(categories.flatMap((c) => c.sections.map((s) => s.id)));
	const mentioned = new Set<string>();

	const newId = (c: ReviewCategory): string => {
		let n = 1;
		while (ids.has(`${c.id}s${n}`)) {
			n++;
		}
		ids.add(`${c.id}s${n}`);
		return `${c.id}s${n}`;
	};
	const locate = (id: string): { category: ReviewCategory; index: number } | undefined => {
		for (const category of categories) {
			const index = category.sections.findIndex((s) => s.id === id);
			if (index >= 0) {
				return { category, index };
			}
		}
		return undefined;
	};
	// Before the given section, or after the other sections of the same file, or last.
	const place = (target: ReviewCategory, section: ReviewSection, before: string) => {
		let at = before ? target.sections.findIndex((s) => s.id === before) : -1;
		if (at < 0) {
			const last = target.sections.map((s) => s.file).lastIndexOf(section.file);
			at = last >= 0 ? last + 1 : target.sections.length;
		}
		target.sections.splice(at, 0, section);
	};
	// The fields of an existing section, in the form the agent writes them.
	const asRaw = (s: ReviewSection): Record<string, unknown> => ({
		file: s.file,
		title: s.title,
		summary: s.summary,
		newStart: s.newRange?.start,
		newEnd: s.newRange?.end,
		oldStart: s.oldRange?.start,
		oldEnd: s.oldRange?.end,
		group: s.group,
		notes: s.notes,
		concerns: s.concerns
	});

	const rawCategories = Array.isArray(obj.categories) ? obj.categories : [];
	for (const [ci, entry] of rawCategories.entries()) {
		const rc = record(entry);
		const id = str(rc.id);
		let target = id ? categories.find((c) => c.id === id) : undefined;
		if (!target) {
			if (!str(rc.title) || !str(rc.newBehavior)) {
				errors.push(id ? `Unknown category id "${id}".` : `New category ${ci + 1}: needs title, oldBehavior and newBehavior.`);
				continue;
			}
			if (id) {
				warnings.push(`Unknown category id "${id}"; "${str(rc.title)}" was added as a new category.`);
			}
			target = { id: `c${nextCategory++}`, title: '', oldBehavior: '', newBehavior: '', sections: [] };
			const before = categories.findIndex((c) => c.id === str(rc.before));
			categories.splice(before >= 0 ? before : categories.length, 0, target);
		}
		target.title = str(rc.title) || target.title;
		target.oldBehavior = str(rc.oldBehavior) || target.oldBehavior;
		target.newBehavior = str(rc.newBehavior) || target.newBehavior;
		if (rc.concerns !== undefined) {
			target.concerns = concerns(rc.concerns);
		}

		const rawSections = Array.isArray(rc.sections) ? rc.sections : [];
		for (const [si, item] of rawSections.entries()) {
			const rs = record(item);
			const sid = str(rs.id);
			const label = `Category "${target.title}", section ${si + 1}${sid ? ` (${sid})` : ''}`;
			const found = sid ? locate(sid) : undefined;
			if (sid && !found) {
				warnings.push(`${label}: unknown section id; added as a new section.`);
			}
			if (rs.remove === true) {
				if (found) {
					mentioned.add(sid);
					found.category.sections.splice(found.index, 1);
				}
				continue;
			}

			if (found) {
				const old = found.category.sections[found.index];
				const fields = Object.fromEntries(Object.entries(rs).filter(([k, v]) => v !== undefined && v !== null && k !== 'id' && k !== 'before' && k !== 'remove' && k !== 'file'));
				const section = await parseSection({ ...asRaw(old), ...fields }, label, ctx, errors, warnings);
				mentioned.add(sid);
				if (!section) {
					continue;
				}
				const updated: ReviewSection = { ...section, id: old.id };
				if (found.category === target && !str(rs.before)) {
					target.sections[found.index] = updated;
				} else {
					found.category.sections.splice(found.index, 1);
					place(target, updated, str(rs.before));
				}
				continue;
			}

			const section = await parseSection(rs, label, ctx, errors, warnings);
			if (section) {
				const added: ReviewSection = { ...section, id: newId(target) };
				mentioned.add(added.id);
				place(target, added, str(rs.before));
			}
		}
	}

	for (const c of categories) {
		c.sections = c.sections.filter((s) => !wholeFiles.has(s.file) || mentioned.has(s.id));
	}
	const review: Review = {
		...base,
		updatedAt: new Date().toISOString(),
		head: ctx.head,
		title: str(obj.title).split('\n')[0].trim() || base.title,
		overview: str(obj.overview) || base.overview,
		categories: categories.filter((c) => c.sections.length > 0)
	};
	return { review, errors, warnings };
}

export function reviewDir(gitDir: string): string {
	return path.join(gitDir, 'explainyourself');
}

export function reviewPath(gitDir: string): string {
	return path.join(reviewDir(gitDir), 'review.json');
}

export async function saveReview(gitDir: string, review: Review): Promise<void> {
	await fs.mkdir(reviewDir(gitDir), { recursive: true });
	const target = reviewPath(gitDir);
	const temp = `${target}.${process.pid}.tmp`;
	await fs.writeFile(temp, JSON.stringify(review, null, '\t'), 'utf8');
	await fs.rename(temp, target);
}

export async function loadReview(gitDir: string): Promise<Review | null> {
	try {
		const data = JSON.parse(await fs.readFile(reviewPath(gitDir), 'utf8')) as Review;
		if (data.version !== 1 || !Array.isArray(data.categories)) {
			return null;
		}
		// Reviews written before tagged findings hold category findings as one Markdown string.
		for (const c of data.categories) {
			c.concerns = concerns(c.concerns);
		}
		return data;
	} catch {
		return null;
	}
}

/** Counts lines the same way editors do: a trailing newline does not start a new line. */
export async function countFileLines(file: string): Promise<number | null> {
	try {
		const content = await fs.readFile(file);
		if (content.length === 0) {
			return 0;
		}
		let count = 0;
		for (const b of content) {
			if (b === 10) {
				count++;
			}
		}
		return content[content.length - 1] === 10 ? count : count + 1;
	} catch {
		return null;
	}
}
