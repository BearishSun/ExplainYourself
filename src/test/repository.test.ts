import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { runCost } from '../core/agent';
import { LineMap, matchLines } from '../core/anchors';
import { changedLines, deriveOldRange, findCoverage, snapSections } from '../core/coverage';
import { DiffLine, mapLine, parseDiff } from '../core/diff';
import { buildChangeSet } from '../core/changes';
import { reviewDelta } from '../core/generate';
import { needsAgent, planUpdate, renderUpdate } from '../core/update';
import { Repository } from '../core/repository';
import { findInstructionFiles, loadGuidance, DEFAULT_REVIEW_RULES, repositoryRulesFile } from '../core/guidance';
import { buildPrompt } from '../core/prompt';
import { findSessions, REVIEW_PROMPT_START, REVIEW_SESSION_NAME } from '../core/sessions';
import { adoptSnapshot, computeFingerprints, loadReview, loadSnapshot, mergeUpdate, normalizeReview, Review, saveReview, saveSnapshots } from '../core/review';
import { Workspace } from '../core/workspace';
import { coverageGaps, renderCoverage } from '../core/repair';
import { parseExplanation, sectionListing } from '../core/explain';
import { applyForward, applyReverse, selectHunks, selectLines, selectSections, withAdjacentBlankLines } from '../core/stager';

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

test('mergeUpdate changes, moves, removes and adds sections by id', async () => {
	const section = (id: string, file: string, start: number, end = start) => ({ id, file, title: id, summary: `${id} summary`, newRange: { start, end } });
	const base: Review = {
		version: 1,
		generatedAt: '',
		head: 'h',
		source: { kind: 'fresh' },
		overview: 'old overview',
		fingerprints: {},
		categories: [
			{ id: 'c1', title: 'One', oldBehavior: 'o', newBehavior: 'n', sections: [section('c1s1', 'a.ts', 1, 3), section('c1s2', 'b.ts', 5, 6)] },
			{ id: 'c2', title: 'Two', oldBehavior: 'o', newBehavior: 'n', sections: [section('c2s1', 'b.ts', 8, 9), section('c2s2', 'c.ts', 1, 2)] },
			{ id: 'c3', title: 'Three', oldBehavior: 'o', newBehavior: 'n', sections: [section('c3s1', 'd.ts', 1)] }
		]
	};
	const raw = {
		categories: [
			{
				id: 'c1',
				sections: [{ id: 'c1s1', summary: 'changed' }, { id: 'c1s2', remove: true }, { file: 'a.ts', title: 'new a', summary: 's', newStart: 5, newEnd: 6 }]
			},
			// c3s1 moves here, which leaves c3 empty.
			{ id: 'c2', newBehavior: 'n2', sections: [{ id: 'c3s1', newStart: 2, newEnd: 3 }] },
			{ title: 'New', oldBehavior: 'o', newBehavior: 'n', before: 'c2', sections: [{ file: 'c.ts', title: 'c again', summary: 's', newStart: 4, newEnd: 5 }] }
		]
	};
	// c.ts was reviewed again in full: its section the output leaves out is gone.
	const { review, errors } = await mergeUpdate(base, raw, new Set(['c.ts']), { head: 'h2', source: base.source, lineCount: async () => 10 });
	assert.deepStrictEqual(errors, []);
	assert.deepStrictEqual(
		review.categories.map((c) => [c.id, c.title, c.newBehavior, c.sections.map((x) => x.id)]),
		[
			['c1', 'One', 'n', ['c1s1', 'c1s3']],
			['c4', 'New', 'n', ['c4s1']],
			['c2', 'Two', 'n2', ['c2s1', 'c3s1']]
		]
	);
	const c1s1 = review.categories[0].sections[0];
	assert.deepStrictEqual([c1s1.title, c1s1.summary, c1s1.newRange], ['c1s1', 'changed', { start: 1, end: 3 }], 'fields left out keep their value');
	assert.deepStrictEqual(review.categories[2].sections[1].newRange, { start: 2, end: 3 });
	assert.strictEqual(review.overview, 'old overview');
	assert.strictEqual(review.head, 'h2');

	const bad = await mergeUpdate(base, { categories: [{ sections: [{ file: 'x.ts', title: 'x', summary: 's', newStart: 1 }] }] }, new Set(), { head: 'h', source: base.source, lineCount: async () => 10 });
	assert.deepStrictEqual(bad.errors, ['New category 1: needs title, oldBehavior and newBehavior.']);
});

