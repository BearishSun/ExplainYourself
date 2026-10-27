import { existsSync, writeFileSync } from 'fs';
import * as path from 'path';
import { AgentProgress, AgentRun, runAgent } from './agent';
import { addedLines, buildChangeSet, ChangeSet } from './changes';
import { git } from './exec';
import { snapSections } from './coverage';
import { buildCoveragePrompt, buildPrompt, buildUpdatePrompt, UpdatedFile, UpdateMode } from './prompt';
import { coverageGaps, renderCoverage } from './repair';
import { computeFingerprints, countFileLines, saveSnapshots, loadReview, mergeUpdate, normalizeReview, Review, reviewDir, reviewPath, saveReview, UPDATE_SCHEMA } from './review';
import { loadGuidance } from './guidance';
import { needsAgent, planUpdate, renderUpdate, UpdatePlan } from './update';
import { findSessions, SessionCandidate } from './sessions';
import { Workspace } from './workspace';

/** Keeps the last prompt sent to Claude next to the review, so the user can read it. */
function savePrompt(repo: Workspace, prompt: string): string {
	writeFileSync(path.join(reviewDir(repo.gitDir), 'prompt.md'), prompt);
	return prompt;
}

export type GenerateSource = { kind: 'auto' } | { kind: 'fresh' } | { kind: 'session'; session: SessionCandidate } | { kind: 'update' };

export interface GenerateOptions {
	claudePath: string;
	model?: string;
	source: GenerateSource;
	sessionMaxAgeDays: number;
	onProgress: (p: AgentProgress) => void;
	/** Receives the running agent so the caller can cancel it. */
	onStart?: (run: AgentRun) => void;
	/**
	 * Lets the user choose the session to fork, from the sessions that edited the changed files, best match
	 * first, or a new agent. Undefined cancels the generation. Without it, the best match is forked when it
	 * wrote some of the changed lines.
	 */
	chooseSession?: (candidates: SessionCandidate[]) => Promise<SessionCandidate | 'new' | undefined>;
	/** Receives the saved review after the first pass, when a coverage pass follows, so it can be shown already. */
	onReview?: (review: Review) => Promise<void>;
}

export interface GenerateResult {
	review: Review;
	warnings: string[];
	/** Set when an update found nothing to re-review. */
	upToDate?: boolean;
}

function lineCounter(repo: Workspace) {
	return (file: string) => countFileLines(repo.absPath(file));
}

/** Records what the review covers (change set, file fingerprints and copies of the reviewed files) and saves it. */
async function saveWithSnapshot(repo: Workspace, changes: ChangeSet, review: Review): Promise<void> {
	review.files = changes.files.map((f) => f.path);
	review.submodules = repo.selectedSubmodules.length > 0 ? repo.selectedSubmodules : undefined;
	review.submoduleHeads = repo.selectedSubmodules.length > 0 ? repo.submoduleHeads() : undefined;
	const sectionFiles = review.categories.flatMap((c) => c.sections.map((s) => s.file));
	review.fingerprints = await computeFingerprints(repo.root, [...review.files, ...sectionFiles]);
	// Copies of all changed text files, so later updates can tell exactly what was edited since.
	const textFiles = changes.files.filter((f) => f.status !== 'binary' && f.status !== 'deleted').map((f) => f.path);
	await saveSnapshots(repo.gitDir, repo.root, [...sectionFiles, ...textFiles], review.fingerprints);
	await saveReview(repo.gitDir, review);
}

/** Turns raw agent output into a review, without saving it. Throws when the output is unusable. */
async function parseReview(repo: Workspace, changes: ChangeSet, raw: unknown, source: Review['source']): Promise<GenerateResult> {
	const { review, errors, warnings } = await normalizeReview(raw, { head: repo.head, source, lineCount: lineCounter(repo) });
	if (errors.length > 0) {
		throw new Error(`The review is invalid:\n${errors.join('\n')}`);
	}
	warnings.push(...snapSections(review, changes.diffs));
	return { review, warnings };
}

