// End-to-end check of the coverage repair pass, on a repository prepared by e2e-generate.js.
// Removes some sections from the saved review, then lets the review session cover the lines again.
// Usage: node scripts/e2e-repair.js <dir> [model]
const fs = require('fs');
const path = require('path');
const { Workspace } = require('../out/core/workspace.js');
const { buildChangeSet } = require('../out/core/changes.js');
const { repairCoverage } = require('../out/core/generate.js');
const { coverageGaps } = require('../out/core/repair.js');
const { loadReview, reviewDir } = require('../out/core/review.js');

const [dir, model = 'claude-sonnet-5-5'] = process.argv.slice(2);

(async () => {
	const repo = await Workspace.open(dir);
	const review = await loadReview(repo.gitDir);
	const changes = await buildChangeSet(repo);

	// Drop the sections of the new timing helper, and cut the last section of the report down to its first line.
	for (const c of review.categories) {
		c.sections = c.sections.filter((s) => s.file !== 'core/timing.ts');
	}
	review.categories = review.categories.filter((c) => c.sections.length > 0);
	const report = review.categories.flatMap((c) => c.sections).filter((s) => s.file === 'core/report.ts' && s.newRange).pop();
	console.log(`Cut "${report.title}" ${report.newRange.start}-${report.newRange.end} to its first line`);
	report.newRange = { start: report.newRange.start, end: report.newRange.start };

	const gaps = coverageGaps(review, changes);
	console.log(`Gaps before: ${gaps.map((g) => `${g.file}:${g.newRange?.start}-${g.newRange?.end}`).join(', ')}`);
	const before = new Set(review.categories.flatMap((c) => c.sections.map((s) => s.id)));
	const sessionBefore = review.source.reviewSessionId;

	const started = Date.now();
	const { review: repaired, warnings } = await repairCoverage(repo, changes, { review, warnings: [] }, {
		claudePath: process.env.CLAUDE_PATH || 'claude',
		model,
		source: { kind: 'fresh' },
		sessionMaxAgeDays: 1,
		onProgress: (p) => console.log(`[${p.kind}] ${p.message.slice(0, 160).replace(/\n/g, ' ')}`)
	});
	console.log(`\nRepaired in ${((Date.now() - started) / 1000).toFixed(1)} s, total cost $${repaired.source.costUsd?.toFixed(3)}`);
	console.log(`Same session: ${repaired.source.reviewSessionId === sessionBefore}`);
	warnings.forEach((w) => console.log(`WARNING ${w}`));
	console.log(`\ncoverage.md:\n${fs.readFileSync(path.join(reviewDir(repo.gitDir), 'coverage.md'), 'utf8')}`);
	for (const c of repaired.categories) {
		for (const s of c.sections) {
			if (!before.has(s.id) || s === report || s.id === report.id) {
				console.log(`${before.has(s.id) ? 'CHANGED' : 'NEW'} ${c.id}/${s.id} ${s.file} ${s.newRange?.start}-${s.newRange?.end} ${s.title}`);
			}
		}
	}
	const left = coverageGaps(repaired, changes);
	console.log(`Gaps after: ${left.length}`);
	process.exit(left.length === 0 ? 0 : 1);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
