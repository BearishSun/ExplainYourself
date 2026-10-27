import { ChangeSet } from './changes';
import { ReviewGuidance } from './guidance';
import { REVIEW_PROMPT_START, SessionCandidate } from './sessions';

export type PromptMode =
	| { kind: 'fresh'; sessions: SessionCandidate[] }
	| { kind: 'session' }
	| { kind: 'skill'; outputFile: string; submitCommand: string };

function fileList(changes: ChangeSet): string {
	return changes.files
		.map((f) => `- ${f.path} (${f.status}${f.oldPath ? ` from ${f.oldPath}` : ''}, +${f.added} -${f.removed})`)
		.join('\n');
}

function sessionBlock(mode: PromptMode): string {
	if (mode.kind === 'session') {
		return [
			'## Context from this session',
			'You are continuing the Claude Code session in which (at least some of) these changes were made.',
			'Use what you know from the conversation about intent, requirements and design decisions.',
			'The code may have changed after the conversation: describe the code as it is now, and verify every claim against the files.',
			'Set sourceSession to the id of this session if you know it.'
		].join('\n');
	}

	if (mode.kind === 'skill') {
		return [
			'## Context from this session',
			'Use what you know from this conversation about intent, requirements and design decisions behind the changes.',
			'The code may contain changes made outside this conversation: describe the code as it is now, and verify every claim against the files.'
		].join('\n');
	}

	if (mode.sessions.length === 0) {
		return [
			'## Context from earlier sessions',
			'No recent Claude Code session transcript edited these files. Derive intent from the code, commit history (git log) and comments only.'
		].join('\n');
	}

	const list = mode.sessions
		.slice(0, 8)
		.map((s) => {
			const files = Object.entries(s.editedFiles)
				.map(([f, n]) => `${f} x${n}`)
				.join(', ');
			return `- ${s.transcript}\n  session ${s.sessionId}, last active ${s.lastActive.toISOString()}, first prompt: "${s.title}"\n  edited: ${files}`;
		})
		.join('\n');
	return [
		'## Context from earlier sessions',
		'These Claude Code session transcripts edited files in this change set (most relevant first). Each is a JSONL file with one event per line; they can be very large.',
		list,
		'Search them with Grep (for example for a changed file name or a distinctive identifier) and read the surrounding user and assistant messages.',
		'Look for the user requests, requirements and design decisions behind the changes. Do not read transcripts end to end.',
		'Transcripts can describe intermediate states that were later reverted: describe the code as it is now.',
		'Set sourceSession to the id of the session that produced most of the changes.'
	].join('\n');
}

/** Tells the agent which paths are inside submodules, which are separate repositories. */
function submoduleNote(changes: ChangeSet): string {
	if (changes.submodules.length === 0) {
		return '';
	}
	return `- Submodules included in the change set: ${changes.submodules.map((m) => `"${m}"`).join(', ')}. Each is a separate git repository inside this one. The annotated diff already contains their changes, with paths starting at the submodule path; use those full paths in sections. To run git for a submodule, use \`git -C "<submodule path>"\`.
`;
}

const READING_ORDER = `## Reading order
Order the categories, and the sections within each category, from the easiest to review to the hardest. The reviewer clears the small, simple changes quickly and reaches the most complex ones last, knowing that only a few remain.
- Judge each category and section by its size and by how hard its code is to get right. Short mechanical changes, such as renames, plumbing, simple accessors, boilerplate or code that is only removed, come first. Ordinary logic comes next. Code where mistakes hide, such as concurrency, lifetimes, memory, error handling or subtle invariants, comes last. When two are about equally hard, the smaller one goes first.
- A section that cannot be understood without another one goes after it, even when the other one is larger. Do not reorder for dependencies otherwise.
- Within a category, keep a declaration next to its definition.
- Tests always get their own category, never mixed into a category with production code, and come last, after all production code. Many reviewers skip them. Use one tests category, or a few when the tests cover clearly separate areas.`;

