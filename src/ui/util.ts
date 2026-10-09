import * as path from 'path';
import * as vscode from 'vscode';
import { Workspace } from '../core/workspace';

let channel: vscode.OutputChannel | undefined;

export function log(message: string): void {
	channel ??= vscode.window.createOutputChannel('ExplainYourself');
	channel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

export function config(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('explainYourself');
}

export const SCHEME = 'explainyourself';

/**
 * Which view a document belongs to: index -> working tree diff, HEAD -> index diff, or the old side of an
 * old/new comparison shown in plain editors.
 */
export type DiffView = 'unstaged' | 'staged' | 'compare';
export type Side = 'old' | 'new';
export type Ref = 'HEAD' | 'INDEX' | 'EMPTY';

export interface VirtualDoc {
	/** Path whose content the document shows. */
	rel: string;
	ref: Ref;
	view: DiffView;
	side: Side;
	/** Path the review knows the file by, when it differs from `rel` (renames). */
	reviewRel?: string;
}

/** Builds the URI of a virtual document. The path keeps the file extension so language detection works. */
export function virtualUri(repo: Workspace, doc: VirtualDoc): vscode.Uri {
	const file = vscode.Uri.file(repo.absPath(doc.rel));
	let filePath = file.path;
	if (doc.view === 'compare') {
		// The tab title shows the base name; mark the old version there.
		const ext = path.posix.extname(filePath);
		filePath = `${filePath.substring(0, filePath.length - ext.length)} (HEAD)${ext}`;
	}
	return vscode.Uri.from({ scheme: SCHEME, path: filePath, query: JSON.stringify(doc) });
}

export function parseVirtualUri(uri: vscode.Uri): VirtualDoc | undefined {
	if (uri.scheme !== SCHEME) {
		return undefined;
	}
	try {
		return JSON.parse(uri.query) as VirtualDoc;
	} catch {
		return undefined;
	}
}

/** Location of a document within the review views. Plain files count as the new side of the unstaged view. */
export interface DocContext {
	rel: string;
	view: DiffView;
	side: Side;
	ref: Ref | 'WORKTREE';
	reviewRel?: string;
}

export function docContext(repo: Workspace | undefined, uri: vscode.Uri): DocContext | undefined {
	if (!repo) {
		return undefined;
	}
	const v = parseVirtualUri(uri);
	if (v) {
		return v;
	}
	if (uri.scheme === 'file') {
		const rel = repo.relPath(uri.fsPath);
		return rel ? { rel, view: 'unstaged', side: 'new', ref: 'WORKTREE' } : undefined;
	}
	return undefined;
}

export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
