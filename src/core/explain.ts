import { AgentProgress, AgentRun, runAgent } from './agent';
import { lines } from './anchors';
import { decode } from './changes';
import { FileDiff, LineRange } from './diff';
import { INTRO } from './prompt';
import { ReviewSection, SectionNote } from './review';

/** Output of a request to explain a section in more detail: the new summary and the full list of notes. */
export const EXPLAIN_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['summary', 'notes'],
	properties: {
		summary: { type: 'string' },
		notes: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['line', 'text'],
				properties: { line: { type: 'integer' }, text: { type: 'string' } }
			}
		}
	}
};

export interface ExplainRequest {
	section: ReviewSection;
	/** The section's lines in the current file. */
	range: LineRange;
	/** The section's notes, at their lines in the current file. */
	notes: SectionNote[];
	/**
	 * The section's code as it is now, one entry per line: "+" for lines added since HEAD, " " for unchanged
	 * lines, "-" for removed HEAD lines, which have no current line number.
	 */
	code: { marker: '+' | ' ' | '-'; line?: number; text: string }[];
}

export interface ExplainOptions {
	claudePath: string;
	model?: string;
	repoRoot: string;
	/** The review session to continue, when it still exists; otherwise a new agent starts. */
	session?: { id: string; cwd: string };
	onProgress?: (p: AgentProgress) => void;
	onStart?: (run: AgentRun) => void;
}

export interface Explanation {
	summary: string;
	/** At their lines in the current file, inside the section, in order. */
	notes: SectionNote[];
	sessionId?: string;
	costUsd?: number;
}

const RULES = `## What to produce
The reviewer has not seen this code before, neither the old nor the new version. Give them what they need to understand the change and judge it.
1. summary: what the code does now, what changed compared to HEAD and why. More detailed than a usual summary, but still succinct: short sentences, no filler, and do not repeat the code. 2-6 sentences, or a short "- " list where the change has several distinct parts. Like the notes, it explains rather than judges.
2. notes: the complete list of notes for the section; it replaces the current notes. A note is a comment shown above a part of the code. Keep current notes that are still right, sharpen ones that are vague, and add notes where the code splits into meaningful parts (argument checks, setup, a loop, cleanup), so a reviewer can read the section part by part.
   - Focus on code that is convoluted or hard to understand: non-obvious conditions, invariants the code relies on, ordering that matters, bit manipulation, index arithmetic, and the reasons behind workarounds. Say why, not only what.
   - Add a note only where a reader would otherwise have to stop and work something out. Code that explains itself gets none.
   - Explain, do not judge: leave out review findings such as bugs, risks or style problems; they are reported separately.
   - line is the first line of the part, in the current file, inside the section. Take it from the listing below. At most one note per line.
   - Each note is one or two short sentences. Do not repeat the summary or restate the code.
   - Return an empty list for a short section that reads clearly with its summary alone.

All text is rendered as Markdown. Wrap code identifiers, types and literal values in backticks.

## Rules
- Read the surrounding code, callers and the HEAD version (git show HEAD:<path>) where the listing is not enough.
- Do not modify any source files.

## Output
Return the summary and notes as structured output matching the provided JSON schema.`;

/**
 * The lines of a section with diff markers, from the file's HEAD -> working tree diff (zero context) and its
 * current text. A file without hunks is new: all its lines are added.
 */
