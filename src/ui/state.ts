import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentProgress, AgentRun } from '../core/agent';
import { LineMap } from '../core/anchors';
import { loadFullDiff } from '../core/changes';
import { deriveOldRange, findUncovered, sectionStatus, SectionStatus, UncoveredChange } from '../core/coverage';
import { FileDiff, LineRange } from '../core/diff';
import { generateReview, GenerateSource } from '../core/generate';
import { migrateRepositoryData } from '../core/legacy';
import { adoptSnapshot, computeFingerprints, DELETED, loadReview, Review, ReviewCategory, ReviewSection, reviewDir, SectionNote } from '../core/review';
import { loadSubmoduleSelection, saveSubmoduleSelection, Workspace } from '../core/workspace';
import { config, log } from './util';

export interface GenerationState {
	log: AgentProgress[];
	run?: AgentRun;
	error?: string;
	done: boolean;
}

/** Shared state: the active repository, its review, and derived review status. */
export class AppState implements vscode.Disposable {
	repo?: Workspace;
	review?: Review;
	fullDiffs = new Map<string, FileDiff>();
	uncovered: UncoveredChange[] = [];
	/** Files changed on disk since the review was generated, outside of tracked editor edits. */
	staleFiles = new Set<string>();
	generation?: GenerationState;

	/** Section ranges and note lines moved along with edits made since the review was written. */
	private readonly newRanges = new Map<string, LineRange | undefined>();
	private readonly noteLines = new Map<string, number[]>();
	/** Reviewed version of each section file; positions in the review refer to it. */
	private readonly snapshots = new Map<string, string>();
	private readonly relocateTimers = new Map<string, NodeJS.Timeout>();
	private readonly trackedFingerprints = new Map<string, string>();
	private readonly disposables: vscode.Disposable[] = [];
	private repoDisposables: vscode.Disposable[] = [];
	private refreshTimer?: NodeJS.Timeout;
	private reviewTimer?: NodeJS.Timeout;
	private derivedTimer?: NodeJS.Timeout;

	private readonly repoEmitter = new vscode.EventEmitter<string[] | 'all'>();
	/** Fires when repository status or diffs change. */
	readonly onDidChangeRepo = this.repoEmitter.event;
	private readonly reviewEmitter = new vscode.EventEmitter<void>();
	/** Fires when the review, its tracked ranges or its derived status change. */
	readonly onDidChangeReview = this.reviewEmitter.event;
	private readonly generationEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeGeneration = this.generationEmitter.event;

	constructor() {
		this.disposables.push(vscode.workspace.onDidChangeTextDocument((e) => e.contentChanges.length > 0 && this.scheduleRelocate(e.document)));
		// Closing a document with unsaved edits returns it to the content on disk.
		this.disposables.push(vscode.workspace.onDidCloseTextDocument((d) => this.scheduleRelocate(d)));
		this.disposables.push(vscode.workspace.onDidSaveTextDocument((d) => this.trackSave(d)));
	}

	dispose(): void {
		this.repoDisposables.forEach((d) => d.dispose());
		this.disposables.forEach((d) => d.dispose());
		this.repoEmitter.dispose();
		this.reviewEmitter.dispose();
		this.generationEmitter.dispose();
	}

