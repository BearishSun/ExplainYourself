// Renders the Review panel outside VS Code with mock data, for visual checks in a headless browser.
// Usage: node scripts/panel-preview.js <out.html> [sections] [staged] [open-submodules] [expand]   (0 sections: no review yet; "-" skips an option)
const fs = require('fs');
const path = require('path');

const [out, sectionCount = '103', stagedCount = '30', openArg, expandArg] = process.argv.slice(2);
const openSubmodules = openArg && openArg !== '-';
const expand = expandArg && expandArg !== '-';
const total = Number(sectionCount);
const staged = Number(stagedCount);
const categories = [];
for (let c = 0, i = 0; i < total; c++) {
	const sections = [];
	for (let s = 0; s < 3 + (c % 5) * 3 && i < total; s++, i++) {
		sections.push({
			id: `c${c}s${s}`,
			file: `src/module${c}/file${s}.cpp`,
			title: `Section ${i}`,
			summary: `Changes \`Function${i}()\`.`,
			lines: `${10 * s + 1}-${10 * s + 8}`,
			status: (i * 7) % total < staged ? 'staged' : 'pending',
			comparable: true,
			related: s === 0 ? Array.from({ length: 7 }, (_, k) => ({ id: `c${c}s${k + 1}`, file: `src/module${c}/subsystem/file${k + 1}.h`, lines: `${4 + 10 * k}-${9 + 10 * k}` })) : s === 1 ? [{ id: `c${c}s1`, file: `src/module${c}/file1.h`, lines: '4-6' }] : [],
			added: (i * 37) % 90,
			removed: (i * 11) % 20,
			changed: Math.max((i * 37) % 90, (i * 11) % 20),
			concerns: i % 4 === 1 ? [{ tag: 'Duplication', text: `\`Parse${i}()\` repeats the loop of \`ParseHeader()\`; call it instead.` }, { tag: 'Docs', text: 'The comment still describes the old retry count.' }] : [],
			nearby: i % 3 === 0 ? 2 : 0
		});
	}
	const done = sections.filter((x) => x.status === 'staged').length;
	const concerns = c % 2 === 0 ? [{ tag: 'Layering', text: '`HeapPool` includes `D3D12Device.h` only for one enum; move the enum to the common header.' }, { tag: 'Performance', text: '`FindFreeBlock()` scans every block per allocation: O(n²) over a frame with many allocations.' }] : [];
	categories.push({ id: `c${c}`, title: `Category ${c}`, oldBehavior: 'Before.', newBehavior: 'After.', concerns, staged: done, total: sections.length, added: sections.reduce((n, x) => n + x.added, 0), removed: sections.reduce((n, x) => n + x.removed, 0), changed: sections.reduce((n, x) => n + x.changed, 0), sections });
}
const noReview = total === 0;
const state = {
	repo: {
		name: 'Framework',
		root: 'D:/Framework',
		branch: 'staging',
		changes: 40,
		submodules: [
			{ path: 'Platform/PS5', initialized: true, selected: true, changed: true },
			{ path: 'Platform/Switch', initialized: true, selected: false, changed: false },
			{ path: 'External/PhysX', initialized: false, selected: false, changed: false }
		]
	},
	account: { installed: true, loggedIn: true, email: 'user@example.com' },
	model: 'claude-sonnet-5-5',
	generation: process.env.PREVIEW_FOLLOW_UP ? { running: true, followUp: true, error: null, log: [{ kind: 'status', message: 'Validating review…' }, { kind: 'status', message: '4 change(s) in 2 file(s) have no section; asking the review session to cover them…' }, { kind: 'tool', message: 'Read coverage.md' }] } : null,
	uncovered: [],
	review: noReview ? null : {
		generatedAt: '2026-10-07T14:00:00Z',
		source: { kind: 'session', model: 'claude-sonnet-5-5', costUsd: 1.234 },
		title: 'Transient heap pools and GPU memory aliasing',
		overview: 'Adds transient heap pools.',
		staged: categories.reduce((n, c) => n + c.staged, 0),
		total,
		stale: [],
		categories
	}
};

// Dark theme variables the panel uses, with VS Code's default dark values.
const theme = `
body { background: #181818; font-family: 'Segoe UI', sans-serif; --vscode-font-size: 13px; --vscode-foreground: #cccccc;
	--vscode-descriptionForeground: #9d9d9d; --vscode-sideBar-background: #181818; --vscode-panel-border: #2b2b2b;
	--vscode-editorWarning-foreground: #cca700; --vscode-testing-iconPassed: #73c991; --vscode-textLink-foreground: #4daafc;
	--vscode-focusBorder: #0078d4; --vscode-button-background: #0078d4; --vscode-button-foreground: #fff;
	--vscode-badge-background: #616161; --vscode-badge-foreground: #f8f8f8; --vscode-textCodeBlock-background: #2b2b2b; }`;
const media = path.join(__dirname, '..', 'media');
fs.writeFileSync(
	out,
	`<!DOCTYPE html><html><head><meta charset="utf-8"><style>${theme}</style><style>${fs.readFileSync(path.join(media, 'review.css'), 'utf8')}</style></head>
<body><div id="root"></div>
<script>window.acquireVsCodeApi = () => ({ getState: () => null, setState() {}, postMessage() {} });</script>
<script>${fs.readFileSync(path.join(media, 'review.js'), 'utf8')}</script>
<script>window.postMessage({ type: 'state', state: ${JSON.stringify(state)} }, '*');</script>
${openSubmodules ? "<script>setTimeout(() => document.querySelector('[data-toggle-subs]').click(), 50);</script>" : ''}
${expand ? "<script>setTimeout(() => document.querySelectorAll('details.category')[1].setAttribute('open', ''), 80);</script>" : ''}
</body></html>`
);
