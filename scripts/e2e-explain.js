// End-to-end check of "Explain in More Detail" on a repository prepared by e2e-generate.js: continues the
// review session for the longest section and prints its summary and notes before and after.
// Usage: node scripts/e2e-explain.js <dir> [model]
const fs = require('fs');
const path = require('path');
const { Workspace } = require('../out/core/workspace.js');
const { loadFullDiff } = require('../out/core/changes.js');
const { explainSection, sectionListing } = require('../out/core/explain.js');
const { loadReview } = require('../out/core/review.js');

const [dir, model = 'claude-sonnet-5-5'] = process.argv.slice(2);

(async () => {
	const repo = await Workspace.open(dir);
	await repo.refresh();
	const review = await loadReview(repo.gitDir);
	const section = review.categories
		.flatMap((c) => c.sections)
		.filter((s) => s.newRange)
		.sort((a, b) => b.newRange.end - b.newRange.start - (a.newRange.end - a.newRange.start))[0];
	const text = fs.readFileSync(path.join(dir, section.file), 'utf8');
	const diffs = await loadFullDiff(repo);
	const request = { section, range: section.newRange, notes: section.notes ?? [], code: sectionListing(diffs.get(section.file), text, section.newRange) };

	console.log(`Section "${section.title}" ${section.file}:${section.newRange.start}-${section.newRange.end}\n`);
	console.log(`BEFORE\n${section.summary}`);
	(section.notes ?? []).forEach((n) => console.log(`  @${n.line}: ${n.text}`));

	const started = Date.now();
	const result = await explainSection(request, {
		claudePath: process.env.CLAUDE_PATH || 'claude',
		model,
		repoRoot: repo.root,
		session: { id: review.source.reviewSessionId, cwd: review.source.reviewCwd }
	});
	console.log(`\nAFTER (${((Date.now() - started) / 1000).toFixed(1)} s, $${result.costUsd?.toFixed(3)}, same session: ${result.sessionId === review.source.reviewSessionId})\n${result.summary}`);
	result.notes.forEach((n) => console.log(`  @${n.line}: ${n.text}`));
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
