import * as path from 'path';
import * as vscode from 'vscode';
import { LineRange } from '../core/diff';
import { changedLines } from '../core/coverage';
import { Effort, ReviewSection } from '../core/review';
import { ClaudeAccount } from './claude';
import { AppState } from './state';
import { log } from './util';

export type ViewMessage =
	| { type: 'command'; command: string; args?: unknown[] }
	| { type: 'ready' }
	| { type: 'rendered'; buttons: string[] }
	| { type: 'error'; message: string };

const COLOR_KEYS = {
	changedLines: ['diffEditor.insertedLineBackground', 'diffEditor.removedLineBackground'],
	changedWords: ['diffEditor.insertedTextBackground', 'diffEditor.removedTextBackground']
} as const;

/** Whether VS Code's own diff colors are on; turning them off overrides them with transparent colors. */
export function diffColorEnabled(kind: keyof typeof COLOR_KEYS): boolean {
	const custom = vscode.workspace.getConfiguration('workbench').get<Record<string, string>>('colorCustomizations') ?? {};
	return !COLOR_KEYS[kind].every((k) => custom[k] === '#00000000');
}

export async function setDiffColor(kind: keyof typeof COLOR_KEYS, enabled: boolean): Promise<void> {
	const wb = vscode.workspace.getConfiguration('workbench');
	const custom = { ...(wb.inspect<Record<string, string>>('colorCustomizations')?.globalValue ?? {}) };
	for (const k of COLOR_KEYS[kind]) {
		if (enabled) {
			delete custom[k];
		} else {
			custom[k] = '#00000000';
		}
	}
	await wb.update('colorCustomizations', custom, vscode.ConfigurationTarget.Global);
}

/** Sidebar webview showing review categories, summaries and progress. */
export class ReviewView implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private pending = false;
	/** Button labels of the last rendered state; integration tests check them. */
	renderedButtons: string[] = [];

	constructor(private readonly extensionUri: vscode.Uri, private readonly state: AppState, private readonly account: ClaudeAccount) {
		const update = () => this.scheduleUpdate();
		state.onDidChangeRepo(update);
		state.onDidChangeReview(update);
		state.onDidChangeGeneration(update);
		account.onDidChange(update);
		vscode.workspace.onDidChangeConfiguration((e) => (e.affectsConfiguration('explainYourself') || e.affectsConfiguration('workbench.colorCustomizations')) && update());
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
		const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'review.css'));
		const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'review.js'));
		view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body><div id="root"></div>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
		view.webview.onDidReceiveMessage((m: ViewMessage) => {
			if (m.type === 'ready') {
				this.update();
			} else if (m.type === 'rendered') {
				this.renderedButtons = m.buttons;
			} else if (m.type === 'error') {
				log(`Review panel script error: ${m.message}`);
			} else if (m.type === 'command') {
				vscode.commands.executeCommand(m.command, ...(m.args ?? []));
			}
		});
		view.onDidChangeVisibility(() => view.visible && this.update());
	}

	private scheduleUpdate(): void {
		if (this.pending) {
			return;
		}
		this.pending = true;
		setTimeout(() => {
			this.pending = false;
			this.update();
		}, 50);
	}

	/** Reveals a section card in the view. */
	reveal(sectionId: string): void {
		this.view?.show(true);
		this.view?.webview.postMessage({ type: 'reveal', sectionId });
	}

	private update(): void {
		if (!this.view?.visible) {
			return;
		}
		const s = this.state;
		const repo = s.repo;
		const review = s.review;
		let staged = 0;
		let total = 0;
		const categories = (review?.categories ?? []).map((c) => {
			const sections = c.sections.map((sec) => {
				const range = s.newRange(sec);
				const status = s.sectionStatus(sec);
				if (status !== 'context') {
					total++;
					staged += status === 'staged' ? 1 : 0;
				}
				return {
					id: sec.id,
					file: sec.file,
					title: sec.title,
					summary: sec.summary,
					lines: rangeLabel(range, sec),
					status,
					rewrite: s.isRewrite(sec),
					comparable: !!range && !!s.compareOldRange(sec) && s.headPath(sec) !== null,
					...effortOf(sec, changedLines(s.fullDiffs.get(sec.file), range, sec.oldRange)),
					related: s.relatedSections(sec).map((r) => ({ id: r.id, file: r.file, lines: rangeLabel(s.newRange(r), r) })),
					concerns: sec.concerns ?? []
				};
			});
			const counted = sections.filter((x) => x.status !== 'context');
			return {
				id: c.id,
				title: c.title,
				oldBehavior: c.oldBehavior,
				newBehavior: c.newBehavior,
				concerns: c.concerns ?? [],
				sections,
				staged: counted.filter((x) => x.status === 'staged').length,
				total: counted.length
			};
		});

		const g = s.generation;
		this.view.webview.postMessage({
			type: 'state',
			state: {
				repo: repo
					? {
							name: path.basename(repo.root),
							root: repo.root,
							branch: repo.branch,
							changes: repo.status.length,
							submodules: repo.submodules.map((m) => ({
								path: m.path,
								initialized: m.initialized,
								selected: repo.selectedSubmodules.includes(m.path),
								changed: m.initialized && repo.submoduleChanged(m.path)
							}))
						}
					: null,
				account: this.account.status,
				generation: g ? { running: !g.done, log: g.log.slice(-40), error: g.error } : null,
				review: review
					? {
							generatedAt: review.generatedAt,
							updatedAt: review.updatedAt,
							source: review.source,
							title: review.title,
							overview: review.overview,
							categories,
							staged,
							total,
							stale: [...s.staleFiles]
						}
					: null,
				uncovered: s.uncovered,
				uncoveredPending: s.uncoveredSections().some((u) => s.sectionStatus(u) === 'pending')
			}
		});
	}
}

/** The agent's effort rating, or one estimated from the size when the review has none. */
function effortOf(section: ReviewSection, changed: { added: number; removed: number }): { effort: Effort; estimated: boolean; added: number; removed: number } {
	const total = changed.added + changed.removed;
	const estimated: Effort = total <= 15 ? 'low' : total <= 60 ? 'medium' : 'high';
	return { effort: section.effort ?? estimated, estimated: !section.effort, ...changed };
}

function rangeLabel(range: LineRange | undefined, section: ReviewSection): string {
	return range ? `${range.start}-${range.end}` : section.oldRange ? `old ${section.oldRange.start}-${section.oldRange.end}` : '';
}
