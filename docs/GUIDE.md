# ExplainYourself guide

Details of every feature. The [README](../README.md) has the short version.

## Setup

The status bar entry **Claude** shows the Claude account in use. Click it, or the account icon in the Review view title bar, to install the Claude Code CLI or to sign in with your Claude subscription (`claude auth login --claudeai` runs in a terminal).

On first start the extension asks to enable `diffEditor.codeLens`. VS Code hides CodeLenses in diff editors unless that setting is on, and the **Stage hunk** buttons are CodeLenses.

Diffs open in VS Code's own diff editor, so syntax highlighting, editing, and VSCodeVim keep working.

## Using the review

1. Open the **ExplainYourself** view in the activity bar. It uses the workspace repository, or **Open Repository…** picks any folder.
2. **Changes** lists staged files, unstaged files, and untracked files. Click a file to open its diff: index ↔ working tree for unstaged files, HEAD ↔ index for staged files.
3. Stage while you read:
   - **Stage hunk** CodeLens above each change, or **Unstage hunk** in the HEAD ↔ index diff.
   - `Ctrl+Alt+S` stages the selected lines. With no selection, it stages the hunk under the cursor. In the HEAD ↔ index diff it unstages instead. VSCodeVim visual-mode selections work.
   - `Ctrl+Alt+Z` undoes the last stage or unstage. `Ctrl+Alt+Y` redoes it. Undo covers hunks, lines, files, sections, and categories.
   - The inline (+) and (−) buttons in **Changes** stage and unstage whole files.
