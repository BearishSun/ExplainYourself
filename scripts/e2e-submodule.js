// End-to-end check of a review that includes a submodule, with a real `claude -p` run.
// Usage: node scripts/e2e-submodule.js [model]
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Workspace } = require('../out/core/workspace.js');
const { generateReview } = require('../out/core/generate.js');
const { loadFullDiff } = require('../out/core/changes.js');
const { findUncovered } = require('../out/core/coverage.js');

const model = process.argv[2] || 'claude-sonnet-5-5';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explainyourself-e2e-sub-'));
const init = (dir, files) => {
	fs.mkdirSync(dir, { recursive: true });
	const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
	git('init', '-q');
	git('config', 'user.email', 't@t');
	git('config', 'user.name', 't');
	git('config', 'core.autocrlf', 'false');
	for (const [name, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		fs.writeFileSync(path.join(dir, name), content);
	}
	git('add', '-A');
	git('commit', '-q', '-m', 'init');
	return git;
};

const lib = path.join(tmp, 'lib');
init(lib, { 'clamp.ts': 'export function clamp(v: number, lo: number, hi: number): number {\n\treturn Math.min(hi, Math.max(lo, v));\n}\n' });
const dir = path.join(tmp, 'app');
const git = init(dir, { 'main.ts': "import { clamp } from './lib/clamp';\n\nexport function volume(v: number): number {\n\treturn clamp(v, 0, 100);\n}\n" });
git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
git('commit', '-q', '-m', 'add lib');

// The library gains a NaN guard; the app switches to a 0..1 range.
fs.writeFileSync(
	path.join(dir, 'lib', 'clamp.ts'),
	'/** Clamps `v` to [lo, hi]. NaN clamps to `lo`. */\nexport function clamp(v: number, lo: number, hi: number): number {\n\tif (Number.isNaN(v)) {\n\t\treturn lo;\n\t}\n\treturn Math.min(hi, Math.max(lo, v));\n}\n'
);
fs.writeFileSync(path.join(dir, 'main.ts'), "import { clamp } from './lib/clamp';\n\nexport function volume(v: number): number {\n\treturn clamp(v, 0, 1);\n}\n");

(async () => {
	const ws = await Workspace.open(dir);
	await ws.setSubmodules(['lib']);
	const started = Date.now();
	const { review, warnings } = await generateReview(ws, {
		claudePath: process.env.CLAUDE_PATH || 'claude',
		model,
		source: { kind: 'fresh' },
		sessionMaxAgeDays: 1,
		onProgress: (p) => p.kind !== 'text' && console.log(`[${p.kind}] ${p.message.slice(0, 120)}`)
	});
	console.log(`\nGenerated in ${((Date.now() - started) / 1000).toFixed(1)} s with ${review.source.model}, $${review.source.costUsd?.toFixed(3)}`);
	warnings.forEach((w) => console.log(`WARNING ${w}`));
	console.log(`Title: ${review.title}`);
	console.log(`Submodules: ${JSON.stringify(review.submodules)} heads ${JSON.stringify(review.submoduleHeads)}`);
	for (const c of review.categories) {
		console.log(`## ${c.title}`);
		c.sections.forEach((s) => console.log(`  * ${s.file} ${s.newRange ? `${s.newRange.start}-${s.newRange.end}` : '-'}: ${s.title}`));
	}
	await ws.refresh();
	const uncovered = findUncovered(review, await loadFullDiff(ws), (s) => s.newRange);
	console.log(`Uncovered changes: ${JSON.stringify(uncovered)}`);
	console.log(`Repository: ${dir}`);
})().catch((e) => {
	console.error('FAILED', e.message);
	process.exit(1);
});
