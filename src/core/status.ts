/** Parser for `git status --porcelain=v2 -z --branch`. */

export interface StatusEntry {
	path: string;
	/** Source path of a staged rename or copy. */
	origPath?: string;
	/** Index status ('.' when unchanged). */
	x: string;
	/** Working tree status ('.' when unchanged). */
	y: string;
	kind: 'tracked' | 'untracked' | 'conflict';
	/** Set for submodules: whether their commit changed, and whether their working tree has changes. */
	submodule?: { commitChanged: boolean; modified: boolean; untracked: boolean };
}

/** Parses the "sub" field of porcelain v2: "N..." for files, "S<c><m><u>" for submodules. */
function submoduleState(sub: string): StatusEntry['submodule'] {
	return sub[0] === 'S' ? { commitChanged: sub[1] === 'C', modified: sub[2] === 'M', untracked: sub[3] === 'U' } : undefined;
}

export interface StatusResult {
	/** Commit HEAD points to, or null on an unborn branch. */
	head: string | null;
	branch: string | null;
	entries: StatusEntry[];
}

export function parseStatus(output: Buffer): StatusResult {
	const tokens = output.toString('utf8').split('\0');
	const result: StatusResult = { head: null, branch: null, entries: [] };

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t) {
			continue;
		}

		if (t.startsWith('# branch.oid ')) {
			const oid = t.substring(13);
			result.head = oid === '(initial)' ? null : oid;
		} else if (t.startsWith('# branch.head ')) {
			const head = t.substring(14);
			result.branch = head === '(detached)' ? null : head;
		} else if (t.startsWith('1 ')) {
			// 1 XY sub mH mI mW hH hI path
			const parts = t.split(' ');
			result.entries.push({ path: parts.slice(8).join(' '), x: parts[1][0], y: parts[1][1], kind: 'tracked', submodule: submoduleState(parts[2]) });
		} else if (t.startsWith('2 ')) {
			// 2 XY sub mH mI mW hH hI Xscore path NUL origPath
			const parts = t.split(' ');
			result.entries.push({ path: parts.slice(9).join(' '), origPath: tokens[++i], x: parts[1][0], y: parts[1][1], kind: 'tracked', submodule: submoduleState(parts[2]) });
		} else if (t.startsWith('u ')) {
			// u XY sub m1 m2 m3 mW h1 h2 h3 path
			const parts = t.split(' ');
			result.entries.push({ path: parts.slice(10).join(' '), x: parts[1][0], y: parts[1][1], kind: 'conflict' });
		} else if (t.startsWith('? ')) {
			result.entries.push({ path: t.substring(2), x: '?', y: '?', kind: 'untracked' });
		}
	}
	return result;
}

export function isStaged(e: StatusEntry): boolean {
	return e.kind === 'tracked' && e.x !== '.';
}

export function isUnstaged(e: StatusEntry): boolean {
	return e.kind !== 'tracked' || e.y !== '.';
}