/** Rules the agent checks the changes against, and how to report what it finds. */
function reviewChecks(guidance: ReviewGuidance): string {
	const instructions =
		guidance.instructions.length > 0
			? `

### Project instructions
The repository has instructions for coding agents that apply to these changes:
${guidance.instructions.map((f) => `- ${f}`).join('\n')}
Read them. Flag changes that break the conventions they state, with the tag "Convention".`
			: '';
	return `## Review checks
Besides explaining the changes, report review findings: what a careful reviewer would push back on. A finding about the code of one section goes into that section's concerns; a finding that spans sections or concerns the whole category goes into the category's concerns.

${guidance.rules}${instructions}

### Reporting findings
- tag: the tag of the rule the finding belongs to, as written in the rules.
- text: name the file and function, say why it is a problem, and give the cleaner alternative in one sentence. Markdown, one or two sentences.
- Order the findings of each section and category by importance, most important first.
- Flag only concrete problems in the changed code. Report a problem in unchanged code only when the change extends it.
- Look for findings actively while reading the code, but omit concerns where you find nothing. Do not invent issues.`;
}

export const INTRO = `${REVIEW_PROMPT_START} A human reviewer will read your categories and summaries next to the diff and stage each change once they understand and accept it.

Assume the reviewer is a competent engineer who is completely unfamiliar with this code. Explain the role of each component and domain term on first mention. Prefer concrete statements ("Load() now retries three times before failing") over vague ones ("improves robustness").

All text fields are rendered as Markdown. Wrap every code identifier, type, file name, setting, command and literal value in backticks, for example \`GpuDevice::EndFrame()\` or \`gpu.TransientIdleFrames\`. Use "- " bullet lists for enumerations of three or more items, and separate paragraphs with a blank line.`;

const CATEGORY_RULES = `   - title: a short noun phrase.
   - oldBehavior: what the affected code did before the change. Name the components involved and their role. For new functionality, say what was missing.
   - newBehavior: what the code does after the change, and why it changed.
   - concerns (optional): review findings (see "Review checks") that do not belong to a single section, for example duplication between two sections or an architectural problem of the whole category.
   - sections: the regions of code the reviewer must read to understand the category.`;

const SECTION_RULES = `   - A section is a region of code that is meaningful for understanding the change, not only the changed lines. When a function changed meaningfully, mark the whole function so the reviewer reads the new version as a unit. When only a small part of a large function changed, mark that part plus the smallest enclosing construct needed to understand it (a branch, a loop, a block).
   - A method or function whose implementation is longer than 30 lines always gets a section of its own. Never put other code, such as a neighbouring method, in the same section.
   - newStart/newEnd: 1-based inclusive lines in the working tree version (the "new" column). Required unless the section covers removed code only. A section that covers a declaration or definition starts at the first line of the documentation comment above it, and ends at its last line, such as the closing brace. Take the numbers from the "new" column of the annotated diff; do not count lines yourself.
   - oldStart/oldEnd: 1-based inclusive lines in the HEAD version (the "old" column). Give them when removed or replaced code matters for understanding, for example a deleted or rewritten function. Otherwise omit them.
   - group (optional): a name shared by sections that show parts of one entity in different places, so the reviewer can jump between them. The main case is a declaration and its definition, for example a method added to a header and its implementation in the source file: give both sections the qualified name, such as "GpuDevice::EndFrame". Put grouped sections in the same category, give each part its own section, and do not group code only because one part calls the other.
   - notes (optional): for a section that covers a method or function longer than 60 lines made of several distinct parts (for example argument checks, setup, the main loop, cleanup), add one note per part. line is the first working tree line of the part, inside the section; text is one or two sentences on what the part does. The reviewer sees each note as a comment above its part in the diff, not in the review panel. Do not add notes to shorter code, and do not repeat the summary.
   - concerns (optional): review findings (see "Review checks") about the code in this section. The reviewer sees a warning icon next to the section and reads them on hover.
   - summary: 1-4 sentences on what this region does now and what changed in it, written for someone who has not seen it before. Mention the old behavior where it differs.
   - file: repository-relative path with forward slashes. Sections can point at unchanged files when a short piece of unchanged code is necessary to understand the change (for example a type definition), but keep those rare.
   - Every changed line ("-" or "+") must belong to at least one section. Each changed line should belong to only one category where possible.
   - Take line numbers from the annotated diff or from reading the files. Never estimate them. Use Read on the working tree file to find the exact start and end of a function.`;

