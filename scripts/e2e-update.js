// End-to-end check of incremental review updates on a repository produced by e2e-generate.js.
// Edits one file, runs "Update review", and reports which sections changed.
// Usage: node scripts/e2e-update.js <scratch repo> [model]
const fs = require('fs');
const path = require('path');
const { Workspace } = require('../out/core/workspace.js');
const { generateReview } = require('../out/core/generate.js');
const { loadReview } = require('../out/core/review.js');

const dir = process.argv[2];
const model = process.argv[3] || 'claude-sonnet-5-5';

const describe = (review) =>
	review.categories.flatMap((c) => c.sections.map((s) => `${c.id}/${s.id} ${s.file} ${s.newRange ? `${s.newRange.start}-${s.newRange.end}` : '-'} ${s.layout ?? ''} ${s.title}`));

(async () => {
	const repo = await Workspace.open(dir);
	const before = await loadReview(repo.gitDir);
	console.log(`Before (session ${before.source.reviewSessionId}):\n  ${describe(before).join('\n  ')}`);

	// Rewrite timed() in core/timing.ts.
	fs.writeFileSync(
		path.join(dir, 'core', 'timing.ts'),
		'/** Measures how long an async operation takes and reports it through `report`. */\nexport async function timed<T>(label: string, fn: () => Promise<T>, report: (line: string) => void = console.log): Promise<T> {\n\tconst start = performance.now();\n\tlet failed = false;\n\ttry {\n\t\treturn await fn();\n\t} catch (e) {\n\t\tfailed = true;\n\t\tthrow e;\n\t} finally {\n\t\tconst ms = (performance.now() - start).toFixed(1);\n\t\treport(`${label}: ${ms} ms${failed ? \' (failed)\' : \'\'}`);\n\t}\n}\n'
	);

	const started = Date.now();
	const { review, warnings, upToDate } = await generateReview(repo, {
		claudePath: process.env.CLAUDE_PATH || 'claude',
		model,
		source: { kind: 'update' },
		sessionMaxAgeDays: 1,
		onProgress: (p) => console.log(`[${p.kind}] ${p.message.slice(0, 140).replace(/\n/g, ' ')}`)
	});
	console.log(`\nUpdated in ${((Date.now() - started) / 1000).toFixed(1)} s, upToDate=${!!upToDate}, total cost $${review.source.costUsd?.toFixed(3)}`);
	warnings.forEach((w) => console.log(`WARNING ${w}`));
	console.log(`Same review session: ${review.source.reviewSessionId === before.source.reviewSessionId}`);
	console.log(`After:\n  ${describe(review).join('\n  ')}`);

	const unchangedBefore = describe(before).filter((l) => !l.includes('core/timing.ts'));
	const unchangedAfter = describe(review).filter((l) => !l.includes('core/timing.ts'));
	console.log(`Sections of other files unchanged: ${JSON.stringify(unchangedBefore) === JSON.stringify(unchangedAfter)}`);

	const again = await generateReview(repo, { claudePath: 'claude', model, source: { kind: 'update' }, sessionMaxAgeDays: 1, onProgress: () => undefined });
	console.log(`Second update reports up to date: ${!!again.upToDate}`);
})().catch((e) => {
	console.error('FAILED', e.message);
	process.exit(1);
});
