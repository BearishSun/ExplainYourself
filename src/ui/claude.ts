import { execFile } from 'child_process';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { config, log } from './util';

export interface AuthStatus {
	installed: boolean;
	loggedIn: boolean;
	email?: string;
	method?: string;
	orgName?: string;
}

function run(file: string, args: string[], timeoutMs = 15000): Promise<string> {
	return new Promise((resolve, reject) => {
		const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
		execFile(file, args, { timeout: timeoutMs, windowsHide: true, shell }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
	});
}

/** Locates the Claude Code CLI: the configured path, PATH, or the default install locations. */
export async function resolveClaudePath(): Promise<string | undefined> {
	const configured = config().get<string>('claudePath');
	if (configured) {
		return configured;
	}

	try {
		const out = await run(process.platform === 'win32' ? 'where' : 'which', ['claude'], 5000);
		const candidates = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
		const exe = candidates.find((c) => /\.exe$/i.test(c)) ?? candidates[0];
		if (exe) {
			return exe;
		}
	} catch {
		// Not on PATH.
	}

	const home = os.homedir();
	const known = process.platform === 'win32'
		? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA ?? '', 'npm', 'claude.cmd')]
		: [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];
	return known.find((p) => existsSync(p));
}

export async function authStatus(claudePath: string | undefined): Promise<AuthStatus> {
	if (!claudePath) {
		return { installed: false, loggedIn: false };
	}
	try {
		const out = JSON.parse(await run(claudePath, ['auth', 'status', '--json']));
		return { installed: true, loggedIn: !!out.loggedIn, email: out.email, method: out.authMethod, orgName: out.orgName };
	} catch (e) {
		// `auth status` exits non-zero when signed out but still prints JSON on stdout.
		const stdout = (e as { stdout?: string }).stdout;
		if (stdout) {
			try {
				const out = JSON.parse(stdout);
				return { installed: true, loggedIn: !!out.loggedIn, email: out.email, method: out.authMethod };
			} catch {
				// Fall through.
			}
		}
		log(`claude auth status failed: ${e}`);
		return { installed: existsSync(claudePath) || !path.isAbsolute(claudePath), loggedIn: false };
	}
}

/** Status bar entry that shows which Claude account the extension uses and offers sign-in. */
export class ClaudeAccount implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	private readonly disposables: vscode.Disposable[] = [this.item];
	status: AuthStatus = { installed: false, loggedIn: false };
	claudePath: string | undefined;
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;

	constructor() {
		this.item.command = 'explainYourself.account';
		this.item.show();
		this.disposables.push(this.emitter);
		this.disposables.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('explainYourself.claudePath') && this.refresh()));
	}

	dispose(): void {
		this.disposables.forEach((d) => d.dispose());
	}

	async refresh(): Promise<void> {
		this.claudePath = await resolveClaudePath();
		this.status = await authStatus(this.claudePath);
		if (!this.status.installed) {
			this.item.text = '$(warning) Claude: not installed';
			this.item.tooltip = 'Claude Code CLI was not found. Click to install or set explainYourself.claudePath.';
		} else if (!this.status.loggedIn) {
			this.item.text = '$(account) Claude: sign in';
			this.item.tooltip = 'Click to link your Claude subscription.';
		} else {
			this.item.text = `$(sparkle) Claude`;
			this.item.tooltip = `Claude: ${this.status.email ?? 'signed in'} (${this.status.method ?? 'unknown method'})\nCLI: ${this.claudePath}`;
		}
		this.emitter.fire();
	}

	private runInTerminal(name: string, command: string): void {
		const terminal = vscode.window.createTerminal({ name });
		terminal.show();
		terminal.sendText(command);
		const sub = vscode.window.onDidCloseTerminal((t) => {
			if (t === terminal) {
				sub.dispose();
				this.refresh();
			}
		});
		// Sign-in completes in the browser; poll so the status updates without closing the terminal.
		let polls = 0;
		const timer = setInterval(async () => {
			await this.refresh();
			if (this.status.loggedIn || ++polls > 60) {
				clearInterval(timer);
			}
		}, 5000);
	}

	private quote(p: string): string {
		return process.platform === 'win32' ? `& "${p}"` : `"${p}"`;
	}

	signIn(): void {
		if (!this.claudePath) {
			this.install();
			return;
		}
		this.runInTerminal('Claude sign-in', `${this.quote(this.claudePath)} auth login --claudeai`);
	}

	signOut(): void {
		if (this.claudePath) {
			this.runInTerminal('Claude sign-out', `${this.quote(this.claudePath)} auth logout`);
		}
	}

	install(): void {
		const command = process.platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';
		this.runInTerminal('Install Claude Code', command);
	}

	async showMenu(): Promise<void> {
		await this.refresh();
		type Item = vscode.QuickPickItem & { action: () => void };
		const items: Item[] = [];
		if (!this.status.installed) {
			items.push({ label: '$(cloud-download) Install Claude Code', action: () => this.install() });
			items.push({ label: '$(gear) Set path to the claude executable', action: () => vscode.commands.executeCommand('workbench.action.openSettings', 'explainYourself.claudePath') });
		} else if (!this.status.loggedIn) {
			items.push({ label: '$(sign-in) Sign in with your Claude subscription', action: () => this.signIn() });
		} else {
			items.push({ label: `$(account) ${this.status.email ?? 'Signed in'}`, description: this.status.orgName, action: () => undefined });
			items.push({ label: '$(sign-in) Sign in with a different account', action: () => this.signIn() });
			items.push({ label: '$(sign-out) Sign out', action: () => this.signOut() });
		}
		items.push({ label: '$(refresh) Refresh status', action: () => this.refresh() });
		const pick = await vscode.window.showQuickPick(items, { title: 'Claude account used by ExplainYourself' });
		pick?.action();
	}
}
