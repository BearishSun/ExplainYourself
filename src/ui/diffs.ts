import * as path from 'path';
import * as vscode from 'vscode';
import { indexRanges } from '../core/coverage';
import { DiffLine, FileDiff, LineRange, mapRange } from '../core/diff';
import { ReviewCategory, ReviewSection } from '../core/review';
import { hunksInRanges, selectHunks, selectLines } from '../core/stager';
import { AppState } from './state';
import { config, DiffView, docContext, DocContext, errorMessage, log, parseVirtualUri, SCHEME, Side, virtualUri } from './util';

/** Serves HEAD and index versions of files. */
export class ContentProvider implements vscode.TextDocumentContentProvider {
	private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.emitter.event;

	constructor(private readonly state: AppState) {
		state.onDidChangeRepo((paths) => {
			for (const doc of vscode.workspace.textDocuments) {
				const ctx = docContext(state.repo, doc.uri);
				if (doc.uri.scheme === SCHEME && ctx && ctx.ref !== 'EMPTY' && (paths === 'all' || paths.includes(ctx.rel))) {
					this.emitter.fire(doc.uri);
				}
			}
		});
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const repo = this.state.repo;
		const ctx = docContext(repo, uri);
		if (!repo || !ctx || ctx.ref === 'EMPTY') {
			return '';
		}
		const content = ctx.ref === 'HEAD' ? await repo.readHead(ctx.rel) : await repo.readIndex(ctx.rel);
		return content.toString('utf8');
	}
}

