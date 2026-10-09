import { promises as fs } from 'fs';
import * as path from 'path';
import { DiffLine, FileDiff, isNullSha, parseDiff } from './diff';
import { git, gitText } from './exec';
import { writeLooseBlob } from './objects';
import { applyForward, applyReverse, remainingHunks } from './stager';
import { isStaged, isUnstaged, parseStatus, StatusEntry } from './status';

/** State of one path in the index. A mode of '0' means the path is absent. */
export interface IndexEntry {
	path: string;
	mode: string;
	sha: string;
}

/** Diffs shown for some paths at one point in time, so undo and redo can show them without asking git. */
interface DiffSnapshot {
	unstaged: Map<string, FileDiff | undefined>;
	staged: Map<string, FileDiff | undefined>;
	/** Working tree stamps; the snapshot is only valid while they match. */
	stamps: Map<string, string>;
}

interface UndoOp {
	label: string;
	before: IndexEntry[];
	after: IndexEntry[];
	views?: { before: DiffSnapshot; after?: DiffSnapshot };
}

export type ChangeListener = (paths: string[] | 'all') => void;

const MAX_UNDO = 200;
const GITLINK = '160000';

/** Submodule entries point at a commit; their diff text ("Subproject commit ...") is not file content. */
function isGitlink(diff: FileDiff): boolean {
	return diff.oldMode === GITLINK || diff.newMode === GITLINK;
}
const BLOB_CACHE_SIZE = 64;

/** A git repository with cached status and diffs, plus index mutations with undo/redo. */
export class Repository {
	status: StatusEntry[] = [];
	head: string | null = null;
	branch: string | null = null;
	/** Index -> working tree diffs keyed by path. */
	unstaged = new Map<string, FileDiff>();
	/** HEAD -> index diffs keyed by new path. */
	staged = new Map<string, FileDiff>();
	diffAlgorithm = 'histogram';

	private readonly listeners = new Set<ChangeListener>();
	private readonly undoStack: UndoOp[] = [];
	private readonly redoStack: UndoOp[] = [];
	private readonly blobCache = new Map<string, Buffer>();
	private queue: Promise<unknown> = Promise.resolve();
	private refreshPending: Promise<void> | null = null;
	private refreshAgain = false;
	/** Index mtime when the cached unstaged diffs were computed. */
	private diffIndexStamp = 0;
	/** Working tree "mtime:size" per path when its cached unstaged diff was computed. */
	private readonly fileStamps = new Map<string, string>();
	/** Incremented on every index write, so refreshes that overlap a write run again. */
	private writes = 0;
	/** Index blob per path written by this instance and not yet confirmed by a diff reload. Empty: removed. */
	private readonly indexShas = new Map<string, string>();
	/** How often staging could reuse a cached diff, for diagnostics. */
	readonly cacheStats = { hits: 0, misses: 0 };

	private constructor(
		readonly root: string,
		readonly gitDir: string,
		readonly objectsDir: string,
		readonly sha1: boolean,
		readonly emptyTree: string
	) {}

