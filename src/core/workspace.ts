import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import { DiffLine, FileDiff } from './diff';
import { gitText } from './exec';
import { ChangeListener, Repository } from './repository';
import { reviewDir } from './review';
import { isStaged, isUnstaged, StatusEntry } from './status';

/** A submodule of the workspace root, at any depth. */
export interface Submodule {
	/** Path relative to the workspace root, with forward slashes. */
	path: string;
	/** False when the submodule has no working tree (`git submodule update --init` was never run). */
	initialized: boolean;
}

/** One repository of the workspace. Paths inside it are its paths with `prefix` in front. */
export interface WorkspacePart {
	/** '' for the root repository, otherwise the submodule path followed by '/'. */
	prefix: string;
	repo: Repository;
}

type Selection = (diff: FileDiff) => Set<DiffLine>;

const MAX_UNDO = 200;

/** Lists the submodules below `root`, recursively. Paths are relative to the outermost root. */
export async function listSubmodules(root: string, prefix = ''): Promise<Submodule[]> {
	if (!existsSync(path.join(root, '.gitmodules'))) {
		return [];
	}
	let out: string;
	try {
		out = await gitText(root, ['config', '--file', '.gitmodules', '-z', '--get-regexp', '^submodule\\..*\\.path$'], { readOnly: true });
	} catch {
		// Exit code 1: no submodule paths.
		return [];
	}
	const result: Submodule[] = [];
	for (const record of out.split('\0')) {
		const value = record.substring(record.indexOf('\n') + 1).trim();
		if (!record.includes('\n') || !value) {
			continue;
		}
		const abs = path.join(root, value);
		const initialized = existsSync(path.join(abs, '.git'));
		const full = prefix + value.split(path.sep).join('/');
		result.push({ path: full, initialized });
		if (initialized) {
			result.push(...(await listSubmodules(abs, full + '/')));
		}
	}
	return result;
}

function settingsPath(gitDir: string): string {
	return path.join(reviewDir(gitDir), 'settings.json');
}

/** Submodules chosen for review, remembered per repository. Null when no choice was saved yet. */
export async function loadSubmoduleSelection(gitDir: string): Promise<string[] | null> {
	try {
		const data = JSON.parse(await fs.readFile(settingsPath(gitDir), 'utf8'));
		return Array.isArray(data.submodules) ? data.submodules.filter((s: unknown) => typeof s === 'string') : null;
	} catch {
		return null;
	}
}

export async function saveSubmoduleSelection(gitDir: string, submodules: string[]): Promise<void> {
	await fs.mkdir(reviewDir(gitDir), { recursive: true });
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(await fs.readFile(settingsPath(gitDir), 'utf8'));
	} catch {
		// First save.
	}
	data.submodules = submodules;
	await fs.writeFile(settingsPath(gitDir), JSON.stringify(data, null, '\t'));
}

export function prefixDiff(diff: FileDiff, prefix: string): FileDiff {
	if (!prefix) {
		return diff;
	}
	// The hunks stay shared, so line selections made on the copy apply to the original.
	return {
		...diff,
		path: prefix + diff.path,
		oldPath: diff.oldPath === null ? null : prefix + diff.oldPath,
		newPath: diff.newPath === null ? null : prefix + diff.newPath
	};
}

function prefixEntry(entry: StatusEntry, prefix: string): StatusEntry {
	return prefix ? { ...entry, path: prefix + entry.path, origPath: entry.origPath && prefix + entry.origPath } : entry;
}

/**
 * The root repository plus the submodules selected for review, seen as one repository. Paths are relative
 * to the root; each operation goes to the repository that owns the path. A step that touches several
 * repositories undoes as one.
 */
export class Workspace {
	status: StatusEntry[] = [];
	/** Index -> working tree diffs keyed by root-relative path. */
	unstaged = new Map<string, FileDiff>();
	/** HEAD -> index diffs keyed by root-relative new path. */
	staged = new Map<string, FileDiff>();

	private subs: (WorkspacePart & { path: string; listener: { dispose(): void } })[] = [];
	private readonly listeners = new Set<ChangeListener>();
	private undoStack: { label: string; repos: Repository[] }[] = [];
	private redoStack: { label: string; repos: Repository[] }[] = [];
	private algorithm = 'histogram';
	private readonly mainPart: WorkspacePart;

	private constructor(
		readonly main: Repository,
		/** All submodules of the root, selected or not. */
		readonly submodules: Submodule[]
	) {
		this.mainPart = { prefix: '', repo: main };
		main.onDidChange((paths) => this.onPartChange('', paths));
	}

	/** Opens the repository containing `dir`. Submodules join with setSubmodules(). */
	static async open(dir: string): Promise<Workspace> {
		const main = await Repository.open(dir);
		return new Workspace(main, await listSubmodules(main.root));
	}

	get root(): string {
		return this.main.root;
	}

	get gitDir(): string {
		return this.main.gitDir;
	}