test('planUpdate sends only the sections that edits touch, and edited code outside sections', async () => {
	const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
	const dir = makeRepo({ 'f.ts': lines(...body) });
	const reviewed = [...body];
	reviewed[4] = 'line 5 changed';
	reviewed[24] = 'line 25 changed';
	write(dir, 'f.ts', lines(...reviewed));
	const repo = await Workspace.open(dir);
	const changes = await buildChangeSet(repo);
	const fingerprints = await computeFingerprints(dir, ['f.ts']);
	await saveSnapshots(repo.gitDir, dir, ['f.ts'], fingerprints);
	const section = (id: string, start: number, end: number) => ({ id, file: 'f.ts', title: id, summary: '', newRange: { start, end }, notes: [{ line: start + 1, text: 'n' }] });
	const review: Review = {
		version: 1,
		generatedAt: '',
		head: repo.head,
		source: { kind: 'fresh' },
		overview: '',
		files: ['f.ts'],
		fingerprints,
		categories: [{ id: 'c1', title: 'C', oldBehavior: '', newBehavior: '', sections: [section('c1s1', 3, 7), section('c1s2', 23, 27)] }]
	};

	// Since the review: two lines added at the top, line 6 (inside c1s1) edited, and new code after line 35.
	const now = ['top 1', 'top 2', ...reviewed];
	now[2 + 5] = 'line 6 edited';
	now.splice(2 + 35, 0, 'new 1', 'new 2');
	write(dir, 'f.ts', lines(...now));
	const current = await buildChangeSet(repo);
	const delta = await reviewDelta(repo, review, current);
	assert.deepStrictEqual(delta, [{ path: 'f.ts', reason: 'modified' }]);

	const plan = await planUpdate(repo, review, delta!, current);
	assert.ok(needsAgent(plan));
	assert.deepStrictEqual([...plan.affected], ['c1s1']);
	const [s1, s2] = plan.base.categories[0].sections;
	assert.deepStrictEqual([s1.newRange, s2.newRange, s2.notes], [{ start: 5, end: 9 }, { start: 25, end: 29 }, [{ line: 26, text: 'n' }]], 'positions follow the edits');
	assert.deepStrictEqual(plan.uncovered, [
		{ file: 'f.ts', range: { start: 1, end: 2 } },
		{ file: 'f.ts', range: { start: 38, end: 39 } }
	]);
	assert.deepStrictEqual(review.categories[0].sections[1].newRange, { start: 23, end: 27 }, 'the previous review is not modified');

	const text = renderUpdate(plan, current);
	assert.ok(text.includes('     8 +| line 6 edited') && text.includes('- c1s1 in category c1') && !text.includes('- c1s2 in category'), text);
	assert.ok(text.includes('Edited code that no section covers: lines 1-2, lines 38-39.'), text);

	// Without the edit inside c1s1 and the new code, only the lines at the top remain for the agent.
	write(dir, 'f.ts', lines(...['top 1', 'top 2', ...reviewed]));
	const moved = await buildChangeSet(repo);
	const movedPlan = await planUpdate(repo, review, (await reviewDelta(repo, review, moved))!, moved);
	assert.deepStrictEqual([movedPlan.affected.size, movedPlan.uncovered.length], [0, 1], 'added lines at the top differ from HEAD');
});

