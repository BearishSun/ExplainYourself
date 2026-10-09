import { FileDiff } from './diff';

export interface FileStats {
	path: string;
	added: number;
	removed: number;
	hunks: number;
	binary: boolean;
}

export interface Report {
	files: FileStats[];
	totalAdded: number;
	totalRemoved: number;
	largest: FileStats | null;
	text: string;
}

/** Summarizes a set of file diffs as statistics and a plain text table. */
export function buildReport(diffs: FileDiff[], options: { maxFiles?: number; sortBy?: 'size' | 'path' } = {}): Report {
	// Reject inputs that cannot produce a meaningful report.
	if (diffs.length === 0) {
		return { files: [], totalAdded: 0, totalRemoved: 0, largest: null, text: 'No changes.' };
	}
	const maxFiles = options.maxFiles ?? 50;
	if (maxFiles <= 0) {
		throw new Error(`maxFiles must be positive, got ${maxFiles}`);
	}

	// Count added and removed lines per file.
	const files: FileStats[] = [];
	for (const diff of diffs) {
		let added = 0;
		let removed = 0;
		for (const hunk of diff.hunks) {
			for (const line of hunk.lines) {
				if (line.type === '+') {
					added++;
				} else if (line.type === '-') {
					removed++;
				}
			}
		}
		files.push({ path: diff.newPath ?? diff.oldPath ?? '?', added, removed, hunks: diff.hunks.length, binary: diff.binary });
	}

	// Order the files and keep the first maxFiles of them.
	if (options.sortBy === 'path') {
		files.sort((a, b) => a.path.localeCompare(b.path));
	} else {
		files.sort((a, b) => b.added + b.removed - (a.added + a.removed) || a.path.localeCompare(b.path));
	}
	const shown = files.slice(0, maxFiles);
	const hidden = files.length - shown.length;

	// Totals cover every file, including the ones left out of the table.
	let totalAdded = 0;
	let totalRemoved = 0;
	let largest: FileStats | null = null;
	for (const f of files) {
		totalAdded += f.added;
		totalRemoved += f.removed;
		if (!largest || f.added + f.removed > largest.added + largest.removed) {
			largest = f;
		}
	}

	// Format the table with aligned columns.
	const width = Math.max(4, ...shown.map((f) => f.path.length));
	const rows = shown.map((f) => {
		const counts = f.binary ? 'binary' : `+${f.added} -${f.removed}`;
		return `${f.path.padEnd(width)}  ${counts.padStart(12)}  ${String(f.hunks).padStart(5)}`;
	});
	const header = `${'File'.padEnd(width)}  ${'Lines'.padStart(12)}  ${'Hunks'.padStart(5)}`;
	const footer = `${files.length} files, +${totalAdded} -${totalRemoved}${hidden > 0 ? ` (${hidden} not shown)` : ''}`;
	const text = [header, '-'.repeat(header.length), ...rows, '', footer].join('\n');

	return { files, totalAdded, totalRemoved, largest, text };
}

/** Renders a report as Markdown, for pull request descriptions. */
export function reportToMarkdown(report: Report, title: string): string {
	const lines: string[] = [];
	lines.push(`## ${title}`);
	lines.push('');
	if (report.files.length === 0) {
		lines.push('_No changes._');
		return lines.join('\n');
	}
	lines.push('| File | Added | Removed | Hunks |');
	lines.push('| --- | ---: | ---: | ---: |');
	for (const f of report.files) {
		const name = f.path.replace(/\|/g, '\\|');
		if (f.binary) {
			lines.push(`| \`${name}\` | binary | | ${f.hunks} |`);
			continue;
		}
		lines.push(`| \`${name}\` | ${f.added} | ${f.removed} | ${f.hunks} |`);
	}
	lines.push('');
	lines.push(`**Total:** +${report.totalAdded} -${report.totalRemoved} in ${report.files.length} files.`);
	if (report.largest) {
		lines.push('');
		lines.push(`Largest change: \`${report.largest.path}\` (+${report.largest.added} -${report.largest.removed}).`);
	}
	const binaries = report.files.filter((f) => f.binary);
	if (binaries.length > 0) {
		lines.push('');
		lines.push(`Binary files: ${binaries.map((f) => `\`${f.path}\``).join(', ')}.`);
	}
	return lines.join('\n');
}
