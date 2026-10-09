// Checks that review generation can fork an existing session (claude -p --resume <id> --fork-session).
// Usage: node scripts/e2e-fork.js <scratch repo from e2e-generate.js> [model]
const { execFileSync } = require('child_process');
const { Workspace } = require('../out/core/workspace.js');
const { generateReview } = require('../out/core/generate.js');

const dir = process.argv[2];
const model = process.argv[3] || 'claude-sonnet-5-5';
const claude = process.env.CLAUDE_PATH || 'claude';

(async () => {
	// A tiny session that "explains" the intent, standing in for the session that wrote the code.
	const out = execFileSync(claude, ['-p', '--model', model, '--output-format', 'json', 'Remember this: the git timeout in core/exec.ts exists because git hung on a network drive. Reply OK.'], {
		cwd: dir,
		encoding: 'utf8'
	});
	const sessionId = JSON.parse(out).session_id;
	console.log(`Seed session ${sessionId}`);

	const repo = await Workspace.open(dir);
	const { review } = await generateReview(repo, {
		claudePath: claude,
		model,
		source: { kind: 'session', session: { sessionId, cwd: dir, transcript: '', title: 'seed', lastActive: new Date(), editedFiles: {} } },
		sessionMaxAgeDays: 1,
		onProgress: (p) => console.log(`[${p.kind}] ${p.message.slice(0, 120).replace(/\n/g, ' ')}`)
	});
	console.log(`Source: ${JSON.stringify(review.source)}`);
	const timeout = review.categories.find((c) => /timeout/i.test(c.title));
	console.log(`Timeout category mentions the network drive: ${/network/i.test(JSON.stringify(timeout ?? {}))}`);
	console.log(timeout?.newBehavior);
})().catch((e) => {
	console.error('FAILED', e.message);
	process.exit(1);
});