test('changedLines counts the changes inside a section', () => {
	const [d] = parseDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3,2 +3,3 @@\n-a\n-b\n+A\n+B\n+C\n@@ -20 +21,0 @@\n-gone\n@@ -30,0 +30,2 @@\n+x\n+y\n');
	// Lines 1-10 hold the first hunk: 3 added, and its 2 removed lines.
	assert.deepStrictEqual(changedLines(d, { start: 1, end: 10 }, undefined), { added: 3, removed: 2, changed: 3 });
	// Only part of a replacement lies inside the range: the section owns the replaced lines paired with its own.
	assert.deepStrictEqual(changedLines(d, { start: 3, end: 3 }, undefined), { added: 1, removed: 1, changed: 1 });
	// Only part of an addition lies inside the range.
	assert.deepStrictEqual(changedLines(d, { start: 31, end: 40 }, undefined), { added: 1, removed: 0, changed: 1 });
	// A removal found through the old range.
	assert.deepStrictEqual(changedLines(d, undefined, { start: 18, end: 22 }), { added: 0, removed: 1, changed: 1 });
	// Untracked files count every line of the range as added; unchanged files count nothing.
	assert.deepStrictEqual(changedLines({ oldPath: null, newPath: 'n', path: 'n', binary: false, hunks: [] }, { start: 5, end: 9 }, undefined), { added: 5, removed: 0, changed: 5 });
	assert.deepStrictEqual(changedLines(undefined, { start: 1, end: 3 }, undefined), { added: 0, removed: 0, changed: 0 });
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

test('findCoverage: cut-off hunk lines and whitespace go to the nearest section, distant code stays uncovered', () => {
	// Hunks: 3-6 replaced (section covers 1-4 of it), a blank line added at 40, code added at 60-61.
	const [d] = parseDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3,4 +3,4 @@\n-a\n-b\n-c\n-d\n+A\n+B\n+C\n+D\n@@ -38,0 +39 @@\n+\n@@ -55,0 +60,2 @@\n+x\n+y\n');
	const section = { id: 's', file: 'f', title: 'S', summary: '', newRange: { start: 1, end: 4 } };
	const review = { categories: [{ id: 'c', title: 'C', oldBehavior: '', newBehavior: '', sections: [section] }] } as unknown as Review;
	const { uncovered, attached } = findCoverage(review, new Map([['f', d]]), (x) => x.newRange);
	assert.deepStrictEqual(
		attached.get('s')!.map((c) => [c.newRange, c.oldRange]),
		[
			[{ start: 5, end: 6 }, { start: 5, end: 6 }],
			[{ start: 39, end: 39 }, undefined]
		]
	);
	assert.deepStrictEqual(uncovered.map((c) => c.newRange), [{ start: 60, end: 61 }]);
});

test('findCoverage: untracked files are checked line by line, and large blocks next to a section stay uncovered', () => {
	// A new file: a section covers lines 1-3, a function the review missed follows at 4-12, a section covers 13-14.
	const text = ['#include "a.h"', 'int x;', '', 'void f()', '{', '\ta();', '\tb();', '\tc();', '\td();', '\te();', '}', '', 'int y;', 'int z;', ''].join('\r\n');
	const diff = { oldPath: null, newPath: 'n.cpp', path: 'n.cpp', binary: false, hunks: [] };
	const sections = [
		{ id: 'a', file: 'n.cpp', title: 'A', summary: '', newRange: { start: 1, end: 3 } },
		{ id: 'b', file: 'n.cpp', title: 'B', summary: '', newRange: { start: 13, end: 14 } }
	];
	const review = { categories: [{ id: 'c', title: 'C', oldBehavior: '', newBehavior: '', sections }] } as unknown as Review;
	const { uncovered, attached } = findCoverage(review, new Map([['n.cpp', diff]]), (x) => x.newRange, new Map([['n.cpp', text]]));
	assert.deepStrictEqual(uncovered.map((c) => [c.newRange, c.added]), [[{ start: 4, end: 12 }, 9]]);
	assert.strictEqual(attached.size, 0);

	// Without the text, any section of the file covers it.
	assert.deepStrictEqual(findCoverage(review, new Map([['n.cpp', diff]]), (x) => x.newRange).uncovered, []);
});

test('coverage repair: lists only the uncovered lines, and merges extended and added sections', async () => {
	const fn = (name: string) => [`void ${name}()`, '{', '\ta();', '\tb();', '\tc();', '\td();', '\te();', '\tf();', '}', ''];
	const dir = makeRepo({ 'a.cpp': 'int x;\n' });
	fs.writeFileSync(path.join(dir, 'a.cpp'), ['int y;', '', ...fn('first'), ...fn('second')].join('\n'));
	fs.writeFileSync(path.join(dir, 'new.cpp'), 'int z;\n');
	const repo = await Workspace.open(dir);
	const changes = await buildChangeSet(repo);
	// The review misses the body of first() and all of new.cpp; second() is covered.
	const sections = [
		{ id: 'c1s1', file: 'a.cpp', title: 'first', summary: 'First.', newRange: { start: 1, end: 3 } },
		{ id: 'c1s2', file: 'a.cpp', title: 'second', summary: 'Second.', newRange: { start: 13, end: 21 } }
	];
	const review = { head: '', title: 'T', overview: '', source: { kind: 'fresh' }, fingerprints: {}, categories: [{ id: 'c1', title: 'C', oldBehavior: 'o', newBehavior: 'n', sections }] } as unknown as Review;

	const gaps = coverageGaps(review, changes);
	assert.deepStrictEqual(gaps.map((g) => [g.file, g.newRange]), [['a.cpp', { start: 4, end: 12 }], ['new.cpp', { start: 1, end: 1 }]]);
	const text = renderCoverage(review, gaps, changes);
	assert.ok(text.includes('- c1: "C"') && text.includes('- c1s1 in category c1: "first", lines 1-3') && text.includes('Not covered: lines 4-12 (+9 -0)'));
	assert.ok(text.includes('     5 +| \ta();') && !text.includes('second()'), 'only the uncovered lines are shown');

	const output = { categories: [{ id: 'c1', sections: [{ id: 'c1s1', newStart: 1, newEnd: 11 }, { file: 'new.cpp', title: 'z', summary: 'Z.', newStart: 1, newEnd: 1 }] }] };
	const merged = await mergeUpdate(review, output, new Set(), { head: '', source: review.source, lineCount: async () => 30 });
	assert.deepStrictEqual(merged.errors, []);
	assert.deepStrictEqual(merged.review.categories[0].sections.map((s) => [s.id, s.newRange, s.summary]), [
		['c1s1', { start: 1, end: 11 }, 'First.'],
		['c1s2', { start: 13, end: 21 }, 'Second.'],
		['c1s3', { start: 1, end: 1 }, 'Z.']
	]);
	assert.deepStrictEqual(coverageGaps(merged.review, changes), []);
});

test('staging a section with a nearby change leaves the next section unstaged', async () => {
	const dir = makeRepo({ 'f.cpp': lines('void a()', '{', '\told();', '}', 'end') });
	// One block: a()'s body and closing line change, and b() follows right after.
	write(dir, 'f.cpp', lines('void a()', '{', '\tnew();', '} // a', 'void b()', '{', '\tb();', '} // b', 'end'));
	const repo = await Repository.open(dir);
	await repo.refresh();
	// Section a() misses its closing line, which then joins it as a nearby change.
	const a = { id: 'a', file: 'f.cpp', title: 'a', summary: '', newRange: { start: 1, end: 3 } };
	const b = { id: 'b', file: 'f.cpp', title: 'b', summary: '', newRange: { start: 5, end: 8 } };
	const review = { categories: [{ id: 'c', title: 'C', oldBehavior: '', newBehavior: '', sections: [a, b] }] } as unknown as Review;
	const { attached } = findCoverage(review, repo.unstaged, (x) => x.newRange);
	const nearby = attached.get('a')!;
	assert.deepStrictEqual(nearby.map((c) => [c.newRange, c.oldRange]), [[{ start: 4, end: 4 }, { start: 4, end: 4 }]]);

	const newRanges = [a.newRange, ...nearby.map((c) => c.newRange!)];
	const oldRanges = nearby.map((c) => c.oldRange!);
	await repo.stageSelections([{ rel: 'f.cpp', select: (d) => selectSections(d.hunks, newRanges, oldRanges) }], 'Stage section');
	assert.strictEqual(indexContent(dir, 'f.cpp'), lines('void a()', '{', '\tnew();', '} // a', 'end'));
});

test('findSessions leaves out review sessions, but not coding sessions that ran the review skill', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explainyourself-repo-'));
	const config = fs.mkdtempSync(path.join(os.tmpdir(), 'explainyourself-claude-'));
	const project = path.join(config, 'projects', 'p');
	fs.mkdirSync(project, { recursive: true });
	const user = (text: string) => JSON.stringify({ type: 'user', cwd: root, message: { content: [{ type: 'text', text }] } });
	const edit = JSON.stringify({ parentUuid: null, type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(root, 'a.ts') } }] } });
	const toolResult = (text: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: text }] } });
	const transcripts: Record<string, string[]> = {
		coding: [user('Add a feature'), edit],
		// Forks of the coding session: the same edits, then the review prompt; newer sessions are also named.
		named: [user('Add a feature'), edit, JSON.stringify({ type: 'custom-title', customTitle: REVIEW_SESSION_NAME, sessionId: 'named' })],
		unnamed: [user('Add a feature'), edit, user(`${REVIEW_PROMPT_START} A human reviewer will read your categories.`)],
		// The /explain-yourself skill prints the prompt as a tool result in the coding session itself.
		skill: [user('Fix a bug'), edit, toolResult(`${REVIEW_PROMPT_START} A human reviewer will read your categories.`)]
	};
	for (const [name, lines] of Object.entries(transcripts)) {
		fs.writeFileSync(path.join(project, `${name}.jsonl`), lines.join('\n') + '\n');
	}

	const previous = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = config;
	try {
		const sessions = await findSessions(root, ['a.ts'], 1);
		assert.deepStrictEqual(sessions.map((s) => s.sessionId).sort(), ['coding', 'skill']);
	} finally {
		if (previous === undefined) {
			delete process.env.CLAUDE_CONFIG_DIR;
		} else {
			process.env.CLAUDE_CONFIG_DIR = previous;
		}
	}
});