/** Builds the instructions for the review agent. */
export function buildPrompt(root: string, changes: ChangeSet, mode: PromptMode, guidance: ReviewGuidance): string {
	const output =
		mode.kind === 'skill'
			? [
					'## Output',
					`Write the review as one JSON object to: ${mode.outputFile}`,
					'The object must match this shape (TypeScript notation; "?" marks optional fields):',
					'{ title: string; overview: string; sourceSession?: string; categories: { title: string; oldBehavior: string; newBehavior: string; concerns?: { tag: string; text: string }[];',
					'  sections: { file: string; title: string; summary: string; newStart?: number; newEnd?: number; oldStart?: number; oldEnd?: number; group?: string; notes?: { line: number; text: string }[]; concerns?: { tag: string; text: string }[] }[] }[] }',
					`Then run: ${mode.submitCommand}`,
					'It validates the file and loads it into the ExplainYourself extension. Fix any reported errors and run it again.'
				].join('\n')
			: '## Output\nReturn the review as structured output matching the provided JSON schema.';

	return `${INTRO}

## Inputs
- Repository root: ${root}
- Annotated diff of all changes from HEAD to the working tree (staged, unstaged and untracked files): ${changes.annotatedPath}
  Each file starts with "=== FILE: <path>". Each line shows the old line number (HEAD), the new line number (working tree), a marker (" " context, "-" removed, "+" added) and the text.
${submoduleNote(changes)}- Changed files:
${fileList(changes)}

${sessionBlock(mode)}

## What to produce
1. categories: group all changes into logical categories that can be reviewed and judged separately: a feature, a bug fix, a refactor, a rename sweep, test updates, build configuration, and so on. Use as few categories as make sense; a small change set can have one. Order the categories for the easiest reading; see "Reading order" below.
2. For each category:
${CATEGORY_RULES}
3. For each section:
${SECTION_RULES}
4. title: one line, at most about 80 characters, naming what the change set does, for example "Transient heap pools and GPU memory aliasing".
5. overview: 2-5 sentences that describe the whole change set.

${READING_ORDER}

${reviewChecks(guidance)}

## Rules
- Read the annotated diff completely before writing anything. Read surrounding code and callers where needed.
- Do not modify any source files.${mode.kind === 'skill' ? ' The only file you write is the review JSON named below.' : ''}

${output}
`;
}

/**
 * Follow-up prompt for the session that just wrote a review, when some changed lines have no section.
 * `coverageFile` lists them (see renderCoverage()). The agent returns only the sections it extends or adds.
 */
export function buildCoveragePrompt(coverageFile: string): string {
	return `Your review leaves some changed lines without a section, but every changed line must belong to a section. The review is otherwise complete; cover only these lines.

## Inputs
- The uncovered lines: ${coverageFile}
  The categories of the review by id, then per file the sections of the file by id and the changed lines no section covers.

## What to produce
For each block of uncovered lines:
1. When the lines are part of the code a neighbouring section explains, such as the rest of its function, extend that section: list it under its category with its id and the new newStart/newEnd (or oldStart/oldEnd for removed lines). Give summary too when the old one no longer describes the larger section. Fields you leave out keep their value. Never add a second section for the rest of a function that a section already covers in part; extend that section.
2. Otherwise add a new section without an id, under the category it belongs to. Use only the category ids listed in the file. Give "before" with a section id to place it before that section; without it, it goes after the sections of the same file.
3. Add a new category, without an id and with title, oldBehavior and newBehavior, only when the code fits no existing category; give "before" with the id of the category it should precede.
Return only the categories and sections you extend or add. Leave out everything else; it stays as it is.

Section rules:
${SECTION_RULES}

## Rules
- Read the uncovered lines file first. Read the source files only where you need more context.
- Do not modify any source files.

## Output
Return the changes as structured output matching the provided JSON schema.
`;
}

export interface UpdatedFile {
	path: string;
	reason: 'modified' | 'added' | 'removed';
	/** Set when the file's HEAD version changed through a commit, so the edits since the review are unknown. */
	headMoved?: boolean;
}

