import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { deflateSync } from 'zlib';

/**
 * Writes a loose blob object without spawning git. Staging stays at one git process per action this way.
 * Only valid for SHA-1 repositories; callers fall back to `git hash-object` otherwise.
 */
export async function writeLooseBlob(objectsDir: string, content: Buffer): Promise<string> {
	const header = Buffer.from(`blob ${content.length}\0`, 'latin1');
	const full = Buffer.concat([header, content]);
	const sha = createHash('sha1').update(full).digest('hex');

	const dir = path.join(objectsDir, sha.substring(0, 2));
	const file = path.join(dir, sha.substring(2));
	try {
		await fs.access(file);
		return sha;
	} catch {
		// Not present yet.
	}

	await fs.mkdir(dir, { recursive: true });
	const temp = path.join(dir, `tmp_obj_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
	await fs.writeFile(temp, deflateSync(full));
	try {
		await fs.rename(temp, file);
	} catch (e) {
		// Another writer may have produced the same object first; that object is identical.
		await fs.rm(temp, { force: true });
		try {
			await fs.access(file);
		} catch {
			throw e;
		}
	}
	return sha;
}