test('findSessions ranks sessions by the uncommitted lines they wrote, also through drafts, scripts and subagents', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explainyourself-repo-'));
	const config = fs.mkdtempSync(path.join(os.tmpdir(), 'explainyourself-claude-'));
	const project = path.join(config, 'projects', 'p');
	fs.mkdirSync(project, { recursive: true });
	const at = (iso: string) => ({ parentUuid: null, type: 'assistant', timestamp: iso });
	const tool = (iso: string, name: string, input: Record<string, unknown>) => JSON.stringify({ ...at(iso), message: { content: [{ type: 'tool_use', name, input }] } });
	const user = JSON.stringify({ type: 'user', cwd: root, message: { content: [{ type: 'text', text: 'Work' }] } });
	const file = path.join(root, 'src', 'stream.cpp');
	const code = ['void Stream::Open(const char* name)', '{', '\tmHandle = OpenStreamHandle(name);', '\tmOpen = true;', '}'];
	const added = new Map([['src/stream.cpp', new Set(code.map((l) => l.trim()).filter((l) => l.length >= 4))]]);

	const transcripts: Record<string, string[]> = {
		// Edited the file often, long ago: none of what it wrote is still uncommitted.
		old: [user, ...Array.from({ length: 5 }, () => tool('2026-01-01T00:00:00Z', 'Edit', { file_path: file, new_string: 'int old = 0;' }))],
		// Wrote the code in place.
		direct: [user, tool('2026-01-02T00:00:00Z', 'Write', { file_path: file, content: code.join('\n') })],
		// Wrote a script that generates the code, and ran it.
		script: [user, tool('2026-01-03T00:00:00Z', 'Write', { file_path: path.join(config, 'gen.py'), content: `src = """\n${code[0]}\n${code[2]}\n"""` })],
		// Wrote a draft elsewhere with the same name; unrelated files of that name do not count.
		draft: [
			user,
			tool('2026-01-04T00:00:00Z', 'Write', { file_path: path.join(config, 'drafts', 'stream.cpp'), content: code[0] }),
			tool('2026-01-04T00:00:00Z', 'Write', { file_path: path.join(config, 'other', 'stream.cpp'), content: 'int unrelated;' })
		],
		// Delegated the edit to a subagent.
		parent: [user]
	};
	for (const [name, lines] of Object.entries(transcripts)) {
		fs.writeFileSync(path.join(project, `${name}.jsonl`), lines.join('\n') + '\n');
	}
	fs.mkdirSync(path.join(project, 'parent', 'subagents'), { recursive: true });
	fs.writeFileSync(path.join(project, 'parent', 'subagents', 'agent-1.jsonl'), tool('2026-01-05T00:00:00Z', 'Edit', { file_path: file, new_string: code[2] }) + '\n');

	const previous = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = config;
	try {
		const sessions = await findSessions(root, ['src/stream.cpp'], 1, added);
		assert.deepStrictEqual(
			sessions.map((s) => [s.sessionId, s.writtenLines]),
			[['direct', 3], ['script', 2], ['parent', 1], ['draft', 1], ['old', 0]]
		);
		assert.strictEqual(sessions.find((s) => s.sessionId === 'draft')!.editedFiles['src/stream.cpp'], 1);
		assert.strictEqual(sessions.find((s) => s.sessionId === 'parent')!.lastEdit!.toISOString(), '2026-01-05T00:00:00.000Z');
	} finally {
		if (previous === undefined) {
			delete process.env.CLAUDE_CONFIG_DIR;
		} else {
			process.env.CLAUDE_CONFIG_DIR = previous;
		}
	}
});

