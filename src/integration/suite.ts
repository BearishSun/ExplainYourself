/**
 * Integration checks that run inside a VS Code extension host. Launched by scripts/integration.js.
 * Results are written to the file named by EXPLAIN_TEST_OUT because a GUI process has no usable stdout.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import type { ExplainYourselfApi } from '../extension';

const lines: string[] = [];
const report = (s: string) => lines.push(s);

function check(cond: unknown, what: string): void {
	report(`${cond ? 'PASS' : 'FAIL'} ${what}`);
	if (!cond) {
		throw new Error(`Check failed: ${what}`);
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | false, what: string, ms = 10000): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = fn();
		if (v) {
			return v;
		}
		await sleep(50);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** Opens an existing reviewed repository and leaves a representative screen for a screenshot. */
async function demo(out: string): Promise<void> {
	const ext = vscode.extensions.getExtension<ExplainYourselfApi>('MarkoPintera.explain-yourself')!;
	const { state } = await ext.activate();
	await waitFor(() => state.review, 'review');
	await vscode.workspace.getConfiguration('diffEditor').update('renderSideBySide', true, vscode.ConfigurationTarget.Global);
	await vscode.workspace.getConfiguration('diffEditor').update('useInlineViewWhenSpaceIsLimited', false, vscode.ConfigurationTarget.Global);
	await vscode.commands.executeCommand('workbench.action.closePanel');
	await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
	await vscode.commands.executeCommand('workbench.view.extension.explainYourself');
	const category = state.review!.categories[Number(process.env.EXPLAIN_DEMO_CATEGORY ?? 0)];
	const section = category.sections[Number(process.env.EXPLAIN_DEMO_SECTION ?? 0)];
	await vscode.commands.executeCommand(process.env.EXPLAIN_DEMO_COMPARE ? 'explainYourself.compareSection' : 'explainYourself.openSection', section.id);
	fs.writeFileSync(path.join(path.dirname(out), 'screenshot-ready'), '');
	await waitFor(() => fs.existsSync(path.join(path.dirname(out), 'screenshot-done')), 'screenshot', 20000).catch(() => undefined);
	fs.writeFileSync(out, 'DONE\n');
}