	get head(): string | null {
		return this.main.head;
	}

	get branch(): string | null {
		return this.main.branch;
	}

	get emptyTree(): string {
		return this.main.emptyTree;
	}

	get diffAlgorithm(): string {
		return this.algorithm;
	}

	set diffAlgorithm(value: string) {
		this.algorithm = value;
		this.parts().forEach((p) => (p.repo.diffAlgorithm = value));
	}

	get cacheStats(): { hits: number; misses: number } {
		return this.parts().reduce((sum, p) => ({ hits: sum.hits + p.repo.cacheStats.hits, misses: sum.misses + p.repo.cacheStats.misses }), { hits: 0, misses: 0 });
	}

	/** Paths of the submodules included in the workspace. */
	get selectedSubmodules(): string[] {
		return this.subs.map((s) => s.path);
	}

	/** The root repository first, then the selected submodules. */
	parts(): WorkspacePart[] {
		return [this.mainPart, ...this.subs];
	}

	/** HEAD commit of each selected submodule. */
	submoduleHeads(): Record<string, string | null> {
		return Object.fromEntries(this.subs.map((s) => [s.path, s.repo.head]));
	}

	/** Whether a submodule has changes in its parent: a new commit, modified or untracked files. */
	submoduleChanged(subPath: string): boolean {
		const { part, rel } = this.ownerOf(subPath);
		return part.repo.status.some((e) => e.path === rel && !!e.submodule);
	}

	/** Selects the submodules to include. Callers refresh afterwards. Unknown or uninitialized paths are skipped. */
	async setSubmodules(paths: string[]): Promise<void> {
		const wanted = new Set(paths.filter((p) => this.submodules.some((s) => s.path === p && s.initialized)));
		const removed = this.subs.filter((s) => !wanted.has(s.path));
		removed.forEach((s) => s.listener.dispose());
		this.subs = this.subs.filter((s) => wanted.has(s.path));

		for (const p of wanted) {
			if (this.subs.some((s) => s.path === p)) {
				continue;
			}
			const repo = await Repository.open(this.main.absPath(p));
			repo.diffAlgorithm = this.algorithm;
			const prefix = p + '/';
			this.subs.push({ path: p, prefix, repo, listener: repo.onDidChange((changed) => this.onPartChange(prefix, changed)) });
		}
		// Longest prefix first, so nested submodules own their paths.
		this.subs.sort((a, b) => b.prefix.length - a.prefix.length || a.path.localeCompare(b.path));

		// Undo steps can no longer reach repositories that left the workspace.
		const gone = new Set(removed.map((s) => s.repo));
		const prune = (stack: { label: string; repos: Repository[] }[]) =>
			stack.map((g) => ({ ...g, repos: g.repos.filter((r) => !gone.has(r)) })).filter((g) => g.repos.length > 0);
		this.undoStack = prune(this.undoStack);
		this.redoStack = prune(this.redoStack);
		this.rebuild();
		this.emit('all');
	}

	onDidChange(listener: ChangeListener): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	private emit(paths: string[] | 'all'): void {
		for (const l of this.listeners) {
			l(paths);
		}
	}

	/** The repository that owns a root-relative path, and the path within it. */
	ownerOf(rel: string): { part: WorkspacePart; rel: string } {
		const sub = this.subs.find((s) => rel.startsWith(s.prefix));
		return sub ? { part: sub, rel: rel.substring(sub.prefix.length) } : { part: this.mainPart, rel };
	}

	/**
	 * Submodule entries of selected submodules whose commit did not change. Their only change is the
	 * content of the submodule, which the workspace shows file by file instead.
	 */
	private hiddenPaths(): Set<string> {
		const hidden = new Set<string>();
		for (const s of this.subs) {
			const { part, rel } = this.ownerOf(s.path);
			const entry = part.repo.status.find((e) => e.path === rel);
			if (entry?.submodule && !entry.submodule.commitChanged) {
				hidden.add(s.path);
			}
		}
		return hidden;
	}

	private rebuild(): void {
		const hidden = this.hiddenPaths();
		const parts = this.parts();
		this.status = parts.flatMap((p) => p.repo.status.map((e) => prefixEntry(e, p.prefix))).filter((e) => !hidden.has(e.path));
		const merge = (pick: (r: Repository) => Map<string, FileDiff>) =>
			new Map(parts.flatMap((p) => [...pick(p.repo).values()].map((d) => prefixDiff(d, p.prefix))).filter((d) => !hidden.has(d.path)).map((d) => [d.path, d]));
		this.unstaged = merge((r) => r.unstaged);
		this.staged = merge((r) => r.staged);
	}

