import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { runCost } from '../core/agent';
import { LineMap, matchLines } from '../core/anchors';
import { changedLines, deriveOldRange } from '../core/coverage';
import { DiffLine, mapLine, parseDiff } from '../core/diff';
import { buildChangeSet } from '../core/changes';
import { reviewDelta } from '../core/generate';
import { Repository } from '../core/repository';
import { findInstructionFiles, loadGuidance, DEFAULT_REVIEW_RULES, repositoryRulesFile } from '../core/guidance';
import { buildPrompt } from '../core/prompt';
import { adoptSnapshot, computeFingerprints, loadReview, loadSnapshot, mergeUpdate, normalizeReview, Review, saveReview, saveSnapshots } from '../core/review';
import { Workspace } from '../core/workspace';
import { applyForward, applyReverse, selectHunks, selectLines, withAdjacentBlankLines } from '../core/stager';

function sh(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'latin1' });
}

function makeRepo(files: Record<string, string>, config: string[][] = []): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainyourself-'));
	sh(dir, 'init', '-q');
	sh(dir, 'config', 'user.email', 't@t');
	sh(dir, 'config', 'user.name', 't');
	sh(dir, 'config', 'core.autocrlf', 'false');
	for (const c of config) {
		sh(dir, 'config', ...c);
	}
	for (const [name, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		fs.writeFileSync(path.join(dir, name), content, 'latin1');
	}
	if (Object.keys(files).length > 0) {
		sh(dir, 'add', '-A');
		sh(dir, 'commit', '-q', '-m', 'init');
	}
	return dir;
}

function write(dir: string, name: string, content: string): void {
	fs.writeFileSync(path.join(dir, name), content, 'latin1');
}

function indexContent(dir: string, name: string): string {
	return sh(dir, 'cat-file', 'blob', `:${name}`);
}

const lines = (...l: string[]) => l.map((x) => x + '\n').join('');

test('parseDiff handles missing newline at end of file', () => {
	const diff = parseDiff('diff --git a/f b/f\nindex 1111111..2222222 100644\n--- a/f\n+++ b/f\n@@ -2 +2 @@\n-b\n\\ No newline at end of file\n+B\n');
	assert.strictEqual(diff.length, 1);
	assert.strictEqual(diff[0].path, 'f');
	assert.strictEqual(diff[0].hunks[0].lines[0].text, 'b');
	assert.strictEqual(diff[0].hunks[0].lines[1].text, 'B\n');
	assert.strictEqual(diff[0].hunks[0].lines[0].oldLine, 2);
});

test('mapLine shifts lines across insertions and deletions', () => {
	const [d] = parseDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -2,0 +3,2 @@\n+x\n+y\n@@ -5 +6,0 @@\n-z\n');
	assert.strictEqual(mapLine(d.hunks, 1, 'old'), 1);
	assert.strictEqual(mapLine(d.hunks, 3, 'old'), 5);
	assert.strictEqual(mapLine(d.hunks, 5, 'old'), 0);
	assert.strictEqual(mapLine(d.hunks, 6, 'old'), 7);
	assert.strictEqual(mapLine(d.hunks, 3, 'new'), 0);
	assert.strictEqual(mapLine(d.hunks, 7, 'new'), 6);
});

test('stage one hunk out of two, then undo and redo', async () => {
	const dir = makeRepo({ 'a.txt': lines('1', '2', '3', '4', '5', '6', '7', '8') });
	write(dir, 'a.txt', lines('1', 'TWO', '3', '4', '5', '6', 'SEVEN', '8'));
	const repo = await Repository.open(dir);
	await repo.refresh();

	const staged = await repo.stageLines('a.txt', (d) => selectHunks([d.hunks[1]]));
	assert.ok(staged);
	assert.strictEqual(indexContent(dir, 'a.txt'), lines('1', '2', '3', '4', '5', '6', 'SEVEN', '8'));
	assert.strictEqual(repo.unstaged.get('a.txt')!.hunks.length, 1);
	assert.strictEqual(repo.staged.get('a.txt')!.hunks.length, 1);

	await repo.undo();
	assert.strictEqual(indexContent(dir, 'a.txt'), lines('1', '2', '3', '4', '5', '6', '7', '8'));
	await repo.redo();
	assert.strictEqual(indexContent(dir, 'a.txt'), lines('1', '2', '3', '4', '5', '6', 'SEVEN', '8'));
});