export async function run(): Promise<void> {
	const out = process.env.EXPLAIN_TEST_OUT!;
	if (process.env.EXPLAIN_DEMO) {
		return demo(out);
	}
	const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
	try {
		const ext = vscode.extensions.getExtension<ExplainYourselfApi>('MarkoPintera.explain-yourself')!;
		const api = await ext.activate();
		const state = api.state;
		await waitFor(() => state.repo && state.repo.status.length > 0, 'repository');
		check(state.repo!.unstagedEntries.length === 2, 'two unstaged entries (modified + untracked)');

		// A repository without a review: the panel offers Generate review.
		await vscode.commands.executeCommand('explainYourself.review.focus');
		const buttons = await waitFor(() => (api.reviewView.renderedButtons.includes('Generate review') ? api.reviewView.renderedButtons : undefined), 'review panel rendered', 15000).catch(
			() => api.reviewView.renderedButtons
		);
		check(buttons.includes('Generate review'), `review panel offers Generate review (buttons: ${JSON.stringify(buttons)})`);

		await vscode.commands.executeCommand('explainYourself.openDiff', 'a.txt', 'unstaged');
		const editor = await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('a.txt') && vscode.window.activeTextEditor, 'diff editor');
		check(vscode.window.visibleTextEditors.some((e) => e.document.uri.scheme === 'explainyourself'), 'index side is visible');

		const codeLenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', editor.document.uri)) ?? [];
		const stageLenses = codeLenses.filter((l) => l.command?.title.includes('Stage hunk'));
		check(stageLenses.length === 3, `three Stage hunk lenses (got ${stageLenses.length})`);

		// Stage the hunk under the cursor on line 20.
		editor.selection = new vscode.Selection(19, 0, 19, 0);
		let t = Date.now();
		await vscode.commands.executeCommand('explainYourself.stageSelection');
		const stageMs = Date.now() - t;
		const index1 = git('cat-file', 'blob', ':a.txt');
		check(index1.includes('line 20 changed') && !index1.includes('line 5 changed'), 'hunk at cursor staged alone');
		report(`INFO stage hunk took ${stageMs} ms`);

		const indexDoc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'explainyourself' && d.uri.query.includes('INDEX'))!;
		await waitFor(() => indexDoc.getText().includes('line 20 changed'), 'index document refresh', 3000);
		report(`INFO index document refreshed ${Date.now() - t} ms after the stage command started`);

		// Warm timings: stage and undo the same hunk a few times.
		for (let i = 0; i < 4; i++) {
			await vscode.commands.executeCommand('explainYourself.undo');
			await sleep(400);
			editor.selection = new vscode.Selection(19, 0, 19, 0);
			const start = Date.now();
			let firstEmit = 0;
			const sub = state.repo!.onDidChange(() => (firstEmit ||= Date.now() - start));
			const docChanged = new Promise<number>((resolve) => {
				const d = vscode.workspace.onDidChangeTextDocument((e) => {
					if (e.document === indexDoc) {
						d.dispose();
						resolve(Date.now() - start);
					}
				});
			});
			await vscode.commands.executeCommand('explainYourself.stageSelection');
			const commandMs = Date.now() - start;
			const docMs = await Promise.race([docChanged, sleep(2000).then(() => -1)]);
			sub.dispose();
			report(`INFO warm stage #${i + 1}: diff views updated after ${firstEmit} ms, index document after ${docMs} ms, command finished after ${commandMs} ms`);
		}

		report(`INFO diff cache ${JSON.stringify(state.repo!.cacheStats)}`);

		// Undo restores the index.
		t = Date.now();
		const undoDoc = new Promise<number>((resolve) => {
			const d = vscode.workspace.onDidChangeTextDocument((e) => {
				if (e.document === indexDoc) {
					d.dispose();
					resolve(Date.now() - t);
				}
			});
		});
		await vscode.commands.executeCommand('explainYourself.undo');
		report(`INFO undo: index document after ${await Promise.race([undoDoc, sleep(2000).then(() => -1)])} ms, command finished after ${Date.now() - t} ms`);
		check(!git('cat-file', 'blob', ':a.txt').includes('line 20 changed'), 'undo restores the index');
		await vscode.commands.executeCommand('explainYourself.redo');
		check(git('cat-file', 'blob', ':a.txt').includes('line 20 changed'), 'redo re-stages');
		await vscode.commands.executeCommand('explainYourself.undo');

		// Line selection: lines 5-5 only.
		editor.selection = new vscode.Selection(4, 0, 4, 3);
		await vscode.commands.executeCommand('explainYourself.stageSelection');
		const index2 = git('cat-file', 'blob', ':a.txt');
		check(index2.includes('line 5 changed') && !index2.includes('line 20 changed'), 'selected line staged');
		await vscode.commands.executeCommand('explainYourself.undo');

		// Load a review and check derived state.
		const review = {
			version: 1,
			generatedAt: new Date().toISOString(),
			head: state.repo!.head,
			source: { kind: 'fresh' },
			overview: 'Test review.',
			// Fingerprints of the reviewed files let section positions follow later edits.
			fingerprints: Object.fromEntries(['a.txt', 'b.txt'].map((f) => [f, createHash('sha1').update(fs.readFileSync(path.join(root, f))).digest('hex')])),
			categories: [
				{
					id: 'c1',
					title: 'Numbers',
					oldBehavior: 'Plain lines.',
					newBehavior: 'Some lines say **changed**.',
					sections: [
						{ id: 'c1s1', file: 'a.txt', title: 'Fifth line', summary: 'Line five now says `changed`.', newRange: { start: 4, end: 6 }, group: 'pair' },
						{ id: 'c1s2', file: 'a.txt', title: 'Twentieth line', summary: 'Line twenty changed too.', newRange: { start: 19, end: 21 }, notes: [{ line: 20, text: 'The changed line.' }] }
					]
				},
				{
					id: 'c2',
					title: 'New file',
					oldBehavior: 'Did not exist.',
					newBehavior: 'Adds b.txt.',
					sections: [{ id: 'c2s1', file: 'b.txt', title: 'b.txt', summary: 'A new file.', newRange: { start: 1, end: 2 }, group: 'pair' }]
				},
				{
					id: 'c3',
					title: 'Rewrite',
					oldBehavior: 'Old block.',
					newBehavior: 'New block.',
					sections: [{ id: 'c3s1', file: 'a.txt', title: 'Block 18-22', summary: 'Rewritten block.', newRange: { start: 18, end: 22 } }]
				}
			]
		};
		const gitDir = state.repo!.gitDir;
		fs.mkdirSync(path.join(gitDir, 'explainyourself'), { recursive: true });
		fs.writeFileSync(path.join(gitDir, 'explainyourself', 'review.json'), JSON.stringify(review));
		await waitFor(() => state.review && state.uncovered.length > 0, 'review load');
		check(state.uncovered.length === 1 && state.uncovered[0].line === 26, `one uncovered change at line 26 (got ${JSON.stringify(state.uncovered)})`);
		check(state.sectionStatus(state.findSection('c1s2')!.section) === 'pending', 'section pending before staging');

		// Stage all for changes no section covers stages exactly those lines, as one undo step.
		const cachedLines = () => git('diff', '--cached', '--', 'a.txt').split('\n').filter((l) => /^[+-](?![+-])/.test(l)).length;
		const indexBefore = git('cat-file', 'blob', ':a.txt');
		const linesBefore = cachedLines();
		await vscode.commands.executeCommand('explainYourself.stageUncovered');
		check(cachedLines() === linesBefore + 1, `uncovered change staged alone (${linesBefore} -> ${cachedLines()} staged lines)`);
		await waitFor(() => state.uncoveredSections().every((u) => state.sectionStatus(u) === 'staged'), 'uncovered change shows as staged', 3000).catch(() => undefined);
		check(state.uncoveredSections().every((u) => state.sectionStatus(u) === 'staged'), 'uncovered change shows as staged');
		await vscode.commands.executeCommand('explainYourself.undo');
		check(git('cat-file', 'blob', ':a.txt') === indexBefore, 'undo unstages it');

		// Old/new comparison of a section, which opens only on request.
		check(JSON.stringify(state.compareOldRange(state.findSection('c3s1')!.section)) === JSON.stringify({ start: 18, end: 22 }), 'derived old range');
		await vscode.commands.executeCommand('explainYourself.openSection', 'c3s1');
		check(
			await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff, 'section opens as a diff', 3000).then(() => true, () => false),
			'section opens as a diff'
		);
		await vscode.commands.executeCommand('explainYourself.compareSection', 'c3s1');
		const isCompareDoc = (e: vscode.TextEditor) => e.document.uri.scheme === 'explainyourself' && e.document.uri.query.includes('"compare"');
		const leftEditor = await waitFor(() => vscode.window.visibleTextEditors.find(isCompareDoc), 'compare HEAD editor');
		const rightEditor = await waitFor(
			() => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file' && e.document.uri.fsPath.endsWith('a.txt')),
			'compare working tree editor'
		);
		check(leftEditor.viewColumn === vscode.ViewColumn.One && rightEditor.viewColumn === vscode.ViewColumn.Two, 'HEAD left, working tree right');
		check(leftEditor.document.getText() === git('show', 'HEAD:a.txt'), 'left side shows HEAD');
		check(!vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputTextDiff)), 'comparison replaced the diff');
		check(leftEditor.visibleRanges[0].start.line <= 17 && rightEditor.visibleRanges[0].start.line <= 17, 'both sides revealed at the section');
		const compareLenses = async () =>
			((await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', rightEditor.document.uri)) ?? []).filter((l) => l.command?.title.includes('Stage hunk')).length;
		check((await compareLenses()) > 0, 'stage lenses in the comparison');
		await vscode.commands.executeCommand('explainYourself.togglePlainCompare');
		await sleep(300);
		check((await compareLenses()) === 0, 'plain mode hides lenses');
		await vscode.commands.executeCommand('explainYourself.togglePlainCompare');
		await vscode.window.showTextDocument(rightEditor.document, rightEditor.viewColumn);
		await vscode.commands.executeCommand('explainYourself.showAsDiff');
		await waitFor(() => !vscode.window.visibleTextEditors.some(isCompareDoc), 'comparison closed');
		check(
			vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.fsPath.endsWith('a.txt'))),
			'show as diff opens the diff'
		);
		check(vscode.window.tabGroups.all.length === 1, 'comparison split closed');

		// Related sections: jump from a.txt to b.txt and back.
		check(state.relatedSections(state.findSection('c1s1')!.section).map((r) => r.id).join() === 'c2s1', 'group links the two sections');
		await vscode.commands.executeCommand('explainYourself.openSection', 'c1s1');
		const pairEditor = await waitFor(() => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file' && e.document.uri.fsPath.endsWith('a.txt')), 'a.txt diff');
		await vscode.window.showTextDocument(pairEditor.document, { viewColumn: pairEditor.viewColumn, selection: new vscode.Range(4, 0, 4, 0) });
		const noteThreads = () => api.diffs.threadsOf(pairEditor.document.uri).filter((t) => t.note).map((t) => t.line);
		await waitFor(() => noteThreads().length > 0, 'note thread', 3000).catch(() => undefined);
		check(JSON.stringify(noteThreads()) === '[18]', `note shown above its line (${JSON.stringify(api.diffs.threadsOf(pairEditor.document.uri).map(({ line, note }) => ({ line, note })))})`);
		await vscode.commands.executeCommand('explainYourself.goToRelated');
		await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('b.txt'), 'go to related opens b.txt');
		check(true, 'go to related opens the other section');
		await vscode.commands.executeCommand('explainYourself.goToRelated');
		await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('a.txt'), 'go to related returns to a.txt');
		check(vscode.window.activeTextEditor!.selection.active.line === 3, `returned to the section start (line ${vscode.window.activeTextEditor!.selection.active.line + 1})`);
		// In the diff, section lines are highlighted; overlapping sections merge into one range.
		const diffUri = vscode.window.activeTextEditor!.document.uri;
		await waitFor(() => api.diffs.highlightsOf(diffUri).length > 0, 'highlights', 3000).catch(() => undefined);
		const highlighted = JSON.stringify(api.diffs.highlightsOf(diffUri));
		check(highlighted === JSON.stringify([{ start: 4, end: 6 }, { start: 18, end: 22 }]), `section lines highlighted (${highlighted})`);

		await vscode.commands.executeCommand('explainYourself.stageSection', 'c1s2');
		await waitFor(() => state.sectionStatus(state.findSection('c1s2')!.section) === 'staged', 'section staged', 3000);
		check(state.sectionStatus(state.findSection('c1s1')!.section) === 'pending', 'other section still pending');
		// Staging jumps to the next section with unstaged changes: c2s1 in b.txt.
		await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('b.txt'), 'jump to the next section', 3000).catch(() => undefined);
		check(!!vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('b.txt'), 'staging a section opens the next one');

		await vscode.commands.executeCommand('explainYourself.stageCategory', 'c2');
		check(git('ls-files', 'b.txt').trim() === 'b.txt', 'untracked file staged through its category');
		check(git('cat-file', 'blob', ':b.txt') === 'b1\nb2\n', 'untracked file content staged');
		await vscode.commands.executeCommand('explainYourself.openSection', 'c1s1');
		await waitFor(() => vscode.window.visibleTextEditors.some((e) => e.document.uri.scheme === 'file' && e.document.uri.fsPath.endsWith('a.txt')), 'a.txt diff again');

		// Editing above a section shifts its range.
		// The comparison closed the original editor; use the one the diff shows now.
		const aEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file' && e.document.uri.fsPath.endsWith('a.txt'))!;
		const c1s2 = () => state.findSection('c1s2')!.section;
		const threadsBefore = api.diffs.threadsOf(aEditor.document.uri);
		await aEditor.edit((e) => e.insert(new vscode.Position(0, 0), 'inserted\n'));
		await waitFor(() => state.newRange(c1s2())!.start === 20, 'section range follows edits', 3000).catch(() => undefined);
		check(state.newRange(c1s2())!.start === 20 && state.notes(c1s2())[0].line === 21, `section range and note follow edits (${JSON.stringify([state.newRange(c1s2()), state.notes(c1s2())])})`);
		// Threads move in place; replacing them makes the editor jump.
		await waitFor(() => api.diffs.threadsOf(aEditor.document.uri)[0]?.line !== threadsBefore[0]?.line, 'threads move', 3000).catch(() => undefined);
		const threadsAfter = api.diffs.threadsOf(aEditor.document.uri);
		check(
			threadsBefore.length > 0 && threadsAfter.length === threadsBefore.length && threadsAfter.every((t, i) => t.thread === threadsBefore[i].thread && t.line === threadsBefore[i].line + 1),
			`comment threads move in place (${JSON.stringify(threadsBefore.map((t) => t.line))} -> ${JSON.stringify(threadsAfter.map((t) => t.line))})`
		);
		await vscode.commands.executeCommand('undo');
		await waitFor(() => state.newRange(c1s2())!.start === 19, 'undo moves the range back', 3000).catch(() => undefined);
		check(state.newRange(c1s2())!.start === 19, 'range moves back after undo');

		// Edits made outside VS Code move positions by content: line 20 rewritten, two lines added above.
		const aPath = path.join(root, 'a.txt');
		const aBefore = fs.readFileSync(aPath, 'utf8');
		await vscode.workspace.saveAll(false);
		const aLines = aBefore.split('\n');
		aLines.splice(19, 1, 'line 20 rewritten outside');
		fs.writeFileSync(aPath, ['top 1', 'top 2', ...aLines].join('\n'));
		await waitFor(() => state.newRange(c1s2())!.start === 21, 'range follows a disk edit', 5000).catch(() => undefined);
		check(
			JSON.stringify(state.newRange(c1s2())) === JSON.stringify({ start: 21, end: 23 }) && state.notes(c1s2())[0].line === 22,
			`range and note follow a disk edit (${JSON.stringify([state.newRange(c1s2()), state.notes(c1s2())])})`
		);
		fs.writeFileSync(aPath, aBefore);
		await waitFor(() => state.newRange(c1s2())!.start === 19, 'range back after restoring', 5000).catch(() => undefined);

		// Submodules: add one, select it, stage a hunk inside it from its diff, and undo.
		const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'explainyourself-lib-'));
		const libGit = (...args: string[]) => execFileSync('git', args, { cwd: lib, encoding: 'utf8' });
		libGit('init', '-q');
		libGit('config', 'user.email', 't@t');
		libGit('config', 'user.name', 't');
		libGit('config', 'core.autocrlf', 'false');
		fs.writeFileSync(path.join(lib, 'lib.txt'), 'one\ntwo\nthree\n');
		libGit('add', '-A');
		libGit('commit', '-q', '-m', 'lib');
		git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'sub');
		git('commit', '-q', '-m', 'add submodule', '--', '.gitmodules', 'sub');
		fs.writeFileSync(path.join(root, 'sub', 'lib.txt'), 'one\nTWO\nthree\n');
		await state.openRepository(root);
		check(state.repo!.submodules.some((m) => m.path === 'sub' && m.initialized), 'submodule listed');
		await vscode.commands.executeCommand('explainYourself.setSubmodules', ['sub']);
		await waitFor(() => state.repo!.unstaged.has('sub/lib.txt'), 'submodule file in the workspace');
		check(!state.repo!.status.some((e) => e.path === 'sub'), 'submodule entry replaced by its files');
		check(fs.readFileSync(path.join(state.repo!.gitDir, 'explainyourself', 'settings.json'), 'utf8').includes('"sub"'), 'submodule choice remembered');
		const panelButtons = await waitFor(() => (api.reviewView.renderedButtons.includes('▾') ? api.reviewView.renderedButtons : undefined), 'submodule arrow', 5000).catch(
			() => api.reviewView.renderedButtons
		);
		check(panelButtons.includes('▾'), `panel shows the submodule arrow (buttons: ${JSON.stringify(panelButtons)})`);

		await vscode.commands.executeCommand('explainYourself.openDiff', 'sub/lib.txt', 'unstaged');
		const subEditor = await waitFor(() => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file' && e.document.uri.fsPath.endsWith('lib.txt')), 'submodule diff');
		const subIndex = await waitFor(() => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'explainyourself' && e.document.uri.path.endsWith('lib.txt')), 'submodule index side');
		check(subIndex.document.getText() === 'one\ntwo\nthree\n', 'index side reads the submodule index');
		const rootStaged = git('diff', '--cached');
		await vscode.commands.executeCommand('explainYourself.stageHunk', subEditor.document.uri.toString(), 2);
		const subGit = (...args: string[]) => execFileSync('git', args, { cwd: path.join(root, 'sub'), encoding: 'utf8' });
		await waitFor(() => subGit('diff', '--cached', '--name-only').trim() === 'lib.txt', 'hunk staged in the submodule', 5000);
		check(subGit('cat-file', 'blob', ':lib.txt') === 'one\nTWO\nthree\n', 'submodule index has the staged hunk');
		check(git('diff', '--cached') === rootStaged, 'root index untouched');
		await vscode.commands.executeCommand('explainYourself.undo');
		await waitFor(() => subGit('diff', '--cached', '--name-only').trim() === '', 'undo in the submodule', 5000);
		check(true, 'undo restores the submodule index');

		// Leave a representative screen for a screenshot.
		await vscode.commands.executeCommand('workbench.view.extension.explainYourself');
		await vscode.commands.executeCommand('explainYourself.openSection', 'c1s1');
		const marker = path.join(path.dirname(out), 'screenshot-ready');
		fs.writeFileSync(marker, '');
		const done = path.join(path.dirname(out), 'screenshot-done');
		await waitFor(() => fs.existsSync(done), 'screenshot', 20000).catch(() => undefined);
		report('DONE');
	} catch (e) {
		report(`ERROR ${e instanceof Error ? e.stack : e}`);
		throw e;
	} finally {
		fs.writeFileSync(out, lines.join('\n') + '\n');
	}
}
