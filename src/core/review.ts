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
	/** "rewrite": mostly rewritten code that reads better as old and new versions side by side than as a diff. */
	layout?: 'rewrite';
	/** Sections with the same group are parts of one entity, such as a method's declaration and its definition. */
	group?: string;
	/** How hard the section is to review, judged by the agent. */
	effort?: Effort;
	/** Comments on the parts of a long method, shown in the diff above each part. */
	notes?: SectionNote[];
	/** Review findings about this section. */
	concerns?: Concern[];
	/** Update output only: id of the existing section this one goes before. Consumed by mergeUpdate(). */
	insertBefore?: string;
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

export type Effort = 'low' | 'medium' | 'high';
const EFFORTS: readonly string[] = ['low', 'medium', 'high'];

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
		layout: {
			type: 'string',
			enum: ['diff', 'rewrite'],
			description: '"rewrite" when most of the region was rewritten and reads better as old and new versions side by side.'
		},
		group: {
			type: 'string',
			description: 'Shared by sections that show parts of one entity, such as a declaration in a header and its definition. Use the qualified name, for example "GpuDevice::EndFrame".'
		},
		effort: {
			type: 'string',
			enum: ['low', 'medium', 'high'],
			description: 'How hard the section is to review: low for mechanical or obvious code, medium for ordinary logic, high for subtle logic such as concurrency, lifetimes or tricky invariants.'
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

/** Update sections can also say where they go among the sections that stay. */
const UPDATE_SECTION_SCHEMA = {
	...SECTION_SCHEMA,
	properties: {
		...SECTION_SCHEMA.properties,
		before: { type: 'string', description: 'Id of an existing section of the same category that this section should precede in reading order. Omit to take the place of the previous sections of the same file, or to go last.' }
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

/** Schema for incremental updates: categories carry the id of the category they update, sections cover only re-reviewed files. */
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
				required: ['title', 'oldBehavior', 'newBehavior', 'sections'],
				properties: {
					id: { type: 'string', description: 'Id of the existing category this entry updates. Omit for a new category.' },
					before: { type: 'string', description: 'New categories only: id of the existing category this one should precede in reading order. Omit to add it last.' },
					...CATEGORY_PROPERTIES,
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
			const s = (rs ?? {}) as Record<string, unknown>;
			const file = str(s.file).replace(/\\/g, '/').replace(/^\.\//, '');
			const label = `Category "${category.title}", section ${si + 1}`;
			if (!file) {
				errors.push(`${label}: missing file.`);
				continue;
			}

			let newRange = range(s.newStart, s.newEnd, s.newRange);
			const oldRange = range(s.oldStart, s.oldEnd, s.oldRange);
			if (!newRange && !oldRange) {
				errors.push(`${label} (${file}): needs newStart/newEnd or oldStart/oldEnd.`);
				continue;
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
				continue;
			}

			category.sections.push({
				id: `${category.id}s${si + 1}`,
				file,
				title: str(s.title) || path.posix.basename(file),
				summary: str(s.summary),
				newRange,
				oldRange,
				layout: str(s.layout) === 'rewrite' ? 'rewrite' : undefined,
				group: str(s.group) || undefined,
				effort: EFFORTS.includes(str(s.effort)) ? (str(s.effort) as Effort) : undefined,
				notes: notes(s.notes, newRange, label, warnings),
				concerns: concerns(s.concerns),
				insertBefore: str(s.before) || undefined
			});
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
export async function mergeUpdate(previous: Review, raw: unknown, changed: ReadonlySet<string>, ctx: NormalizeContext): Promise<NormalizeResult> {
	const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const rawCategories = Array.isArray(obj.categories) ? (obj.categories as Record<string, unknown>[]) : [];
	// Reuse the full normalization for validation; it keeps the order of the categories.
	const { review: parsed, errors, warnings } = await normalizeReview(obj.categories ? obj : { ...obj, categories: [] }, ctx);
	const realErrors = errors.filter((e) => e !== 'The review has no categories.');

	// Sections of re-reviewed files leave a placeholder, so their replacements keep the reading order.
	type Slot = ReviewSection | { placeholder: string };
	const slots = new Map<string, Slot[]>(previous.categories.map((c) => [c.id, c.sections.map((s): Slot => (changed.has(s.file) ? { placeholder: s.file } : s))]));
	const categories: ReviewCategory[] = previous.categories.map((c) => ({ ...c, sections: [] }));
	let nextCategory = Math.max(0, ...previous.categories.map((c) => parseInt(c.id.substring(1), 10) || 0)) + 1;
	const sectionNumber = (s: Slot) => ('id' in s ? parseInt(s.id.split('s').pop() ?? '', 10) || 0 : 0);

	parsed.categories.forEach((update, i) => {
		const id = str(rawCategories[i]?.id);
		let target = categories.find((c) => c.id === id);
		if (target) {
			target.title = update.title || target.title;
			target.oldBehavior = update.oldBehavior || target.oldBehavior;
			target.newBehavior = update.newBehavior || target.newBehavior;
			target.concerns = update.concerns;
		} else {
			if (id) {
				warnings.push(`Unknown category id "${id}"; "${update.title}" was added as a new category.`);
			}
			target = { ...update, id: `c${nextCategory++}`, sections: [] };
			const before = categories.findIndex((c) => c.id === str(rawCategories[i]?.before));
			categories.splice(before >= 0 ? before : categories.length, 0, target);
			slots.set(target.id, []);
		}

		const list = slots.get(target.id)!;
		let nextSection = Math.max(0, ...list.map(sectionNumber)) + 1;
		for (const { insertBefore, ...s } of update.sections) {
			const section: ReviewSection = { ...s, id: `${target.id}s${nextSection++}` };
			let at = insertBefore ? list.findIndex((x) => 'id' in x && x.id === insertBefore) : -1;
			if (at < 0) {
				at = list.findIndex((x) => 'placeholder' in x && x.placeholder === s.file);
			}
			list.splice(at >= 0 ? at : list.length, 0, section);
		}
	});
	for (const c of categories) {
		c.sections = slots.get(c.id)!.filter((x): x is ReviewSection => 'id' in x);
	}

	const review: Review = {
		...previous,
		updatedAt: new Date().toISOString(),
		head: ctx.head,
		title: parsed.title || previous.title,
		overview: parsed.overview || previous.overview,
		categories: categories.filter((c) => c.sections.length > 0)
	};
	return { review, errors: realErrors, warnings };
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
