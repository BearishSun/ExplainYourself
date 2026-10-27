import { createReadStream, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createInterface } from 'readline';

/** A Claude Code session transcript that edited files of the change set. */
export interface SessionCandidate {
	sessionId: string;
	transcript: string;
	/** Working directory the session ran in; needed to resume it. */
	cwd: string | null;
	title: string;
	lastActive: Date;
	/** Changed files (repo-relative) that the session edited, with edit counts. */
	editedFiles: Record<string, number>;
	/** Lines added by the change set that the session wrote: how much of the uncommitted code is its work. */
	writtenLines: number;
	/** When the session last edited a changed file. */
	lastEdit: Date | null;
}

/** Lines added by the change set, per repo-relative file, in the form `addedLineKey` gives. */
export type AddedLines = ReadonlyMap<string, ReadonlySet<string>>;

/** Added lines long enough to tell where they came from when found outside their file, by key, with their file. */
type DistinctiveLines = ReadonlyMap<string, string>;
const DISTINCTIVE_LENGTH = 16;

/** Key of a line for matching what a session wrote against the change set; null for lines too common to tell. */
export function addedLineKey(text: string): string | null {
	const t = text.trim();
	return t.length >= 4 && /\w/.test(t) ? t : null;
}

/** The text an edit tool call writes to its file. */
function writtenText(input: Record<string, unknown>): string {
	const text = (v: unknown) => (typeof v === 'string' ? v : '');
	const edits = Array.isArray(input.edits) ? input.edits.map((e) => text((e as Record<string, unknown>)?.new_string)) : [];
	return [text(input.content), text(input.new_string), text(input.new_source), ...edits].join('\n');
}

export function claudeConfigDir(): string {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function claudeProjectsDir(): string {
	return path.join(claudeConfigDir(), 'projects');
}

/** Name of the sessions the review agent runs in. */
export const REVIEW_SESSION_NAME = 'ExplainYourself review';
/** First words of every review prompt, also of review sessions started before they were named. */
export const REVIEW_PROMPT_START = 'You are preparing a guided code review.';

const FILE_PATH = /"(?:file_path|notebook_path)":"((?:[^"\\]|\\.)*)"/g;
const EDIT_TOOLS = /"name":"(?:Edit|Write|MultiEdit|NotebookEdit)"/;
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function normalize(p: string): string {
	const resolved = path.resolve(p);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function firstUserText(event: Record<string, unknown>): string | null {
	const message = event.message as { content?: unknown } | undefined;
	const content = message?.content;
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		const text = content.find((c) => c && (c as { type?: string }).type === 'text') as { text?: string } | undefined;
		return text?.text ?? null;
	}
	return null;
}

/** True for a line that is a review prompt sent to the review agent, not one shown in a tool result. */
function isReviewPrompt(line: string): boolean {
	try {
		const event = JSON.parse(line) as Record<string, unknown>;
		return event.type === 'user' && !!firstUserText(event)?.startsWith(REVIEW_PROMPT_START);
	} catch {
		return false;
	}
}

/**
 * Maps a path a session edited to the changed file it may be, or undefined. `byName` marks a file elsewhere
 * that only shares the changed file's name, such as a draft written to a scratch folder and copied in later.
 */
type FileResolver = (target: string) => { rel: string; byName: boolean } | undefined;

/** Edits a session made to changed files: edit counts, the added lines it wrote, and when it last edited. */
class EditLog {
	readonly editedFiles: Record<string, number> = {};
	readonly written = new Set<string>();
	lastEdit: Date | null = null;

	constructor(
		private readonly resolve: FileResolver,
		private readonly added: AddedLines,
		private readonly distinctive: DistinctiveLines
	) {}

