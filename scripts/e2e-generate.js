// End-to-end check of review generation with a real `claude -p` run on a scratch repository.
// Usage: node scripts/e2e-generate.js [model]
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Workspace } = require('../out/core/workspace.js');
const { generateReview } = require('../out/core/generate.js');
const { loadFullDiff } = require('../out/core/changes.js');
const { findUncovered } = require('../out/core/coverage.js');

const model = process.argv[2] || 'claude-sonnet-5-5';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainyourself-e2e-'));
const git = (...args) => execFileSync('git', args, { cwd: dir });
git('init', '-q');
git('config', 'user.email', 't@t');
git('config', 'user.name', 't');
git('config', 'core.autocrlf', 'false');

const src = path.join(__dirname, '..', 'src', 'core');
fs.mkdirSync(path.join(dir, 'core'));
for (const f of ['exec.ts', 'diff.ts', 'stager.ts']) {
	fs.copyFileSync(path.join(src, f), path.join(dir, 'core', f));
}
// Project instructions the review should check the changes against.
fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Conventions\n\n- Names have no abbreviations: `fileStats`, not `f`; loop variables are named, `fileIndex`, not `i`.\n');
git('add', '-A');
git('commit', '-q', '-m', 'init');

const edit = (file, fn) => {
	const p = path.join(dir, 'core', file);
	fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8')));
};

// Change 1: a timeout for git invocations.
edit('exec.ts', (s) =>
	s
		.replace('\treadOnly?: boolean;\n}', '\treadOnly?: boolean;\n\t/** Kills git after this many milliseconds. */\n\ttimeoutMs?: number;\n}')
		.replace(
			"\t\tchild.on('error', reject);",
			"\t\tconst timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;\n\t\tchild.on('exit', () => clearTimeout(timer));\n\t\tchild.on('error', reject);"
		)
);
// Change 2: rename splitLines -> splitIntoLines.
edit('diff.ts', (s) => s.replace(/splitLines/g, 'splitIntoLines'));
edit('stager.ts', (s) => s.replace(/splitLines/g, 'splitIntoLines'));
// Change 3: a new file.
fs.writeFileSync(
	path.join(dir, 'core', 'timing.ts'),
	'/** Measures how long an async operation takes. */\nexport async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {\n\tconst start = Date.now();\n\ttry {\n\t\treturn await fn();\n\t} finally {\n\t\tconsole.log(`${label}: ${Date.now() - start} ms`);\n\t}\n}\n'
);

// Change 4: tests for the new helper; the review should put them in their own category, last.
fs.mkdirSync(path.join(dir, 'test'));
fs.writeFileSync(
	path.join(dir, 'test', 'timing.test.ts'),
	"import * as assert from 'assert';\nimport { test } from 'node:test';\nimport { timed } from '../core/timing';\n\ntest('timed returns the result', async () => {\n\tassert.strictEqual(await timed('x', async () => 42), 42);\n});\n\ntest('timed rethrows', async () => {\n\tawait assert.rejects(timed('x', async () => {\n\t\tthrow new Error('boom');\n\t}));\n});\n"
);

// Change 5: a new file with a method over 60 lines (own section, with notes) and one over 30 lines (own section).
fs.copyFileSync(path.join(__dirname, 'e2e-fixtures', 'report.ts'), path.join(dir, 'core', 'report.ts'));

(async () => {
	const repo = await Workspace.open(dir);
	const started = Date.now();
	const { review, warnings } = await generateReview(repo, {
		claudePath: process.env.CLAUDE_PATH || 'claude',
		model,
		source: { kind: 'fresh' },
		sessionMaxAgeDays: 1,
		onProgress: (p) => console.log(`[${p.kind}] ${p.message.slice(0, 160).replace(/\n/g, ' ')}`)
	});
	console.log(`\nGenerated in ${((Date.now() - started) / 1000).toFixed(1)} s, cost $${review.source.costUsd?.toFixed(3)}`);
	warnings.forEach((w) => console.log(`WARNING ${w}`));
	console.log(`Overview: ${review.overview}\n`);
	for (const c of review.categories) {
		console.log(`## ${c.title}\n  before: ${c.oldBehavior}\n  after: ${c.newBehavior}`);
		for (const x of c.concerns ?? []) {
			console.log(`  check [${x.tag}] ${x.text}`);
		}
		for (const s of c.sections) {
			const nr = s.newRange ? `${s.newRange.start}-${s.newRange.end}` : '-';
			const or = s.oldRange ? `${s.oldRange.start}-${s.oldRange.end}` : '-';
			console.log(`  * ${s.file} new ${nr} old ${or} [${s.effort ?? '-'}]: ${s.title} — ${s.summary}`);
			for (const x of s.concerns ?? []) {
				console.log(`      check [${x.tag}] ${x.text}`);
			}
			for (const n of s.notes ?? []) {
				console.log(`      note @${n.line}: ${n.text}`);
			}
		}
	}
	await repo.refresh();
	const uncovered = findUncovered(review, await loadFullDiff(repo), (s) => s.newRange);
	console.log(`\nUncovered changes: ${JSON.stringify(uncovered)}`);
	console.log(`Repository: ${dir}`);
})().catch((e) => {
	console.error('FAILED', e.message);
	process.exit(1);
});