export type UpdateMode = { kind: 'resumed' } | { kind: 'fresh' } | { kind: 'skill'; outputFile: string; submitCommand: string };

/**
 * Prompt for a review update. `updateFile` describes, per changed file, the edits since the review, the
 * sections they touch and the current diff around them (see renderUpdate()). The agent returns only what
 * changes, by id.
 */
export function buildUpdatePrompt(root: string, changes: ChangeSet, reviewFile: string, updateFile: string, mode: UpdateMode, guidance: ReviewGuidance): string {
	const context =
		mode.kind === 'resumed'
			? 'You wrote the review earlier in this session. The code changed since then.'
			: 'A review of this change set exists. The code changed since it was written.';
	const output =
		mode.kind === 'skill'
			? [
					'## Output',
					`Write the update as one JSON object to: ${mode.outputFile}`,
					'Shape (TypeScript notation; "?" marks optional fields):',
					'{ title?: string; overview?: string; categories: { id?: string; before?: string; title?: string; oldBehavior?: string; newBehavior?: string; concerns?: { tag: string; text: string }[];',
					'  sections?: { id?: string; remove?: boolean; before?: string; file?: string; title?: string; summary?: string; newStart?: number; newEnd?: number; oldStart?: number; oldEnd?: number; group?: string; notes?: { line: number; text: string }[]; concerns?: { tag: string; text: string }[] }[] }[] }',
					`Then run: ${mode.submitCommand}`,
					'It validates the update, merges it into the review and loads it into the ExplainYourself extension. Fix any reported errors and run it again.'
				].join('\n')
			: '## Output\nReturn the update as structured output matching the provided JSON schema.';

	return `${INTRO}

${context} Update the review for these edits only. Everything else stays as it is: sections the edits do not touch keep their text, and their positions already follow the edits.

## Inputs
- The edits since the review: ${updateFile}
  Per file: the edits ("-" lines removed since the review, "+" lines added, with current line numbers), the sections they touch with their current positions, edited code that no section covers, and the current diff against HEAD around them. Files that changed too much, or whose HEAD moved, are marked to be reviewed again in full.
- Repository root: ${root}
- Review (JSON; ids of categories and sections, their text, and positions in the reviewed version of each file): ${reviewFile}
- Annotated diff of the complete current change set (HEAD -> working tree): ${changes.annotatedPath}
  Read it only for files to review again in full, or when the context in the edits file is not enough.
${submoduleNote(changes)}
## What to produce
Only the categories and sections that change, by id. Everything you leave out stays as it is.
1. Sections the edits touch: for each, give its id and the fields that change, such as summary, newStart/newEnd, notes or concerns. Fields you leave out keep their value. Give the id with "remove": true when the section no longer has changes or no longer makes sense. Leave out a touched section that needs no change.
2. Edited code that no section covers, when it differs from HEAD: extend a neighbouring section to cover it (give its id and the new range), or add a new section without an id, in the category it belongs to.
3. Files to review again in full: give every section the file needs. Give the id of a previous section you keep, with its current lines; previous sections you leave out are removed.
4. Categories: list the category that holds each section you give, with its "id". Give title, oldBehavior, newBehavior or concerns only when they no longer describe the category after the update. Concerns, when given, replace all findings of the category. Add a new category, without an id and with title, oldBehavior and newBehavior, only when the new code fits no existing one; give "before" with the id of the category it should precede.
5. To move a section to another category, list it under that category with its id. "before" with a section id places a section before it; without it, a section keeps its place, and a new one goes after the sections of the same file.
6. title and overview (optional): only when the update changes what the change set does.
7. A category left without sections is removed.

Section rules, for new sections and changed fields:
${SECTION_RULES}

${READING_ORDER}

${reviewChecks(guidance)}

## Rules
- Read the edits file first. Read the review file, the annotated diff or the source only for what the edits file does not show.
- Keep the group names of the review for entities that still exist, so that sections stay grouped.
- Do not modify any source files.${mode.kind === 'skill' ? ' The only file you write is the update JSON named below.' : ''}

${output}
`;
}
