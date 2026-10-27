import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { indexRanges } from './core/coverage';
import { DiffLine, FileDiff } from './core/diff';
import { setGitPath } from './core/exec';
import { explainSection } from './core/explain';
import { activeRulesFile, DEFAULT_REVIEW_RULES, userRulesFile } from './core/guidance';
import { migrateUserData } from './core/legacy';
import { reviewDir, ReviewSection } from './core/review';
import { SessionCandidate } from './core/sessions';
import { selectSections } from './core/stager';
import { StatusEntry } from './core/status';
import { ChangesTree } from './ui/changesTree';
import { ClaudeAccount } from './ui/claude';
import { ContentProvider, DiffController } from './ui/diffs';
import { diffColorEnabled, ReviewView, setDiffColor } from './ui/reviewView';
import { updateSkillIfInstalled, useInSession } from './ui/skill';
import { AppState } from './ui/state';
import { config, DiffView, errorMessage, log, SCHEME } from './ui/util';

const LAST_REPO_KEY = 'explainYourself.lastRepository';

type FileArg = string | { kind: 'file'; view: DiffView; entry: StatusEntry } | vscode.Uri | undefined;

/** Returned from activate() so integration tests can inspect state. */
export interface ExplainYourselfApi {
	state: AppState;
	diffs: DiffController;
	reviewView: ReviewView;
}

