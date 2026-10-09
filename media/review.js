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
	function effortPill(sec) {
		const title = `${sec.effort[0].toUpperCase()}${sec.effort.slice(1)} effort${sec.estimated ? ' (estimated from size)' : ''}: +${sec.added} −${sec.removed} lines`;
		return `<span class="effort effort-${sec.effort}" title="${title}">${sec.added + sec.removed}</span>`;
	}

	/** Review findings as a list, each starting with the tag of the rule it belongs to. */
	function concernList(concerns) {
		return `<ul class="concern-list">${concerns.map((c) => `<li>${c.tag ? `<span class="tag">${esc(c.tag)}</span> ` : ''}${inline(c.text)}</li>`).join('')}</ul>`;
	}

	const WARNING_ICON =
		'<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M7.13 1.5a1 1 0 0 1 1.74 0l6.5 11.5A1 1 0 0 1 14.5 14.5h-13a1 1 0 0 1-.87-1.5zM8 5a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-3.5A.75.75 0 0 0 8 5zm0 7.5a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8z"/></svg>';

	/** "claude-sonnet-5-5" or "claude-opus-4-1-20250805" -> "Sonnet 5.5" / "Opus 4.1"; other names stay as they are. */
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

		// Submodules: a ▾ next to the main button opens a checklist of the ones to review.
		const subs = s.repo.submodules ?? [];
		const chosen = subs.filter((m) => m.selected);
		const arrow = subs.length
			? `<button class="arrow ${subsOpen ? 'open' : ''}" data-toggle-subs title="Choose the submodules to review${chosen.length ? ` (${chosen.length} selected)` : ''}">▾</button>`
			: '';
		const subList = subsOpen && subs.length
			? `<div class="submodules">
				<div class="muted small">Submodules to include in the review:</div>
				${subs
					.map(
						(m) => `<label class="sub ${m.initialized ? '' : 'muted'}" title="${m.initialized ? esc(m.path) : 'Not initialized: run git submodule update --init'}">
					<input type="checkbox" data-sub="${esc(m.path)}" ${m.selected ? 'checked' : ''} ${!m.initialized || running ? 'disabled' : ''}>
					<span>${esc(m.path)}</span>${m.changed ? ' <span class="badge">changed</span>' : ''}${m.initialized ? '' : ' <span class="small">(not initialized)</span>'}</label>`
					)
					.join('')}
			</div>`
			: chosen.length
				? `<div class="muted small sub-summary">Includes ${chosen.map((m) => esc(m.path)).join(', ')}</div>`
				: '';

		parts.push(`<div class="header">
			<div class="repo" title="${esc(s.repo.root)}"><b>${esc(s.repo.name)}</b> ${s.repo.branch ? `<span class="muted">on ${esc(s.repo.branch)}</span>` : ''}</div>
			<div class="account muted">${accountLine}</div>
			<div class="buttons">
				${
					r
						? `<span class="split"><button data-cmd="explainYourself.updateReview" ${running ? 'disabled' : ''} title="Re-review only the files that changed since the review, continuing the review session">Update review</button>${arrow}</span>
				<button class="secondary" data-cmd="explainYourself.generate" ${running ? 'disabled' : ''} title="Review the whole change set again from scratch">Full regenerate</button>`
						: `<span class="split"><button data-cmd="explainYourself.generate" ${running ? 'disabled' : ''} title="Fork the Claude session that wrote the changes when one is found; otherwise start a new agent">Generate review</button>${arrow}</span>`
				}
			</div>
			${subList}
		</div>`);

		const g = s.generation;
		if (g && (g.running || g.error)) {
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
				${r.stale.length ? `<div class="warn small">Changed since the review: ${r.stale.map(esc).join(', ')}. Use Update review to re-review them.</div>` : ''}
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
							<span class="section-name"><a class="section-title" data-open="${sec.id}">${inline(sec.title)}</a>${sec.status === 'context' ? '' : effortPill(sec)}${
								sec.concerns.length ? `<span class="warn" tabindex="0" data-concerns="${sec.id}" aria-label="${sec.concerns.length} review findings">${WARNING_ICON}</span>` : ''
							}${sec.rewrite ? '<span class="badge" title="Mostly rewritten: opens as the old and new versions side by side">rewrite</span>' : ''}</span>
							${sec.status === 'pending' ? `<button class="small" data-stage="${sec.id}" title="Stage every change inside this section">Stage</button>` : ''}
						</div>
						<div class="file muted small"><a data-open="${sec.id}">${esc(sec.file)}${sec.lines ? `:${esc(sec.lines)}` : ''}</a>
							${sec.comparable ? `<span class="views"><a data-open-diff="${sec.id}" title="Open as a diff">Diff</a> · <a data-compare="${sec.id}" title="Old and new versions side by side, without diff markup">Old ↔ New</a></span>` : ''}</div>
						<div class="summary">${md(sec.summary)}</div>
						${sec.related.length ? `<div class="related small muted">Related: ${sec.related.map((x) => `<a data-open="${x.id}" title="Open the related section">${esc(x.file.split('/').pop())}${x.lines ? `:${esc(x.lines)}` : ''}</a>`).join(' · ')}</div>` : ''}
					</div>`
					)
					.join('');
				parts.push(`<details class="category ${done ? 'done' : ''}" data-category="${c.id}" ${open ? 'open' : ''}>
					<summary><span class="cat-title">${inline(c.title)}</span> <span class="count">${c.staged}/${c.total}</span>
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
		root.querySelectorAll('[data-open-diff]').forEach((b) =>
			b.addEventListener('click', (e) => {
				e.preventDefault();
				run('explainYourself.openSection', /** @type {HTMLElement} */ (b).dataset.openDiff, 'diff');
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
			c.sections.filter((sec) => sec.status !== 'context').map((sec) => [{ id: sec.id, staged: sec.status === 'staged', title: `${c.title} › ${sec.title}` }])
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
			sq.className = `sq ${done ? 'staged' : 'pending'}`;
			sq.title =
				group.length === 1
					? `${group[0].title} (${done ? 'staged' : 'to review'})`
					: `${group.length} sections, ${staged} staged\n` + group.slice(0, 12).map((x) => `${x.staged ? '✓' : '•'} ${x.title}`).join('\n') + (group.length > 12 ? '\n…' : '');
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