test('explain: the section listing marks added and removed lines; the output keeps notes inside the section', () => {
	// Line 2 replaced, line 4 added, old line 5 removed after line 5.
	const [d] = parseDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -2 +2 @@\n-old two\n+two\n@@ -3,0 +4 @@\n+four\n@@ -5 +5,0 @@\n-old five\n');
	const code = sectionListing(d, 'one\ntwo\nthree\nfour\nfive\nsix\n', { start: 1, end: 6 });
	assert.deepStrictEqual(
		code.map((l) => `${l.line ?? '-'}${l.marker}${l.text}`),
		['1 one', '--old two', '2+two', '3 three', '4+four', '5 five', '--old five', '6 six']
	);
	const untracked = sectionListing({ oldPath: null, newPath: 'n', path: 'n', binary: false, hunks: [] }, 'a\nb\n', { start: 1, end: 2 });
	assert.deepStrictEqual(untracked.map((l) => l.marker), ['+', '+']);

	const parsed = parseExplanation(
		{ summary: ' Does a thing. ', notes: [{ line: 9, text: 'Second.' }, { line: 3, text: 'First.' }, { line: 3, text: 'Duplicate.' }, { line: 40, text: 'Outside.' }, { line: 5, text: ' ' }] },
		{ start: 2, end: 20 }
	);
	assert.deepStrictEqual(parsed, { summary: 'Does a thing.', notes: [{ line: 3, text: 'First.' }, { line: 9, text: 'Second.' }] });
	assert.throws(() => parseExplanation({ summary: '', notes: [] }, { start: 1, end: 2 }));
});

