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
 * Reads a transcript: where it ran, its title and the changed files it edited. Returns null for sessions that
 * edited none of them, and for review sessions: they are forks of the coding session, so they hold the same
 * edits, and forking one would hand the new review agent the previous reviews.
 */
async function scanTranscript(file: string, root: string, changed: Map<string, string>): Promise<Omit<SessionCandidate, 'lastActive' | 'transcript'> | null> {
	const editedFiles: Record<string, number> = {};
	let cwd: string | null = null;
	let title = '';
	let customTitle = '';
	let userEventsLeft = 50;
	const rootPrefix = normalize(root) + path.sep;

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

		// Only assistant tool calls; other events repeat the same input.
		if (!line.startsWith('{"parentUuid"') && !line.includes('"type":"assistant"')) {
			continue;
		}
		if (!line.includes('"type":"tool_use"') || !EDIT_TOOLS.test(line)) {
			continue;
		}

		for (const m of line.matchAll(FILE_PATH)) {
			let p: string;
			try {
				p = normalize(JSON.parse(`"${m[1]}"`));
			} catch {
				continue;
			}
			if (!p.startsWith(rootPrefix)) {
				continue;
			}
			const rel = changed.get(p);
			if (rel) {
				editedFiles[rel] = (editedFiles[rel] ?? 0) + 1;
			}
		}
	}

	if (Object.keys(editedFiles).length === 0) {
		return null;
	}
	return { sessionId: path.basename(file, '.jsonl'), cwd, title: customTitle || title, editedFiles };
}

/**
 * Finds recent Claude Code sessions that edited files in the change set, leaving out review sessions.
 * Sessions are ranked by how many changed files they touched, then by recency.
 */
export async function findSessions(root: string, changedFiles: string[], maxAgeDays: number): Promise<SessionCandidate[]> {
	const projects = claudeProjectsDir();
	const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
	const changed = new Map(changedFiles.map((f) => [normalize(path.join(root, f)), f]));

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
			const r = await scanTranscript(t.file, root, changed).catch(() => null);
			results.push(r ? { ...r, transcript: t.file, lastActive: t.mtime } : null);
		}
	};
	await Promise.all(Array.from({ length: 6 }, worker));

	return results
		.filter((r): r is SessionCandidate => r !== null)
		.sort((a, b) => {
			const files = Object.keys(b.editedFiles).length - Object.keys(a.editedFiles).length;
			return files !== 0 ? files : b.lastActive.getTime() - a.lastActive.getTime();
		});
}