export async function activate(context: vscode.ExtensionContext): Promise<ExplainYourselfApi> {
	setGitPath(config().get<string>('gitPath') || 'git');
	const state = new AppState();
	const account = new ClaudeAccount();
	const diffs = new DiffController(state);
	const reviewView = new ReviewView(context.extensionUri, state, account);
	const tree = new ChangesTree(state);
	const treeView = vscode.window.createTreeView('explainYourself.changes', { treeDataProvider: tree, canSelectMany: true });

	context.subscriptions.push(state, account, diffs, treeView);
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, new ContentProvider(state)));
	context.subscriptions.push(vscode.window.registerWebviewViewProvider('explainYourself.review', reviewView, { webviewOptions: { retainContextWhenHidden: true } }));

	const setRepoContext = () => {
		vscode.commands.executeCommand('setContext', 'explainYourself.hasRepository', !!state.repo);
		vscode.commands.executeCommand('setContext', 'explainYourself.canUndo', !!state.repo?.canUndo);
		vscode.commands.executeCommand('setContext', 'explainYourself.canRedo', !!state.repo?.canRedo);
	};
	context.subscriptions.push(state.onDidChangeRepo(() => {
		setRepoContext();
		treeView.description = state.repo ? path.basename(state.repo.root) : undefined;
	}));

	const requireRepo = () => {
		if (!state.repo) {
			vscode.window.showWarningMessage('ExplainYourself: open a Git repository first.');
		}
		return state.repo;
	};

	const filesOf = (arg: FileArg, selected?: readonly unknown[]): string[] => {
		const items = selected && selected.length > 0 ? selected : [arg];
		return items
			.map((a) => {
				if (typeof a === 'string') {
					return a;
				}
				if (a instanceof vscode.Uri) {
					return state.repo?.relPath(a.fsPath) ?? undefined;
				}
				return (a as { entry?: StatusEntry } | undefined)?.entry?.path;
			})
			.filter((p): p is string => !!p);
	};

	const guarded = (fn: (...args: any[]) => Promise<unknown>) => async (...args: any[]) => {
		try {
			await fn(...args);
		} catch (e) {
			log(errorMessage(e));
			vscode.window.showErrorMessage(`ExplainYourself: ${errorMessage(e)}`);
		}
	};

	const register = (id: string, fn: (...args: any[]) => Promise<unknown> | unknown) =>
		context.subscriptions.push(vscode.commands.registerCommand(id, guarded(async (...args) => fn(...args))));

	const openRepo = async (dir: string) => {
		await state.openRepository(dir);
		await context.globalState.update(LAST_REPO_KEY, state.repo!.root);
		setRepoContext();
	};

	/** Stages every unstaged change inside the given sections, and the small changes next to them, as one undo step. */
	const stageSections = async (sections: ReviewSection[], label: string) => {
		const repo = requireRepo();
		if (!repo) {
			return;
		}
		const byFile = new Map<string, ReviewSection[]>();
		for (const s of sections.flatMap((x) => state.stageUnits(x))) {
			if (state.sectionStatus(s) === 'pending') {
				byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
			}
		}
		const items = [...byFile].map(([rel, list]) => {
			const newRanges = list.map((s) => state.newRange(s)).filter((r) => !!r) as { start: number; end: number }[];
			const oldRanges = list.flatMap((s) => (s.oldRange ? indexRanges(repo, s, undefined) : []));
			return {
				rel,
				select: (d: FileDiff) => selectSections(d.hunks, newRanges, oldRanges)
			};
		});
		if (items.length > 0) {
			await repo.stageSelections(items, label);
			state.scheduleRefresh();
		}
	};

	register('explainYourself.openRepository', async () => {
		const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Open Repository' });
		if (picked?.[0]) {
			await openRepo(picked[0].fsPath);
			vscode.commands.executeCommand('workbench.view.extension.explainYourself');
		}
	});
	register('explainYourself.refresh', async () => {
		await requireRepo()?.refresh();
		await state.reloadReview();
	});
	register('explainYourself.openDiff', (rel: string, view: DiffView) => diffs.openDiff(rel, view === 'staged' ? 'staged' : 'unstaged'));
	register('explainYourself.openDiffAt', (rel: string, line: number) => {
		const repo = requireRepo();
		const view = repo && !repo.unstaged.has(rel) && repo.staged.has(rel) ? 'staged' : 'unstaged';
		return diffs.openDiff(rel, view, { range: { start: line, end: line }, side: 'new' });
	});
	register('explainYourself.stageFile', async (arg: FileArg, selected?: unknown[]) => {
		const files = filesOf(arg, selected);
		if (files.length > 0) {
			await requireRepo()?.stageFiles(files, `Stage ${files.length === 1 ? path.posix.basename(files[0]) : `${files.length} files`}`);
		}
	});
	register('explainYourself.unstageFile', async (arg: FileArg, selected?: unknown[]) => {
		const files = filesOf(arg, selected);
		if (files.length > 0) {
			await requireRepo()?.unstageFiles(files, `Unstage ${files.length === 1 ? path.posix.basename(files[0]) : `${files.length} files`}`);
		}
	});
	register('explainYourself.stageAll', async () => {
		const repo = requireRepo();
		const files = repo?.unstagedEntries.map((e) => e.path) ?? [];
		if (files.length > 0) {
			await repo!.stageFiles(files, 'Stage all');
		}
	});
	register('explainYourself.unstageAll', async () => {
		const repo = requireRepo();
		const files = repo?.stagedEntries.map((e) => e.path) ?? [];
		if (files.length > 0) {
			await repo!.unstageFiles(files, 'Unstage all');
		}
	});
	register('explainYourself.stageSelection', () => diffs.stageSelection());
	register('explainYourself.stageHunk', (uri: string, line: number) => diffs.stageHunkAt(uri, line));
	register('explainYourself.unstageHunk', (uri: string, line: number) => diffs.stageHunkAt(uri, line));
	register('explainYourself.undo', async () => {
		const label = await requireRepo()?.undo();
		vscode.window.setStatusBarMessage(label ? `ExplainYourself: undid "${label}"` : 'ExplainYourself: nothing to undo', 2500);
	});
	register('explainYourself.redo', async () => {
		const label = await requireRepo()?.redo();
		vscode.window.setStatusBarMessage(label ? `ExplainYourself: redid "${label}"` : 'ExplainYourself: nothing to redo', 2500);
	});

	/** Asks which session to fork for the review: the sessions that edited the changes, best match first, or a new agent. */
	const chooseSession = async (sessions: SessionCandidate[]): Promise<SessionCandidate | 'new' | undefined> => {
		type Item = vscode.QuickPickItem & { choice?: SessionCandidate | 'new' };
		const ago = (d: Date) => {
			const minutes = Math.round((Date.now() - d.getTime()) / 60000);
			return minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
		};
		const item = (s: SessionCandidate): Item => ({
			label: s.title || s.sessionId,
			description: `${s.writtenLines > 0 ? `wrote ${s.writtenLines} changed line(s)` : 'none of its edits are uncommitted'} · last edit ${ago(s.lastEdit ?? s.lastActive)}`,
			detail: `${Object.keys(s.editedFiles).length} changed file(s): ${Object.keys(s.editedFiles).map((f) => f.split('/').pop()).slice(0, 6).join(', ')}`,
			choice: s
		});
		const writers = sessions.filter((s) => s.writtenLines > 0);
		const others = sessions.filter((s) => s.writtenLines === 0);
		const fresh: Item = { label: '$(add) New agent', description: 'without a session', detail: 'Reads the code, and the transcripts of the sessions below, for intent.', choice: 'new' };
		const items: Item[] = [
			...writers.map(item),
			...(writers.length > 0 ? [{ label: '', kind: vscode.QuickPickItemKind.Separator }] : []),
			fresh,
			...(others.length > 0 ? [{ label: 'Edited these files earlier', kind: vscode.QuickPickItemKind.Separator }, ...others.slice(0, 10).map(item)] : [])
		];
		const pick = await vscode.window.showQuickPick(items, { title: 'Which Claude session should write the review?', placeHolder: 'The session is forked; the original is not changed.', matchOnDescription: true, matchOnDetail: true });
		return pick?.choice;
	};

	const startGeneration = async (source: Parameters<AppState['generate']>[0], ask = config().get<boolean>('askForSession', true)) => {
		if (!requireRepo()) {
			return;
		}
		await account.refresh();
		if (!account.status.installed || !account.claudePath) {
			await account.showMenu();
			return;
		}
		if (!account.status.loggedIn) {
			const pick = await vscode.window.showWarningMessage('ExplainYourself: Claude is not signed in.', 'Sign in', 'Try anyway');
			if (pick === 'Sign in') {
				account.signIn();
				return;
			}
			if (pick !== 'Try anyway') {
				return;
			}
		}
		vscode.commands.executeCommand('explainYourself.review.focus');
		if (await state.generate(source, account.claudePath, ask ? chooseSession : undefined)) {
			vscode.window.showInformationMessage('ExplainYourself: the review is up to date; no reviewed file changed.');
		}
		if (state.generation?.error) {
			vscode.window.showErrorMessage(`ExplainYourself: ${state.generation.error.split('\n')[0]}`);
		}
	};
	register('explainYourself.generate', () => startGeneration({ kind: 'auto' }));
	register('explainYourself.updateReview', () => startGeneration({ kind: 'update' }));
	register('explainYourself.generateFresh', () => startGeneration({ kind: 'fresh' }));
	// Asks for the session even when the setting says not to.
	register('explainYourself.generateFromSession', () => startGeneration({ kind: 'auto' }, true));
	register('explainYourself.cancelGeneration', () => state.cancelGeneration());
	register('explainYourself.setSubmodules', (paths: string[]) => state.setSubmodules(paths));
	register('explainYourself.selectSubmodules', async () => {
		const repo = requireRepo();
		if (!repo) {
			return;
		}
		const available = repo.submodules.filter((m) => m.initialized);
		if (available.length === 0) {
			vscode.window.showInformationMessage('ExplainYourself: this repository has no initialized submodules.');
			return;
		}
		const picked = await vscode.window.showQuickPick(
			available.map((m) => ({ label: m.path, description: repo.submoduleChanged(m.path) ? 'changed' : undefined, picked: repo.selectedSubmodules.includes(m.path) })),
			{ canPickMany: true, title: 'Submodules to include in the review' }
		);
		if (picked) {
			await state.setSubmodules(picked.map((p) => p.label));
		}
	});
	register('explainYourself.showPrompt', async () => {
		if (!state.repo) {
			return;
		}
		const file = vscode.Uri.file(path.join(reviewDir(state.repo.gitDir), 'prompt.md'));
		try {
			await vscode.workspace.fs.stat(file);
		} catch {
			vscode.window.showInformationMessage('No prompt yet. The prompt is saved when a review is generated or updated.');
			return;
		}
		await vscode.window.showTextDocument(file, { preview: true });
	});
	register('explainYourself.editReviewRules', async () => {
		// The repository's rules file when it has one, otherwise the user's, created with the default rules.
		const active = state.repo ? await activeRulesFile(state.repo.root) : null;
		const file = vscode.Uri.file(active ?? userRulesFile());
		if (!active) {
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file.fsPath)));
			await vscode.workspace.fs.writeFile(file, Buffer.from(DEFAULT_REVIEW_RULES, 'utf8'));
		}
		await vscode.window.showTextDocument(file);
	});
	register('explainYourself.useInSession', () => useInSession(context.extensionPath, state.repo?.root));

	register('explainYourself.openSection', (id: string) => diffs.openSection(id));
	register('explainYourself.compareSection', (arg: string | vscode.CommentThread) => {
		const id = typeof arg === 'string' ? arg : diffs.sectionOfThread(arg);
		return id ? diffs.compareSection(id) : undefined;
	});
	register('explainYourself.compareAtCursor', () => diffs.compareAtCursor());
	// Comment threads pass themselves; editor title buttons pass the editor's URI, which is ignored.
	register('explainYourself.goToRelated', (arg?: unknown) =>
		diffs.goToRelated(typeof arg === 'string' ? arg : arg && typeof arg === 'object' && 'comments' in arg ? diffs.sectionOfThread(arg as vscode.CommentThread) : undefined)
	);
	register('explainYourself.showAsDiff', () => diffs.showAsDiff());
	register('explainYourself.togglePlainCompare', () => config().update('plainCompare', !config().get('plainCompare', false), vscode.ConfigurationTarget.Global));
	register('explainYourself.stageSection', async (arg: string | vscode.CommentThread) => {
		const id = typeof arg === 'string' ? arg : diffs.sectionOfThread(arg);
		const found = id ? state.findSection(id) : undefined;
		if (!found) {
			return;
		}
		// Pick the next section before staging: the next one in review order that still has unstaged changes.
		const all = (state.review?.categories ?? []).flatMap((c) => c.sections);
		const index = all.indexOf(found.section);
		const next = [...all.slice(index + 1), ...all.slice(0, index)].find((s) => state.sectionStatus(s) === 'pending');
		await stageSections([found.section], `Stage section "${found.section.title}"`);
		if (next && config().get('jumpToNextSection', true)) {
			await diffs.openSection(next.id);
			reviewView.follow(next.id);
		}
	});
	register('explainYourself.revealSection', (thread: vscode.CommentThread) => {
		const id = diffs.sectionOfThread(thread);
		if (id) {
			reviewView.reveal(id);
		}
	});
	// One explanation at a time: each continues the review session.
	let explaining: string | undefined;
	register('explainYourself.explainSection', async (arg: string | vscode.CommentThread) => {
		const id = typeof arg === 'string' ? arg : diffs.sectionOfThread(arg);
		const found = id ? state.findSection(id) : undefined;
		const review = state.review;
		if (!found || !review) {
			return;
		}
		if (explaining || (state.generation && !state.generation.done)) {
			vscode.window.showInformationMessage(`ExplainYourself: wait until ${explaining ? `"${explaining}" is explained` : 'the review is generated'}.`);
			return;
		}
		await account.refresh();
		if (!account.status.installed || !account.claudePath) {
			await account.showMenu();
			return;
		}
		const claudePath = account.claudePath;
		const { section } = found;
		explaining = section.title;
		try {
			const request = await state.explainRequest(section);
			const source = review.source;
			const explanation = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `ExplainYourself: explaining "${section.title}" in more detail…`, cancellable: true },
				(_progress, token) =>
					explainSection(request, {
						claudePath,
						model: config().get<string>('model', 'claude-sonnet-5-5') || undefined,
						repoRoot: state.repo!.root,
						session: source.reviewSessionId && source.reviewCwd && fs.existsSync(source.reviewCwd) ? { id: source.reviewSessionId, cwd: source.reviewCwd } : undefined,
						onStart: (run) => token.onCancellationRequested(() => run.cancel())
					})
			);
			if (state.review !== review) {
				throw new Error('The review was regenerated meanwhile.');
			}
			await state.applyExplanation(section.id, explanation);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			if (message !== 'Cancelled.') {
				vscode.window.showErrorMessage(`ExplainYourself: could not explain "${section.title}": ${message.split('\n')[0]}`);
			}
		} finally {
			explaining = undefined;
		}
	});
	register('explainYourself.stageUncovered', async () => {
		const sections = state.uncoveredSections();
		await stageSections(sections, `Stage ${sections.length === 1 ? 'the change' : `${sections.length} changes`} not covered by the review`);
	});
	register('explainYourself.stageCategory', async (id: string) => {
		const category = state.review?.categories.find((c) => c.id === id);
		if (category) {
			await stageSections(category.sections, `Stage category "${category.title}"`);
		}
	});

	// Every on/off setting, in one checklist; the title button opens the rest (model, paths, diff algorithm).
	register('explainYourself.settings', async () => {
		type Item = vscode.QuickPickItem & { key?: string; on?: boolean };
		const setting = (key: string, label: string, detail: string, fallback: boolean): Item => ({ key, label, detail, on: config().get<boolean>(key, fallback) });
		const items: Item[] = [
			{ label: 'Diffs', kind: vscode.QuickPickItemKind.Separator },
			{ key: 'changedLines', label: 'Changed lines', detail: 'Diff background on changed lines.', on: diffColorEnabled('changedLines') },
			{ key: 'changedWords', label: 'Changed words', detail: 'Diff background on changed words.', on: diffColorEnabled('changedWords') },
			setting('showSummaries', 'Summaries in diffs', 'Section summaries as comments above each section.', true),
			setting('summariesExpanded', 'Summaries expanded', 'Expand those comments by default.', true),
			setting('highlightSections', 'Section highlights', 'Shade the lines each section covers.', true),
			setting('codeLens', 'Stage hunk buttons', '"Stage hunk" / "Unstage hunk" above each hunk.', true),
			setting('plainCompare', 'Plain Old ↔ New', 'No highlights, summaries or buttons in the old/new comparison.', false),
			setting('stageFromEditors', 'Staging in plain editors', 'Stage hunk buttons in editors of repository files too, not only in diffs.', false),
			{ label: 'Review', kind: vscode.QuickPickItemKind.Separator },
			setting('jumpToNextSection', 'Jump to the next section', 'After staging a section, open the next one with unstaged changes.', true),
			setting('askForSession', 'Ask which session to fork', 'Before generating a review; otherwise the best match is used.', true)
		];
		const all = { iconPath: new vscode.ThemeIcon('settings-gear'), tooltip: 'All ExplainYourself settings: model, paths, diff algorithm…' };
		const pick = vscode.window.createQuickPick<Item>();
		pick.title = 'ExplainYourself settings';
		pick.placeholder = 'Check the settings to turn on, then press Enter';
		pick.canSelectMany = true;
		pick.matchOnDetail = true;
		pick.items = items;
		pick.selectedItems = items.filter((i) => i.on);
		pick.buttons = [all];
		const accepted = await new Promise<boolean>((resolve) => {
			pick.onDidAccept(() => resolve(true));
			pick.onDidHide(() => resolve(false));
			pick.onDidTriggerButton(() => {
				resolve(false);
				vscode.commands.executeCommand('workbench.action.openSettings', '@ext:markopintera.explain-yourself');
			});
			pick.show();
		});
		const selected = new Set(pick.selectedItems);
		pick.dispose();
		if (!accepted) {
			return;
		}
		for (const item of items.filter((i) => i.key && selected.has(i) !== i.on)) {
			await vscode.commands.executeCommand('explainYourself.setToggle', item.key, selected.has(item));
		}
	});
	register('explainYourself.setToggle', async (name: string, value: boolean) => {
		if (name === 'changedLines' || name === 'changedWords') {
			await setDiffColor(name, value);
		} else {
			// Older names of two settings.
			const key = name === 'summaries' ? 'showSummaries' : name;
			await config().update(key, value, vscode.ConfigurationTarget.Global);
		}
	});
	register('explainYourself.setModel', (model: string) => config().update('model', model, vscode.ConfigurationTarget.Global));
	register('explainYourself.toggleInline', async () => {
		const diffConfig = vscode.workspace.getConfiguration('diffEditor');
		await diffConfig.update('renderSideBySide', !diffConfig.get('renderSideBySide', true), vscode.ConfigurationTarget.Global);
	});
	register('explainYourself.account', () => account.showMenu());
	register('explainYourself.signIn', () => account.signIn());

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('explainYourself.gitPath')) {
			setGitPath(config().get<string>('gitPath') || 'git');
		}
		if (e.affectsConfiguration('explainYourself.diffAlgorithm') && state.repo) {
			state.repo.diffAlgorithm = config().get<string>('diffAlgorithm', 'histogram');
			state.scheduleRefresh();
		}
	}));

	await migrateUserData();
	await migrateLegacySettings(context);
	setRepoContext();
	account.refresh();
	updateSkillIfInstalled(context.extensionPath);
	offerDiffCodeLens(context);

	// Open the workspace repository, or the one used last.
	const candidates = [...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath), context.globalState.get<string>(LAST_REPO_KEY)].filter((p): p is string => !!p);
	for (const dir of candidates) {
		try {
			await openRepo(dir);
			break;
		} catch {
			// Not a repository; try the next candidate.
		}
	}
	return { state, diffs, reviewView };
}