/** Turns raw agent output into a saved review. Throws when the output is unusable. */
export async function finishReview(repo: Workspace, changes: ChangeSet, raw: unknown, source: Review['source']): Promise<GenerateResult> {
	const result = await parseReview(repo, changes, raw, source);
	await saveWithSnapshot(repo, changes, result.review);
	return result;
}

/** Merges raw update output into the planned base review and saves it. Throws when the output is unusable. */
export async function finishUpdate(repo: Workspace, changes: ChangeSet, plan: UpdatePlan, raw: unknown, source: Review['source']): Promise<GenerateResult> {
	const { review, errors, warnings } = await mergeUpdate(plan.base, raw, plan.wholeFiles, { head: repo.head, source, lineCount: lineCounter(repo) });
	if (errors.length > 0) {
		throw new Error(`The review update is invalid:\n${errors.join('\n')}`);
	}
	review.source = source;
	warnings.push(...snapSections(review, changes.diffs));
	await saveWithSnapshot(repo, changes, review);
	return { review, warnings };
}

/**
 * Lists the files whose review is out of date: files that entered or left the change set, and files whose
 * content changed. Returns null when the review cannot be updated incrementally (its HEAD is unknown).
 */
export async function reviewDelta(repo: Workspace, review: Review, changes: ChangeSet): Promise<UpdatedFile[] | null> {
	const current = new Set(changes.files.map((f) => f.path));
	const previous = new Set(review.files ?? Object.keys(review.fingerprints));
	const all = new Set([...current, ...previous, ...Object.keys(review.fingerprints)]);

	// Files whose HEAD version changed through commits, in the root and in each submodule.
	const headChanged = new Set<string>();
	for (const { prefix, repo: part } of repo.parts()) {
		const before = prefix ? review.submoduleHeads?.[prefix.slice(0, -1)] : review.head;
		if (before === part.head) {
			continue;
		}
		if (!before || !part.head) {
			if (!prefix) {
				return null;
			}
			// A submodule new to the review: its files count as added anyway.
			continue;
		}
		try {
			const out = await git(part.root, ['diff', '--name-only', '-z', '--no-renames', before, part.head], { readOnly: true });
			out.toString('utf8').split('\0').filter(Boolean).forEach((f) => headChanged.add(prefix + f));
		} catch {
			if (!prefix) {
				return null;
			}
		}
	}

	const fingerprints = await computeFingerprints(repo.root, all);
	const result: UpdatedFile[] = [];
	for (const file of [...all].sort()) {
		if (current.has(file) && !previous.has(file)) {
			result.push({ path: file, reason: 'added' });
		} else if (!current.has(file) && previous.has(file)) {
			result.push({ path: file, reason: 'removed' });
		} else if (fingerprints[file] !== review.fingerprints[file] || headChanged.has(file)) {
			result.push({ path: file, reason: 'modified', ...(headChanged.has(file) ? { headMoved: true } : {}) });
		}
	}
	return result;
}