	static async open(dir: string): Promise<Repository> {
		const out = await gitText(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'objects', '--show-object-format'], { readOnly: true });
		const [top, gitDir, objects, format] = out.split(/\r?\n/);
		const root = path.resolve(top);
		const objectsDir = path.resolve(root, objects);
		const emptyTree = (await gitText(root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' })).trim();
		return new Repository(root, path.resolve(gitDir), objectsDir, format === 'sha1', emptyTree);
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
		return path.join(this.root, rel);
	}

	relPath(abs: string): string | null {
		const rel = path.relative(this.root, abs);
		if (rel.startsWith('..') || path.isAbsolute(rel)) {
			return null;
		}
		return rel.split(path.sep).join('/');
	}

	private diffArgs(): string[] {
		return ['-U0', '--full-index', '--no-ext-diff', '--no-textconv', `--diff-algorithm=${this.diffAlgorithm}`, '--src-prefix=a/', '--dst-prefix=b/'];
	}

	private async diffUnstaged(paths?: string[]): Promise<FileDiff[]> {
		const args = ['diff', ...this.diffArgs(), '--no-renames'];
		const out = await git(this.root, paths ? [...args, '--', ...paths] : args, { readOnly: true });
		return parseDiff(out.toString('latin1'));
	}

	private async diffStaged(paths?: string[]): Promise<FileDiff[]> {
		const args = ['diff', '--cached', ...this.diffArgs(), '-M', this.head ?? this.emptyTree];
		const out = await git(this.root, paths ? [...args, '--', ...paths] : args, { readOnly: true });
		return parseDiff(out.toString('latin1'));
	}

	/** Reloads status and all diffs. Concurrent calls coalesce into at most one extra run. */
	refresh(): Promise<void> {
		if (this.refreshPending) {
			this.refreshAgain = true;
			return this.refreshPending;
		}

		const run = async (): Promise<void> => {
			do {
				this.refreshAgain = false;
				const writes = this.writes;
				const indexStamp = await this.indexStamp();
				const statusOut = await git(this.root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], { readOnly: true });
				const status = parseStatus(statusOut);
				const stamps = await this.fileStampsOf(status.entries.filter(isUnstaged).map((e) => e.path));
				this.head = status.head;
				const [unstaged, staged] = await Promise.all([this.diffUnstaged(), this.diffStaged()]);
				if (writes !== this.writes) {
					// An index write overlapped this refresh; its results may be stale.
					this.refreshAgain = true;
					continue;
				}
				this.status = status.entries;
				this.branch = status.branch;
				this.unstaged = new Map(unstaged.map((d) => [d.path, d]));
				this.staged = new Map(staged.map((d) => [d.path, d]));
				this.diffIndexStamp = indexStamp;
				this.indexShas.clear();
				this.fileStamps.clear();
				stamps.forEach((v, k) => this.fileStamps.set(k, v));
			} while (this.refreshAgain);
			this.emit('all');
		};

		this.refreshPending = run().finally(() => (this.refreshPending = null));
		return this.refreshPending;
	}

	/** Reloads the diffs of specific paths without touching the rest. */
	async refreshPaths(paths: string[], which: 'both' | 'unstaged' | 'staged' = 'both'): Promise<void> {
		const writes = this.writes;
		const stamps = which === 'staged' ? null : await this.fileStampsOf(paths);
		const [unstaged, staged] = await Promise.all([
			which === 'staged' ? null : this.diffUnstaged(paths),
			which === 'unstaged' ? null : this.diffStaged(paths)
		]);
		if (writes !== this.writes) {
			return;
		}
		for (const p of paths) {
			this.indexShas.delete(p);
			if (unstaged) {
				this.unstaged.delete(p);
				this.fileStamps.set(p, stamps?.get(p) ?? 'missing');
			}
			if (staged) {
				this.staged.delete(p);
			}
		}
		unstaged?.forEach((d) => this.unstaged.set(d.path, d));
		staged?.forEach((d) => this.staged.set(d.path, d));
		this.emit(paths);
	}

	private async fileStampsOf(paths: string[]): Promise<Map<string, string>> {
		const result = new Map<string, string>();
		await Promise.all(
			paths.map(async (p) => {
				try {
					const st = await fs.stat(this.absPath(p));
					result.set(p, `${st.mtimeMs}:${st.size}`);
				} catch {
					result.set(p, 'missing');
				}
			})
		);
		return result;
	}

	/** Returns the cached index -> working tree diff when neither the index nor the file changed since. */
	private async cachedUnstagedDiff(rel: string): Promise<FileDiff | undefined> {
		const diff = this.unstaged.get(rel);
		const stamp = this.fileStamps.get(rel);
		if (!diff || !stamp || this.diffIndexStamp === 0) {
			return undefined;
		}
		const [indexStamp, fileStamps] = await Promise.all([this.indexStamp(), this.fileStampsOf([rel])]);
		return indexStamp === this.diffIndexStamp && fileStamps.get(rel) === stamp ? diff : undefined;
	}

	/** Reads a blob by object id, with a small cache. Null ids read as empty. */
	async readBlob(sha: string | undefined): Promise<Buffer> {
		if (isNullSha(sha)) {
			return Buffer.alloc(0);
		}

		const cached = this.blobCache.get(sha!);
		if (cached) {
			return cached;
		}

		const content = await git(this.root, ['cat-file', 'blob', sha!], { readOnly: true });
		this.cacheBlob(sha!, content);
		return content;
	}

	private cacheBlob(sha: string, content: Buffer): void {
		this.blobCache.set(sha, content);
		if (this.blobCache.size > BLOB_CACHE_SIZE) {
			this.blobCache.delete(this.blobCache.keys().next().value!);
		}
	}