/** Copies user settings from the extension's former name (SlopReview), once. */
async function migrateLegacySettings(context: vscode.ExtensionContext): Promise<void> {
	const done = 'explainYourself.legacySettingsMigrated';
	if (context.globalState.get(done)) {
		return;
	}
	const legacy = vscode.workspace.getConfiguration('slopReview');
	const properties = Object.keys(context.extension.packageJSON.contributes?.configuration?.properties ?? {});
	for (const key of properties.map((p) => p.replace(/^explainYourself\./, ''))) {
		const value = legacy.inspect(key)?.globalValue;
		if (value !== undefined && config().inspect(key)?.globalValue === undefined) {
			await config().update(key, value, vscode.ConfigurationTarget.Global);
		}
	}
	await context.globalState.update(done, true);
}

/** Stage buttons are CodeLenses, which diff editors hide unless diffEditor.codeLens is on. */
async function offerDiffCodeLens(context: vscode.ExtensionContext): Promise<void> {
	const diffConfig = vscode.workspace.getConfiguration('diffEditor');
	if (diffConfig.get('codeLens') || context.globalState.get('explainYourself.codeLensOffered')) {
		return;
	}
	await context.globalState.update('explainYourself.codeLensOffered', true);
	const pick = await vscode.window.showInformationMessage(
		'ExplainYourself shows "Stage hunk" buttons as CodeLenses. VS Code hides CodeLenses in diff editors unless "diffEditor.codeLens" is enabled. Enable it?',
		'Enable',
		'Not now'
	);
	if (pick === 'Enable') {
		await diffConfig.update('codeLens', true, vscode.ConfigurationTarget.Global);
	}
}

export function deactivate(): void {
	// Disposables are released through the extension context.
}
