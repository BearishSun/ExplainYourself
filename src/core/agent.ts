import { ChildProcess, spawn } from 'child_process';
import { claudeProjectsDir, REVIEW_SESSION_NAME } from './sessions';
import { OUTPUT_SCHEMA } from './review';

export interface AgentProgress {
	kind: 'tool' | 'text' | 'status';
	message: string;
}

export interface AgentOptions {
	claudePath: string;
	/** Directory the agent runs in. For forked sessions this must be the session's original directory. */
	cwd: string;
	repoRoot: string;
	prompt: string;
	model?: string;
	/** Resume this session, so the agent inherits its conversation. */
	resumeSessionId?: string;
	/** Resume into a copy of the session instead of continuing it. */
	fork?: boolean;
	/** Structured output schema. Defaults to the full review schema. */
	schema?: object;
	onProgress?: (p: AgentProgress) => void;
}

export interface AgentResult {
	output: unknown;
	sessionId?: string;
	costUsd?: number;
	/** Model the CLI ran, as reported in its init event. */
	model?: string;
}

/** Handle to a running agent; `result` settles when the process exits. */
export interface AgentRun {
	result: Promise<AgentResult>;
	cancel(): void;
}

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git log:*)', 'Bash(git blame:*)', 'Bash(git status:*)'];

function describeTool(name: string, input: Record<string, unknown>): string {
	const target = input.file_path ?? input.path ?? input.pattern ?? input.command ?? '';
	return `${name} ${String(target)}`.trim();
}

interface TokenCounts {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_creation?: { ephemeral_1h_input_tokens?: number };
}

interface ModelUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
}

/**
 * Cost of this run alone. On a resumed or forked session, `total_cost_usd` also includes everything the
 * session cost before, so the run's share is estimated: its tokens, weighted by their relative prices
 * (the same ratios for every Claude model), times the session's cost per weighted token.
 */
export function runCost(result: Record<string, unknown>, resumed: boolean): number | undefined {
	const total = result.total_cost_usd;
	if (typeof total !== 'number') {
		return undefined;
	}
	if (!resumed) {
		return total;
	}
	const usage = result.usage as TokenCounts | undefined;
	const models = result.modelUsage as Record<string, ModelUsage> | undefined;
	if (!usage || !models) {
		return undefined;
	}
	const cacheWrite = (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0 ? 2 : 1.25;
	const weigh = (input = 0, output = 0, read = 0, created = 0) => input + 5 * output + 0.1 * read + cacheWrite * created;
	const run = weigh(usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens);
	let session = 0;
	for (const m of Object.values(models)) {
		session += weigh(m.inputTokens, m.outputTokens, m.cacheReadInputTokens, m.cacheCreationInputTokens);
	}
	return session > 0 ? total * Math.min(1, run / session) : undefined;
}

/** Launches `claude -p` with structured output and streams its progress. */
export function runAgent(options: AgentOptions): AgentRun {
	const args = [
		'-p',
		'--output-format',
		'stream-json',
		'--verbose',
		'--json-schema',
		JSON.stringify(options.schema ?? OUTPUT_SCHEMA),
		'--permission-mode',
		'dontAsk',
		'--allowedTools',
		READ_ONLY_TOOLS.join(','),
		'--disallowedTools',
		'Edit,Write,NotebookEdit',
		'--add-dir',
		options.repoRoot,
		claudeProjectsDir()
	];
	if (options.model) {
		args.push('--model', options.model);
	}
	// Sessions persist so that later review updates can resume them.
	if (options.resumeSessionId) {
		args.push('--resume', options.resumeSessionId);
		if (options.fork) {
			args.push('--fork-session');
		}
	}
	if (!options.resumeSessionId || options.fork) {
		args.push('--name', REVIEW_SESSION_NAME);
	}

	let child: ChildProcess | null = null;
	let cancelled = false;

	const result = new Promise<AgentResult>((resolve, reject) => {
		const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(options.claudePath);
		child = spawn(options.claudePath, args, { cwd: options.cwd, windowsHide: true, shell: useShell, env: { ...process.env } });

		let buffer = '';
		let stderr = '';
		let final: Record<string, unknown> | null = null;
		let model: string | undefined;

		const handleLine = (line: string) => {
			if (!line.trim()) {
				return;
			}
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
				model = event.model;
				return;
			}
			if (event.type === 'result') {
				final = event;
				return;
			}

			if (event.type === 'assistant') {
				const content = (event.message as { content?: unknown[] } | undefined)?.content ?? [];
				for (const c of content as Record<string, unknown>[]) {
					if (c.type === 'tool_use') {
						options.onProgress?.({ kind: 'tool', message: describeTool(String(c.name), (c.input ?? {}) as Record<string, unknown>) });
					} else if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
						options.onProgress?.({ kind: 'text', message: c.text.trim() });
					}
				}
			}
		};

		child.stdout!.setEncoding('utf8');
		child.stdout!.on('data', (chunk: string) => {
			buffer += chunk;
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				handleLine(buffer.substring(0, nl));
				buffer = buffer.substring(nl + 1);
			}
		});
		child.stderr!.setEncoding('utf8');
		child.stderr!.on('data', (chunk: string) => (stderr += chunk));
		child.on('error', (e) => reject(new Error(`Could not start Claude (${options.claudePath}): ${e.message}`)));
		child.on('close', (code) => {
			handleLine(buffer);
			if (cancelled) {
				reject(new Error('Cancelled.'));
				return;
			}

			const r = final as Record<string, unknown> | null;
			if (!r || r.is_error) {
				const detail = (r && (r.result || r.subtype)) || stderr.trim() || `exit code ${code}`;
				reject(new Error(`Claude failed: ${String(detail)}`));
				return;
			}

			let output = r.structured_output;
			if (output === undefined && typeof r.result === 'string') {
				try {
					output = JSON.parse(r.result);
				} catch {
					reject(new Error('Claude returned no structured output.'));
					return;
				}
			}
			resolve({ output, sessionId: r.session_id as string | undefined, costUsd: runCost(r, !!options.resumeSessionId), model });
		});

		child.stdin!.end(options.prompt);
	});

	return {
		result,
		cancel: () => {
			cancelled = true;
			child?.kill();
		}
	};
}
