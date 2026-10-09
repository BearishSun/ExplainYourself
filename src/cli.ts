/**
 * Command line entry used by the /explain-yourself Claude Code skill, so that the session that wrote the code
 * can produce the review itself.
 *
 *   node cli.js prepare [--repo <dir>]   Writes the annotated diff and prints the review instructions.
 *   node cli.js submit  [--repo <dir>]   Validates the drafted review and loads it into the extension.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { buildChangeSet } from './core/changes';
import { finishReview } from './core/generate';
import { loadGuidance } from './core/guidance';
import { migrateRepositoryData } from './core/legacy';
import { buildPrompt } from './core/prompt';
import { loadReview, reviewDir } from './core/review';
import { loadSubmoduleSelection, Workspace } from './core/workspace';

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function quote(s: string): string {
	return `"${s}"`;
}

async function main(): Promise<number> {
	const command = process.argv[2];
	const repo = await Workspace.open(path.resolve(arg('--repo') ?? process.cwd()));
	await migrateRepositoryData(repo.gitDir);
	// The same submodules as the extension reviews.
	await repo.setSubmodules((await loadSubmoduleSelection(repo.gitDir)) ?? (await loadReview(repo.gitDir))?.submodules ?? []);
	const draft = path.join(reviewDir(repo.gitDir), 'review.draft.json');

	if (command === 'prepare') {
		const changes = await buildChangeSet(repo);
		if (changes.files.length === 0) {
			console.log('There are no changes to review.');
			return 1;
		}
		const submit = `node ${quote(__filename)} submit --repo ${quote(repo.root)}`;
		const guidance = await loadGuidance(repo.root, changes.files.map((f) => f.path));
		console.log(buildPrompt(repo.root, changes, { kind: 'skill', outputFile: draft, submitCommand: submit }, guidance));
		return 0;
	}

	if (command === 'submit') {
		const raw = JSON.parse(await fs.readFile(draft, 'utf8'));
		const changes = await buildChangeSet(repo);
		const { review, warnings } = await finishReview(repo, changes, raw, { kind: 'skill', sessionId: arg('--session') });
		warnings.forEach((w) => console.log(`warning: ${w}`));
		const sections = review.categories.reduce((n, c) => n + c.sections.length, 0);
		console.log(`Review saved: ${review.categories.length} categories, ${sections} sections. ExplainYourself picks it up automatically.`);
		return 0;
	}

	console.log('Usage: node cli.js prepare|submit [--repo <dir>]');
	return 2;
}

main().then(
	(code) => process.exit(code),
	(e) => {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
);