4. **Generate review** asks Claude to categorize the change set (HEAD → working tree, including untracked files). The **Review** view then shows:
   - a progress grid at the top, like a disk defragmenter: one square per section, filling the panel width over up to six rows. When sections are too many for that, neighbouring squares merge, and a merged square stays yellow until all of its sections are staged. A square is yellow while its section has unstaged changes and green once they are all staged. Click a square to open its section;
   - a one-line title and a short overview of the change set;
   - the categories, collapsed when a new review arrives; per category: what the code did before, what it does now, and **Check**: review findings that span several sections (see [Review rules](#review-rules));
   - categories and sections in reading order: bottom-up by default, from utilities that depend on nothing to the code that uses them, or top-down when a lower layer only makes sense through its caller. Tests always get their own category, last;
   - per section: the region of code to read, with a summary, an effort pill, and a **Stage** button that stages every change inside it. A method whose implementation is longer than 30 lines always gets a section of its own. The pill follows the section name and shows the number of changed lines in the section; its color is how hard the agent judged the section to review (green low, amber medium, red high). A warning icon after the pill marks a section with review findings; hover over it to read them;
   - **Not covered by the review**: changes that no section covers, so nothing slips through. These are often only whitespace; **Stage all** next to the heading stages exactly these changes as one undo step.
5. In the diff, section summaries appear as collapsible threads above each section. A section that covers a method longer than 60 lines also gets a short **Note** above each distinct part of the method, such as argument checks, the main loop, or cleanup. Notes appear only in the diff, not in the panel.
6. The agent groups sections that show parts of one entity, such as a method's declaration in a header and its definition in the source file. In a diff, `Ctrl+Alt+O` or the **Go to Related Section** button jumps to the next section of the group, and the summary above a grouped section links its partners. Section cards in the panel link them too.
7. Rewritten code is easier to read as two complete versions than as a diff. When the agent tags a section as a rewrite (`layout: "rewrite"`), the section carries a **rewrite** badge and opens as **Old ↔ New**. The HEAD version opens read-only on the left. The working tree file opens on the right. Both are scrolled to the section and show no diff markup. Every section with an old version also has **Diff** and **Old ↔ New** links, and the editor title bar has the same switch. The right side is the real file, so editing and `Ctrl+Alt+S` work there.

The Review view title bar holds **Undo**, **Redo**, the inline ⇄ side-by-side switch, the Claude account, and **Settings**. Settings switches VS Code's changed-line and changed-word colors, the summaries in diffs, and **Plain Old ↔ New**, which hides summaries and Stage CodeLenses in the comparison.

## Updating the review

**Update review** re-reviews only what changed since the review was written:

- files whose content changed, including through a new commit;
- files that joined the change set;
- files that left it, whose sections are dropped.

The update resumes the review agent's own session (`claude -p --resume`), so the agent already knows the rest of the change set. It returns sections for the listed files only, and the extension merges them into the review. Sections of other files stay unchanged. If the review session no longer exists, a new agent updates the review from `review.json`. **Full regenerate** reviews the whole change set again.

## Review rules

Besides explaining the changes, the agent reports what a careful reviewer would push back on. Each finding starts with the tag of the rule it breaks:

- architecture: **Black box**, **Leaky API**, **Separation**, **Layering**, **Generalization**, **Bolted on**, **Consistency**;
- code smells: **Hack**, **Duplication**, **Docs**, **Performance**, **Smell**;
- **Risk** for risky edge cases and changed behavior, after the rest;
- **Convention** for changes that break the repository's own instructions.

A finding about one section appears on that section: as the warning icon in the panel, and under **Check** in its summary in the diff. Findings that span sections appear under the category's **Check**.

The agent also reads the instruction files for coding agents that apply to the changed files: `CLAUDE.md`, `AGENTS.md` and `.claude/CLAUDE.md` in the repository root and in every directory on the way to a changed file.

The rules are a Markdown file you can edit. **Rules** in the panel, or **ExplainYourself: Edit Review Rules**, opens it, creating it with the default rules first. The agent uses the first of these that exists:

1. `.explainyourself/review-rules.md` in the repository, shared with everyone who works on it;
2. `~/.explainyourself/review-rules.md`, your own rules for all repositories;
3. the built-in defaults.

Write each rule as a bullet that starts with its tag in bold, such as `- **Naming**: …`.


## When files change after the review

Section ranges and notes stay on their code when the file changes later, whether you type in VS Code or another tool rewrites the file. Saving a review keeps a copy of each file that has sections (`.git/explainyourself/snapshots`). The extension diffs that copy against the current text, the unsaved editor content included, and moves each position with its line:

- lines added or removed above a section shift it;
- lines added or removed inside a section grow or shrink it;
- when the first or last line of a section was rewritten, the section starts or ends at the rewritten code;
- a note on a rewritten line moves to the start of the rewrite.

Only positions move: summaries and notes still describe the code as it was. **Update review** re-reviews every file that changed since the review was written.

## Submodules

By default a submodule is one entry: its commit pointer. To review the changes inside it, click **▾** next to **Generate review** or **Update review** and check the submodule. **ExplainYourself: Select Submodules to Review…** does the same from the command palette. The list shows every submodule, including nested ones, and marks those with changes.

A selected submodule joins the workspace:

- its changed files appear in **Changes** and in the review under their full paths, such as `Platform/PS5/Source/Device.cpp`;
- staging a hunk, a selection, a section, or a file writes to the submodule's own index; a step that touches several repositories undoes as one;
- its pointer entry in the parent disappears while only its content changed; after a new commit inside the submodule, the pointer change shows again, and staging it stages that commit.

The choice is saved in `.git/explainyourself/settings.json` and recorded in the review, so it carries over to later reviews. **Update review** re-reviews the files of newly selected submodules and drops sections of submodules you deselect.

## Where the context comes from

The review is written for a reviewer who has never seen the code. Claude gets the most context from the session that wrote the code. **Generate review** searches recent Claude Code transcripts (`~/.claude/projects`) for the session that edited the changed files. If it finds one, it forks that session (`claude -p --resume <id> --fork-session`), so the reviewer agent inherits the whole conversation. The original session is not modified. Otherwise a new agent starts, receives the matching transcripts, and greps them for intent and requirements.

Review agents use Sonnet 5.5 (`claude-sonnet-5-5`) unless `explainYourself.model` says otherwise. The panel shows the model and the cost of the review. Runs that resume or fork a session report the session's whole cost, so for those the extension estimates the run's share from its token counts and shows it with ≈.

Agents run read-only: `Read`, `Grep`, `Glob`, and read-only git commands. The review is stored in `.git/explainyourself/review.json`, next to the annotated diff the agent reads (`changes.txt`) and the last prompt sent to Claude (`prompt.md`; open it with the **Prompt** link in the panel or **ExplainYourself: Show Last Prompt Sent to Claude**).

## Settings

| Setting | Default | |
| --- | --- | --- |
| `explainYourself.model` | `claude-sonnet-5-5` | Model for review generation and updates, e.g. `opus`. Empty: the Claude Code default. |
| `explainYourself.claudePath` | (auto) | Path to `claude`. |
| `explainYourself.sessionSearchDays` | 14 | How far back to search session transcripts. |
| `explainYourself.diffAlgorithm` | `histogram` | Diff algorithm for hunks. |
| `explainYourself.showSummaries`, `summariesExpanded`, `codeLens` | on | Display options. |
| `explainYourself.openRewritesSideBySide` | on | Open rewritten sections as Old ↔ New instead of a diff. |
| `explainYourself.plainCompare` | off | No summaries or CodeLenses in Old ↔ New. |
| `explainYourself.stageFromEditors` | off | Also allow `Ctrl+Alt+S` and hunk CodeLenses in plain editors. |

## How staging stays fast

Line and hunk staging does not run `git apply`. The extension rebuilds the index blob in-process from the cached `git diff -U0` output and writes the loose object itself. It then runs a single `git update-index --index-info`. The remaining diff is also computed in-process and shown before git finishes writing. In the integration test the diff view updates about 8 ms after the stage command, and the git write completes about 70 ms after it. Undo and redo restore the recorded index entries and show the remembered diffs the same way. The cached diff is used only while the index and the file are unchanged on disk (mtime and size); otherwise the extension asks git again.

## Development

```bash
npm test                   # unit tests against temporary git repositories
npm run test:integration   # runs the extension in a separate VS Code instance with a throwaway profile
node scripts/e2e-generate.js sonnet   # real review generation on a scratch repository (uses your Claude account)
```

`src/core` has no VS Code dependency: git access, diff parsing, staging, the session finder, the prompt, and the agent runner. `src/ui` holds the VS Code integration.

## Publishing

1. Create a publisher at https://marketplace.visualstudio.com/manage and put its ID in `publisher` in `package.json`.
2. Create an Azure DevOps personal access token with the **Marketplace (Manage)** scope, for all accessible organizations.
3. Run `npx vsce login <publisher>` and paste the token.
4. Run `npm run publish`. Later releases: `npm run publish -- patch` (or `minor`, `major`) raises the version and publishes.

For VSCodium, Cursor and other editors that use Open VSX: create an account and token at https://open-vsx.org, then run `npx ovsx publish explain-yourself-<version>.vsix -p <token>`.