/** Thread labels and author names are plain text; drop the backticks of inline code. */
function plain(text: string): string {
	return text.replace(/`([^`]+)`/g, '$1');
}

/** Where a comment thread goes: a section summary, or one of the section's notes when `note` is set. */
interface ThreadAnchor {
	/** Identifies the thread on its document, so later refreshes update it instead of replacing it. */
	key: string;
	line: number;
	category: ReviewCategory;
	section: ReviewSection;
	note?: string;
}

/** Sorted union of line ranges, so overlapping sections do not stack their highlight. */
function mergeRanges(ranges: LineRange[]): LineRange[] {
	const result: LineRange[] = [];
	for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
		const last = result[result.length - 1];
		if (last && r.start <= last.end + 1) {
			last.end = Math.max(last.end, r.end);
		} else {
			result.push({ ...r });
		}
	}
	return result;
}

/** Lines of code kept in view above a revealed section, so it does not open flush with the top. */
const REVEAL_CONTEXT_LINES = 5;

/** Scrolls an editor so that a section starts REVEAL_CONTEXT_LINES below the top, or as far down as the file allows. */
function revealSection(editor: vscode.TextEditor, r: LineRange): void {
	const top = Math.max(0, r.start - 1 - REVEAL_CONTEXT_LINES);
	const reveal = () => editor.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop);
	reveal();
	// A diff editor that is still computing a large diff scrolls to its cursor again when the diff is ready.
	// Reveal once more if that happens soon after opening, while the cursor is still where we put it.
	const cursor = editor.selection.active;
	const watch = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
		if (e.textEditor === editor && e.visibleRanges[0]?.start.line !== top && editor.selection.active.isEqual(cursor)) {
			stop();
			reveal();
		}
	});
	const timer = setTimeout(() => stop(), 2000);
	const stop = () => {
		clearTimeout(timer);
		watch.dispose();
	};
}

function toRange(r: LineRange): vscode.Range {
	return new vscode.Range(r.start - 1, 0, r.end - 1, Number.MAX_SAFE_INTEGER);
}

/** Opens diffs and comparisons, provides stage actions, and shows review summaries on them. */
export class DiffController implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly comments = vscode.comments.createCommentController('explainYourself', 'ExplainYourself');
	/** Comment threads by document URI, then by anchor key, with the content they show. */
	private readonly threads = new Map<string, Map<string, { thread: vscode.CommentThread; content: string }>>();
	/** Generation time of the review the threads show. A newly generated review replaces every thread. */
	private threadsGeneratedAt: string | undefined;
	private readonly threadSections = new WeakMap<vscode.CommentThread, string>();
	private readonly lensEmitter = new vscode.EventEmitter<void>();
	/**
	 * Section lines: a faint background, and a thin bar along their left edge that stays visible over the
	 * diff's own line colors, which remain the main signal.
	 */
	private readonly sectionDecoration = vscode.window.createTextEditorDecorationType({
		backgroundColor: new vscode.ThemeColor('explainYourself.sectionBackground'),
		borderColor: new vscode.ThemeColor('explainYourself.sectionBorder'),
		borderStyle: 'solid',
		borderWidth: '0 0 0 2px',
		isWholeLine: true
	});
	/** Highlighted lines by document URI, for tests. */
	private readonly highlights = new Map<string, LineRange[]>();
	/** Working tree file opened as the right side of an old/new comparison. */
	private compareRight: string | undefined;

	constructor(private readonly state: AppState) {
		this.disposables.push(this.comments, this.lensEmitter, this.sectionDecoration);
		this.disposables.push(vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: SCHEME }], {
			onDidChangeCodeLenses: this.lensEmitter.event,
			provideCodeLenses: (doc) => this.provideCodeLenses(doc)
		}));

		const refresh = () => this.refreshEditors();
		this.disposables.push(state.onDidChangeRepo(refresh));
		this.disposables.push(state.onDidChangeReview(refresh));
		this.disposables.push(vscode.window.onDidChangeVisibleTextEditors(refresh));
		// Whether an editor belongs to a review diff shows in its tab, which can appear after the editor.
		this.disposables.push(
			vscode.window.tabGroups.onDidChangeTabs(() => {
				this.lensEmitter.fire();
				this.refreshHighlights();
			})
		);
		this.disposables.push(vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()));
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('explainYourself.summariesExpanded')) {
					// Threads take the setting when they are created.
					this.disposeThreads(() => true);
				}
				if (e.affectsConfiguration('explainYourself')) {
					refresh();
				}
			})
		);
		this.updateContext();
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
	}

	private disposeThreads(match: (uri: string) => boolean): void {
		for (const [uri, shown] of this.threads) {
			if (match(uri)) {
				shown.forEach((t) => t.thread.dispose());
				this.threads.delete(uri);
			}
		}
	}

	/** Opens the diff of a file. Reveals `range` (on `side`) when given. */
	async openDiff(rel: string, view: Exclude<DiffView, 'compare'>, reveal?: { range: LineRange; side: Side }): Promise<void> {
		const repo = this.state.repo;
		if (!repo) {
			return;
		}
		// Leaving an old/new comparison: put the diff where the comparison started.
		const viewColumn = (await this.closeCompare()) ? vscode.ViewColumn.One : undefined;

		const entry = repo.status.find((e) => e.path === rel);
		const name = path.posix.basename(rel);
		let left: vscode.Uri;
		let right: vscode.Uri;
		let title: string;
		if (view === 'unstaged') {
			const untracked = entry?.kind === 'untracked';
			left = virtualUri(repo, { rel, ref: untracked ? 'EMPTY' : 'INDEX', view, side: 'old' });
			right = entry?.y === 'D' ? virtualUri(repo, { rel, ref: 'EMPTY', view, side: 'new' }) : vscode.Uri.file(repo.absPath(rel));
			title = `${name} (Index ↔ Working Tree)`;
		} else {
			const diff = repo.staged.get(rel);
			const oldRel = diff?.oldPath ?? rel;
			left = virtualUri(repo, { rel: oldRel, ref: diff && diff.oldPath === null ? 'EMPTY' : 'HEAD', view, side: 'old' });
			right = virtualUri(repo, { rel, ref: entry?.x === 'D' ? 'EMPTY' : 'INDEX', view, side: 'new' });
			title = `${name} (HEAD ↔ Index)`;
		}

		const selection = reveal?.side === 'new' ? new vscode.Range(reveal.range.start - 1, 0, reveal.range.start - 1, 0) : undefined;
		await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, selection, viewColumn });

		if (reveal) {
			const target = reveal.side === 'new' ? right : left;
			const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === target.toString());
			if (editor) {
				revealSection(editor, reveal.range);
			}
		}
	}

	/** Opens a section: as a diff when its file has changes, and as a plain editor otherwise. */
	async openSection(sectionId: string): Promise<void> {
		const repo = this.state.repo;
		const found = this.state.findSection(sectionId);
		if (!repo || !found) {
			return;
		}
		const { section } = found;
		const newRange = this.state.newRange(section);
		const status = this.state.sectionStatus(section);
		const hasUnstaged = repo.unstaged.has(section.file) || repo.status.some((e) => e.path === section.file && e.kind === 'untracked');

		if (status === 'context' && newRange) {
			await this.closeCompare();
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(repo.absPath(section.file)));
			const editor = await vscode.window.showTextDocument(doc, { preview: true, selection: toRange(newRange).with({ end: toRange(newRange).start }) });
			revealSection(editor, newRange);
			return;
		}

		const view: DiffView = hasUnstaged || !repo.staged.has(section.file) ? 'unstaged' : 'staged';
		if (newRange) {
			const range = view === 'unstaged' ? newRange : indexRanges(repo, { ...section, oldRange: undefined }, newRange)[0];
			await this.openDiff(section.file, view, range ? { range, side: 'new' } : undefined);
		} else if (section.oldRange) {
			const range = view === 'unstaged' ? indexRanges(repo, section, undefined)[0] : section.oldRange;
			await this.openDiff(section.file, view, range ? { range, side: 'old' } : undefined);
		}
	}

	/**
	 * Shows a section as two plain editors: the complete HEAD version on the left, the working tree file on
	 * the right. Without diff markup, a rewritten function reads as a whole.
	 */
	async compareSection(sectionId: string): Promise<void> {
		const repo = this.state.repo;
		const found = this.state.findSection(sectionId);
		if (!repo || !found) {
			return;
		}
		const { section } = found;
		const newRange = this.state.newRange(section);
		const oldRange = this.state.compareOldRange(section);
		const headPath = this.state.headPath(section);
		if (!newRange || !oldRange || headPath === null) {
			vscode.window.setStatusBarMessage('ExplainYourself: this section has no old version to compare with', 3000);
			await this.openSection(sectionId);
			return;
		}

		await this.closeCompare();
		const left = virtualUri(repo, { rel: headPath, ref: 'HEAD', view: 'compare', side: 'old', reviewRel: section.file });
		const leftEditor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(left), {
			viewColumn: vscode.ViewColumn.One,
			preview: true,
			preserveFocus: true
		});
		const rightUri = vscode.Uri.file(repo.absPath(section.file));
		const rightEditor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(rightUri), {
			viewColumn: vscode.ViewColumn.Two,
			preview: true,
			selection: new vscode.Range(newRange.start - 1, 0, newRange.start - 1, 0)
		});
		this.compareRight = rightUri.toString();

		revealSection(leftEditor, oldRange);
		revealSection(rightEditor, newRange);
		this.refreshEditors();
	}

	/** Compares the section under the cursor, or the first comparable section of the active file. */
	async compareAtCursor(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const ctx = editor && docContext(this.state.repo, editor.document.uri);
		if (!editor || !ctx) {
			return;
		}
		const line = editor.selection.active.line + 1;
		const sections = this.sectionRanges(ctx);
		const comparable = sections.filter((s) => this.state.compareOldRange(s.section) && this.state.newRange(s.section));
		const target = comparable.find((s) => s.ranges.some((r) => line >= r.start && line <= r.end)) ?? comparable[0];
		if (!target) {
			vscode.window.setStatusBarMessage('ExplainYourself: no review section in this file has an old version to compare with', 3000);
			return;
		}
		await this.compareSection(target.section.id);
	}

	/**
	 * Opens the next section of a section's group, for example the definition of a declaration. Without an
	 * id, uses the grouped section under the cursor, or the first grouped section of the active file.
	 */
	async goToRelated(sectionId?: string): Promise<void> {
		let section = sectionId ? this.state.findSection(sectionId)?.section : undefined;
		if (!section) {
			const editor = vscode.window.activeTextEditor;
			const ctx = editor && docContext(this.state.repo, editor.document.uri);
			if (!editor || !ctx) {
				return;
			}
			const line = editor.selection.active.line + 1;
			const grouped = this.sectionRanges(ctx).filter((s) => this.state.relatedSections(s.section).length > 0);
			section = (grouped.find((s) => s.ranges.some((r) => line >= r.start && line <= r.end)) ?? grouped[0])?.section;
		}
		if (!section) {
			vscode.window.setStatusBarMessage('ExplainYourself: no section in this file has related sections', 3000);
			return;
		}
		// Cycle through the group in review order.
		const group = [section, ...this.state.relatedSections(section)];
		const all = (this.state.review?.categories ?? []).flatMap((c) => c.sections).filter((s) => group.includes(s));
		const next = all[(all.indexOf(section) + 1) % all.length];
		if (next !== section) {
			await this.openSection(next.id);
		}
	}

	/** Leaves the old/new comparison for the regular diff of the same file, at the same place. */
	async showAsDiff(): Promise<void> {
		const repo = this.state.repo;
		const editor = vscode.window.activeTextEditor;
		const ctx = editor && docContext(repo, editor.document.uri);
		if (!repo || !ctx) {
			return;
		}
		const rel = ctx.reviewRel ?? ctx.rel;
		const fileEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file' && repo.relPath(e.document.uri.fsPath) === rel);
		const line = (fileEditor?.selection.active.line ?? 0) + 1;
		const view = repo.unstaged.has(rel) || repo.status.some((e) => e.path === rel && e.kind === 'untracked') || !repo.staged.has(rel) ? 'unstaged' : 'staged';
		const range = view === 'unstaged' ? { start: line, end: line } : mapRange(repo.unstaged.get(rel)?.hunks ?? [], { start: line, end: line }, 'new')[0];
		await this.openDiff(rel, view, range ? { range, side: 'new' } : undefined);
	}

	/** Closes the editors of an old/new comparison. Returns true when one was open. */
	private async closeCompare(): Promise<boolean> {
		const tabs: vscode.Tab[] = [];
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (!(tab.input instanceof vscode.TabInputText)) {
					continue;
				}
				const uri = tab.input.uri;
				if (parseVirtualUri(uri)?.view === 'compare') {
					tabs.push(tab);
				} else if (uri.toString() === this.compareRight && group.viewColumn === vscode.ViewColumn.Two && !tab.isDirty) {
					// The working tree side was opened for the comparison; keep it if the user edited it.
					tabs.push(tab);
				}
			}
		}
		this.compareRight = undefined;
		if (!tabs.some((t) => parseVirtualUri((t.input as vscode.TabInputText).uri)?.view === 'compare')) {
			return false;
		}
		await vscode.window.tabGroups.close(tabs, true);
		return true;
	}

	/** True while the HEAD side of an old/new comparison of `rel` is visible. */
	private isInCompare(rel: string): boolean {
		return vscode.window.visibleTextEditors.some((e) => {
			const v = parseVirtualUri(e.document.uri);
			return v?.view === 'compare' && (v.reviewRel ?? v.rel) === rel;
		});
	}

	/** Plain reading: no summaries or CodeLenses in an old/new comparison. */
	private isPlain(ctx: DocContext): boolean {
		return config().get('plainCompare', false) && (ctx.view === 'compare' || (ctx.ref === 'WORKTREE' && this.isInCompare(ctx.rel)));
	}

	/** Returns true when a document is shown as part of one of our diffs or comparisons. */
	private isInOurDiff(uri: vscode.Uri): boolean {
		if (uri.scheme === SCHEME) {
			return true;
		}
		const rel = this.state.repo?.relPath(uri.fsPath);
		if (rel && this.isInCompare(rel)) {
			return true;
		}
		const key = uri.toString();
		return vscode.window.tabGroups.all.some((g) =>
			g.tabs.some((t) => t.input instanceof vscode.TabInputTextDiff && t.input.original.scheme === SCHEME && t.input.modified.toString() === key)
		);
	}

	private updateContext(): void {
		const editor = vscode.window.activeTextEditor;
		const ctx = editor ? docContext(this.state.repo, editor.document.uri) : undefined;
		const stageable = ctx && ctx.ref !== 'EMPTY' && ctx.view !== 'compare' && (ctx.ref !== 'WORKTREE' || this.isInOurDiff(editor!.document.uri) || config().get('stageFromEditors'));
		const comparing = !!ctx && (ctx.view === 'compare' || (ctx.ref === 'WORKTREE' && this.isInCompare(ctx.rel)));
		vscode.commands.executeCommand('setContext', 'explainYourself.editorView', stageable ? ctx!.view : '');
		vscode.commands.executeCommand('setContext', 'explainYourself.compareActive', comparing);
		const reviewEditor = !!ctx && ctx.ref !== 'EMPTY' && (ctx.ref !== 'WORKTREE' || this.isInOurDiff(editor!.document.uri));
		vscode.commands.executeCommand('setContext', 'explainYourself.reviewEditor', reviewEditor);
		const hasRelated = reviewEditor && this.state.sectionsForFile(ctx!.reviewRel ?? ctx!.rel).some(({ section }) => this.state.relatedSections(section).length > 0);
		vscode.commands.executeCommand('setContext', 'explainYourself.hasRelated', hasRelated);
	}

	private provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
		const repo = this.state.repo;
		const ctx = docContext(repo, doc.uri);
		if (!repo || !ctx || ctx.side !== 'new' || ctx.view === 'compare' || !config().get('codeLens', true) || this.isPlain(ctx)) {
			return [];
		}
		if (ctx.ref === 'WORKTREE' && !this.isInOurDiff(doc.uri) && !config().get('stageFromEditors')) {
			return [];
		}

		const uri = doc.uri.toString();
		if (ctx.view === 'unstaged' && repo.status.some((e) => e.path === ctx.rel && e.kind === 'untracked')) {
			return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title: '$(add) Stage file', command: 'explainYourself.stageFile', arguments: [ctx.rel] })];
		}

		const diff = (ctx.view === 'unstaged' ? repo.unstaged : repo.staged).get(ctx.rel);
		if (!diff || diff.binary) {
			return [];
		}

		const lenses: vscode.CodeLens[] = [];
		const lastLine = Math.max(0, doc.lineCount - 1);
		for (const h of diff.hunks) {
			// Pure removals show on the line that follows them.
			const line = Math.min(lastLine, Math.max(0, h.newCount === 0 ? h.newStart : h.newStart - 1));
			const range = new vscode.Range(line, 0, line, 0);
			const anchor = h.newCount === 0 ? h.newStart + 1 : h.newStart;
			const counts = `${h.oldCount ? `-${h.oldCount}` : ''}${h.oldCount && h.newCount ? ' ' : ''}${h.newCount ? `+${h.newCount}` : ''}`;
			lenses.push(
				ctx.view === 'unstaged'
					? new vscode.CodeLens(range, { title: `$(add) Stage hunk (${counts})`, command: 'explainYourself.stageHunk', arguments: [uri, anchor] })
					: new vscode.CodeLens(range, { title: `$(remove) Unstage hunk (${counts})`, command: 'explainYourself.unstageHunk', arguments: [uri, anchor] })
			);
		}
		return lenses;
	}

	/**
	 * Highlights the lines of each section in review diffs and comparisons, together with the nearby changes
	 * that staging the section also stages, so the reader sees what a stage takes.
	 */
	private refreshHighlights(): void {
		const repo = this.state.repo;
		const show = config().get('highlightSections', true);
		this.highlights.clear();
		for (const editor of vscode.window.visibleTextEditors) {
			const uri = editor.document.uri;
			const ctx = docContext(repo, uri);
			if (!repo || !show || !ctx || this.isPlain(ctx) || (ctx.ref === 'WORKTREE' && !this.isInOurDiff(uri))) {
				editor.setDecorations(this.sectionDecoration, []);
				continue;
			}
			const ranges = this.sectionRanges(ctx).flatMap(({ section, ranges }) => {
				const nearby = this.state.stageUnits(section).slice(1);
				if (ctx.ref === 'WORKTREE') {
					return [...ranges, ...nearby.flatMap((u) => (u.newRange ? [u.newRange] : []))];
				}
				if (ctx.ref === 'INDEX' && ctx.view !== 'compare') {
					return [...ranges, ...nearby.flatMap((u) => indexRanges(repo, u, u.newRange))];
				}
				return ranges;
			});
			const merged = mergeRanges(ranges);
			this.highlights.set(uri.toString(), merged);
			editor.setDecorations(this.sectionDecoration, merged.map(toRange));
		}
	}

	/** Highlighted section lines of a document. For tests. */
	highlightsOf(uri: vscode.Uri): LineRange[] {
		return this.highlights.get(uri.toString()) ?? [];
	}

	/** Lines of the review sections that apply to a document, in that document's coordinates. */
	private sectionRanges(ctx: DocContext): { category: ReviewCategory; section: ReviewSection; ranges: LineRange[] }[] {
		const repo = this.state.repo;
		if (!repo || ctx.ref === 'EMPTY') {
			return [];
		}

		return this.state.sectionsForFile(ctx.reviewRel ?? ctx.rel).map(({ category, section }) => {
			const newRange = this.state.newRange(section);
			let ranges: LineRange[] = [];
			if (ctx.ref === 'WORKTREE') {
				ranges = newRange ? [newRange] : [];
			} else if (ctx.view === 'compare') {
				const oldRange = this.state.compareOldRange(section);
				ranges = oldRange ? [oldRange] : [];
			} else if (ctx.ref === 'HEAD') {
				ranges = section.oldRange ? [section.oldRange] : [];
			} else {
				ranges = indexRanges(repo, section, newRange);
			}
			return { category, section, ranges };
		});
	}

	private refreshEditors(): void {
		this.lensEmitter.fire();
		this.updateContext();
		this.refreshHighlights();

		this.refreshThreads();
	}

	/**
	 * Places each section summary on exactly one side of each diff view, just above the section, and each
	 * note just above the part of the section it explains.
	 */
	private threadAnchors(ctx: DocContext): ThreadAnchor[] {
		const repo = this.state.repo;
		// In a comparison the summary shows once, on the working tree side.
		if (!repo || !config().get('showSummaries', true) || ctx.view === 'compare' || this.isPlain(ctx)) {
			return [];
		}

		const result: ThreadAnchor[] = [];
		for (const { category, section } of this.state.sectionsForFile(ctx.rel)) {
			const newRange = this.state.newRange(section);
			const unstaged = repo.unstaged.get(section.file)?.hunks ?? [];
			const newInIndex = newRange ? mapRange(unstaged, newRange, 'new') : [];
			let start: number | undefined;
			if (ctx.ref === 'WORKTREE') {
				start = newRange?.start;
			} else if (ctx.ref === 'INDEX' && ctx.view === 'unstaged') {
				start = newRange ? undefined : indexRanges(repo, section, undefined)[0]?.start;
			} else if (ctx.ref === 'INDEX' && ctx.view === 'staged') {
				start = newInIndex[0]?.start;
			} else if (ctx.ref === 'HEAD') {
				start = newInIndex.length === 0 ? section.oldRange?.start : undefined;
			}
			if (start !== undefined) {
				result.push({ key: section.id, line: Math.max(0, start - 2), category, section });
			}

			// Notes refer to working tree lines; the staged view shows them where those lines are in the index.
			for (const [i, note] of this.state.notes(section).entries()) {
				const line = ctx.ref === 'WORKTREE' ? note.line : ctx.ref === 'INDEX' && ctx.view === 'staged' ? mapRange(unstaged, { start: note.line, end: note.line }, 'new')[0]?.start : undefined;
				if (line !== undefined) {
					result.push({ key: `${section.id}#${i}`, line: Math.max(0, line - 2), category, section, note: note.text });
				}
			}
		}
		return result;
	}

	/**
	 * Shows the comment threads of each visible review document. Existing threads move and change in place:
	 * replacing a thread removes and re-adds its view zone, which makes the editor jump while the user types.
	 */
	private refreshThreads(): void {
		if (this.state.review?.generatedAt !== this.threadsGeneratedAt) {
			this.disposeThreads(() => true);
			this.threadsGeneratedAt = this.state.review?.generatedAt;
		}
		const open = new Set<string>();
		const collapse = config().get('summariesExpanded', true) ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
		for (const editor of vscode.window.visibleTextEditors) {
			const uri = editor.document.uri;
			const ctx = docContext(this.state.repo, uri);
			const key = uri.toString();
			if (!ctx || open.has(key)) {
				continue;
			}
			open.add(key);

			const shown = this.threads.get(key) ?? new Map<string, { thread: vscode.CommentThread; content: string }>();
			this.threads.set(key, shown);
			const anchors = this.threadAnchors(ctx);
			for (const a of anchors) {
				const range = new vscode.Range(a.line, 0, a.line, 0);
				const view = this.threadView(a);
				const content = JSON.stringify([view.comment.author.name, (view.comment.body as vscode.MarkdownString).value, view.label, view.contextValue]);
				const existing = shown.get(a.key);
				if (!existing) {
					const thread = this.comments.createCommentThread(uri, range, [view.comment]);
					thread.canReply = false;
					thread.label = view.label;
					thread.contextValue = view.contextValue;
					thread.collapsibleState = collapse;
					this.threadSections.set(thread, a.section.id);
					shown.set(a.key, { thread, content });
					continue;
				}
				if (!existing.thread.range?.isEqual(range)) {
					existing.thread.range = range;
				}
				if (existing.content !== content) {
					existing.thread.comments = [view.comment];
					existing.thread.label = view.label;
					existing.thread.contextValue = view.contextValue;
					existing.content = content;
				}
			}
			const keys = new Set(anchors.map((a) => a.key));
			for (const [k, t] of shown) {
				if (!keys.has(k)) {
					t.thread.dispose();
					shown.delete(k);
				}
			}
		}
		this.disposeThreads((uri) => !open.has(uri));
	}

	/** Comment, label and context value of a thread. Notes are plain comments: no label, links or section buttons. */
	private threadView(a: ThreadAnchor): { comment: vscode.Comment; label?: string; contextValue: string } {
		if (a.note !== undefined) {
			return { comment: { body: new vscode.MarkdownString(a.note), mode: vscode.CommentMode.Preview, author: { name: 'Note' } }, contextValue: 'explainYourselfNote' };
		}
		const related = this.state.relatedSections(a.section);
		const links = related.map((r) => {
			const range = this.state.newRange(r);
			const label = `${path.posix.basename(r.file)}${range ? `:${range.start}` : ''}`;
			return `[${label}](command:explainYourself.openSection?${encodeURIComponent(JSON.stringify([r.id]))} "${r.title.replace(/"/g, "'")}")`;
		});
		const concerns = (a.section.concerns ?? []).map((c) => `- ${c.tag ? `**${c.tag}:** ` : ''}${c.text}`).join('\n');
		const body = new vscode.MarkdownString(
			(a.section.summary || '_No summary._') + (concerns ? `\n\n$(warning) **Check**\n\n${concerns}` : '') + (links.length ? `\n\n$(link) Related: ${links.join(' · ')}` : ''),
			true
		);
		body.isTrusted = { enabledCommands: ['explainYourself.openSection'] };
		return {
			comment: { body, mode: vscode.CommentMode.Preview, author: { name: plain(a.section.title) } },
			label: plain(a.category.title),
			contextValue: related.length ? 'explainYourselfGrouped' : 'explainYourselfSection'
		};
	}

	/** Comment threads shown on a document: 0-based line, whether the thread is a note, and the thread. For tests. */
	threadsOf(uri: vscode.Uri): { line: number; note: boolean; thread: vscode.CommentThread }[] {
		return [...(this.threads.get(uri.toString())?.values() ?? [])].map(({ thread }) => ({ line: thread.range?.start.line ?? -1, note: thread.contextValue === 'explainYourselfNote', thread }));
	}

	sectionOfThread(thread: vscode.CommentThread): string | undefined {
		return this.threadSections.get(thread);
	}

	/** Stages (or unstages, in the HEAD <-> index view) the selection, or the hunk under the cursor. */
	async stageSelection(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const ctx = editor && docContext(this.state.repo, editor.document.uri);
		if (!editor || !ctx || ctx.ref === 'EMPTY' || ctx.view === 'compare') {
			return;
		}

		const ranges = editor.selections.map((s) => ({
			start: s.start.line + 1,
			end: s.end.line + 1 - (s.end.character === 0 && s.end.line > s.start.line ? 1 : 0)
		}));
		const hunkMode = editor.selections.every((s) => s.isEmpty);
		const select = (d: FileDiff): Set<DiffLine> => (hunkMode ? selectHunks(hunksInRanges(d.hunks, ranges, ctx.side)) : selectLines(d.hunks, ranges, ctx.side));
		await this.apply(ctx, editor.document, select, hunkMode ? 'hunk' : 'lines');
	}

	/** Stages or unstages the hunk at `line` (on the new side) of the document `uri`. */
	async stageHunkAt(uri: string, line: number): Promise<void> {
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
		const ctx = doc && docContext(this.state.repo, doc.uri);
		if (!doc || !ctx) {
			return;
		}
		await this.apply(ctx, doc, (d) => selectHunks(hunksInRanges(d.hunks, [{ start: line, end: line }], 'new')), 'hunk');
	}

	private async apply(ctx: DocContext, doc: vscode.TextDocument, select: (d: FileDiff) => Set<DiffLine>, what: string): Promise<void> {
		const repo = this.state.repo;
		if (!repo) {
			return;
		}
		try {
			if (ctx.ref === 'WORKTREE' && doc.isDirty) {
				await doc.save();
			}
			const started = Date.now();
			const done =
				ctx.view === 'unstaged'
					? await repo.stageLines(ctx.rel, select, `Stage ${what} in ${path.posix.basename(ctx.rel)}`)
					: await repo.unstageLines(ctx.rel, select, `Unstage ${what} in ${path.posix.basename(ctx.rel)}`);
			log(`${ctx.view === 'unstaged' ? 'Stage' : 'Unstage'} ${what} ${ctx.rel}: ${done ? 'ok' : 'nothing selected'} in ${Date.now() - started} ms`);
			if (!done) {
				vscode.window.setStatusBarMessage(`ExplainYourself: no ${ctx.view === 'unstaged' ? 'unstaged' : 'staged'} change at the cursor`, 2500);
			}
			this.state.scheduleRefresh();
		} catch (e) {
			vscode.window.showErrorMessage(`ExplainYourself: ${errorMessage(e)}`);
		}
	}
}
