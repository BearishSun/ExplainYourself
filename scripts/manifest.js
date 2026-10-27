// Regenerates the "contributes" section of package.json. Run with: node scripts/manifest.js
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const cmd = (command, title, icon) => ({ command, title, category: 'ExplainYourself', ...(icon ? { icon: `$(${icon})` } : {}) });

pkg.contributes = {
	viewsContainers: { activitybar: [{ id: 'explainYourself', title: 'ExplainYourself', icon: 'media/icon.svg' }] },
	views: {
		explainYourself: [
			{ type: 'webview', id: 'explainYourself.review', name: 'Review' },
			{ id: 'explainYourself.changes', name: 'Changes', visibility: 'collapsed' }
		]
	},
	viewsWelcome: [
		{ view: 'explainYourself.changes', contents: 'No Git repository is open.\n[Open Repository…](command:explainYourself.openRepository)', when: '!explainYourself.hasRepository' }
	],
	commands: [
		cmd('explainYourself.openRepository', 'Open Repository…', 'folder-opened'),
		cmd('explainYourself.refresh', 'Refresh', 'refresh'),
		cmd('explainYourself.stageFile', 'Stage File', 'add'),
		cmd('explainYourself.unstageFile', 'Unstage File', 'remove'),
		cmd('explainYourself.stageAll', 'Stage All Changes', 'add'),
		cmd('explainYourself.unstageAll', 'Unstage All Changes', 'remove'),
		cmd('explainYourself.stageSelection', 'Stage/Unstage Selected Lines (or Hunk at Cursor)', 'diff-added'),
		{ ...cmd('explainYourself.undo', 'Undo Last Stage/Unstage', 'discard'), enablement: 'explainYourself.canUndo' },
		{ ...cmd('explainYourself.redo', 'Redo Stage/Unstage', 'redo'), enablement: 'explainYourself.canRedo' },
		cmd('explainYourself.generate', 'Generate Review', 'sparkle'),
		cmd('explainYourself.updateReview', 'Update Review (Re-review Changed Files)', 'sync'),
		cmd('explainYourself.settings', 'Display Settings…', 'settings-gear'),
		cmd('explainYourself.generateFromSession', 'Generate Review from a Claude Session…'),
		cmd('explainYourself.generateFresh', 'Generate Review with a New Agent'),
		cmd('explainYourself.useInSession', 'Generate Review from Inside a Claude Session (/explain-yourself)'),
		cmd('explainYourself.cancelGeneration', 'Cancel Review Generation'),
		cmd('explainYourself.selectSubmodules', 'Select Submodules to Review…'),
		cmd('explainYourself.setSubmodules', 'Set Submodules to Review'),
		cmd('explainYourself.showPrompt', 'Show Last Prompt Sent to Claude'),
		cmd('explainYourself.editReviewRules', 'Edit Review Rules'),
		cmd('explainYourself.stageUncovered', 'Stage Changes Not Covered by the Review'),
		cmd('explainYourself.stageSection', 'Stage Section', 'check'),
		cmd('explainYourself.revealSection', 'Show in Review Panel', 'list-tree'),
		cmd('explainYourself.explainSection', 'Explain in More Detail', 'question'),
		cmd('explainYourself.toggleInline', 'Toggle Inline / Side-by-Side Diff', 'split-horizontal'),
		cmd('explainYourself.compareSection', 'Compare Old ↔ New', 'versions'),
		cmd('explainYourself.compareAtCursor', 'Compare Old ↔ New Version of the Section at the Cursor', 'versions'),
		cmd('explainYourself.showAsDiff', 'Show as Diff', 'diff'),
		cmd('explainYourself.goToRelated', 'Go to Related Section (Declaration ↔ Definition)', 'go-to-file'),
		cmd('explainYourself.togglePlainCompare', 'Toggle Highlights in Old ↔ New Comparison', 'eye'),
		cmd('explainYourself.account', 'Claude Account…', 'account'),
		cmd('explainYourself.signIn', 'Sign in to Claude'),
		cmd('explainYourself.openSection', 'Open Review Section'),
		cmd('explainYourself.openDiff', 'Open Diff'),
		cmd('explainYourself.openDiffAt', 'Open Diff at Line'),
		cmd('explainYourself.stageHunk', 'Stage Hunk'),
		cmd('explainYourself.unstageHunk', 'Unstage Hunk'),
		cmd('explainYourself.stageCategory', 'Stage Category'),
		cmd('explainYourself.setToggle', 'Set Highlight Toggle'),
		cmd('explainYourself.setModel', 'Set Review Model')
	],
	menus: {
		commandPalette: ['generateFromSession', 'generateFresh', 'useInSession', 'compareSection', 'openSection','openDiff', 'openDiffAt', 'stageHunk', 'unstageHunk', 'stageCategory', 'setToggle', 'setModel', 'stageSection', 'revealSection', 'explainSection', 'stageFile', 'unstageFile', 'setSubmodules'].map(
			(c) => ({ command: `explainYourself.${c}`, when: 'false' })
		),
		'view/title': [
			{ command: 'explainYourself.undo', when: 'view == explainYourself.changes', group: 'navigation@1' },
			{ command: 'explainYourself.redo', when: 'view == explainYourself.changes', group: 'navigation@2' },
			{ command: 'explainYourself.refresh', when: 'view == explainYourself.changes', group: 'navigation@3' },
			{ command: 'explainYourself.openRepository', when: 'view == explainYourself.changes', group: 'navigation@4' },
			{ command: 'explainYourself.undo', when: 'view == explainYourself.review', group: 'navigation@1' },
			{ command: 'explainYourself.redo', when: 'view == explainYourself.review', group: 'navigation@2' },
			{ command: 'explainYourself.toggleInline', when: 'view == explainYourself.review', group: 'navigation@3' },
			{ command: 'explainYourself.account', when: 'view == explainYourself.review', group: 'navigation@4' },
			{ command: 'explainYourself.settings', when: 'view == explainYourself.review', group: 'navigation@5' }
		],
		'view/item/context': [
			{ command: 'explainYourself.stageFile', when: 'view == explainYourself.changes && viewItem == file-unstaged', group: 'inline' },
			{ command: 'explainYourself.unstageFile', when: 'view == explainYourself.changes && viewItem == file-staged', group: 'inline' },
			{ command: 'explainYourself.stageAll', when: 'view == explainYourself.changes && viewItem == group-unstaged', group: 'inline' },
			{ command: 'explainYourself.unstageAll', when: 'view == explainYourself.changes && viewItem == group-staged', group: 'inline' }
		],
		'editor/title': [
			{ command: 'explainYourself.stageSelection', when: 'explainYourself.editorView', group: 'navigation@-10' },
			{ command: 'explainYourself.undo', when: 'explainYourself.editorView', group: 'navigation@-9' },
			{ command: 'explainYourself.toggleInline', when: 'explainYourself.editorView && !explainYourself.compareActive', group: 'navigation@-8' },
			{ command: 'explainYourself.compareAtCursor', when: 'explainYourself.reviewEditor && !explainYourself.compareActive', group: 'navigation@-7' },
			{ command: 'explainYourself.showAsDiff', when: 'explainYourself.compareActive', group: 'navigation@-7' },
			{ command: 'explainYourself.goToRelated', when: 'explainYourself.hasRelated', group: 'navigation@-6.5' },
			{ command: 'explainYourself.togglePlainCompare', when: 'explainYourself.compareActive', group: 'navigation@-6' }
		],
		'editor/context': [
			{ command: 'explainYourself.stageSelection', when: 'explainYourself.editorView', group: '1_explainYourself@1' },
			{ command: 'explainYourself.undo', when: 'explainYourself.editorView', group: '1_explainYourself@2' }
		],
		'comments/commentThread/title': [
			{ command: 'explainYourself.stageSection', when: 'commentController == explainYourself && commentThread != explainYourselfNote', group: 'inline@1' },
			{ command: 'explainYourself.compareSection', when: 'commentController == explainYourself && commentThread != explainYourselfNote', group: 'inline@2' },
			{ command: 'explainYourself.goToRelated', when: 'commentController == explainYourself && commentThread == explainYourselfGrouped', group: 'inline@3' },
			{ command: 'explainYourself.revealSection', when: 'commentController == explainYourself && commentThread != explainYourselfNote', group: 'inline@4' },
			{ command: 'explainYourself.explainSection', when: 'commentController == explainYourself && commentThread != explainYourselfNote', group: 'inline@5' }
		]
	},
	keybindings: [
		{ command: 'explainYourself.goToRelated', key: 'ctrl+alt+o', mac: 'cmd+alt+o', when: 'editorTextFocus && explainYourself.hasRelated' },
		{ command: 'explainYourself.stageSelection', key: 'ctrl+alt+s', mac: 'cmd+alt+s', when: 'editorTextFocus && explainYourself.editorView' },
		{ command: 'explainYourself.undo', key: 'ctrl+alt+z', mac: 'cmd+alt+z', when: 'explainYourself.editorView || focusedView == explainYourself.changes || focusedView == explainYourself.review' },
		{ command: 'explainYourself.redo', key: 'ctrl+alt+y', mac: 'cmd+alt+shift+z', when: 'explainYourself.editorView || focusedView == explainYourself.changes || focusedView == explainYourself.review' }
	],
	colors: [
		{
			id: 'explainYourself.sectionBackground',
			description: 'Background of the lines a review section covers in diffs. Keep it faint: the diff colors show the changes.',
			defaults: { dark: '#ffffff0d', light: '#0000000a', highContrast: '#ffffff0d', highContrastLight: '#0000000a' }
		},
		{
			id: 'explainYourself.sectionBorder',
			description: 'Bar along the left edge of the lines a review section covers in diffs. It stays visible over the diff colors.',
			defaults: { dark: '#ffffff59', light: '#00000040', highContrast: '#ffffffa0', highContrastLight: '#00000080' }
		}
	],
	configuration: {
		title: 'ExplainYourself',
		properties: {
			'explainYourself.claudePath': { type: 'string', default: '', description: 'Path to the claude executable. Empty: search PATH and the default install locations.' },
			'explainYourself.gitPath': { type: 'string', default: '', description: 'Path to the git executable. Empty: use git from PATH.' },
			'explainYourself.model': { type: 'string', default: 'claude-sonnet-5-5', description: 'Model for review generation and updates, for example "claude-sonnet-5-5", "sonnet" or "opus". Empty: the Claude Code default.' },
			'explainYourself.sessionSearchDays': { type: 'number', default: 14, description: 'How many days of Claude Code session transcripts to search for the session that wrote the changes.' },
			'explainYourself.askForSession': { type: 'boolean', default: true, description: 'Before generating a review, choose which Claude session to fork, or a new agent. The sessions that wrote the most of the uncommitted lines come first. When off, that session is forked without asking, or a new agent starts when no session wrote any of them.' },
			'explainYourself.diffAlgorithm': { type: 'string', enum: ['histogram', 'patience', 'myers', 'minimal'], default: 'histogram', description: 'Diff algorithm used to compute hunks.' },
			'explainYourself.showSummaries': { type: 'boolean', default: true, description: 'Show section summaries inline in diffs.' },
			'explainYourself.summariesExpanded': { type: 'boolean', default: true, description: 'Expand inline section summaries by default.' },
			'explainYourself.jumpToNextSection': { type: 'boolean', default: true, description: 'After staging a section, open the next section that still has unstaged changes.' },
			'explainYourself.highlightSections': { type: 'boolean', default: true, description: 'Shade the lines each review section covers in diffs, with the nearby changes staged along with it. Change the colors with the explainYourself.sectionBackground and explainYourself.sectionBorder theme colors.' },
			'explainYourself.codeLens': { type: 'boolean', default: true, description: 'Show "Stage hunk" / "Unstage hunk" CodeLenses in diffs.' },
			'explainYourself.plainCompare': { type: 'boolean', default: false, description: 'Hide highlights, summaries and CodeLenses in the old ↔ new comparison.' },
			'explainYourself.stageFromEditors': { type: 'boolean', default: false, description: 'Also allow staging, and show hunk CodeLenses, in plain editors of repository files.' }
		}
	}
};

fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