	/**
	 * Records the edits of one transcript line, when it is an assistant message with edit or Bash tool calls.
	 * Edits of changed files count the added lines they write. Edits of other files, such as a script that
	 * generates code or a draft copied in later, and Bash commands count the distinctive added lines they hold.
	 */
	record(line: string): void {
		// Only assistant tool calls; other events repeat the same input.
		if (!line.startsWith('{"parentUuid"') && !line.includes('"type":"assistant"')) {
			return;
		}
		if (!line.includes('"type":"tool_use"') || !(EDIT_TOOLS.test(line) || line.includes('"name":"Bash"'))) {
			return;
		}
		let event: { timestamp?: string; message?: { content?: unknown } };
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		const at = event.timestamp ? new Date(event.timestamp) : null;
		const blocks = Array.isArray(event.message?.content) ? (event.message!.content as Record<string, unknown>[]) : [];
		for (const block of blocks) {
			if (block?.type !== 'tool_use' || !block.input || typeof block.input !== 'object') {
				continue;
			}
			const input = block.input as Record<string, unknown>;
			if (block.name === 'Bash') {
				this.matchAnywhere(typeof input.command === 'string' ? input.command : '', at);
				continue;
			}
			if (!EDIT_TOOL_NAMES.has(String(block.name))) {
				continue;
			}
			const target = input.file_path ?? input.notebook_path;
			const match = typeof target === 'string' ? this.resolve(target) : undefined;
			if (!match || match.byName) {
				// Not a changed file, or one that only shares its name: what it holds decides.
				this.matchAnywhere(writtenText(input), at);
				continue;
			}
			const lines = this.added.get(match.rel);
			for (const l of lines ? writtenText(input).split('\n') : []) {
				const key = addedLineKey(l);
				if (key && lines!.has(key)) {
					this.written.add(`${match.rel}\0${key}`);
				}
			}
			this.edited(match.rel, at);
		}
	}

	/** Counts the distinctive added lines that `text` holds, for the files they belong to. */
	private matchAnywhere(text: string, at: Date | null): void {
		const files = new Set<string>();
		for (const l of text.split('\n')) {
			const key = addedLineKey(l);
			const rel = key ? this.distinctive.get(key) : undefined;
			if (rel) {
				this.written.add(`${rel}\0${key}`);
				files.add(rel);
			}
		}
		files.forEach((rel) => this.edited(rel, at));
	}

	private edited(rel: string, at: Date | null): void {
		this.editedFiles[rel] = (this.editedFiles[rel] ?? 0) + 1;
		if (at && !isNaN(at.getTime()) && (!this.lastEdit || at > this.lastEdit)) {
			this.lastEdit = at;
		}
	}
}

/**
 * Resolves edited paths to changed files: paths inside the repository directly, and paths elsewhere, such as
 * a copy of the repository or a worktree, by the longest matching tail of directory and file names.
 */
function fileResolver(root: string, changedFiles: string[]): FileResolver {
	const rootPrefix = normalize(root) + path.sep;
	const changed = new Map(changedFiles.map((f) => [normalize(path.join(root, f)), f]));
	const byName = new Map<string, { rel: string; parts: string[] }[]>();
	for (const [abs, rel] of changed) {
		const parts = abs.slice(rootPrefix.length).split(path.sep);
		const name = parts[parts.length - 1];
		byName.set(name, [...(byName.get(name) ?? []), { rel, parts }]);
	}
	return (target) => {
		const abs = normalize(target);
		if (abs.startsWith(rootPrefix)) {
			const rel = changed.get(abs);
			return rel !== undefined ? { rel, byName: false } : undefined;
		}
		const parts = abs.split(path.sep);
		let best: { rel: string; tail: number } | undefined;
		for (const c of byName.get(parts[parts.length - 1]) ?? []) {
			let tail = 0;
			while (tail < c.parts.length && tail < parts.length && c.parts[c.parts.length - 1 - tail] === parts[parts.length - 1 - tail]) {
				tail++;
			}
			if (tail > (best?.tail ?? 0)) {
				best = { rel: c.rel, tail };
			}
		}
		return best && { rel: best.rel, byName: best.tail < 2 };
	};
}

/** Transcripts of the subagents a session ran; their edits count as the session's. */
async function subagentTranscripts(file: string): Promise<string[]> {
	const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
	try {
		return (await fs.readdir(dir)).filter((e) => e.endsWith('.jsonl')).map((e) => path.join(dir, e));
	} catch {
		return [];
	}
}

/**
 * Reads a transcript: where it ran, its title, the changed files it and its subagents edited, and which of the
 * added lines they wrote. Returns null for sessions that edited none of the files, and for review sessions:
 * they are forks of the coding session, so they hold the same edits, and forking one would hand the new
 * review agent the previous reviews.
 */