	/** Reads the index version of a path. Returns empty content when the path is not in the index. */
	async readIndex(rel: string): Promise<Buffer> {
		const written = this.indexShas.get(rel);
		if (written !== undefined) {
			return this.readBlob(written || undefined);
		}
		const known = this.unstaged.get(rel)?.oldSha ?? this.staged.get(rel)?.newSha;
		if (known && !isNullSha(known)) {
			return this.readBlob(known);
		}

		try {
			return await git(this.root, ['cat-file', 'blob', `:${rel}`], { readOnly: true });
		} catch {
			return Buffer.alloc(0);
		}
	}

	/** Reads the HEAD version of a path. Returns empty content when HEAD lacks the path. */
	async readHead(rel: string): Promise<Buffer> {
		if (!this.head) {
			return Buffer.alloc(0);
		}

		try {
			return await git(this.root, ['cat-file', 'blob', `HEAD:${rel}`], { readOnly: true });
		} catch {
			return Buffer.alloc(0);
		}
	}

	/** Runs index mutations one at a time so that undo snapshots stay consistent. */
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(fn, fn);
		this.queue = result.catch(() => undefined);
		return result;
	}

	private async writeBlob(content: Buffer): Promise<string> {
		const sha = this.sha1
			? await writeLooseBlob(this.objectsDir, content)
			: (await gitText(this.root, ['hash-object', '-w', '--no-filters', '--stdin'], { input: content })).trim();
		this.cacheBlob(sha, content);
		return sha;
	}

	private async writeEntries(entries: IndexEntry[]): Promise<void> {
		const zero = this.sha1 ? '0'.repeat(40) : '0'.repeat(64);
		const input = entries.map((e) => (e.mode === '0' ? `0 ${zero}\t${e.path}\0` : `${e.mode} ${e.sha}\t${e.path}\0`)).join('');
		await git(this.root, ['update-index', '-z', '--index-info'], { input: Buffer.from(input, 'utf8') });
	}

	private async readEntries(paths: string[]): Promise<IndexEntry[]> {
		const out = await gitText(this.root, ['ls-files', '-s', '-z', '--', ...paths], { readOnly: true });
		const found = new Map<string, IndexEntry>();
		for (const record of out.split('\0')) {
			const m = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(record);
			if (m && m[3] === '0') {
				found.set(m[4], { path: m[4], mode: m[1], sha: m[2] });
			}
		}
		return paths.map((p) => found.get(p) ?? { path: p, mode: '0', sha: '' });
	}

	/** Index entries as HEAD has them; missing paths come back with mode '0'. */
	private async readHeadEntries(paths: string[]): Promise<IndexEntry[] | null> {
		if (!this.head) {
			return null;
		}
		const out = await gitText(this.root, ['ls-tree', '-z', this.head, '--', ...paths], { readOnly: true });
		const found = new Map<string, IndexEntry>();
		for (const record of out.split('\0')) {
			const m = /^(\d+) \w+ ([0-9a-f]+)\t(.*)$/s.exec(record);
			if (m) {
				found.set(m[3], { path: m[3], mode: m[1], sha: m[2] });
			}
		}
		return paths.map((p) => found.get(p) ?? { path: p, mode: '0', sha: '' });
	}

	private pushUndo(op: UndoOp): void {
		this.undoStack.push(op);
		if (this.undoStack.length > MAX_UNDO) {
			this.undoStack.shift();
		}
		this.redoStack.length = 0;
	}

	/** Returns the current index -> working tree diff of a path, making untracked files diffable first. */
	private async unstagedDiffFor(rel: string): Promise<{ diff: FileDiff | undefined; addedIntent: boolean }> {
		const entry = this.status.find((e) => e.path === rel);
		let addedIntent = false;
		if (entry?.kind === 'untracked') {
			await git(this.root, ['add', '--intent-to-add', '--', rel]);
			addedIntent = true;
		}

		const cached = addedIntent ? undefined : await this.cachedUnstagedDiff(rel);
		if (cached) {
			this.cacheStats.hits++;
			return { diff: cached, addedIntent };
		}
		this.cacheStats.misses++;
		const [diff] = await this.diffUnstaged([rel]);
		return { diff, addedIntent };
	}

	/**
	 * Stages the lines chosen by `select` from the index -> working tree diff of a file.
	 * `select` receives the diff that the selection must refer to. Returns false when nothing was staged.
	 */
	stageLines(rel: string, select: (diff: FileDiff) => Set<DiffLine>, label = 'Stage lines'): Promise<boolean> {
		return this.stageSelections([{ rel, select }], label);
	}

	/** Stages line selections in several files as one undoable step. */
	stageSelections(items: { rel: string; select: (diff: FileDiff) => Set<DiffLine> }[], label = 'Stage lines'): Promise<boolean> {
		return this.serialize(async () => {
			const before: IndexEntry[] = [];
			const after: IndexEntry[] = [];
			const touched: string[] = [];
			const derived = new Map<string, FileDiff | null>();
			for (const { rel, select } of items) {
				const { diff, addedIntent } = await this.unstagedDiffFor(rel);
				const lines = diff && !diff.binary ? select(diff) : new Set<DiffLine>();
				if (!diff || lines.size === 0) {
					if (addedIntent) {
						await this.writeEntries([{ path: rel, mode: '0', sha: '' }]);
					}
					continue;
				}
				if (isGitlink(diff)) {
					// Stage the commit the submodule is at, as `git add` would.
					before.push(...(await this.readEntries([rel])));
					await git(this.root, ['add', '--', rel]);
					after.push(...(await this.readEntries([rel])));
					touched.push(rel);
					derived.set(rel, null);
					continue;
				}

				const base = (await this.readBlob(diff.oldSha)).toString('latin1');
				const content = Buffer.from(applyForward(base, diff.hunks, lines), 'latin1');
				const mode = diff.oldMode ?? diff.newMode ?? '100644';
				const sha = await this.writeBlob(content);
				before.push(addedIntent ? { path: rel, mode: '0', sha: '' } : { path: rel, mode, sha: diff.oldSha! });
				after.push({ path: rel, mode, sha });
				touched.push(rel);
				const hunks = remainingHunks(diff.hunks, lines, 'forward');
				derived.set(rel, hunks && { ...diff, oldPath: rel, oldSha: sha, oldMode: mode, hunks });
			}

			if (touched.length === 0) {
				return false;
			}
			await this.commitLineWrite({ label, before, after }, derived, 'unstaged');
			return true;
		});
	}

	/** Unstages the lines chosen by `select` from the HEAD -> index diff of a file. */
	unstageLines(rel: string, select: (diff: FileDiff) => Set<DiffLine>, label = 'Unstage lines'): Promise<boolean> {
		return this.serialize(async () => {
			const [diff] = await this.diffStaged([rel]);
			const lines = diff && !diff.binary ? select(diff) : new Set<DiffLine>();
			if (!diff || lines.size === 0 || !diff.newPath) {
				return false;
			}
			if (isGitlink(diff)) {
				const before = await this.readEntries([rel]);
				const after = (await this.readHeadEntries([rel])) ?? [{ path: rel, mode: '0', sha: '' }];
				await this.commitLineWrite({ label, before, after }, new Map([[rel, null]]), 'staged');
				return true;
			}

			const base = (await this.readBlob(diff.newSha)).toString('latin1');
			const mode = diff.newMode ?? '100644';
			const before: IndexEntry = { path: rel, mode, sha: diff.newSha! };
			const allAdded = diff.hunks.every((h) => h.lines.every((l) => l.type !== '+' || lines.has(l)));
			let after: IndexEntry;
			if (diff.oldPath === null && allAdded) {
				// Unstaging every line of a new file makes it untracked again.
				after = { path: rel, mode: '0', sha: '' };
			} else {
				const content = Buffer.from(applyReverse(base, diff.hunks, lines), 'latin1');
				after = { path: rel, mode, sha: await this.writeBlob(content) };
			}

			const hunks = after.mode === '0' ? null : remainingHunks(diff.hunks, lines, 'reverse');
			await this.commitLineWrite({ label, before: [before], after: [after] }, new Map([[rel, hunks && { ...diff, newSha: after.sha, hunks }]]), 'staged');
			return true;
		});
	}

	/**
	 * Writes a line-level index change. Diffs derived in-process for the `side` view are published before
	 * git finishes writing, so views update without waiting for the process. A failed write rolls them back.
	 * The other view, and paths whose diff could not be derived, reload from git before this resolves.
	 */
	private async commitLineWrite(op: UndoOp, derived: Map<string, FileDiff | null>, side: 'unstaged' | 'staged'): Promise<void> {
		const paths = op.after.map((e) => e.path);
		op.views = { before: await this.snapshot(paths) };
		const map = side === 'unstaged' ? this.unstaged : this.staged;
		const previous = new Map(paths.map((p) => [p, map.get(p)]));
		const missing: string[] = [];
		for (const p of paths) {
			const d = derived.get(p);
			if (!d) {
				missing.push(p);
			} else if (d.hunks.length === 0 && d.oldMode === d.newMode) {
				map.delete(p);
			} else {
				map.set(p, d);
			}
		}
		op.after.forEach((e) => this.indexShas.set(e.path, e.mode === '0' ? '' : e.sha));

		this.writes++;
		this.diffIndexStamp = 0;
		if (missing.length < paths.length) {
			this.emit(paths);
		}

		try {
			await this.writeEntries(op.after);
		} catch (e) {
			previous.forEach((d, p) => (d ? map.set(p, d) : map.delete(p)));
			paths.forEach((p) => this.indexShas.delete(p));
			this.emit(paths);
			throw e;
		}
		// Refreshes that started before the write finished read the old index; make them run again.
		this.writes++;
		this.pushUndo(op);

		// Staging leaves the working tree untouched, so file stamps stay valid against the new index.
		if (side === 'unstaged' && missing.length === 0) {
			this.diffIndexStamp = await this.indexStamp();
		}

		const other = side === 'unstaged' ? 'staged' : 'unstaged';
		await Promise.all([this.refreshPaths(paths, other), missing.length > 0 ? this.refreshPaths(missing, side) : undefined]);
		op.views.after = await this.snapshot(paths);
	}

	private async snapshot(paths: string[]): Promise<DiffSnapshot> {
		return {
			unstaged: new Map(paths.map((p) => [p, this.unstaged.get(p)])),
			staged: new Map(paths.map((p) => [p, this.staged.get(p)])),
			stamps: await this.fileStampsOf(paths)
		};
	}

	/** Writes index entries for undo or redo, showing the remembered diffs first when they are still valid. */
	private async restore(entries: IndexEntry[], view: DiffSnapshot | undefined): Promise<void> {
		const paths = entries.map((e) => e.path);
		let shown = false;
		if (view) {
			const stamps = await this.fileStampsOf(paths);
			if (paths.every((p) => stamps.get(p) === view.stamps.get(p))) {
				for (const p of paths) {
					const u = view.unstaged.get(p);
					const st = view.staged.get(p);
					u ? this.unstaged.set(p, u) : this.unstaged.delete(p);
					st ? this.staged.set(p, st) : this.staged.delete(p);
				}
				entries.forEach((e) => this.indexShas.set(e.path, e.mode === '0' ? '' : e.sha));
				shown = true;
			}
		}

		this.writes++;
		this.diffIndexStamp = 0;
		if (shown) {
			this.emit(paths);
		}
		try {
			await this.writeEntries(entries);
		} finally {
			this.writes++;
			// Reload the touched paths first so diff views settle before the slower status refresh.
			await this.refreshPaths(paths);
			await this.refresh();
		}
	}

	/** Stages whole files, including deletions. */
	stageFiles(paths: string[], label = 'Stage files'): Promise<void> {
		return this.serialize(async () => {
			const before = await this.readEntries(paths);
			await git(this.root, ['add', '-A', '--', ...paths]);
			this.writes++;
			const after = await this.readEntries(paths);
			this.pushUndo({ label, before, after });
			await this.refresh();
		});
	}

	/** Restores whole files in the index to their HEAD state. */
	unstageFiles(paths: string[], label = 'Unstage files'): Promise<void> {
		return this.serialize(async () => {
			const all = new Set(paths);
			for (const e of this.status) {
				if (e.origPath && all.has(e.path)) {
					all.add(e.origPath);
				}
			}

			const list = [...all];
			const before = await this.readEntries(list);
			if (this.head) {
				await git(this.root, ['reset', '-q', 'HEAD', '--', ...list], { okCodes: [0, 1] });
			} else {
				await git(this.root, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...list]);
			}
			this.writes++;
			const after = await this.readEntries(list);
			this.pushUndo({ label, before, after });
			await this.refresh();
		});
	}

	/** Reverts the last index mutation. Returns its label, or null when there is nothing to undo. */
	undo(): Promise<string | null> {
		return this.serialize(async () => {
			const op = this.undoStack.pop();
			if (!op) {
				return null;
			}
			this.redoStack.push(op);
			await this.restore(op.before, op.views?.before);
			return op.label;
		});
	}

	/** Re-applies the last undone mutation. */
	redo(): Promise<string | null> {
		return this.serialize(async () => {
			const op = this.redoStack.pop();
			if (!op) {
				return null;
			}
			this.undoStack.push(op);
			await this.restore(op.after, op.views?.after);
			return op.label;
		});
	}

	/** Returns the mtime of the index file, used to detect external index changes. */
	async indexStamp(): Promise<number> {
		try {
			return (await fs.stat(path.join(this.gitDir, 'index'))).mtimeMs;
		} catch {
			return 0;
		}
	}
}
