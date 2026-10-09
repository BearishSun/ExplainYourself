import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { claudeConfigDir } from '../core/sessions';

const SKILL_NAME = 'explain-yourself';

function skillFile(): string {
	return path.join(claudeConfigDir(), 'skills', SKILL_NAME, 'SKILL.md');
}

function skillContent(cliPath: string): string {
	return `---
name: ${SKILL_NAME}
description: Prepare a ExplainYourself guided code review of the current uncommitted changes, using what this session knows about why the code was written. Use when the user runs /${SKILL_NAME} or asks to prepare or refresh the changes for review in ExplainYourself.
---

Run this command from the repository that contains the changes (pass --repo when the session's working directory is a different repository):

    node "${cliPath}" prepare --repo "<repository root>"

It writes an annotated diff and prints the review instructions. Follow them exactly: write the review JSON to the file it names, then run the submit command it prints. The ExplainYourself extension in VS Code loads the result automatically.

Run the skill again to refresh the review after the code changes.
`;
}

/** Installs or updates the /explain-yourself skill. Returns the skill path. */
export async function installSkill(extensionPath: string): Promise<string> {
	const file = skillFile();
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, skillContent(path.join(extensionPath, 'out', 'cli.js')), 'utf8');
	return file;
}

/** Rewrites an installed skill whose CLI path points at an older extension version. */
export async function updateSkillIfInstalled(extensionPath: string): Promise<void> {
	// The skill was called /slop-review before the extension was renamed; replace it.
	const legacy = path.join(claudeConfigDir(), 'skills', 'slop-review');
	try {
		await fs.access(legacy);
		await installSkill(extensionPath);
		await fs.rm(legacy, { recursive: true, force: true });
		return;
	} catch {
		// No legacy skill.
	}
	const file = skillFile();
	try {
		const current = await fs.readFile(file, 'utf8');
		const wanted = skillContent(path.join(extensionPath, 'out', 'cli.js'));
		if (current !== wanted) {
			await fs.writeFile(file, wanted, 'utf8');
		}
	} catch {
		// Not installed.
	}
}

export async function useInSession(extensionPath: string, repoRoot: string | undefined): Promise<void> {
	const file = await installSkill(extensionPath);
	const command = `/${SKILL_NAME}`;
	await vscode.env.clipboard.writeText(command);
	const message = `Installed the ${command} skill (${file}). In the Claude Code session that wrote the changes, run ${command}${repoRoot ? ` (repository: ${repoRoot})` : ''}. The command is on the clipboard. The review appears here when the session submits it.`;
	vscode.window.showInformationMessage(message);
}