test('snapSections moves section edges out to their block of added lines, but not past other sections or code', () => {
	// Lines 10-19 added: a doc comment (10-13), f() (14-16), a blank line (17), g() (18-19). Lines 40-45: code before h() (40-43), h() (44-45).
	const added = ['/**', ' * Does f.', ' * @return Nothing.', ' */', 'void f()', '{', '}', '', 'void g()', '{'];
	const more = ['int a = 1;', 'int b = 2;', 'int c = 3;', 'int d = 4;', 'void h()', '{'];
	const body = (start: number, lines: string[]) => `@@ -${start - 1},0 +${start},${lines.length} @@\n${lines.map((l) => `+${l}\n`).join('')}`;
	const [d] = parseDiff(`diff --git a/f b/f\n--- a/f\n+++ b/f\n${body(10, added)}${body(40, more)}`);
	const section = (id: string, start: number, end: number) => ({ id, file: 'f', title: id, summary: '', newRange: { start, end } });
	const f = section('f', 12, 15);
	const g = section('g', 18, 19);
	const h = section('h', 44, 45);
	const review = { categories: [{ id: 'c', title: 'C', oldBehavior: '', newBehavior: '', sections: [f, g, h] }] } as unknown as Review;
	const messages = snapSections(review, new Map([['f', d]]));
	// f() starts inside its doc comment and ends before its brace; g() follows a blank line that f() takes.
	assert.deepStrictEqual(f.newRange, { start: 10, end: 17 });
	assert.deepStrictEqual(g.newRange, { start: 18, end: 19 });
	// h() is preceded by four lines of code: not a miscount, so it stays.
	assert.deepStrictEqual(h.newRange, { start: 44, end: 45 });
	assert.strictEqual(messages.length, 2);
});