export function sectionListing(diff: FileDiff | undefined, text: string, range: LineRange): ExplainRequest['code'] {
	const untracked = !!diff && diff.oldPath === null && diff.hunks.length === 0;
	// Lines added since HEAD, and the HEAD lines removed before each working tree line.
	const added = new Set<number>();
	const removedBefore = new Map<number, string[]>();
	for (const h of diff?.hunks ?? []) {
		const at = h.newCount === 0 ? h.newStart + 1 : h.newStart;
		for (const l of h.lines) {
			if (l.type === '+') {
				added.add(l.newLine);
			} else if (l.type === '-') {
				removedBefore.set(at, [...(removedBefore.get(at) ?? []), decode(l.text.replace(/\r?\n$/, ''))]);
			}
		}
	}
	const fileLines = lines(text);
	const code: ExplainRequest['code'] = [];
	for (let n = range.start; n <= Math.min(range.end, fileLines.length); n++) {
		(removedBefore.get(n) ?? []).forEach((t) => code.push({ marker: '-', text: t }));
		code.push({ marker: untracked || added.has(n) ? '+' : ' ', line: n, text: fileLines[n - 1] });
	}
	return code;
}

function listing(request: ExplainRequest): string {
	return request.code.map((l) => `${l.line !== undefined ? String(l.line).padStart(6) : '      '} ${l.marker}| ${l.text}`).join('\n');
}

/** Prompt asking for a more detailed explanation of one section. `resumed` when the agent wrote the review. */
export function buildExplainPrompt(request: ExplainRequest, resumed: boolean): string {
	const { section, range } = request;
	const current = [
		`Section: "${section.title}" in ${section.file}, lines ${range.start}-${range.end} of the current file.`,
		`Current summary: ${section.summary}`,
		request.notes.length > 0 ? `Current notes:\n${request.notes.map((n) => `- line ${n.line}: ${n.text}`).join('\n')}` : 'Current notes: none.'
	].join('\n');
	const code = `The section's code now (current line, marker, text; "+" added since HEAD, "-" removed, " " unchanged):\n${listing(request)}`;
	const intro = resumed
		? 'The reviewer asked for a more detailed explanation of one section of the review you wrote in this session. The code may have changed since; describe it as it is now.'
		: `${INTRO}\n\nA review of the uncommitted changes (HEAD -> working tree) exists. The reviewer asked for a more detailed explanation of one of its sections.`;
	return `${intro}\n\n${current}\n\n${code}\n\n${RULES}\n`;
}

/** Asks the agent to explain a section in more detail. Continues the review session when it still exists. */
export async function explainSection(request: ExplainRequest, options: ExplainOptions): Promise<Explanation> {
	const run = async (resume: boolean) => {
		const agent = runAgent({
			claudePath: options.claudePath,
			cwd: resume ? options.session!.cwd : options.repoRoot,
			repoRoot: options.repoRoot,
			prompt: buildExplainPrompt(request, resume),
			model: options.model,
			resumeSessionId: resume ? options.session!.id : undefined,
			schema: EXPLAIN_SCHEMA,
			onProgress: options.onProgress
		});
		options.onStart?.(agent);
		return agent.result;
	};

	let result;
	try {
		result = await run(!!options.session);
	} catch (e) {
		// The review session may have been deleted; a new agent can still explain from the code.
		if (!options.session || !/No conversation found/i.test(e instanceof Error ? e.message : String(e))) {
			throw e;
		}
		result = await run(false);
	}
	return { ...parseExplanation(result.output, request.range), sessionId: result.sessionId, costUsd: result.costUsd };
}

/** Validates the agent's output: a summary, and notes inside the section, one per line, in order. */
export function parseExplanation(raw: unknown, range: LineRange): { summary: string; notes: SectionNote[] } {
	const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
	if (!summary) {
		throw new Error('The explanation has no summary.');
	}
	const notes = new Map<number, string>();
	for (const n of Array.isArray(obj.notes) ? obj.notes : []) {
		const { line, text } = (n ?? {}) as { line?: unknown; text?: unknown };
		if (typeof line === 'number' && Number.isInteger(line) && line >= range.start && line <= range.end && typeof text === 'string' && text.trim() && !notes.has(line)) {
			notes.set(line, text.trim());
		}
	}
	return { summary, notes: [...notes].sort((a, b) => a[0] - b[0]).map(([line, text]) => ({ line, text })) };
}