/** Builds the change set, picks the context source, runs the agent and saves the review. */
export async function generateReview(repo: Workspace, options: GenerateOptions): Promise<GenerateResult> {
	options.onProgress({ kind: 'status', message: 'Collecting changes…' });
	const changes = await buildChangeSet(repo);
	if (changes.files.length === 0) {
		throw new Error('There are no changes to review.');
	}

	if (options.source.kind === 'update') {
		const previous = await loadReview(repo.gitDir);
		const files = previous && (await reviewDelta(repo, previous, changes));
		if (previous && files) {
			return updateReview(repo, changes, previous, files, options);
		}
		options.onProgress({ kind: 'status', message: 'The review cannot be updated incrementally; generating a new one.' });
	}

	let session: SessionCandidate | undefined;
	let candidates: SessionCandidate[] = [];
	if (options.source.kind === 'session') {
		session = options.source.session;
	} else {
		options.onProgress({ kind: 'status', message: 'Searching recent Claude sessions…' });
		candidates = await findSessions(repo.root, changes.files.map((f) => f.path), options.sessionMaxAgeDays, addedLines(changes));
		// Only sessions that can be resumed, from their original directory, can be forked.
		const forkable = candidates.filter((c) => c.cwd && existsSync(c.cwd));
		if (options.source.kind !== 'fresh' && options.chooseSession && forkable.length > 0) {
			const choice = await options.chooseSession(forkable);
			if (!choice) {
				throw new Error('Cancelled.');
			}
			session = choice === 'new' ? undefined : choice;
		} else if (options.source.kind !== 'fresh' && forkable[0]?.writtenLines > 0) {
			// Automatically, only a session that wrote some of the uncommitted code.
			session = forkable[0];
		}
	}

	const guidance = await loadGuidance(repo.root, changes.files.map((f) => f.path));
	const prompt = buildPrompt(repo.root, changes, session ? { kind: 'session' } : { kind: 'fresh', sessions: candidates }, guidance);
	options.onProgress({
		kind: 'status',
		message: session ? `Forking session "${session.title || session.sessionId}"…` : 'Starting a new review agent…'
	});

	const cwd = session?.cwd ?? repo.root;
	const run = runAgent({
		claudePath: options.claudePath,
		cwd,
		repoRoot: repo.root,
		prompt: savePrompt(repo, prompt),
		model: options.model,
		resumeSessionId: session?.sessionId,
		fork: true,
		onProgress: options.onProgress
	});
	options.onStart?.(run);
	const result = await run.result;

	options.onProgress({ kind: 'status', message: 'Validating review…' });
	const parsed = await parseReview(repo, changes, result.output, {
		kind: session ? 'session' : 'fresh',
		sessionId: session?.sessionId,
		reviewSessionId: result.sessionId,
		reviewCwd: cwd,
		model: result.model ?? options.model,
		costUsd: result.costUsd
	});
	await saveWithSnapshot(repo, changes, parsed.review);
	if (coverageGaps(parsed.review, changes).length === 0) {
		return parsed;
	}

	// The reviewer can start on the first pass while the review session covers what it missed.
	await options.onReview?.(parsed.review);
	const repaired = await repairCoverage(repo, changes, parsed, options);
	if (repaired.review !== parsed.review) {
		// Positions are in the files as of the first pass; its snapshot moves them along with later edits.
		await saveReview(repo.gitDir, repaired.review);
	}
	return repaired;
}

/**
 * Checks that the sections of a new review cover every changed line. When some do not, the review session
 * continues with only the uncovered lines, and adds or extends sections for them. Once: lines still uncovered
 * after that are left to the reviewer. A failed pass keeps the review as it is.
 */
export async function repairCoverage(repo: Workspace, changes: ChangeSet, parsed: GenerateResult, options: GenerateOptions): Promise<GenerateResult> {
	const { review, warnings } = parsed;
	const gaps = coverageGaps(review, changes);
	const source = review.source;
	if (gaps.length === 0 || !source.reviewSessionId || !source.reviewCwd) {
		return parsed;
	}

	const files = new Set(gaps.map((g) => g.file)).size;
	options.onProgress({ kind: 'status', message: `Covering ${gaps.length} change(s) the review missed, in ${files} file(s)…` });
	const coverageFile = path.join(reviewDir(repo.gitDir), 'coverage.md');
	writeFileSync(coverageFile, renderCoverage(review, gaps, changes));
	try {
		const agent = runAgent({
			claudePath: options.claudePath,
			cwd: source.reviewCwd,
			repoRoot: repo.root,
			prompt: buildCoveragePrompt(coverageFile),
			model: options.model,
			resumeSessionId: source.reviewSessionId,
			schema: UPDATE_SCHEMA,
			onProgress: options.onProgress
		});
		options.onStart?.(agent);
		const result = await agent.result;

		options.onProgress({ kind: 'status', message: 'Merging the new sections…' });
		// Invalid entries are skipped; the lines they were meant to cover stay listed as uncovered.
		const merged = await mergeUpdate(review, result.output, new Set(), { head: repo.head, source, lineCount: lineCounter(repo) });
		merged.review.updatedAt = review.updatedAt;
		merged.review.source = {
			...source,
			reviewSessionId: result.sessionId ?? source.reviewSessionId,
			model: result.model ?? source.model,
			costUsd: (source.costUsd ?? 0) + (result.costUsd ?? 0)
		};
		warnings.push(...merged.errors, ...merged.warnings, ...snapSections(merged.review, changes.diffs));
		const left = coverageGaps(merged.review, changes).length;
		if (left > 0) {
			warnings.push(`${left} change(s) still have no section; they are listed under "Not covered by the review".`);
		}
		return { review: merged.review, warnings };
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		return { review, warnings: [...warnings, `Covering the changes without a section failed (${reason}); the review is saved without them.`] };
	}
}

