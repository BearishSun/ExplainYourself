import { existsSync, writeFileSync } from 'fs';
import * as path from 'path';
import { AgentProgress, AgentRun, runAgent } from './agent';
import { buildChangeSet, ChangeSet } from './changes';
import { git } from './exec';
import { buildPrompt, buildUpdatePrompt, UpdatedFile, UpdateMode } from './prompt';
import { computeFingerprints, countFileLines, saveSnapshots, loadReview, mergeUpdate, normalizeReview, Review, reviewDir, reviewPath, saveReview, UPDATE_SCHEMA } from './review';
import { loadGuidance } from './guidance';
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

/** Records what the review covers (change set, file fingerprints and snapshots) and saves it. */
async function saveWithSnapshot(repo: Workspace, changes: ChangeSet, review: Review): Promise<void> {
	review.files = changes.files.map((f) => f.path);
	review.submodules = repo.selectedSubmodules.length > 0 ? repo.selectedSubmodules : undefined;
	review.submoduleHeads = repo.selectedSubmodules.length > 0 ? repo.submoduleHeads() : undefined;
	const sectionFiles = review.categories.flatMap((c) => c.sections.map((s) => s.file));
	review.fingerprints = await computeFingerprints(repo.root, [...review.files, ...sectionFiles]);
	await saveSnapshots(repo.gitDir, repo.root, sectionFiles, review.fingerprints);
	await saveReview(repo.gitDir, review);
}

/** Turns raw agent output into a saved review. Throws when the output is unusable. */
export async function finishReview(repo: Workspace, changes: ChangeSet, raw: unknown, source: Review['source']): Promise<GenerateResult> {
	const { review, errors, warnings } = await normalizeReview(raw, { head: repo.head, source, lineCount: lineCounter(repo) });
	if (errors.length > 0) {
		throw new Error(`The review is invalid:\n${errors.join('\n')}`);
	}
	await saveWithSnapshot(repo, changes, review);
	return { review, warnings };
}

/** Merges raw update output into the previous review and saves it. Throws when the output is unusable. */
export async function finishUpdate(repo: Workspace, changes: ChangeSet, previous: Review, raw: unknown, files: UpdatedFile[], source: Review['source']): Promise<GenerateResult> {
	const changed = new Set(files.map((f) => f.path));
	const { review, errors, warnings } = await mergeUpdate(previous, raw, changed, { head: repo.head, source, lineCount: lineCounter(repo) });
	if (errors.length > 0) {
		throw new Error(`The review update is invalid:\n${errors.join('\n')}`);
	}
	review.source = source;
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
			result.push({ path: file, reason: 'modified' });
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
		candidates = await findSessions(repo.root, changes.files.map((f) => f.path), options.sessionMaxAgeDays);
		if (options.source.kind !== 'fresh' && candidates[0]?.cwd && existsSync(candidates[0].cwd)) {
			session = candidates[0];
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
	return finishReview(repo, changes, result.output, {
		kind: session ? 'session' : 'fresh',
		sessionId: session?.sessionId,
		reviewSessionId: result.sessionId,
		reviewCwd: cwd,
		model: result.model ?? options.model,
		costUsd: result.costUsd
	});
}

/** Re-reviews only the files that changed since the review, continuing the review agent's session when possible. */
async function updateReview(repo: Workspace, changes: ChangeSet, previous: Review, files: UpdatedFile[], options: GenerateOptions): Promise<GenerateResult> {
	if (files.length === 0) {
		options.onProgress({ kind: 'status', message: 'The review is up to date.' });
		return { review: previous, warnings: [], upToDate: true };
	}

	const guidance = await loadGuidance(repo.root, files.map((f) => f.path));
	const run = async (resume: boolean) => {
		const cwd = resume ? previous.source.reviewCwd! : repo.root;
		const mode: UpdateMode = resume ? { kind: 'resumed' } : { kind: 'fresh' };
		options.onProgress({
			kind: 'status',
			message: `${resume ? 'Resuming the review session' : 'Starting a new review agent'} to re-review ${files.length} file(s)…`
		});
		const agent = runAgent({
			claudePath: options.claudePath,
			cwd,
			repoRoot: repo.root,
			prompt: savePrompt(repo, buildUpdatePrompt(repo.root, changes, reviewPath(repo.gitDir), files, mode, guidance)),
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
	return finishUpdate(repo, changes, previous, result.output, files, {
		...previous.source,
		reviewSessionId: result.sessionId ?? previous.source.reviewSessionId,
		reviewCwd: cwd,
		model: result.model ?? options.model ?? previous.source.model,
		costUsd: (previous.source.costUsd ?? 0) + (result.costUsd ?? 0)
	});
}
