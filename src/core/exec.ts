import { spawn } from 'child_process';

/** Error raised when a git invocation exits with an unexpected code. */
export class GitError extends Error {
	constructor(message: string, public readonly args: string[], public readonly stderr: string, public readonly exitCode: number) {
		super(message);
	}
}

export interface GitOptions {
	/** Data written to the process stdin. */
	input?: Buffer | string;
	/** Exit codes that count as success. Defaults to [0]. */
	okCodes?: number[];
	/** Read-only commands set this so they never take optional locks (e.g. status refreshing the index). */
	readOnly?: boolean;
}

let gitPath = 'git';

export function setGitPath(path: string): void {
	gitPath = path || 'git';
}

const LOCK_RETRIES = 20;
const LOCK_RETRY_DELAY_MS = 15;

function runOnce(cwd: string, args: string[], options: GitOptions): Promise<{ stdout: Buffer; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
		if (options.readOnly) {
			env.GIT_OPTIONAL_LOCKS = '0';
		}

		const child = spawn(gitPath, ['--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], { cwd, env, windowsHide: true });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on('data', (d: Buffer) => out.push(d));
		child.stderr.on('data', (d: Buffer) => err.push(d));
		child.on('error', reject);
		child.on('close', (code) => resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), code: code ?? -1 }));
		if (options.input !== undefined) {
			child.stdin.end(options.input);
		} else {
			child.stdin.end();
		}
	});
}

/** Runs git and returns stdout. Retries while another process holds index.lock. */
export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<Buffer> {
	const okCodes = options.okCodes ?? [0];
	for (let attempt = 0; ; attempt++) {
		const result = await runOnce(cwd, args, options);
		if (okCodes.includes(result.code)) {
			return result.stdout;
		}

		if (attempt < LOCK_RETRIES && result.stderr.includes('index.lock')) {
			await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
			continue;
		}

		const message = `git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim()}`;
		throw new GitError(message, args, result.stderr, result.code);
	}
}

/** Runs git and returns stdout decoded as UTF-8. */
export async function gitText(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
	return (await git(cwd, args, options)).toString('utf8');
}
