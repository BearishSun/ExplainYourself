import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Moves a directory to its new name, unless the new one already exists. */
async function moveDirectory(from: string, to: string): Promise<void> {
	try {
		await fs.access(to);
		return;
	} catch {
		// The new directory does not exist yet.
	}
	try {
		await fs.rename(from, to);
	} catch {
		// Nothing to move.
	}
}

/** Moves a repository's review data from the extension's former name (SlopReview) to the current one. */
export async function migrateRepositoryData(gitDir: string): Promise<void> {
	await moveDirectory(path.join(gitDir, 'slopreview'), path.join(gitDir, 'explainyourself'));
}

/** Moves the user's review rules from the extension's former name (SlopReview) to the current one. */
export async function migrateUserData(): Promise<void> {
	await moveDirectory(path.join(os.homedir(), '.slopreview'), path.join(os.homedir(), '.explainyourself'));
}
