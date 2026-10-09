import * as path from 'path';
import * as vscode from 'vscode';
import { StatusEntry, isStaged, isUnstaged } from '../core/status';
import { AppState } from './state';
import { DiffView } from './util';

type Node = { kind: 'group'; view: DiffView; entries: StatusEntry[] } | { kind: 'file'; view: DiffView; entry: StatusEntry };

const STATUS_TEXT: Record<string, string> = {
	M: 'Modified',
	A: 'Added',
	D: 'Deleted',
	R: 'Renamed',
	C: 'Copied',
	T: 'Type changed',
	U: 'Conflict',
	'?': 'Untracked'
};

/** Tree of staged and unstaged files of the active repository. */
export class ChangesTree implements vscode.TreeDataProvider<Node> {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly state: AppState) {
		state.onDidChangeRepo(() => this.emitter.fire());
		state.onDidChangeReview(() => this.emitter.fire());
	}

	getChildren(node?: Node): Node[] {
		const repo = this.state.repo;
		if (!repo) {
			return [];
		}
		if (!node) {
			const staged = repo.status.filter(isStaged);
			const unstaged = repo.status.filter(isUnstaged);
			return [
				{ kind: 'group', view: 'staged', entries: staged },
				{ kind: 'group', view: 'unstaged', entries: unstaged }
			];
		}
		if (node.kind === 'group') {
			return [...node.entries].sort((a, b) => a.path.localeCompare(b.path)).map((entry) => ({ kind: 'file', view: node.view, entry }));
		}
		return [];
	}

	getTreeItem(node: Node): vscode.TreeItem {
		if (node.kind === 'group') {
			const label = node.view === 'staged' ? 'Staged' : 'Changes';
			const item = new vscode.TreeItem(`${label} (${node.entries.length})`, vscode.TreeItemCollapsibleState.Expanded);
			item.contextValue = `group-${node.view}`;
			item.id = `group-${node.view}`;
			return item;
		}

		const repo = this.state.repo!;
		const e = node.entry;
		const letter = node.view === 'staged' ? e.x : e.kind === 'untracked' ? '?' : e.kind === 'conflict' ? 'U' : e.y;
		const item = new vscode.TreeItem(vscode.Uri.file(repo.absPath(e.path)));
		item.id = `${node.view}:${e.path}`;
		item.label = path.posix.basename(e.path);
		const dir = path.posix.dirname(e.path);
		const pending = this.state.review ? this.state.sectionsForFile(e.path).filter((s) => this.state.sectionStatus(s.section) === 'pending').length : 0;
		item.description = `${dir === '.' ? '' : dir}  ${letter === '?' ? 'U' : letter}${pending ? `  · ${pending} to review` : ''}`;
		item.tooltip = `${e.path}${e.origPath ? ` (from ${e.origPath})` : ''}\n${STATUS_TEXT[letter] ?? letter}`;
		item.contextValue = node.view === 'staged' ? 'file-staged' : 'file-unstaged';
		item.command = { title: 'Open diff', command: 'explainYourself.openDiff', arguments: [e.path, node.view] };
		return item;
	}
}