test('stage selected lines of a replacement block', async () => {
	const dir = makeRepo({ 'a.txt': lines('a', 'b', 'c', 'd') });
	write(dir, 'a.txt', lines('a', 'B', 'C', 'd'));
	const repo = await Repository.open(dir);
	await repo.refresh();

	// Select new line 3 ("C"); its partner "c" is removed with it.
	await repo.stageLines('a.txt', (d) => selectLines(d.hunks, [{ start: 3, end: 3 }], 'new'));
	assert.strictEqual(indexContent(dir, 'a.txt'), lines('a', 'b', 'C', 'd'));

	// Select new line 2 ("B") from the remaining diff.
	await repo.stageLines('a.txt', (d) => selectLines(d.hunks, [{ start: 2, end: 2 }], 'new'));
	assert.strictEqual(indexContent(dir, 'a.txt'), lines('a', 'B', 'C', 'd'));
	assert.strictEqual(repo.unstaged.get('a.txt'), undefined);
});

test('stage a pure deletion through the line after it', async () => {
	const dir = makeRepo({ 'a.txt': lines('a', 'b', 'c') });
	write(dir, 'a.txt', lines('a', 'c'));
	const repo = await Repository.open(dir);
	await repo.refresh();
	await repo.stageLines('a.txt', (d) => selectLines(d.hunks, [{ start: 2, end: 2 }], 'new'));
	assert.strictEqual(indexContent(dir, 'a.txt'), lines('a', 'c'));
});

test('unstage selected lines', async () => {
	const dir = makeRepo({ 'a.txt': lines('a', 'b', 'c', 'd', 'e') });
	write(dir, 'a.txt', lines('A', 'b', 'c', 'd', 'E', 'f'));
	sh(dir, 'add', 'a.txt');
	const repo = await Repository.open(dir);
	await repo.refresh();

	await repo.unstageLines('a.txt', (d) => selectLines(d.hunks, [{ start: 5, end: 6 }], 'new'));
	assert.strictEqual(indexContent(dir, 'a.txt'), lines('A', 'b', 'c', 'd', 'e'));
	await repo.undo();
	assert.strictEqual(indexContent(dir, 'a.txt'), lines('A', 'b', 'c', 'd', 'E', 'f'));
});

test('stage part of an untracked file, then unstage all of it', async () => {
	const dir = makeRepo({ 'base.txt': 'x\n' });
	write(dir, 'new.txt', lines('1', '2', '3'));
	const repo = await Repository.open(dir);
	await repo.refresh();

	await repo.stageLines('new.txt', (d) => selectLines(d.hunks, [{ start: 1, end: 2 }], 'new'));
	assert.strictEqual(indexContent(dir, 'new.txt'), lines('1', '2'));
	await repo.unstageLines('new.txt', (d) => selectHunks(d.hunks));
	assert.strictEqual(sh(dir, 'ls-files', 'new.txt'), '');
	await repo.undo();
	await repo.undo();
	assert.strictEqual(sh(dir, 'ls-files', 'new.txt'), '');
});

test('missing final newline is handled when staging an append', async () => {
	const dir = makeRepo({ 'a.txt': 'a\nb' });
	write(dir, 'a.txt', 'a\nb\nc\n');
	const repo = await Repository.open(dir);
	await repo.refresh();
	await repo.stageLines('a.txt', (d) => selectLines(d.hunks, [{ start: 3, end: 3 }], 'new'));
	const staged = indexContent(dir, 'a.txt');
	assert.ok(staged === 'a\nb\nc\n' || staged === 'a\nb\nc\n', JSON.stringify(staged));
});

test('autocrlf: staging lines keeps the clean (LF) form', async () => {
	const dir = makeRepo({});
	sh(dir, 'config', 'core.autocrlf', 'true');
	write(dir, 'a.txt', 'a\r\nb\r\nc\r\n');
	sh(dir, 'add', 'a.txt');
	sh(dir, 'commit', '-q', '-m', 'init');
	write(dir, 'a.txt', 'a\r\nB\r\nc\r\nD\r\n');
	const repo = await Repository.open(dir);
	await repo.refresh();
	assert.strictEqual(repo.unstaged.get('a.txt')!.hunks.length, 2);
	await repo.stageLines('a.txt', (d) => selectLines(d.hunks, [{ start: 4, end: 4 }], 'new'));
	assert.strictEqual(indexContent(dir, 'a.txt'), 'a\nb\nc\nD\n');
});

