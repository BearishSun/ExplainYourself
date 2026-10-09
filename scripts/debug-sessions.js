// Lists Claude Code sessions that edited changed files of a repository.
// Usage: node scripts/debug-sessions.js <repo> [days]
const { findSessions } = require('../out/core/sessions.js');
const { Repository } = require('../out/core/repository.js');

(async () => {
	const repo = await Repository.open(process.argv[2] || process.cwd());
	await repo.refresh();
	const files = [...new Set([...repo.status.map((e) => e.path), ...repo.staged.keys()])];
	const started = Date.now();
	const sessions = await findSessions(repo.root, files, Number(process.argv[3] || 14));
	console.log(`${files.length} changed files, ${sessions.length} sessions, ${Date.now() - started} ms`);
	for (const s of sessions.slice(0, 5)) {
		console.log(`${s.sessionId} ${s.lastActive.toISOString()} cwd=${s.cwd}`);
		console.log(`  "${s.title.slice(0, 100)}"`);
		console.log(`  ${Object.entries(s.editedFiles).map(([f, n]) => `${f} x${n}`).join(', ')}`);
	}
})();
