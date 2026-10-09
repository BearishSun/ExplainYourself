import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** What the review agent checks the changes against, besides understanding them. */
export interface ReviewGuidance {
	/** Review rules in Markdown: the user's or repository's rules file, or the defaults. */
	rules: string;
	/** Repository-relative paths of instruction files for coding agents (CLAUDE.md, AGENTS.md) that apply to the changes. */
	instructions: string[];
}

/** Rules used when neither the repository nor the user has a rules file. */
export const DEFAULT_REVIEW_RULES = `Check the changes against these rules. Each rule starts with the tag to use for its findings.

### Architecture
- **Black box**: public documentation says what an API does, its inputs, outputs and errors, and how to call it. Flag documentation that explains how or why it works inside, unless the caller needs that to use it correctly (thread safety, ownership, complexity). Flag documentation that names a specific caller ("used by the importer"): an API should read as usable by anyone.
- **Leaky API**: flag public signatures that expose internal types or state, APIs that need a call order they do not state, and APIs that depend on hidden global state.
- **Separation**: flag a new or grown class, module or function that does more than one job, such as parsing, caching and presentation together. Name the boundary where it would split. Flag this only when a split is realistic.
- **Layering**: flag dependencies that point the wrong way, such as a low-level utility that knows about one of its callers; new dependencies between modules that were independent; logic placed in the wrong layer.
- **Generalization**: flag a feature that one system added to another and shaped around itself: named after the caller, taking the caller's types, or special-casing it. Suggest the general form that any caller could use.
- **Bolted on**: flag a feature attached to an API that was not shaped for it, when reshaping the API would be cleaner. Signs: boolean or mode parameters that switch behavior, near-duplicate parallel methods, optional parameters that only one caller uses.
- **Consistency**: a new concept has one name everywhere. Operations of the same kind on different types have parallel names and parameter order (\`CreateBuffer\`/\`CreateTexture\`). Opposite operations are paired and symmetric (\`Acquire\`/\`Release\`, \`Begin\`/\`End\`, \`Create\`/\`Destroy\`). Flag a missing counterpart, a mismatched pair (\`Open\`/\`Destroy\`), and names or patterns that break the conventions of the surrounding code.

### Code smells
- **Hack**: special cases for one input or caller, magic constants, sleeps or retries that hide a race, state passed through globals, swallowed errors, casts that bypass the type system.
- **Duplication**: copied blocks within the change, or code that reimplements something the codebase already has. Name the existing code.
- **Docs**: comments or documentation that are outdated, wrong or misleading after the change; names that no longer describe what the code does; documentation that only restates the signature; comments that narrate the edit history ("previously this…", "changed to fix…").
- **Performance**: quadratic or worse growth in data-dependent sizes, repeated linear searches, I/O inside loops, allocations on hot paths. Say what grows and how. Leave out micro-optimizations.
- **Smell**: dead code, unused parameters, needless indirection, abbreviated names.

### Other findings
- **Risk**: risky edge cases, and changed behavior that callers rely on. List these after the findings above.
- Do not mention missing tests.
`;

/** Repository rules file; overrides the user's rules for everyone working in the repository. */
export function repositoryRulesFile(root: string): string {
	return path.join(root, '.explainyourself', 'review-rules.md');
}

/** The user's rules file, shared by all repositories. */
export function userRulesFile(): string {
	return path.join(os.homedir(), '.explainyourself', 'review-rules.md');
}

/** The rules file that applies to a repository, or null when the defaults apply. */
export async function activeRulesFile(root: string): Promise<string | null> {
	for (const file of [repositoryRulesFile(root), userRulesFile()]) {
		try {
			if ((await fs.readFile(file, 'utf8')).trim()) {
				return file;
			}
		} catch {
			// No rules file here.
		}
	}
	return null;
}

const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', path.join('.claude', 'CLAUDE.md')];

/**
 * Instruction files for coding agents that apply to the given files: those in the repository root and in
 * every directory between the root and a file, outermost first.
 */
export async function findInstructionFiles(root: string, files: Iterable<string>): Promise<string[]> {
	const dirs = new Set<string>(['']);
	for (const file of files) {
		for (let dir = path.posix.dirname(file); dir !== '.' && dir !== '' && !dirs.has(dir); dir = path.posix.dirname(dir)) {
			dirs.add(dir);
		}
	}
	const found: string[] = [];
	for (const dir of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
		for (const name of INSTRUCTION_FILES) {
			const rel = path.posix.join(dir, name.split(path.sep).join('/'));
			try {
				if ((await fs.stat(path.join(root, rel))).isFile()) {
					found.push(rel);
				}
			} catch {
				// Not present.
			}
		}
	}
	return found;
}

export async function loadGuidance(root: string, files: Iterable<string>): Promise<ReviewGuidance> {
	const rulesFile = await activeRulesFile(root);
	return {
		rules: rulesFile ? (await fs.readFile(rulesFile, 'utf8')).trim() : DEFAULT_REVIEW_RULES.trim(),
		instructions: await findInstructionFiles(root, files)
	};
}