test('whole-file stage and unstage with undo', async () => {
	const dir = makeRepo({ 'a.txt': 'a\n', 'gone.txt': 'g\n' });
	write(dir, 'a.txt', 'A\n');
	fs.unlinkSync(path.join(dir, 'gone.txt'));
	write(dir, 'n.txt', 'n\n');
	const repo = await Repository.open(dir);
	await repo.refresh();

	await repo.stageFiles(['a.txt', 'gone.txt', 'n.txt']);
	assert.deepStrictEqual(repo.unstagedEntries, []);
	assert.strictEqual(repo.stagedEntries.length, 3);
	await repo.undo();
	assert.strictEqual(repo.stagedEntries.length, 0);
	await repo.redo();
	await repo.unstageFiles(['a.txt']);
	assert.strictEqual(repo.stagedEntries.length, 2);
});

test('randomized: partial stage followed by staging the rest reproduces the working tree', async () => {
	let seed = 12345;
	const rand = (n: number) => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed % n;
	};

	const original = Array.from({ length: 40 }, (_, i) => `line ${i}`);
	const dir = makeRepo({ 'r.txt': lines(...original) });
	const repo = await Repository.open(dir);

	for (let round = 0; round < 60; round++) {
		sh(dir, 'reset', '-q');
		const edited: string[] = [];
		for (const l of original) {
			const r = rand(10);
			if (r === 0) continue;
			if (r === 1) edited.push(`changed ${l} ${round}`);
			else if (r === 2) edited.push(l, `inserted ${round}-${edited.length}`);
			else edited.push(l);
		}
		const finalNewline = rand(4) !== 0;
		const text = lines(...edited);
		const content = finalNewline ? text : text.slice(0, -1);
		write(dir, 'r.txt', content);
		await repo.refresh();

		const diff = repo.unstaged.get('r.txt');
		if (!diff) continue;
		const total = edited.length;
		const start = 1 + rand(total);
		const end = Math.min(total, start + rand(6));
		const side = rand(2) === 0 ? 'new' : 'old';
		await repo.stageLines('r.txt', (d) => selectLines(d.hunks, [{ start, end }], side));
		// The in-process remaining diff must turn the new index into the working tree.
		const remaining = repo.unstaged.get('r.txt');
		const partial = indexContent(dir, 'r.txt');
		assert.strictEqual(remaining ? applyForward(partial, remaining.hunks, selectHunks(remaining.hunks)) : partial, content, `round ${round} derived`);
		await repo.stageLines('r.txt', (d) => selectHunks(d.hunks));
		assert.strictEqual(indexContent(dir, 'r.txt'), content, `round ${round}`);

		// Unstage a random part, then everything; the index must return to HEAD.
		await repo.unstageLines('r.txt', (d) => selectLines(d.hunks, [{ start, end }], side));
		const stagedRest = repo.staged.get('r.txt');
		const partialIndex = indexContent(dir, 'r.txt');
		assert.strictEqual(stagedRest ? applyReverse(partialIndex, stagedRest.hunks, selectHunks(stagedRest.hunks)) : partialIndex, lines(...original), `round ${round} derived reverse`);
		await repo.unstageLines('r.txt', (d) => selectHunks(d.hunks));
		assert.strictEqual(indexContent(dir, 'r.txt'), lines(...original), `round ${round} unstage`);
	}
});

test('deriveOldRange maps a rewritten function back to HEAD', () => {
	const [d] = parseDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -4,3 +4,4 @@\n-a\n-b\n-c\n+A\n+B\n+C\n+D\n@@ -12,0 +14,2 @@\n+x\n+y\n');
	assert.deepStrictEqual(deriveOldRange(d.hunks, { start: 3, end: 8 }), { start: 3, end: 7 });
	assert.deepStrictEqual(deriveOldRange(d.hunks, { start: 4, end: 7 }), { start: 4, end: 6 });
	assert.strictEqual(deriveOldRange(d.hunks, { start: 14, end: 15 }), undefined);
});