/**
 * Updates the review for the edits made since it was written, continuing the review agent's session when
 * possible. Only sections the edits touch, and edited code no section covers, go to the agent; the other
 * sections keep their text and move with the edits.
 */
async function updateReview(repo: Workspace, changes: ChangeSet, previous: Review, files: UpdatedFile[], options: GenerateOptions): Promise<GenerateResult> {
	if (files.length === 0) {
		options.onProgress({ kind: 'status', message: 'The review is up to date.' });
		return { review: previous, warnings: [], upToDate: true };
	}

	const plan = await planUpdate(repo, previous, files, changes);
	if (!needsAgent(plan)) {
		options.onProgress({ kind: 'status', message: 'The edits touch no reviewed code; moving the sections along with them.' });
		return finishUpdate(repo, changes, plan, { categories: [] }, previous.source);
	}
	const updateFile = path.join(reviewDir(repo.gitDir), 'update.md');
	writeFileSync(updateFile, renderUpdate(plan, changes));
	const scope = [
		plan.affected.size > 0 ? `${plan.affected.size} section(s)` : '',
		plan.uncovered.length > 0 ? `${plan.uncovered.length} new edit(s)` : '',
		plan.wholeFiles.size > 0 ? `${plan.wholeFiles.size} whole file(s)` : ''
	]
		.filter(Boolean)
		.join(', ');

	const guidance = await loadGuidance(repo.root, files.map((f) => f.path));
	const run = async (resume: boolean) => {
		const cwd = resume ? previous.source.reviewCwd! : repo.root;
		const mode: UpdateMode = resume ? { kind: 'resumed' } : { kind: 'fresh' };
		options.onProgress({
			kind: 'status',
			message: `${resume ? 'Resuming the review session' : 'Starting a new review agent'} to review ${scope}…`
		});
		const agent = runAgent({
			claudePath: options.claudePath,
			cwd,
			repoRoot: repo.root,
			prompt: savePrompt(repo, buildUpdatePrompt(repo.root, changes, reviewPath(repo.gitDir), updateFile, mode, guidance)),
			model: options.model,
			resumeSessionId: resume ? previous.source.reviewSessionId : undefined,
			schema: UPDATE_SCHEMA,
			onProgress: options.onProgress
		});
		options.onStart?.(agent);
		return { result: await agent.result, cwd };
	};

	const canResume = !!previous.source.reviewSessionId && !!previous.source.reviewCwd && existsSync(previous.source.reviewCwd);
	let outcome: Awaited<ReturnType<typeof run>>;
	try {
		outcome = await run(canResume);
	} catch (e) {
		// The review session may have been deleted; a new agent can still update from the review file.
		if (!canResume || !/No conversation found/i.test(e instanceof Error ? e.message : String(e))) {
			throw e;
		}
		outcome = await run(false);
	}

	options.onProgress({ kind: 'status', message: 'Merging the update…' });
	const { result, cwd } = outcome;
	return finishUpdate(repo, changes, plan, result.output, {
		...previous.source,
		reviewSessionId: result.sessionId ?? previous.source.reviewSessionId,
		reviewCwd: cwd,
		model: result.model ?? options.model ?? previous.source.model,
		costUsd: (previous.source.costUsd ?? 0) + (result.costUsd ?? 0)
	});
}
