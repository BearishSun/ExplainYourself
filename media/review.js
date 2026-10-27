// @ts-check
(function () {
	const vscode = acquireVsCodeApi();
	// Script errors go to the ExplainYourself output channel; webview consoles are hard to reach.
	window.addEventListener('error', (e) => vscode.postMessage({ type: 'error', message: `${e.message} (review.js:${e.lineno}:${e.colno})` }));
	const root = document.getElementById('root');
	/** @type {any} */
	let state = null;
	const saved = vscode.getState() ?? {};
	/** Expanded categories. Categories start collapsed; ids repeat across reviews, so a new review resets this. */
	const expanded = new Set(saved.expanded ?? []);
	let expandedFor = saved.expandedFor ?? '';
	/** Scroll offset that re-renders keep; persisted so a recreated webview restores it too. */
	let scrollTop = saved.scrollTop ?? 0;
	let lastStateJson = '';
	let revealId = null;
	/** Whether the submodule checklist is open. */
	let subsOpen = false;

	const run = (command, ...args) => vscode.postMessage({ type: 'command', command, args });

	function esc(s) {
		return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	}

	/** Inline markdown in one line of text: `code` and **bold**. */
	function inline(s) {
		return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
	}

	/** Minimal markdown: paragraphs, "- " bullets, `code` and **bold**. */
	function md(text) {
		const blocks = String(text ?? '').trim().split(/\n\s*\n/);
		return blocks
			.map((b) => {
				const lines = b.split('\n');
				if (lines.every((l) => /^\s*[-*] /.test(l))) {
					return '<ul>' + lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('') + '</ul>';
				}
				return `<p>${inline(b)}</p>`;
			})
			.join('');
	}

	/** Effort indicator: colored by how hard the section is to review, showing its changed line count. */
	/**
	 * Pill with the number of changed lines, colored by size. Categories hold several sections, so their
	 * thresholds are higher.
	 */
	/** Size class of a changed-line count: low, medium, high or huge, at or below each limit in turn. */
	function sizeClass(n, limits) {
		const i = limits.findIndex((limit) => n <= limit);
		return SIZES[i < 0 ? SIZES.length - 1 : i];
	}
	const SIZES = ['low', 'medium', 'high', 'huge'];

	function sizePill(item, limits) {
		const n = item.changed;
		const size = sizeClass(n, limits);
		return `<span class="effort effort-${size}" title="${n} changed lines: +${item.added} −${item.removed}">${n}</span>`;
	}
	const SECTION_LIMITS = [10, 30, 80];
	const CATEGORY_LIMITS = [50, 150, 400];

	/** Review findings as a list, each starting with the tag of the rule it belongs to. */
	function concernList(concerns) {
		return `<ul class="concern-list">${concerns.map((c) => `<li>${c.tag ? `<span class="tag">${esc(c.tag)}</span> ` : ''}${inline(c.text)}</li>`).join('')}</ul>`;
	}

	const WARNING_ICON =
		'<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M7.13 1.5a1 1 0 0 1 1.74 0l6.5 11.5A1 1 0 0 1 14.5 14.5h-13a1 1 0 0 1-.87-1.5zM8 5a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-3.5A.75.75 0 0 0 8 5zm0 7.5a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8z"/></svg>';

	/** "claude-sonnet-5-5" or "claude-opus-4-1-20250805" -> "Sonnet 5.5" / "Opus 4.1"; other names stay as they are. */
	/** Models offered for the review, as [id, name]; an empty id leaves the choice to Claude Code. */
	const MODELS = [
		['claude-sonnet-5-5', 'Sonnet 5.5'],
		['claude-opus-5-5', 'Opus 5.5'],
		['claude-fable-5-1', 'Fable 5.1'],
		['claude-haiku-5-5', 'Haiku 5.5'],
		['', 'Claude Code default']
	];

	function modelName(id) {
		const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
		return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id;
	}

	function el(html) {
		const t = document.createElement('template');
		t.innerHTML = html.trim();
		return /** @type {HTMLElement} */ (t.content.firstElementChild);
	}

	function persist() {
		vscode.setState({ expanded: [...expanded], expandedFor, scrollTop });
	}

	function scroller() {
		return document.scrollingElement ?? document.documentElement;
	}

	function render() {
		if (!state) {
			root.innerHTML = '<p class="muted">Loading…</p>';
			return;
		}
		const s = state;
		const parts = [];

		if (!s.repo) {
			parts.push(`<p>No Git repository is open.</p><button data-cmd="explainYourself.openRepository">Open Repository…</button>`);
			root.innerHTML = parts.join('');
			strip.hidden = true;
			bind();
			return;
		}

		const acc = s.account;
		const accountLine = !acc.installed
			? `<span class="warn">Claude Code CLI not found.</span> <a data-cmd="explainYourself.account">Install / configure</a>`
			: !acc.loggedIn
				? `<span class="warn">Not signed in to Claude.</span> <a data-cmd="explainYourself.signIn">Sign in</a>`
				: `Claude: ${esc(acc.email ?? 'signed in')} <a data-cmd="explainYourself.account">Account</a>`;

		const running = s.generation?.running;
		const r = s.review;

		// Sticky progress strip: a grid of squares, one per reviewable section. layoutSquares() fills it.
		strip.hidden = !(r && r.total > 0);
		if (r && r.total > 0) {
			stripLabel.innerHTML = `<span>${r.staged} of ${r.total} sections reviewed</span><span class="pct">${Math.floor((100 * r.staged) / r.total)}%</span>`;
		}

		// Review options: a ▾ next to the main button opens the model choice and a checklist of the submodules to review.
		const subs = s.repo.submodules ?? [];
		const chosen = subs.filter((m) => m.selected);
		const model = s.model ?? '';
		const models = MODELS.some(([id]) => id === model) ? MODELS : [...MODELS, [model, modelName(model)]];
		const arrow = `<button class="arrow ${subsOpen ? 'open' : ''}" data-toggle-subs title="Model${subs.length ? ' and submodules' : ''} for the review">▾</button>`;
		const subList = subsOpen
			? `<div class="submodules">
				<label class="model-row"><span class="muted small">Model</span>
					<select data-model ${running ? 'disabled' : ''} title="Model for generating, updating and explaining the review">
						${models.map(([id, name]) => `<option value="${esc(id)}" ${id === model ? 'selected' : ''}>${esc(name)}</option>`).join('')}
					</select></label>
				${
					subs.length
						? `<div class="muted small">Submodules to include in the review:</div>
				${subs
					.map(
						(m) => `<label class="sub ${m.initialized ? '' : 'muted'}" title="${m.initialized ? esc(m.path) : 'Not initialized: run git submodule update --init'}">
					<input type="checkbox" data-sub="${esc(m.path)}" ${m.selected ? 'checked' : ''} ${!m.initialized || running ? 'disabled' : ''}>
					<span>${esc(m.path)}</span>${m.changed ? ' <span class="badge">changed</span>' : ''}${m.initialized ? '' : ' <span class="small">(not initialized)</span>'}</label>`
					)
					.join('')}`
						: ''
				}
			</div>`
			: `<div class="muted small sub-summary">${esc(model ? modelName(model) : 'Claude Code default model')}${chosen.length ? ` · includes ${chosen.map((m) => esc(m.path)).join(', ')}` : ''}</div>`;

		parts.push(`<div class="header">
			<div class="repo" title="${esc(s.repo.root)}"><b>${esc(s.repo.name)}</b> ${s.repo.branch ? `<span class="muted">on ${esc(s.repo.branch)}</span>` : ''}</div>
			<div class="account muted">${accountLine}</div>
			<div class="buttons">
				${
					r
						? `<span class="split"><button data-cmd="explainYourself.updateReview" ${running ? 'disabled' : ''} title="Re-review only the files that changed since the review, continuing the review session">Update review</button>${arrow}</span>
				<button class="secondary" data-cmd="explainYourself.generate" ${running ? 'disabled' : ''} title="Review the whole change set again from scratch">Full regenerate</button>`
						: `<span class="split"><button data-cmd="explainYourself.generate" ${running ? 'disabled' : ''} title="Choose the Claude session that wrote the changes to fork, or a new agent, to write the review">Generate review</button>${arrow}</span>`
				}
			</div>
			${subList}
		</div>`);

		const g = s.generation;
		if (g && g.running && g.followUp) {
			// The first pass is shown below; a slim bar reports the pass that still runs.
			const last = g.log.filter((l) => l.kind === 'status').pop();
			const log = g.log.map((l) => `<div class="log-${l.kind}">${esc(l.message.length > 300 ? l.message.slice(0, 300) + '…' : l.message)}</div>`).join('');
			parts.push(`<details class="generation follow-up" ${followUpOpen ? 'open' : ''}><summary class="gen-title"><span class="spinner"></span> <span class="follow-up-text">${esc(last ? last.message : 'Working on the review…')}</span>
				<button class="secondary small" data-cmd="explainYourself.cancelGeneration" title="Stop the pass; the review keeps what it has">Cancel</button></summary>
				<div class="log">${log}</div></details>`);
		} else if (g && (g.running || g.error)) {
			const log = g.log.map((l) => `<div class="log-${l.kind}">${esc(l.message.length > 300 ? l.message.slice(0, 300) + '…' : l.message)}</div>`).join('');
			parts.push(`<div class="generation ${g.error ? 'error' : ''}">
				<div class="gen-title">${g.running ? '<span class="spinner"></span> Working on the review…' : 'Review generation failed'}
				${g.running ? '<button class="secondary small" data-cmd="explainYourself.cancelGeneration">Cancel</button>' : ''}</div>
				${g.error ? `<pre class="err">${esc(g.error)}</pre>` : ''}
				<div class="log">${log}</div></div>`);
		}

		if (!r) {
			parts.push(`<p class="muted">No review yet. ${s.repo.changes} changed file(s). Generate a review to group the changes into categories with summaries, or stage hunks directly from the Changes view.</p>`);
		} else {
			const src = r.source.kind === 'session' ? 'forked coding session' : r.source.kind === 'skill' ? 'Claude session (/explain-yourself)' : 'new agent';
			// Runs on a resumed or forked session report an estimated cost; see runCost() in agent.ts.
			const approxCost = r.source.kind === 'session' || !!r.updatedAt;
			const when = r.updatedAt ? `updated ${new Date(r.updatedAt).toLocaleString()}` : `generated ${new Date(r.generatedAt).toLocaleString()}`;
			parts.push(`<div class="overview">
				${r.title ? `<h2 class="review-title">${inline(r.title)}</h2>` : ''}
				<div class="muted small">${when} by ${src}${r.source.model ? ` using <span title="${esc(r.source.model)}">${esc(modelName(r.source.model))}</span>` : ''}${r.source.costUsd ? ` · ${approxCost ? '≈' : ''}$${r.source.costUsd.toFixed(2)}` : ''} · <a data-cmd="explainYourself.showPrompt" title="Open the last prompt sent to Claude">Prompt</a> · <a data-cmd="explainYourself.editReviewRules" title="Edit the rules the review checks the code against">Rules</a></div>
				${r.stale.length ? `<details class="stale small"><summary><span class="warn">${r.stale.length === 1 ? '1 file changed' : `${r.stale.length} files changed`} since the review.</span> Update review re-reviews ${r.stale.length === 1 ? 'it' : 'them'}.</summary>${r.stale.map((f) => `<div class="stale-file">${esc(f)}</div>`).join('')}</details>` : ''}
				${md(r.overview)}
			</div>`);

			for (const c of r.categories) {
				const open = expanded.has(c.id);
				const done = c.total > 0 && c.staged === c.total;
				const sections = c.sections
					.map(
						(sec) => `<div class="section ${sec.status}" data-section="${sec.id}">
						<div class="section-head">
							<span class="dot" title="${sec.status === 'staged' ? 'Staged' : sec.status === 'context' ? 'Unchanged context' : 'Not staged yet'}"></span>
							<span class="section-name"><a class="section-title" data-open="${sec.id}">${inline(sec.title)}</a>${sec.status === 'context' ? '' : sizePill(sec, SECTION_LIMITS)}${
								sec.concerns.length ? `<span class="concern-icon" tabindex="0" data-concerns="${sec.id}" aria-label="${sec.concerns.length} review findings">${WARNING_ICON}</span>` : ''
							}</span>
							${sec.status === 'pending' ? `<button class="small" data-stage="${sec.id}" title="Stage every change inside this section">Stage</button>` : ''}
						</div>
						<div class="file muted small"><a data-open="${sec.id}">${esc(sec.file)}${sec.lines ? `:${esc(sec.lines)}` : ''}</a>${
								sec.nearby ? ` <span class="nearby" title="Whitespace changes and changes next to this section. Staging the section stages them too.">+${sec.nearby} nearby</span>` : ''}
							${sec.comparable ? `<span class="views"><a data-open-diff="${sec.id}" title="Open as a diff">Diff</a> · <a data-compare="${sec.id}" title="Old and new versions side by side, without diff markup">Old ↔ New</a></span>` : ''}</div>
						<div class="summary">${md(sec.summary)}</div>
						${sec.related.length ? relatedList(sec) : ''}
					</div>`
					)
					.join('');
				parts.push(`<details class="category ${done ? 'done' : ''}" data-category="${c.id}" ${open ? 'open' : ''}>
					<summary><span class="cat-title">${inline(c.title)}${c.total ? sizePill(c, CATEGORY_LIMITS) : ''}</span> <span class="count">${c.staged}/${c.total}</span>
					${!done ? `<button class="small" data-stage-category="${c.id}" title="Stage every change in this category">Stage all</button>` : ''}</summary>
					<div class="behavior"><div class="label">Before</div>${md(c.oldBehavior)}</div>
					<div class="behavior"><div class="label">After</div>${md(c.newBehavior)}</div>
					${c.concerns.length ? `<div class="behavior concerns"><div class="label">Check</div>${concernList(c.concerns)}</div>` : ''}
					<div class="sections">${sections}</div>
				</details>`);
			}

			if (s.uncovered.length) {
				const items = s.uncovered
					.map((u) => `<div><a data-uncovered="${esc(u.file)}" data-line="${u.line}">${esc(u.file)}:${u.line}</a> <span class="muted small">${u.added || u.removed ? `+${u.added} -${u.removed}` : 'file'}</span></div>`)
					.join('');
				parts.push(`<details class="category uncovered" open><summary><span class="cat-title">Not covered by the review</span> <span class="count">${s.uncovered.length}</span>
					${s.uncoveredPending ? '<button class="small" data-stage-uncovered title="Stage every change that no section covers">Stage all</button>' : ''}</summary>
					<p class="muted small">These changes are not part of any section. They were made after the review or the agent missed them.</p>${items}</details>`);
			}
		}

		// Replacing the content resets the scroll position, so carry it over.
		root.innerHTML = parts.join('');
		bind();
		layoutSquares();
		fitRelated();
		scroller().scrollTop = scrollTop;

		if (revealId) {
			const target = root.querySelector(`[data-section="${revealId}"]`);
			revealId = null;
			if (target) {
				target.closest('details')?.setAttribute('open', '');
				target.scrollIntoView({ block: 'center' });
				target.classList.add('flash');
			}
		}
	}

	/** Shows the findings of a section in a popup below its warning icon, as wide as the panel. */
	function showConcerns(icon) {
		const sec = state?.review?.categories.flatMap((c) => c.sections).find((x) => x.id === icon.dataset.concerns);
		if (!sec) {
			return;
		}
		let tip = document.getElementById('concern-tip');
		if (!tip) {
			tip = el('<div id="concern-tip" role="tooltip"></div>');
			document.body.appendChild(tip);
		}
		tip.innerHTML = `<div class="tip-title">Check</div>${concernList(sec.concerns)}`;
		tip.style.display = 'block';
		const r = icon.getBoundingClientRect();
		const below = r.bottom + 4;
		tip.style.top = `${below + tip.offsetHeight > window.innerHeight && r.top > tip.offsetHeight + 4 ? r.top - tip.offsetHeight - 4 : below}px`;
	}

	function hideConcerns() {
		const tip = document.getElementById('concern-tip');
		if (tip) {
			tip.style.display = 'none';
		}
	}

	function bind() {
		hideConcerns();
		root.querySelectorAll('[data-concerns]').forEach((icon) => {
			const target = /** @type {HTMLElement} */ (icon);
			target.addEventListener('mouseenter', () => showConcerns(target));
			target.addEventListener('focus', () => showConcerns(target));
			target.addEventListener('mouseleave', hideConcerns);
			target.addEventListener('blur', hideConcerns);
		});
		root.querySelector('.follow-up')?.addEventListener('toggle', (e) => (followUpOpen = /** @type {HTMLDetailsElement} */ (e.target).open));
		root.querySelectorAll('[data-cmd]').forEach((b) =>
			b.addEventListener('click', (e) => {
				e.preventDefault();
				run(/** @type {HTMLElement} */ (b).dataset.cmd);
			})
		);
		root.querySelectorAll('[data-toggle-subs]').forEach((b) =>
			b.addEventListener('click', () => {
				subsOpen = !subsOpen;
				render();
			})
		);
		root.querySelector('[data-model]')?.addEventListener('change', (e) => run('explainYourself.setModel', /** @type {HTMLSelectElement} */ (e.target).value));
		root.querySelectorAll('[data-sub]').forEach((b) =>
			b.addEventListener('change', () => {
				const paths = [...root.querySelectorAll('[data-sub]')]
					.filter((x) => /** @type {HTMLInputElement} */ (x).checked)
					.map((x) => /** @type {HTMLElement} */ (x).dataset.sub);
				run('explainYourself.setSubmodules', paths);
			})
		);
		root.querySelectorAll('[data-open]').forEach((b) =>
			b.addEventListener('click', (e) => {
				e.preventDefault();
				const id = /** @type {HTMLElement} */ (b).dataset.open;
				run('explainYourself.openSection', id);
				// A related section may sit in another category; bring its card into view too.
				if (b.closest('.related')) {
					showCard(id);
				}
			})
		);
		root.querySelectorAll('.related-toggle').forEach((t) => {
			const toggle = () => {
				const list = /** @type {HTMLElement} */ (t.closest('.related'));
				const id = list.dataset.related;
				const expanded = list.classList.toggle('expanded');
				if (expanded) {
					expandedRelated.add(id);
				} else {
					expandedRelated.delete(id);
				}
				t.textContent = expanded ? 'less' : `all ${list.querySelectorAll('[data-open]').length}`;
				fitRelated();
			};
			t.addEventListener('click', toggle);
			t.addEventListener('keydown', (e) => (/** @type {KeyboardEvent} */ (e).key === 'Enter' || /** @type {KeyboardEvent} */ (e).key === ' ') && (e.preventDefault(), toggle()));
		});
		root.querySelectorAll('[data-open-diff]').forEach((b) =>
			b.addEventListener('click', (e) => {
				e.preventDefault();
				run('explainYourself.openSection', /** @type {HTMLElement} */ (b).dataset.openDiff);
			})
		);
		root.querySelectorAll('[data-compare]').forEach((b) =>
			b.addEventListener('click', (e) => {
				e.preventDefault();
				run('explainYourself.compareSection', /** @type {HTMLElement} */ (b).dataset.compare);
			})
		);
		root.querySelectorAll('[data-stage]').forEach((b) =>
			b.addEventListener('click', (e) => {
				e.preventDefault();
				run('explainYourself.stageSection', /** @type {HTMLElement} */ (b).dataset.stage);
			})
		);
		root.querySelectorAll('[data-stage-category]').forEach((b) =>
			b.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				run('explainYourself.stageCategory', /** @type {HTMLElement} */ (b).dataset.stageCategory);
			})
		);
		root.querySelectorAll('[data-stage-uncovered]').forEach((b) =>
			b.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				run('explainYourself.stageUncovered');
			})
		);
		root.querySelectorAll('[data-uncovered]').forEach((b) =>
			b.addEventListener('click', (e) => {
				e.preventDefault();
				const d = /** @type {HTMLElement} */ (b).dataset;
				run('explainYourself.openDiffAt', d.uncovered, Number(d.line));
			})
		);
		root.querySelectorAll('details[data-category]').forEach((d) =>
			d.addEventListener('toggle', () => {
				const id = /** @type {HTMLElement} */ (d).dataset.category;
				const open = /** @type {HTMLDetailsElement} */ (d).open;
				if (open) {
					expanded.add(id);
				} else {
					expanded.delete(id);
				}
				persist();
			})
		);
	}

	// Progress grid geometry, in CSS pixels. Squares grow to fill the width, up to MAX_CELL. When more
	// than MAX_ROWS rows would make squares smaller than MIN_CELL, neighbouring squares merge pairwise,
	// as often as needed.
	const MAX_CELL = 16;
	const MIN_CELL = 7;
	const MAX_ROWS = 6;
	const GAP = 2;
	// The strip lives outside #root and survives re-renders, so a square changing state animates.
	const strip = document.createElement('div');
	strip.className = 'progress-strip';
	strip.hidden = true;
	const grid = document.createElement('div');
	grid.className = 'squares';
	const stripLabel = document.createElement('div');
	stripLabel.className = 'progress-label small';
	strip.append(grid, stripLabel);
	root.before(strip);
	grid.addEventListener('click', (e) => {
		const sq = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-sq]'));
		if (sq) {
			run('explainYourself.openSection', sq.dataset.sq);
			showCard(sq.dataset.sq);
		}
	});
	/** Grid geometry last applied; skips relayouts on resizes that do not change it. */
	let gridKey = '';

	function layoutSquares() {
		const r = state?.review;
		// The grid is only as wide as its squares, so measure the space the strip offers.
		const style = getComputedStyle(strip);
		const available = strip.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
		if (strip.hidden || !r || available <= 0) {
			return;
		}
		// Sizes are whole device pixels: fractional sizes make the browser round each gap differently.
		const dpr = window.devicePixelRatio || 1;
		const width = Math.floor(available * dpr);
		const gap = Math.max(1, Math.round(GAP * dpr));
		const maxCell = Math.round(MAX_CELL * dpr);
		let cells = r.categories.flatMap((c) =>
			c.sections
				.filter((sec) => sec.status !== 'context')
				.map((sec) => [{ id: sec.id, staged: sec.status === 'staged', size: SIZES.indexOf(sizeClass(sec.changed, SECTION_LIMITS)), title: `${c.title} › ${sec.title}` }])
		);
		let cols = 1;
		let cell = maxCell;
		for (;;) {
			cols = Math.max(1, Math.ceil(cells.length / MAX_ROWS), Math.floor((width + gap) / (maxCell + gap)));
			cell = Math.min(maxCell, Math.floor((width - (cols - 1) * gap) / cols));
			if (cells.length <= 1 || cell >= MIN_CELL * dpr) {
				break;
			}
			const merged = [];
			for (let i = 0; i < cells.length; i += 2) {
				merged.push(cells[i].concat(cells[i + 1] ?? []));
			}
			cells = merged;
		}

		const key = `${cols}:${cell}:${dpr}`;
		if (key !== gridKey) {
			gridKey = key;
			grid.style.gridTemplateColumns = `repeat(${cols}, ${cell / dpr}px)`;
			grid.style.gridAutoRows = `${cell / dpr}px`;
			grid.style.gap = `${gap / dpr}px`;
			// The label ends where the squares end.
			stripLabel.style.width = `${(cols * cell + (cols - 1) * gap) / dpr}px`;
			grid.style.setProperty('--sq-radius', `${Math.max(1, Math.round(cell * 0.22)) / dpr}px`);
		}

		// Reuse the existing squares and only change their state, so the change animates.
		while (grid.children.length > cells.length) {
			grid.lastElementChild?.remove();
		}
		while (grid.children.length < cells.length) {
			grid.appendChild(document.createElement('span'));
		}
		cells.forEach((group, i) => {
			const sq = /** @type {HTMLElement} */ (grid.children[i]);
			const staged = group.filter((x) => x.staged).length;
			const done = staged === group.length;
			// A merged square opens its first section that still needs review.
			sq.dataset.sq = (group.find((x) => !x.staged) ?? group[0]).id;
			// Colored by size, like the pills; a merged square takes the size of its largest section.
			sq.className = `sq ${done ? 'staged' : 'pending'} size-${SIZES[Math.max(...group.map((x) => x.size))]}`;
			sq.title =
				group.length === 1
					? `${group[0].title} (${done ? 'staged' : 'to review'})`
					: `${group.length} sections, ${staged} staged\n` + group.slice(0, 12).map((x) => `${x.staged ? '✓' : '•'} ${x.title}`).join('\n') + (group.length > 12 ? '\n…' : '');
		});
	}

	/** Whether the user expanded the log of a follow-up pass; kept across re-renders. */
	let followUpOpen = false;

	/** Sections whose related list the user expanded; kept across re-renders. */
	const expandedRelated = new Set();

	/**
	 * Links to the related sections of a section: file names, with the full path in the tooltip. The list
	 * stays on one line; when it does not fit, a toggle expands it.
	 */
	function relatedList(sec) {
		const links = sec.related
			.map((x) => {
				const where = `${x.file}${x.lines ? `:${x.lines}` : ''}`;
				return `<a data-open="${x.id}" title="${esc(where)}">${esc(x.file.split('/').pop())}${x.lines ? `:${esc(x.lines)}` : ''}</a>`;
			})
			.join(' · ');
		const expanded = expandedRelated.has(sec.id);
		return `<div class="related small muted${expanded ? ' expanded' : ''}" data-related="${sec.id}"><span class="related-items">Related: ${links}</span><a class="related-toggle" role="button" tabindex="0" ${expanded ? '' : 'hidden'}>${expanded ? 'less' : `all ${sec.related.length}`}</a></div>`;
	}

	/** Shows the toggle of each collapsed related list that does not fit on one line. */
	function fitRelated() {
		root.querySelectorAll('.related:not(.expanded)').forEach((el) => {
			const items = /** @type {HTMLElement} */ (el.querySelector('.related-items'));
			const toggle = /** @type {HTMLElement} */ (el.querySelector('.related-toggle'));
			// Lists in closed categories have no width yet; they are measured when the category opens.
			if (items.clientWidth > 0) {
				toggle.hidden = items.scrollWidth <= items.clientWidth + 1;
			}
		});
	}

	/** Expands a section's category, scrolls its card into view and flashes it. */
	function showCard(id) {
		const card = root.querySelector(`[data-section="${id}"]`);
		if (card) {
			card.closest('details')?.setAttribute('open', '');
			card.scrollIntoView({ block: 'center' });
			card.classList.remove('flash');
			void (/** @type {HTMLElement} */ (card).offsetWidth);
			card.classList.add('flash');
		}
	}

	new ResizeObserver(() => layoutSquares()).observe(strip);
	new ResizeObserver(() => fitRelated()).observe(root);
	// Opening a category lays out its related lists; toggle does not bubble, so listen while capturing.
	root.addEventListener('toggle', () => fitRelated(), true);

	window.addEventListener('message', (e) => {
		const m = e.data;
		if (m.type === 'state') {
			// Repository refreshes often produce identical state; skip those renders.
			const json = JSON.stringify(m.state);
			if (json === lastStateJson) {
				return;
			}
			lastStateJson = json;
			state = m.state;
			const generatedAt = state.review?.generatedAt ?? '';
			if (generatedAt && generatedAt !== expandedFor) {
				expanded.clear();
				expandedFor = generatedAt;
				persist();
			}
			render();
			vscode.postMessage({ type: 'rendered', buttons: [...root.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()) });
		} else if (m.type === 'reveal') {
			revealId = m.sectionId;
			render();
		}
	});

	let scrollSaveTimer = 0;
	window.addEventListener('scroll', () => {
		scrollTop = scroller().scrollTop;
		clearTimeout(scrollSaveTimer);
		scrollSaveTimer = setTimeout(persist, 200);
	});

	render();
	vscode.postMessage({ type: 'ready' });
})();