test('mergeUpdate replaces sections of changed files only', async () => {
	const section = (id: string, file: string, start: number) => ({ id, file, title: id, summary: '', newRange: { start, end: start } });
	const previous: Review = {
		version: 1,
		generatedAt: '',
		head: 'h',
		source: { kind: 'fresh' },
		overview: 'old overview',
		fingerprints: {},
		categories: [
			{ id: 'c1', title: 'One', oldBehavior: 'o', newBehavior: 'n', sections: [section('c1s1', 'a.ts', 1), section('c1s2', 'b.ts', 2)] },
			{ id: 'c2', title: 'Two', oldBehavior: 'o', newBehavior: 'n', sections: [section('c2s1', 'b.ts', 5)] }
		]
	};
	const raw = {
		categories: [
			{ id: 'c1', title: 'One updated', oldBehavior: 'o2', newBehavior: 'n2', sections: [{ file: 'b.ts', title: 'new b', summary: 's', newStart: 7, newEnd: 8 }] },
			{ title: 'Three', oldBehavior: 'o3', newBehavior: 'n3', sections: [{ file: 'b.ts', title: 'b3', summary: 's', newStart: 1, newEnd: 1, layout: 'rewrite' }] }
		]
	};
	const { review, errors } = await mergeUpdate(previous, raw, new Set(['b.ts']), { head: 'h2', source: previous.source, lineCount: async () => 10 });
	assert.deepStrictEqual(errors, []);
	assert.deepStrictEqual(review.categories.map((c) => c.id), ['c1', 'c3']);
	assert.strictEqual(review.categories[0].title, 'One updated');
	assert.deepStrictEqual(review.categories[0].sections.map((s) => [s.id, s.file]), [['c1s1', 'a.ts'], ['c1s2', 'b.ts']]);
	assert.deepStrictEqual(review.categories[0].sections[1].newRange, { start: 7, end: 8 });
	assert.strictEqual(review.categories[1].sections[0].layout, 'rewrite');
	assert.strictEqual(review.overview, 'old overview');
	assert.strictEqual(review.head, 'h2');
});

test('mergeUpdate keeps the reading order', async () => {
	const section = (id: string, file: string) => ({ id, file, title: id, summary: '', newRange: { start: 1, end: 1 } });
	const previous: Review = {
		version: 1,
		generatedAt: '',
		head: 'h',
		source: { kind: 'fresh' },
		overview: '',
		fingerprints: {},
		categories: [
			{ id: 'c1', title: 'Utilities', oldBehavior: 'o', newBehavior: 'n', sections: [section('c1s1', 'a.ts'), section('c1s2', 'b.ts'), section('c1s3', 'c.ts')] },
			{ id: 'c2', title: 'Tests', oldBehavior: 'o', newBehavior: 'n', sections: [section('c2s1', 't.ts')] }
		]
	};
	const s = (file: string, title: string, extra = {}) => ({ file, title, summary: 's', newStart: 1, newEnd: 1, ...extra });
	const raw = {
		categories: [
			// b.ts keeps its place between a.ts and c.ts; d.ts asks to go before a.ts.
			{ id: 'c1', title: 'Utilities', oldBehavior: 'o', newBehavior: 'n', sections: [s('b.ts', 'b again', { effort: 'high' }), s('d.ts', 'd', { before: 'c1s1' })] },
			// A new category asks to go before the tests.
			{ title: 'Feature', before: 'c2', oldBehavior: 'o', newBehavior: 'n', sections: [s('e.ts', 'e')] }
		]
	};
	const { review, errors } = await mergeUpdate(previous, raw, new Set(['b.ts', 'd.ts', 'e.ts']), { head: 'h', source: previous.source, lineCount: async () => 10 });
	assert.deepStrictEqual(errors, []);
	assert.deepStrictEqual(review.categories.map((c) => c.title), ['Utilities', 'Feature', 'Tests']);
	assert.deepStrictEqual(review.categories[0].sections.map((x) => x.file), ['d.ts', 'a.ts', 'b.ts', 'c.ts']);
	assert.strictEqual(review.categories[0].sections[2].effort, 'high');
	assert.ok(review.categories.every((c) => c.sections.every((x) => !('insertBefore' in x))), 'placement hints are not stored');
	assert.strictEqual(new Set(review.categories.flatMap((c) => c.sections.map((x) => x.id))).size, 6, 'section ids stay unique');
});

