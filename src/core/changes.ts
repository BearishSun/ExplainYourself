import { promises as fs } from 'fs';
import * as path from 'path';
import { FileDiff, LineRange, parseDiff } from './diff';
import { git } from './exec';
import { reviewDir } from './review';
import { prefixDiff, Workspace, WorkspacePart } from './workspace';

/** Summary of one changed file in the full HEAD -> working tree change set. */
export interface ChangedFile {
	path: string;
	oldPath?: string;
	status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'binary';
	added: number;
	removed: number;
}

export interface ChangeSet {
	files: ChangedFile[];
	/** Path of the annotated diff written for the agent. */
	annotatedPath: string;
	/** HEAD -> working tree diffs with zero context, used for coverage checks. */
	diffs: Map<string, FileDiff>;
	/** HEAD -> working tree diffs with context, as the annotated diff shows them. Missing for untracked files. */
	contextDiffs: Map<string, FileDiff>;
	/** Submodules whose changes the change set includes. */
	submodules: string[];
}

const CONTEXT_LINES = 8;
const MAX_UNTRACKED_LINES = 3000;

function pad(n: number | string, width: number): string {
	const s = String(n);
	return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function decode(latin1: string): string {
	return Buffer.from(latin1, 'latin1').toString('utf8');
}

/** The annotated lines of the hunks of `diff` that touch any of the working tree `ranges`. */
export function renderHunks(diff: FileDiff, ranges: readonly LineRange[]): string {
	const out: string[] = [];
	for (const h of diff.hunks) {
		const start = h.newStart;
		const end = h.newStart + Math.max(h.newCount, 1) - 1;
		if (!ranges.some((r) => r.start <= end + 1 && r.end >= start - 1)) {
			continue;
		}
		out.push(`@@ old ${h.oldStart},${h.oldCount} new ${h.newStart},${h.newCount}`);
		for (const l of h.lines) {
			const oldNo = l.oldLine ? pad(l.oldLine, 6) : '      ';
			const newNo = l.newLine ? pad(l.newLine, 6) : '      ';
			out.push(`${oldNo} ${newNo} ${l.type}| ${decode(l.text.replace(/\r?\n$/, ''))}`);
		}
	}
	return out.join('\n');
}

function renderDiff(diff: FileDiff, status: ChangedFile['status']): string {
	const out: string[] = [];
	const header = status === 'renamed' ? `renamed from ${diff.oldPath}` : status;
	out.push(`=== FILE: ${diff.path} (${header})`);
	if (diff.binary) {
		out.push('(binary file; content not shown)', '');
		return out.join('\n');
	}

	for (const h of diff.hunks) {
		out.push(`@@ old ${h.oldStart},${h.oldCount} new ${h.newStart},${h.newCount}`);
		for (const l of h.lines) {
			const oldNo = l.oldLine ? pad(l.oldLine, 6) : '      ';
			const newNo = l.newLine ? pad(l.newLine, 6) : '      ';
			out.push(`${oldNo} ${newNo} ${l.type}| ${decode(l.text.replace(/\r?\n$/, ''))}`);
		}
	}
	out.push('');
	return out.join('\n');
}

/** HEAD -> working tree diff of one repository, with root-relative paths. Hidden submodule entries are left out. */
async function partDiff(ws: Workspace, part: WorkspacePart, context: number): Promise<FileDiff[]> {
	const { repo, prefix } = part;
	const base = repo.head ?? repo.emptyTree;
	const args = ['diff', `-U${context}`, '--no-ext-diff', '--no-textconv', '--full-index', '-M', `--diff-algorithm=${repo.diffAlgorithm}`, '--src-prefix=a/', '--dst-prefix=b/', base];
	const out = await git(repo.root, args, { readOnly: true });
	return parseDiff(out.toString('latin1'))
		.map((d) => prefixDiff(d, prefix))
		.filter((d) => ws.status.some((e) => e.path === d.path) || !ws.selectedSubmodules.includes(d.path));
}

/** Untracked files of the workspace, with root-relative paths. */
function untracked(ws: Workspace): string[] {
	return ws.status.filter((s) => s.kind === 'untracked').map((s) => s.path);
}

/** Loads HEAD -> working tree diffs with zero context. Untracked files appear as fully added. */
export async function loadFullDiff(ws: Workspace): Promise<Map<string, FileDiff>> {
	const parts = await Promise.all(ws.parts().map((p) => partDiff(ws, p, 0)));
	const diffs = new Map(parts.flat().map((d) => [d.path, d]));
	for (const p of untracked(ws)) {
		diffs.set(p, { oldPath: null, newPath: p, path: p, binary: false, hunks: [] });
	}
	return diffs;
}

/** Builds the full change set (HEAD -> working tree, untracked files included) and writes the annotated diff. */
export async function buildChangeSet(ws: Workspace): Promise<ChangeSet> {
	await ws.refresh();
	const [contextDiffs, zeroDiffs] = await Promise.all([
		Promise.all(ws.parts().map((p) => partDiff(ws, p, CONTEXT_LINES))),
		Promise.all(ws.parts().map((p) => partDiff(ws, p, 0)))
	]);

	const files: ChangedFile[] = [];
	const sections: string[] = [];
	for (const d of contextDiffs.flat()) {
		const added = d.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === '+').length, 0);
		const removed = d.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === '-').length, 0);
		const status: ChangedFile['status'] = d.binary
			? 'binary'
			: d.oldPath === null
				? 'added'
				: d.newPath === null
					? 'deleted'
					: d.oldPath !== d.newPath
						? 'renamed'
						: 'modified';
		files.push({ path: d.path, oldPath: status === 'renamed' ? d.oldPath! : undefined, status, added, removed });
		sections.push(renderDiff(d, status));
	}

	const diffs = new Map(zeroDiffs.flat().map((d) => [d.path, d]));

	for (const file of untracked(ws)) {
		const e = { path: file };
		let content: Buffer;
		try {
			content = await fs.readFile(ws.absPath(e.path));
		} catch {
			continue;
		}

		if (content.includes(0)) {
			files.push({ path: e.path, status: 'binary', added: 0, removed: 0 });
			sections.push(`=== FILE: ${e.path} (untracked, binary; content not shown)\n`);
			continue;
		}

		const lines = content.toString('utf8').split(/\r?\n/);
		if (lines[lines.length - 1] === '') {
			lines.pop();
		}
		files.push({ path: e.path, status: 'untracked', added: lines.length, removed: 0 });
		const out = [`=== FILE: ${e.path} (untracked new file)`, `@@ old 0,0 new 1,${lines.length}`];
		lines.slice(0, MAX_UNTRACKED_LINES).forEach((l, i) => out.push(`${'      '} ${pad(i + 1, 6)} +| ${l}`));
		if (lines.length > MAX_UNTRACKED_LINES) {
			out.push(`... ${lines.length - MAX_UNTRACKED_LINES} more lines; read the file directly.`);
		}
		out.push('');
		sections.push(out.join('\n'));

		// Untracked files count as fully added for coverage checks.
		diffs.set(e.path, {
			oldPath: null,
			newPath: e.path,
			path: e.path,
			binary: false,
			hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: lines.length, lines: lines.map((t, i) => ({ type: '+', text: t, oldLine: 0, newLine: i + 1 })) }]
		});
	}

	const dir = reviewDir(ws.gitDir);
	await fs.mkdir(dir, { recursive: true });
	const annotatedPath = path.join(dir, 'changes.txt');
	const legend = [
		'Annotated change set: HEAD -> working tree (staged, unstaged and untracked changes).',
		'Columns: old line (HEAD) | new line (working tree) | marker (" " context, "-" removed, "+" added) | text.',
		''
	].join('\n');
	await fs.writeFile(annotatedPath, legend + sections.join('\n'), 'utf8');
	return { files, annotatedPath, diffs, contextDiffs: new Map(contextDiffs.flat().map((d) => [d.path, d])), submodules: ws.selectedSubmodules };
}
