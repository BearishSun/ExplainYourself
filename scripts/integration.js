// Runs src/integration/suite.ts in a separate VS Code instance with a throwaway profile.
// Usage: node scripts/integration.js [path-to-Code-executable]
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ext = path.resolve(__dirname, '..');
const code = (process.argv[2] !== '--demo' && process.argv[2]) || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explainyourself-it-'));
const repo = path.join(tmp, 'repo');
const userData = path.join(tmp, 'user');
const out = path.join(tmp, 'result.txt');

// --demo <repo>: open an existing repository with a review instead of the test fixture.
const demoIndex = process.argv.indexOf('--demo');
const demoRepo = demoIndex >= 0 ? process.argv[demoIndex + 1] : null;
if (demoIndex >= 0) {
	process.argv.splice(demoIndex, 2);
}

fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo });
git('init', '-q');
git('config', 'user.email', 't@t');
git('config', 'user.name', 't');
git('config', 'core.autocrlf', 'false');
const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
fs.writeFileSync(path.join(repo, 'a.txt'), original.join('\n') + '\n');
git('add', '-A');
git('commit', '-q', '-m', 'init');
const modified = [...original];
modified[4] = 'line 5 changed';
modified[19] = 'line 20 changed';
modified.splice(25, 0, 'inserted after 25');
fs.writeFileSync(path.join(repo, 'a.txt'), modified.join('\n') + '\n');
fs.writeFileSync(path.join(repo, 'b.txt'), 'b1\nb2\n');

fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(
	path.join(userData, 'User', 'settings.json'),
	JSON.stringify({ 'diffEditor.codeLens': true, 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'window.restoreWindows': 'none' })
);

const childEnv = { ...process.env, EXPLAIN_TEST_OUT: out, ...(demoRepo ? { EXPLAIN_DEMO: '1' } : {}) };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(
	code,
	[
		demoRepo || repo,
		'--new-window',
		'--disable-extensions',
		'--skip-welcome',
		'--skip-release-notes',
		`--user-data-dir=${userData}`,
		`--extensions-dir=${path.join(tmp, 'ext')}`,
		`--extensionDevelopmentPath=${ext}`,
		`--extensionTestsPath=${path.join(ext, 'out', 'integration', 'suite.js')}`
	],
	{ env: childEnv, stdio: 'inherit' }
);

const screenshot = process.env.EXPLAIN_SCREENSHOT;
let captured = false;
const poll = setInterval(() => {
	if (captured || !fs.existsSync(path.join(tmp, 'screenshot-ready'))) {
		return;
	}
	captured = true;
	if (screenshot) {
		setTimeout(() => {
			try {
				execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'screenshot.ps1'), screenshot]);
			} catch (e) {
				console.error('screenshot failed', e.message);
			}
			fs.writeFileSync(path.join(tmp, 'screenshot-done'), '');
		}, 2500);
	} else {
		fs.writeFileSync(path.join(tmp, 'screenshot-done'), '');
	}
}, 200);

child.on('exit', (exitCode) => {
	clearInterval(poll);
	const result = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '(no result file)\n';
	process.stdout.write(result);
	console.log(`VS Code exited with ${exitCode}; workspace ${tmp}`);
	process.exit(result.includes('FAIL') || result.includes('ERROR') || !result.includes('DONE') ? 1 : 0);
});