test('changedLines counts the changes inside a section', () => {
	const [d] = parseDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3,2 +3,3 @@\n-a\n-b\n+A\n+B\n+C\n@@ -20 +21,0 @@\n-gone\n@@ -30,0 +30,2 @@\n+x\n+y\n');
	// Lines 1-10 hold the first hunk: 3 added, and its 2 removed lines.
	assert.deepStrictEqual(changedLines(d, { start: 1, end: 10 }, undefined), { added: 3, removed: 2 });
	// Only part of an addition lies inside the range.
	assert.deepStrictEqual(changedLines(d, { start: 31, end: 40 }, undefined), { added: 1, removed: 0 });
	// A removal found through the old range.
	assert.deepStrictEqual(changedLines(d, undefined, { start: 18, end: 22 }), { added: 0, removed: 1 });
	// Untracked files count every line of the range as added; unchanged files count nothing.
	assert.deepStrictEqual(changedLines({ oldPath: null, newPath: 'n', path: 'n', binary: false, hunks: [] }, { start: 5, end: 9 }, undefined), { added: 5, removed: 0 });
	assert.deepStrictEqual(changedLines(undefined, { start: 1, end: 3 }, undefined), { added: 0, removed: 0 });
});

test('reviewDelta finds modified, added and removed files', async () => {
	const dir = makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
	write(dir, 'a.txt', 'A\n');
	write(dir, 'b.txt', 'B\n');
	const repo = await Workspace.open(dir);
	const changes = await buildChangeSet(repo);
	const review: Review = {
		version: 1,
		generatedAt: '',
		head: repo.head,
		source: { kind: 'fresh' },
		overview: '',
		categories: [],
		files: changes.files.map((f) => f.path),
		fingerprints: await computeFingerprints(dir, changes.files.map((f) => f.path))
	};
	assert.deepStrictEqual(await reviewDelta(repo, review, changes), []);

	sh(dir, 'checkout', '--', 'a.txt');
	write(dir, 'b.txt', 'BB\n');
	write(dir, 'c.txt', 'c\n');
	const delta = await reviewDelta(repo, review, await buildChangeSet(repo));
	assert.deepStrictEqual(delta, [
		{ path: 'a.txt', reason: 'removed' },
		{ path: 'b.txt', reason: 'modified' },
		{ path: 'c.txt', reason: 'added' }
	]);
});

test('runCost leaves out what a resumed session cost before', () => {
	// Measured: a Haiku session cost $0.0234562; a one-turn fork of it reported this result.
	const forked = {
		total_cost_usd: 0.0266518,
		usage: { input_tokens: 9, output_tokens: 30, cache_read_input_tokens: 28046, cache_creation_input_tokens: 116, cache_creation: { ephemeral_1h_input_tokens: 116 } },
		modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 18, outputTokens: 72, cacheReadInputTokens: 45338, cacheCreationInputTokens: 10870 } }
	};
	// Haiku list prices for the fork's own tokens: $1/M input, $5/M output, $0.10/M cache reads, $2/M 1-hour cache writes.
	const direct = (9 + 5 * 30 + 0.1 * 28046 + 2 * 116) / 1e6;
	assert.ok(Math.abs(runCost(forked, true)! - direct) < 0.0002, `estimate ${runCost(forked, true)} vs ${direct}`);
	assert.strictEqual(runCost(forked, false), 0.0266518);
});

test('staging a section takes the blank lines around it', () => {
	// A new function, with blank separators before and after, plus an unrelated change.
	const [d] = parseDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3,0 +4,6 @@\n+\n+void g()\n+{\n+}\n+\n+\n@@ -9 +15 @@\n-x\n+ \n');
	const section = selectLines(d.hunks, [{ start: 5, end: 7 }], 'new');
	const texts = (set: Set<DiffLine>) => d.hunks.flatMap((h) => h.lines).filter((l) => set.has(l)).map((l) => l.text);
	assert.deepStrictEqual(texts(section), ['void g()\n', '{\n', '}\n']);
	// Blank lines on both sides join; the blank line in the other hunk does not.
	assert.deepStrictEqual(texts(withAdjacentBlankLines(d.hunks, section)), ['\n', 'void g()\n', '{\n', '}\n', '\n', '\n']);
	assert.strictEqual(withAdjacentBlankLines(d.hunks, new Set()).size, 0);
});