	private onPartChange(prefix: string, paths: string[] | 'all'): void {
		if (paths === 'all') {
			this.rebuild();
			this.emit('all');
			return;
		}
		// Path-level changes leave the status alone; update just those diffs.
		const part = this.parts().find((p) => p.prefix === prefix);
		if (!part) {
			return;
		}
		const hidden = this.hiddenPaths();
		const keys = paths.map((p) => prefix + p);
		paths.forEach((p, i) => {
			const key = keys[i];
			for (const [own, merged] of [
				[part.repo.unstaged, this.unstaged],
				[part.repo.staged, this.staged]
			] as const) {
				const d = own.get(p);
				if (d && !hidden.has(key)) {
					merged.set(key, prefixDiff(d, prefix));
				} else {
					merged.delete(key);
				}
			}
		});
		this.emit(keys);
	}

	get stagedEntries(): StatusEntry[] {
		return this.status.filter(isStaged);
	}

	get unstagedEntries(): StatusEntry[] {
		return this.status.filter(isUnstaged);
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	absPath(rel: string): string {
		return this.main.absPath(rel);
	}

	relPath(abs: string): string | null {
		return this.main.relPath(abs);
	}

	async refresh(): Promise<void> {
		await Promise.all(this.parts().map((p) => p.repo.refresh()));
	}

	async refreshPaths(paths: string[], which: 'both' | 'unstaged' | 'staged' = 'both'): Promise<void> {
		await Promise.all([...this.group(paths)].map(([part, rels]) => part.repo.refreshPaths(rels, which)));
	}

	readIndex(rel: string): Promise<Buffer> {
		const { part, rel: own } = this.ownerOf(rel);
		return part.repo.readIndex(own);
	}

	readHead(rel: string): Promise<Buffer> {
		const { part, rel: own } = this.ownerOf(rel);
		return part.repo.readHead(own);
	}

	/** Groups root-relative paths by owning repository. */
	private group(paths: string[]): Map<WorkspacePart, string[]> {
		const result = new Map<WorkspacePart, string[]>();
		for (const p of paths) {
			const { part, rel } = this.ownerOf(p);
			result.set(part, [...(result.get(part) ?? []), rel]);
		}
		return result;
	}

	private pushUndo(label: string, repos: Repository[]): void {
		if (repos.length === 0) {
			return;
		}
		this.undoStack.push({ label, repos });
		if (this.undoStack.length > MAX_UNDO) {
			this.undoStack.shift();
		}
		this.redoStack = [];
	}

	stageLines(rel: string, select: Selection, label = 'Stage lines'): Promise<boolean> {
		return this.stageSelections([{ rel, select }], label);
	}

	/** Stages line selections in several files, possibly in several repositories, as one undoable step. */
	async stageSelections(items: { rel: string; select: Selection }[], label = 'Stage lines'): Promise<boolean> {
		const byPart = new Map<WorkspacePart, { rel: string; select: Selection }[]>();
		const selectOf = new Map<string, Selection>(items.map((i) => [i.rel, i.select]));
		for (const [part, rels] of this.group(items.map((i) => i.rel))) {
			byPart.set(
				part,
				rels.map((rel) => {
					const select = selectOf.get(part.prefix + rel)!;
					return { rel, select: (d: FileDiff) => select(prefixDiff(d, part.prefix)) };
				})
			);
		}
		const touched: Repository[] = [];
		for (const [part, list] of byPart) {
			if (await part.repo.stageSelections(list, label)) {
				touched.push(part.repo);
			}
		}
		this.pushUndo(label, touched);
		return touched.length > 0;
	}

	async unstageLines(rel: string, select: Selection, label = 'Unstage lines'): Promise<boolean> {
		const { part, rel: own } = this.ownerOf(rel);
		const done = await part.repo.unstageLines(own, (d) => select(prefixDiff(d, part.prefix)), label);
		if (done) {
			this.pushUndo(label, [part.repo]);
		}
		return done;
	}

	async stageFiles(paths: string[], label = 'Stage files'): Promise<void> {
		const touched: Repository[] = [];
		for (const [part, rels] of this.group(paths)) {
			await part.repo.stageFiles(rels, label);
			touched.push(part.repo);
		}
		this.pushUndo(label, touched);
	}

	async unstageFiles(paths: string[], label = 'Unstage files'): Promise<void> {
		const touched: Repository[] = [];
		for (const [part, rels] of this.group(paths)) {
			await part.repo.unstageFiles(rels, label);
			touched.push(part.repo);
		}
		this.pushUndo(label, touched);
	}

	/** Reverts the last step in every repository it touched. Returns its label, or null when there is nothing to undo. */
	async undo(): Promise<string | null> {
		const step = this.undoStack.pop();
		if (!step) {
			return null;
		}
		this.redoStack.push(step);
		for (const repo of [...step.repos].reverse()) {
			await repo.undo();
		}
		return step.label;
	}

	async redo(): Promise<string | null> {
		const step = this.redoStack.pop();
		if (!step) {
			return null;
		}
		this.undoStack.push(step);
		for (const repo of step.repos) {
			await repo.redo();
		}
		return step.label;
	}
}