	async openRepository(dir: string): Promise<void> {
		const repo = await Workspace.open(dir);
		await migrateRepositoryData(repo.gitDir);
		repo.diffAlgorithm = config().get<string>('diffAlgorithm', 'histogram');
		// Submodules chosen earlier, or the ones the last review covered.
		const selection = (await loadSubmoduleSelection(repo.gitDir)) ?? (await loadReview(repo.gitDir))?.submodules ?? [];
		await repo.setSubmodules(selection).catch((e) => log(`Could not open submodules: ${e}`));
		this.repoDisposables.forEach((d) => d.dispose());
		this.repoDisposables = [];
		this.repo = repo;
		this.review = undefined;
		this.newRanges.clear();
		this.noteLines.clear();
		this.snapshots.clear();

		this.repoDisposables.push(repo.onDidChange((paths) => this.repoEmitter.fire(paths)));
		this.repoDisposables.push(repo.onDidChange(() => this.scheduleDerived()));

		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(repo.root), '**'));
		const onFs = (uri: vscode.Uri) => {
			const p = uri.fsPath;
			if (p.includes(`${path.sep}.git${path.sep}`) && !/[\\/](index|HEAD|refs[\\/].*)$/.test(p)) {
				return;
			}
			this.scheduleRefresh();
		};
		watcher.onDidChange(onFs);
		watcher.onDidCreate(onFs);
		watcher.onDidDelete(onFs);
		this.repoDisposables.push(watcher);

		// Linked worktrees keep their git dir outside the working tree.
		if (!repo.gitDir.startsWith(repo.root + path.sep)) {
			const gitWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(repo.gitDir), '{index,HEAD}'));
			gitWatcher.onDidChange(() => this.scheduleRefresh());
			gitWatcher.onDidCreate(() => this.scheduleRefresh());
			this.repoDisposables.push(gitWatcher);
		}

		const reviewWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(reviewDir(repo.gitDir)), 'review.json'));
		const onReview = () => this.scheduleReviewReload();
		reviewWatcher.onDidChange(onReview);
		reviewWatcher.onDidCreate(onReview);
		reviewWatcher.onDidDelete(onReview);
		this.repoDisposables.push(reviewWatcher);

		await repo.refresh();
		await this.reloadReview();
		this.repoEmitter.fire('all');
	}

	/** Includes the given submodules in the workspace and remembers the choice. */
	async setSubmodules(paths: string[]): Promise<void> {
		const repo = this.repo;
		if (!repo) {
			return;
		}
		await repo.setSubmodules(paths);
		await saveSubmoduleSelection(repo.gitDir, repo.selectedSubmodules);
		await repo.refresh();
		await this.updateDerived();
	}

	scheduleRefresh(): void {
		clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => {
			this.repo?.refresh().catch((e) => log(`Refresh failed: ${e}`));
		}, 120);
	}

	private scheduleReviewReload(): void {
		clearTimeout(this.reviewTimer);
		this.reviewTimer = setTimeout(() => this.reloadReview().catch((e) => log(`Review reload failed: ${e}`)), 200);
	}

	private scheduleDerived(): void {
		clearTimeout(this.derivedTimer);
		this.derivedTimer = setTimeout(() => this.updateDerived().catch((e) => log(`Review status update failed: ${e}`)), 150);
	}

	async reloadReview(): Promise<void> {
		if (!this.repo) {
			return;
		}
		const repo = this.repo;
		const review = (await loadReview(repo.gitDir)) ?? undefined;
		const snapshots = new Map<string, string>();
		for (const file of new Set(review?.categories.flatMap((c) => c.sections.map((s) => s.file)))) {
			const fp = review!.fingerprints[file];
			const content = fp && fp !== DELETED ? await adoptSnapshot(repo.gitDir, repo.root, file, fp) : null;
			if (content !== null) {
				snapshots.set(file, content);
			}
		}
		this.review = review;
		this.newRanges.clear();
		this.noteLines.clear();
		this.snapshots.clear();
		snapshots.forEach((content, file) => this.snapshots.set(file, content));
		this.trackedFingerprints.clear();
		await this.relocate(new Set(snapshots.keys()));
		await this.updateDerived();
	}

	/** Text of a working tree file as the user sees it: the open document, or the file on disk. */
	private async currentText(file: string): Promise<string | null> {
		const abs = this.repo!.absPath(file);
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && path.normalize(d.uri.fsPath).toLowerCase() === path.normalize(abs).toLowerCase());
		if (doc && !doc.isClosed) {
			return doc.getText();
		}
		try {
			return await fs.readFile(abs, 'utf8');
		} catch {
			return null;
		}
	}

	/**
	 * Moves section ranges and note lines of `files` to where their code is now, by diffing the reviewed
	 * version of each file against its current text. Returns true when a position changed.
	 */
	private async relocate(files: Iterable<string>): Promise<boolean> {
		const review = this.review;
		let changed = false;
		for (const file of files) {
			const snapshot = this.snapshots.get(file);
			const current = snapshot === undefined ? null : await this.currentText(file);
			if (this.review !== review) {
				return false;
			}
			const map = snapshot !== undefined && current !== null && current !== snapshot ? LineMap.build(snapshot, current) : null;
			for (const { section } of this.sectionsForFile(file)) {
				const range = section.newRange && (map ? map.range(section.newRange) : { ...section.newRange });
				const notes = (section.notes ?? []).map((n) => (map ? map.line(n.line) : n.line));
				if (JSON.stringify(range) !== JSON.stringify(this.newRange(section)) || JSON.stringify(notes) !== JSON.stringify(this.noteLines.get(section.id) ?? notes)) {
					changed = true;
				}
				this.newRanges.set(section.id, range);
				this.noteLines.set(section.id, notes);
			}
		}
		return changed;
	}

	private scheduleRelocate(doc: vscode.TextDocument): void {
		const rel = this.repo && this.review && doc.uri.scheme === 'file' ? this.repo.relPath(doc.uri.fsPath) : undefined;
		if (!rel || !this.snapshots.has(rel)) {
			return;
		}
		clearTimeout(this.relocateTimers.get(rel));
		this.relocateTimers.set(
			rel,
			setTimeout(() => {
				this.relocateTimers.delete(rel);
				this.relocate([rel])
					.then((changed) => changed && this.reviewEmitter.fire())
					.catch((e) => log(`Could not move review positions in ${rel}: ${e}`));
			}, 60)
		);
	}

	/** Recomputes coverage and staleness. Runs after repository and review changes. */
	private async updateDerived(): Promise<void> {
		const repo = this.repo;
		const review = this.review;
		if (!repo || !review) {
			this.fullDiffs.clear();
			this.uncovered = [];
			this.staleFiles.clear();
			this.reviewEmitter.fire();
			return;
		}

		await this.relocate([...this.snapshots.keys()]);
		this.fullDiffs = await loadFullDiff(repo);
		this.uncovered = findUncovered(review, this.fullDiffs, (s) => this.newRange(s));

		const current = await computeFingerprints(repo.root, Object.keys(review.fingerprints));
		this.staleFiles.clear();
		for (const [file, fp] of Object.entries(review.fingerprints)) {
			const expected = this.trackedFingerprints.get(file) ?? fp;
			if (current[file] !== expected) {
				this.staleFiles.add(file);
			}
		}
		this.reviewEmitter.fire();
	}

	/** Current working tree range of a section, moved along with edits made since the review was written. */
	newRange(section: ReviewSection): LineRange | undefined {
		return this.newRanges.has(section.id) ? this.newRanges.get(section.id) : section.newRange;
	}

	/** Changes no section covers, as sections that hold one change each, so they can be staged like sections. */
	uncoveredSections(): ReviewSection[] {
		return this.uncovered.map((u, i) => ({ id: `uncovered${i}`, file: u.file, title: `${u.file}:${u.line}`, summary: '', newRange: u.newRange, oldRange: u.oldRange }));
	}

	/** Notes of a section, at their current lines. */
	notes(section: ReviewSection): SectionNote[] {
		const lines = this.noteLines.get(section.id);
		return (section.notes ?? []).map((n, i) => ({ text: n.text, line: lines?.[i] ?? n.line }));
	}

	/** HEAD path of a section's file (differs from the section's path after a rename), or null for new files. */
	headPath(section: ReviewSection): string | null {
		const diff = this.fullDiffs.get(section.file);
		return diff ? diff.oldPath : section.file;
	}

	/** HEAD lines to show next to a section in the old/new comparison: given by the review, or derived. */
	compareOldRange(section: ReviewSection): LineRange | undefined {
		if (section.oldRange) {
			return section.oldRange;
		}
		const newRange = this.newRange(section);
		const diff = this.fullDiffs.get(section.file);
		if (!newRange || !diff || diff.oldPath === null) {
			return undefined;
		}
		return deriveOldRange(diff.hunks, newRange);
	}

	/** Sections the agent tagged as rewritten, when an old version exists to compare with. */
	isRewrite(section: ReviewSection): boolean {
		return section.layout === 'rewrite' && !!this.newRange(section) && !!this.compareOldRange(section) && this.headPath(section) !== null;
	}

	/** The other sections of a section's group, in review order. */
	relatedSections(section: ReviewSection): ReviewSection[] {
		if (!section.group) {
			return [];
		}
		return (this.review?.categories ?? []).flatMap((c) => c.sections).filter((s) => s.group === section.group && s.id !== section.id);
	}

	sectionStatus(section: ReviewSection): SectionStatus {
		if (!this.repo) {
			return 'pending';
		}
		return sectionStatus(this.repo, section, this.newRange(section), new Set(this.fullDiffs.keys()));
	}

	sectionsForFile(file: string): { category: ReviewCategory; section: ReviewSection }[] {
		const result: { category: ReviewCategory; section: ReviewSection }[] = [];
		for (const category of this.review?.categories ?? []) {
			for (const section of category.sections) {
				if (section.file === file) {
					result.push({ category, section });
				}
			}
		}
		return result;
	}

	findSection(id: string): { category: ReviewCategory; section: ReviewSection } | undefined {
		for (const category of this.review?.categories ?? []) {
			const section = category.sections.find((s) => s.id === id);
			if (section) {
				return { category, section };
			}
		}
		return undefined;
	}

	private async trackSave(doc: vscode.TextDocument): Promise<void> {
		if (!this.repo || !this.review || doc.uri.scheme !== 'file') {
			return;
		}
		const rel = this.repo.relPath(doc.uri.fsPath);
		if (!rel || !(rel in this.review.fingerprints)) {
			return;
		}
		// Saved edits were tracked range by range, so they do not make the review stale.
		const fp = await computeFingerprints(this.repo.root, [rel]);
		if (fp[rel]) {
			this.trackedFingerprints.set(rel, fp[rel]);
		}
	}

	/** Generates or updates the review. Returns true when an update found nothing to re-review. */
	async generate(source: GenerateSource, claudePath: string): Promise<boolean> {
		const repo = this.repo;
		if (!repo || (this.generation && !this.generation.done)) {
			return false;
		}
		let upToDate = false;

		const state: GenerationState = { log: [], done: false };
		this.generation = state;
		this.generationEmitter.fire();
		try {
			const model = config().get<string>('model', 'claude-sonnet-5-5') || undefined;
			const result = await generateReview(repo, {
				claudePath,
				model,
				source,
				sessionMaxAgeDays: config().get<number>('sessionSearchDays', 14),
				onProgress: (p) => {
					state.log.push(p);
					this.generationEmitter.fire();
				},
				onStart: (run) => (state.run = run)
			});
			upToDate = !!result.upToDate;
			result.warnings.forEach((w) => state.log.push({ kind: 'status', message: `Warning: ${w}` }));
			await this.reloadReview();
		} catch (e) {
			state.error = e instanceof Error ? e.message : String(e);
			log(`Review generation failed: ${state.error}`);
		} finally {
			state.done = true;
			state.run = undefined;
			this.generationEmitter.fire();
		}
		return upToDate;
	}

	cancelGeneration(): void {
		this.generation?.run?.cancel();
	}
}