test('workspace reviews and stages changes inside a submodule', async () => {
	const lib = makeRepo({ 'lib.cpp': lines('int f()', '{', '\treturn 1;', '}') });
	const dir = makeRepo({ 'main.cpp': lines('int main()', '{', '}') });
	sh(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'ext/lib');
	sh(dir, 'commit', '-q', '-m', 'add submodule');
	const sub = path.join(dir, 'ext', 'lib');
	write(dir, 'ext/lib/lib.cpp', lines('int f()', '{', '\treturn 2;', '}'));
	write(dir, 'main.cpp', lines('int main()', '{', '\treturn 0;', '}'));

	const ws = await Workspace.open(dir);
	assert.deepStrictEqual(ws.submodules, [{ path: 'ext/lib', initialized: true }]);
	await ws.refresh();
	assert.ok(ws.status.some((e) => e.path === 'ext/lib'), 'unselected submodule shows as one entry');
	assert.ok(ws.submoduleChanged('ext/lib'));

	await ws.setSubmodules(['ext/lib']);
	await ws.refresh();
	// The submodule's own entry hides: its commit did not change, its files show instead.
	assert.deepStrictEqual(ws.unstagedEntries.map((e) => e.path).sort(), ['ext/lib/lib.cpp', 'main.cpp']);
	const changes = await buildChangeSet(ws);
	assert.deepStrictEqual(changes.files.map((f) => f.path).sort(), ['ext/lib/lib.cpp', 'main.cpp']);
	assert.deepStrictEqual(changes.submodules, ['ext/lib']);
	assert.ok(fs.readFileSync(changes.annotatedPath, 'utf8').includes('=== FILE: ext/lib/lib.cpp (modified)'));

	// One step stages in both repositories, and undoes and redoes as one.
	const all = (d: { hunks: Parameters<typeof selectHunks>[0] }) => selectHunks(d.hunks);
	await ws.stageSelections([{ rel: 'ext/lib/lib.cpp', select: all }, { rel: 'main.cpp', select: all }], 'Stage both');
	const stagedIn = (cwd: string) => sh(cwd, 'diff', '--cached', '--name-only').trim();
	assert.strictEqual(stagedIn(sub), 'lib.cpp');
	assert.strictEqual(stagedIn(dir), 'main.cpp');
	assert.ok(ws.staged.has('ext/lib/lib.cpp') && !ws.unstaged.has('ext/lib/lib.cpp'));
	await ws.undo();
	assert.strictEqual(stagedIn(sub) + stagedIn(dir), '');
	assert.ok(ws.unstaged.has('ext/lib/lib.cpp'));
	await ws.redo();
	assert.strictEqual(stagedIn(sub), 'lib.cpp');

	// A new commit in the submodule shows as a pointer change; staging it stages the commit, not text.
	sh(sub, 'commit', '-q', '-m', 'f returns 2');
	await ws.refresh();
	const pointer = ws.unstaged.get('ext/lib');
	assert.ok(pointer, 'pointer change appears');
	await ws.stageLines('ext/lib', (d) => selectHunks(d.hunks), 'Stage pointer');
	const entry = sh(dir, 'ls-files', '-s', 'ext/lib').split(' ');
	assert.strictEqual(entry[0], '160000');
	assert.strictEqual(entry[1], sh(sub, 'rev-parse', 'HEAD').trim());
});

test('staging a new function section leaves no blank lines unstaged', async () => {
	const dir = makeRepo({ 'f.cpp': lines('void a()', '{', '}', '', 'void c()', '{', '}') });
	write(dir, 'f.cpp', lines('void a()', '{', '}', '', 'void b()', '{', '\tb();', '}', '', 'void c()', '{', '}'));
	const repo = await Repository.open(dir);
	await repo.refresh();
	const hunks = repo.unstaged.get('f.cpp')!.hunks;
	// The section is the function itself, lines 5-8, without the blank line git reports as added.
	assert.ok(hunks.flatMap((h) => h.lines).some((l) => l.text === '\n'), 'diff adds a blank line');
	await repo.stageSelections([{ rel: 'f.cpp', select: (d) => withAdjacentBlankLines(d.hunks, selectLines(d.hunks, [{ start: 5, end: 8 }], 'new')) }], 'Stage section');
	assert.strictEqual(sh(dir, 'diff', '--name-only').trim(), '', 'nothing left unstaged');
});