async function scanTranscript(
	file: string,
	resolve: FileResolver,
	added: AddedLines,
	distinctive: DistinctiveLines
): Promise<Omit<SessionCandidate, 'lastActive' | 'transcript'> | null> {
	const edits = new EditLog(resolve, added, distinctive);
	let cwd: string | null = null;
	let title = '';
	let customTitle = '';
	let userEventsLeft = 50;

	const input = createReadStream(file, { encoding: 'utf8' });
	const lines = createInterface({ input, crlfDelay: Infinity });
	for await (const line of lines) {
		if (line.includes(`"customTitle":"${REVIEW_SESSION_NAME}"`) || (line.includes(REVIEW_PROMPT_START) && isReviewPrompt(line))) {
			input.destroy();
			return null;
		}
		if ((!cwd || !title) && userEventsLeft > 0) {
			if (line.includes('"cwd"') || line.includes('"type":"user"')) {
				userEventsLeft--;
				try {
					const event = JSON.parse(line) as Record<string, unknown>;
					cwd ??= typeof event.cwd === 'string' ? event.cwd : null;
					if (!title && event.type === 'user' && !event.isMeta) {
						const text = firstUserText(event);
						if (text && !text.startsWith('<')) {
							title = text.replace(/\s+/g, ' ').trim().substring(0, 160);
						}
					}
				} catch {
					// Partial or malformed line.
				}
			}
		}

		if (line.includes('"custom-title"') || line.includes('"type":"summary"')) {
			const m = /"(?:customTitle|summary)":"((?:[^"\\]|\\.)*)"/.exec(line);
			if (m) {
				customTitle = JSON.parse(`"${m[1]}"`);
			}
		}

		edits.record(line);
	}

	for (const sub of await subagentTranscripts(file)) {
		const subLines = createInterface({ input: createReadStream(sub, { encoding: 'utf8' }), crlfDelay: Infinity });
		for await (const line of subLines) {
			edits.record(line);
		}
	}

	if (Object.keys(edits.editedFiles).length === 0) {
		return null;
	}
	return {
		sessionId: path.basename(file, '.jsonl'),
		cwd,
		title: customTitle || title,
		editedFiles: edits.editedFiles,
		writtenLines: edits.written.size,
		lastEdit: edits.lastEdit
	};
}

/**
 * Finds recent Claude Code sessions that edited files in the change set, leaving out review sessions.
 * Sessions are ranked by how many of the `added` lines they wrote, then by their last edit. A session that
 * edited the files long ago, in code since committed, wrote none of them.
 */
export async function findSessions(root: string, changedFiles: string[], maxAgeDays: number, added: AddedLines = new Map()): Promise<SessionCandidate[]> {
	const projects = claudeProjectsDir();
	const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
	const resolve = fileResolver(root, changedFiles);
	const distinctive = new Map<string, string>();
	for (const [rel, keys] of added) {
		keys.forEach((key) => key.length >= DISTINCTIVE_LENGTH && !distinctive.has(key) && distinctive.set(key, rel));
	}

	let dirs: string[];
	try {
		dirs = await fs.readdir(projects);
	} catch {
		return [];
	}

	const transcripts: { file: string; mtime: Date }[] = [];
	for (const d of dirs) {
		let entries: string[];
		try {
			entries = await fs.readdir(path.join(projects, d));
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!e.endsWith('.jsonl')) {
				continue;
			}
			const file = path.join(projects, d, e);
			try {
				const st = await fs.stat(file);
				if (st.mtimeMs >= cutoff) {
					transcripts.push({ file, mtime: st.mtime });
				}
			} catch {
				// Removed while scanning.
			}
		}
	}

	// Scan a few transcripts at a time; some are tens of megabytes.
	const results: (SessionCandidate | null)[] = [];
	let next = 0;
	const worker = async () => {
		while (next < transcripts.length) {
			const t = transcripts[next++];
			const r = await scanTranscript(t.file, resolve, added, distinctive).catch(() => null);
			results.push(r ? { ...r, transcript: t.file, lastActive: t.mtime } : null);
		}
	};
	await Promise.all(Array.from({ length: 6 }, worker));

	return results
		.filter((r): r is SessionCandidate => r !== null)
		.sort((a, b) => b.writtenLines - a.writtenLines || (b.lastEdit ?? b.lastActive).getTime() - (a.lastEdit ?? a.lastActive).getTime());
}