test('LineMap moves ranges and lines along with edits', () => {
	const before = lines('header', 'void f() {', '  a();', '  b();', '}', '', 'void g() {', '  c();', '}');
	// Lines inserted above, f's signature changed, a line added inside g.
	const after = lines('// new', '// lines', 'header', 'void f(int x) {', '  a();', '  b();', '}', '', 'void g() {', '  c();', '  d();', '}');
	const map = LineMap.build(before, after)!;
	assert.deepStrictEqual(map.range({ start: 2, end: 5 }), { start: 4, end: 7 }, 'changed first line moves to its replacement');
	assert.deepStrictEqual(map.range({ start: 7, end: 9 }), { start: 9, end: 12 }, 'range grows with lines added inside');
	assert.strictEqual(map.line(8), 10);
	assert.strictEqual(map.line(2), 4, 'a changed line maps to what replaced it');

	// Line endings and trailing whitespace do not count as changes.
	assert.deepStrictEqual(LineMap.build(before, before.replace(/\n/g, '  \r\n'))!.range({ start: 2, end: 5 }), { start: 2, end: 5 });

	// Removing a whole range leaves a one-line range where it was.
	const removed = LineMap.build(before, lines('header', 'void g() {', '  c();', '}'))!;
	assert.deepStrictEqual(removed.range({ start: 2, end: 6 }), { start: 2, end: 2 });
	assert.deepStrictEqual(removed.range({ start: 7, end: 9 }), { start: 2, end: 4 });
});

test('matchLines finds a shortest edit script on random edits', () => {
	let seed = 7;
	const rand = (n: number) => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed % n;
	};
	for (let round = 0; round < 200; round++) {
		const a = Array.from({ length: rand(30) }, () => String(rand(6)));
		const b = a.filter(() => rand(4) !== 0);
		for (let i = 0; i < rand(5); i++) {
			b.splice(rand(b.length + 1), 0, String(rand(6)));
		}
		const pairs = matchLines(a, b, 1000)!;
		for (let i = 0; i < pairs.length; i++) {
			const [x, y] = pairs[i];
			assert.strictEqual(a[x], b[y]);
			assert.ok(i === 0 || (x > pairs[i - 1][0] && y > pairs[i - 1][1]), 'pairs increase');
		}
		// A longest common subsequence by dynamic programming.
		const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
		for (let i = a.length - 1; i >= 0; i--) {
			for (let j = b.length - 1; j >= 0; j--) {
				dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
		assert.strictEqual(pairs.length, dp[0][0], `round ${round}`);
	}
	assert.strictEqual(matchLines(['a', 'b', 'c'], ['x', 'y', 'z'], 4), null, 'gives up past the edit limit');
});

test('notes are validated against their section', async () => {
	const raw = {
		title: 't',
		overview: 'o',
		categories: [
			{
				title: 'C',
				oldBehavior: 'o',
				newBehavior: 'n',
				sections: [
					{
						file: 'a.ts',
						title: 'Long method',
						summary: 's',
						newStart: 10,
						newEnd: 90,
						notes: [
							{ line: 40, text: 'Main loop.' },
							{ line: 12, text: 'Checks arguments.' },
							{ line: 95, text: 'Outside.' },
							{ line: 20, text: '' }
						]
					}
				]
			}
		]
	};
	const { review, warnings } = await normalizeReview(raw, { head: 'h', source: { kind: 'fresh' }, lineCount: async () => 100 });
	assert.deepStrictEqual(review.categories[0].sections[0].notes, [
		{ line: 12, text: 'Checks arguments.' },
		{ line: 40, text: 'Main loop.' }
	]);
	assert.strictEqual(warnings.length, 1);
});

test('snapshots keep the reviewed versions of section files', async () => {
	const dir = makeRepo({ 'a.txt': lines('one', 'two') });
	const gitDir = path.join(dir, '.git');
	write(dir, 'a.txt', lines('one', 'two', 'three'));
	write(dir, 'b.txt', lines('b'));
	const fingerprints = await computeFingerprints(dir, ['a.txt', 'b.txt']);
	await saveSnapshots(gitDir, dir, ['a.txt'], fingerprints);
	assert.strictEqual(await loadSnapshot(gitDir, fingerprints['a.txt']), lines('one', 'two', 'three'));
	assert.strictEqual(await loadSnapshot(gitDir, fingerprints['b.txt']), null, 'only section files are kept');

	// A later save drops snapshots the review no longer uses; a changed file cannot be adopted.
	write(dir, 'a.txt', lines('one'));
	const next = await computeFingerprints(dir, ['a.txt']);
	await saveSnapshots(gitDir, dir, ['a.txt'], next);
	assert.strictEqual(await loadSnapshot(gitDir, fingerprints['a.txt']), null);
	assert.strictEqual(await adoptSnapshot(gitDir, dir, 'a.txt', fingerprints['a.txt']), null);
	assert.strictEqual(await adoptSnapshot(gitDir, dir, 'a.txt', next['a.txt']), lines('one'));
});

test('findings are tagged per section and category; old Markdown findings still load', async () => {
	const raw = {
		title: 't',
		overview: 'o',
		categories: [
			{
				title: 'C',
				oldBehavior: 'o',
				newBehavior: 'n',
				concerns: [{ tag: 'Layering', text: '`A` depends on `B`.' }, { tag: '', text: '' }],
				sections: [{ file: 'a.ts', title: 'S', summary: 's', newStart: 1, newEnd: 2, concerns: [{ tag: 'Duplication', text: 'Repeats `f()`.' }] }]
			}
		]
	};
	const { review } = await normalizeReview(raw, { head: 'h', source: { kind: 'fresh' }, lineCount: async () => 10 });
	assert.deepStrictEqual(review.categories[0].concerns, [{ tag: 'Layering', text: '`A` depends on `B`.' }]);
	assert.deepStrictEqual(review.categories[0].sections[0].concerns, [{ tag: 'Duplication', text: 'Repeats `f()`.' }]);

	const dir = makeRepo({});
	const legacy = { ...review, categories: [{ ...review.categories[0], concerns: '- First thing.\n- Second\n  continued.' }] };
	await saveReview(path.join(dir, '.git'), legacy as unknown as Review);
	const loaded = await loadReview(path.join(dir, '.git'));
	assert.deepStrictEqual(loaded!.categories[0].concerns, [
		{ tag: '', text: 'First thing.' },
		{ tag: '', text: 'Second\n  continued.' }
	]);
});

test('guidance: repository rules override the defaults; instruction files on the way to changed files', async () => {
	const dir = makeRepo({ 'CLAUDE.md': '# root', 'Engine/AGENTS.md': '# engine', 'Engine/Render/x.cpp': 'x', 'Other/CLAUDE.md': '# other', 'Other/y.cpp': 'y' });
	assert.deepStrictEqual(await findInstructionFiles(dir, ['Engine/Render/x.cpp']), ['CLAUDE.md', 'Engine/AGENTS.md']);
	assert.deepStrictEqual(await findInstructionFiles(dir, ['Engine/Render/x.cpp', 'Other/y.cpp']), ['CLAUDE.md', 'Engine/AGENTS.md', 'Other/CLAUDE.md']);

	const defaults = await loadGuidance(dir, ['Other/y.cpp']);
	fs.mkdirSync(path.dirname(repositoryRulesFile(dir)), { recursive: true });
	fs.writeFileSync(repositoryRulesFile(dir), '- **Naming**: no abbreviations.\n');
	const custom = await loadGuidance(dir, ['Other/y.cpp']);
	assert.strictEqual(custom.rules, '- **Naming**: no abbreviations.');
	// Without a repository file, the user's file or the defaults apply.
	assert.ok(defaults.rules === DEFAULT_REVIEW_RULES.trim() || defaults.rules.length > 0);

	const changes = { annotatedPath: 'changes.txt', files: [], submodules: [] } as unknown as Parameters<typeof buildPrompt>[1];
	const prompt = buildPrompt(dir, changes, { kind: 'session' }, custom);
	assert.ok(prompt.includes('**Naming**: no abbreviations.') && prompt.includes('- CLAUDE.md') && prompt.includes('- Other/CLAUDE.md'));
});
