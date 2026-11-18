/* Markdown editors for notes and first messages (to-dos, sessions, hand-offs, workflows).

   One view, no preview pane: the text stays plain markdown in a textarea, and a highlight
   layer drawn under it styles it in place (headings, emphasis, lists, code, @ references,
   workflow blanks), so what you see is exactly what Claude gets. Both layers use the same
   monospace font and only change colour and weight, which keeps the caret aligned. The
   highlight layer is the one in the page's flow: it sets the editor's height as the text
   grows, and the textarea covers it exactly, so nothing has to be measured or resized.

   On top of that: a toolbar, list continuation, prompt structures, and "@" completion over
   the local file system with a preview of the file or folder (src/main/files.js). */
(() => {
  const api = window.stroll;
  const IS_MAC = api.platform === 'darwin';
  const MOD = IS_MAC ? '⌘' : 'Ctrl+';
  const modKey = e => (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Same reference pattern as src/main/files.js: @path, or @"a path with spaces or (brackets)".
  const REF_RE = /(?:^|(?<=[\s([]))@(?:"([^"\n]+)"|([^\s"'`()[\]{}<>,;]*[^\s"'`()[\]{}<>,;.:!?]))/g;
  // Inline markup, first match wins: code, bold, {{blank}}, @ref, [link](url), italic.
  const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\{\{[^}\n]*\}\})|((?:^|(?<=[\s([]))@(?:"[^"\n]+"|[^\s"'`()[\]{}<>,;]*[^\s"'`()[\]{}<>,;.:!?]))|(\[[^\]\n]+\]\([^)\s]+\))|((?<![\w*])\*(?![\s*])[^*\n]+?\*(?![\w*])|(?<![\w_])_(?![\s_])[^_\n]+?_(?![\w_]))/g;
  // What's being typed after "@", up to the caret: inside an open quote, or a bare path.
  const TYPING_REF = /(?:^|[\s([])@(?:"([^"\n]*)|([^\s"'`()[\]{}<>,;]*))$/;
  // A path the bare form can hold; any other is written in quotes (one with a quote in it can't be).
  const BARE_PATH = /^[^\s"'`()[\]{}<>,;]*[^\s"'`()[\]{}<>,;.:!?]$/;
  const refText = p => (BARE_PATH.test(p) || p.includes('"') ? `@${p}` : `@"${p}"`);

  const mk = s => `<span class="md-mk">${esc(s)}</span>`;

  function inline(s, o) {
    let out = '';
    let last = 0;
    for (const m of s.matchAll(INLINE)) {
      const [t] = m;
      out += esc(s.slice(last, m.index));
      last = m.index + t.length;
      if (m[1]) out += `<span class="md-code">${mk('`')}${esc(t.slice(1, -1))}${mk('`')}</span>`;
      else if (m[2]) out += `<span class="md-b">${mk(t.slice(0, 2))}${inline(t.slice(2, -2), o)}${mk(t.slice(-2))}</span>`;
      else if (m[3]) out += o.blanks ? `<span class="md-blank">${esc(t)}</span>` : esc(t);
      else if (m[4]) {
        const kind = o.refs ? (o.refs.get(o.refKey(t[1] === '"' ? t.slice(2, -1) : t.slice(1))) || 'pending') : '';
        const title = { file: 'File', dir: 'Folder', missing: 'Not found' }[kind];
        out += `<span class="md-ref ${kind}"${title ? ` title="${title}"` : ''}>${esc(t)}</span>`;
      } else if (m[5]) {
        const i = t.indexOf('](');
        out += `${mk('[')}<span class="md-link">${esc(t.slice(1, i))}</span>${mk(t.slice(i))}`;
      } else out += `<span class="md-i">${mk(t[0])}${esc(t.slice(1, -1))}${mk(t[0])}</span>`;
    }
    return out + esc(s.slice(last));
  }

  // Markdown to highlighted HTML that keeps every character, so it lines up with the text.
  function highlight(text, o = {}) {
    let fence = false;
    return String(text || '').split('\n').map(line => {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return `<span class="md-fence">${esc(line)}</span>`; }
      if (fence) return `<span class="md-cb">${esc(line)}</span>`;
      let m = line.match(/^(#{1,6} )(.*)$/);
      if (m) return `<span class="md-h">${mk(m[1])}${inline(m[2], o)}</span>`;
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return mk(line);
      m = line.match(/^(\s*>\s?)(.*)$/);
      if (m) return `<span class="md-q">${mk(m[1])}${inline(m[2], o)}</span>`;
      m = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s)?(.*)$/);
      if (m) {
        const done = m[4] && /x/i.test(m[4]);
        return `${m[1]}<span class="md-li">${esc(m[2])}</span>${m[3]}${m[4] ? `<span class="md-box">${esc(m[4])}</span>` : ''}${done ? `<span class="md-done">${inline(m[5], o)}</span>` : inline(m[5], o)}`;
      }
      return inline(line, o);
    }).join('\n');
  }

  // Starting points for a prompt; ¦ is where the caret (or the selected text) goes.
  const STRUCTURES = [
    { label: 'Task', help: 'Goal, context, constraints, done when', text: '## Goal\n¦\n\n## Context\n- \n\n## Constraints\n- \n\n## Done when\n- [ ] \n' },
    { label: 'Bug', help: 'What happens, what should, how to reproduce', text: '## What happens\n¦\n\n## What should happen\n\n\n## Steps to reproduce\n1. \n\n## Where to look\n- \n' },
    { label: 'Research', help: 'Question, sources, what to report', text: '## Question\n¦\n\n## Sources to check\n- \n\n## Report back\nFindings, open questions and next steps, briefly.\n' },
    { label: 'Review', help: 'What to review and what to look for', text: '## Review\n¦\n\n## Focus on\n- \n\n## Report back\nFindings ranked by severity, each with file:line and a suggested fix.\n' },
  ];

  const svg = body => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const TOOLS = [
    ['heading', 'Heading', '<b>H</b>'],
    ['bold', `Bold (${MOD}B)`, '<b>B</b>'],
    ['italic', `Italic (${MOD}I)`, '<i>I</i>'],
    ['code', `Code (${MOD}E)`, svg('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>')],
    ['|'],
    ['ul', 'Bulleted list', svg('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>')],
    ['ol', 'Numbered list', svg('<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 4.5h1.5V9M4 9h3M4 14.5c0-.8.7-1.5 1.5-1.5s1.5.6 1.5 1.3c0 1.2-3 2-3 3.7h3"/>')],
    ['task', 'Checklist', svg('<rect x="3.5" y="4.5" width="6" height="6" rx="1.2"/><path d="M5 15.5l1.5 1.5 3-3M13 7.5h8M13 16h8"/>')],
    ['quote', 'Quote', svg('<path d="M5 7h5v5c0 3-2 4.5-4 5M14 7h5v5c0 3-2 4.5-4 5"/>')],
    ['|'],
    ['ref', 'Reference a file or folder (type @)', '<b>@</b>'],
    ['structure', 'Insert a structure for the prompt', `${svg('<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M3.5 9h17M9 9v11.5"/>')}<span>Structure</span>`],
  ];

  // ---------- one popup, shared by every editor: @ completion or the structure menu ----------
  const pop = { el: null, ed: null, mode: null, items: [], idx: 0, at: 0, seq: 0, peekSeq: 0, peekTimer: null };

  function popEl() {
    if (pop.el) return pop.el;
    const el = document.createElement('div');
    el.className = 'mde-pop';
    el.hidden = true;
    // Clicks in the popup must not take focus from the textarea.
    el.addEventListener('mousedown', e => e.preventDefault());
    el.addEventListener('click', e => {
      const it = e.target.closest('[data-i]');
      if (it) return choose(Number(it.dataset.i));
      if (e.target.closest('[data-browse]')) { const ed = pop.ed; close(); return ed?.browse(); }
      return undefined;
    });
    el.addEventListener('mousemove', e => {
      const it = e.target.closest('[data-i]');
      if (it && Number(it.dataset.i) !== pop.idx) { pop.idx = Number(it.dataset.i); paintPop(); }
    });
    document.body.appendChild(el);
    pop.el = el;
    return el;
  }

  function close() {
    pop.seq += 1;
    pop.mode = null;
    pop.ed = null;
    if (pop.el) pop.el.hidden = true;
  }

  // Where a character of the textarea is on screen, measured on a hidden copy of it.
  function caretXY(ta, index) {
    const cs = getComputedStyle(ta);
    const div = document.createElement('div');
    for (const p of ['boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']) div.style[p] = cs[p];
    Object.assign(div.style, { position: 'fixed', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', borderStyle: 'solid' });
    div.textContent = ta.value.slice(0, index);
    const span = document.createElement('span');
    span.textContent = '@';
    div.appendChild(span);
    document.body.appendChild(div);
    const r = ta.getBoundingClientRect();
    const out = { x: r.left + span.offsetLeft - ta.scrollLeft, y: r.top + span.offsetTop - ta.scrollTop, h: span.offsetHeight };
    div.remove();
    return out;
  }

  function place(x, top, bottom) {
    const el = pop.el;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
    el.style.top = `${bottom + h + 8 > window.innerHeight && top - h - 4 > 8 ? top - h - 4 : bottom + 4}px`;
  }

  const kb = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  function paintPop() {
    const el = pop.el;
    if (pop.mode === 'structure') {
      el.className = 'mde-pop menu';
      el.innerHTML = pop.items.map((s, i) => `<div class="mde-item ${i === pop.idx ? 'on' : ''}" data-i="${i}"><b>${esc(s.label)}</b><small>${esc(s.help)}</small></div>`).join('');
      return;
    }
    el.className = 'mde-pop refs';
    const cwd = pop.ed?.cwd() || '';
    const list = pop.items.length
      ? pop.items.map((it, i) => `<div class="mde-item ${i === pop.idx ? 'on' : ''}" data-i="${i}">
          <span class="ic ${it.dir ? 'dir' : ''}">${it.dir ? svg('<path d="M3 7.5A2.5 2.5 0 015.5 5H9l2 2.5h7.5A2.5 2.5 0 0121 10v6.5a2.5 2.5 0 01-2.5 2.5h-13A2.5 2.5 0 013 16.5z"/>') : svg('<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>')}</span>
          <span class="nm">${esc(it.name)}${it.dir ? '/' : ''}</span><span class="pt">\u200e${esc(it.parent)}\u200e</span></div>`).join('')
      : `<div class="mde-none">Nothing matches in ${esc(cwd.replace(/^\/(Users|home)\/[^/]+/, '~') || 'this folder')}</div>`;
    const peek = pop.items.length ? '<div class="mde-peek" id="mde-peek"><div class="pk-head">…</div></div>' : '';
    el.innerHTML = `<div class="mde-cols"><div class="mde-list">${list}</div>${peek}</div>
      <div class="mde-foot"><span>↑↓ choose · ↩ or Tab insert · a folder opens it</span><button type="button" class="link-btn" data-browse>Browse…</button></div>`;
    el.querySelector('.mde-item.on')?.scrollIntoView({ block: 'nearest' });
    schedulePeek();
  }

  function schedulePeek() {
    clearTimeout(pop.peekTimer);
    const it = pop.items[pop.idx];
    if (!it || !pop.ed) return;
    const seq = ++pop.peekSeq;
    const ed = pop.ed;
    pop.peekTimer = setTimeout(async () => {
      let p;
      try { p = await api.invoke('fs:peek', ed.cwd(), it.path); } catch (_) { return; }
      const box = pop.el.querySelector('#mde-peek');
      if (seq !== pop.peekSeq || !box) return;
      const head = `<div class="pk-head" title="${esc(p.path)}">\u200e${esc(p.path.replace(/^\/(Users|home)\/[^/]+/, '~'))}\u200e</div>`;
      let body;
      if (p.kind === 'dir') body = `<div class="pk-meta">${p.count} item${p.count === 1 ? '' : 's'}</div><pre>${esc(p.entries.join('\n'))}${p.count > p.entries.length ? '\n…' : ''}</pre>`;
      else if (p.kind === 'missing') body = '<div class="pk-meta">Not found</div>';
      else if (p.binary || p.unreadable) body = `<div class="pk-meta">${kb(p.size)} · ${p.binary ? 'binary file' : "can't be read"}</div>`;
      else body = `<div class="pk-meta">${kb(p.size)}</div><pre>${esc(p.text)}${p.more ? '\n…' : ''}</pre>`;
      box.innerHTML = head + body;
    }, 70);
  }

  function choose(i) {
    const ed = pop.ed;
    const it = pop.items[i];
    if (!ed || !it) return close();
    if (pop.mode === 'structure') { close(); return ed.insertStructure(it.text); }
    const ta = ed.ta;
    const ref = refText(it.path);
    const quoted = ref[1] === '"';
    // Typed inside quotes, the closing one right after the caret goes with what's replaced.
    const end = ta.selectionStart + (pop.quoted && ta.value[ta.selectionStart] === '"' ? 1 : 0);
    if (!it.dir) return ed.replace(pop.at, end, `${ref} `, pop.at + ref.length + 1);
    // A folder keeps the popup open on its contents: the caret stays inside the quotes, if any.
    ed.replace(pop.at, end, ref, pop.at + ref.length - (quoted ? 1 : 0));
    return ed.complete();
  }

  function popKey(e) {
    if (!pop.mode || pop.el.hidden || e.isComposing) return false;
    const n = pop.items.length;
    if (e.key === 'ArrowDown' && n) { pop.idx = (pop.idx + 1) % n; paintPop(); }
    else if (e.key === 'ArrowUp' && n) { pop.idx = (pop.idx - 1 + n) % n; paintPop(); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && n && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) choose(pop.idx);
    else if (e.key === 'Escape') { close(); e.stopPropagation(); }
    else return false;
    e.preventDefault();
    return true;
  }

  // Typing on the last line scrolls the page to keep the caret in view: the completion follows
  // the caret instead of closing (it closes once the caret is out of sight). Other lists
  // scrolling, like the sidebar when something updates, don't concern it.
  function placeAtCaret() {
    const xy = caretXY(pop.ed.ta, pop.at);
    if (xy.y + xy.h < 0 || xy.y > window.innerHeight) return close();
    return place(xy.x - 10, xy.y, xy.y + xy.h);
  }
  window.addEventListener('resize', close);
  document.addEventListener('scroll', e => {
    if (!pop.el || pop.el.hidden || !pop.ed || pop.el.contains(e.target)) return;
    if (!e.target.contains?.(pop.ed.wrap)) return;
    if (pop.mode === 'refs') placeAtCaret(); else close();
  }, true);

  // ---------- an editor ----------
  function attach(ta, opts = {}) {
    const o = { blanks: false, cwd: () => '', rows: 4, ...opts };
    const wrap = document.createElement('div');
    wrap.className = 'mde';
    wrap.innerHTML = `<div class="mde-bar">${TOOLS.map(([act, title, html]) => (act === '|' ? '<span class="mde-sep"></span>'
      : `<button type="button" class="mde-tool ${act}" data-tool="${act}" title="${esc(title)}" tabindex="-1">${html}</button>`)).join('')}
      <span class="mde-hint">Markdown · <b>@</b> files</span></div>
      <div class="mde-body"><pre class="mde-hl" aria-hidden="true"></pre></div>`;
    ta.before(wrap);
    wrap.querySelector('.mde-body').appendChild(ta);
    ta.classList.add('mde-input');
    ta.removeAttribute('rows');
    wrap.style.setProperty('--rows', o.rows);
    const hl = wrap.querySelector('.mde-hl');
    const refs = new Map(); // `${cwd}\n${ref}` -> 'file' | 'dir' | 'missing'
    const refKey = r => `${o.cwd()}\n${r}`;
    let refTimer = null;

    const paint = () => { hl.innerHTML = `${highlight(ta.value, { blanks: o.blanks, refs, refKey })} `; };
    const checkRefs = () => {
      clearTimeout(refTimer);
      const unknown = [...new Set([...ta.value.matchAll(REF_RE)].map(m => m[1] ?? m[2]))].filter(r => !refs.has(refKey(r)));
      if (!unknown.length) return;
      const cwd = o.cwd();
      refTimer = setTimeout(async () => {
        let kinds;
        try { kinds = await api.invoke('fs:refs', cwd, unknown); } catch (_) { return; }
        for (const [r, k] of Object.entries(kinds)) refs.set(`${cwd}\n${r}`, k);
        paint();
      }, 250);
    };
    // Edits go through insertText so they land in the textarea's own undo history.
    const replace = (start, end, text, selStart = null, selEnd = null) => {
      ta.focus();
      ta.setSelectionRange(start, end);
      const ok = text ? document.execCommand('insertText', false, text) : (start === end || document.execCommand('delete'));
      if (!ok) {
        ta.setRangeText(text, start, end, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (selStart != null) ta.setSelectionRange(selStart, selEnd ?? selStart);
    };

    const surround = mark => {
      const { selectionStart: s, selectionEnd: e, value: v } = ta;
      const n = mark.length;
      if (v.slice(s - n, s) === mark && v.slice(e, e + n) === mark) return replace(s - n, e + n, v.slice(s, e), s - n, e - n);
      return replace(s, e, mark + v.slice(s, e) + mark, s + n, e + n);
    };

    // Applies fn to each line the selection touches.
    const eachLine = fn => {
      const v = ta.value;
      const s = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      let e = v.indexOf('\n', ta.selectionEnd);
      if (e < 0) e = v.length;
      const lines = v.slice(s, e).split('\n');
      const out = lines.map((l, i) => fn(l, i, lines)).join('\n');
      if (out !== v.slice(s, e)) replace(s, e, out, s + out.length);
    };
    const LIST = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s)?/;
    const TOOL = {
      heading: () => eachLine(l => { const m = l.match(/^(#{1,6}) /); if (!m) return `## ${l}`; return m[1].length >= 3 ? l.slice(m[0].length) : `#${l}`; }),
      bold: () => surround('**'),
      italic: () => surround('*'),
      code: () => (ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n') ? surround('\n```\n') : surround('`')),
      ul: () => eachLine((l, _i, all) => (all.every(x => /^\s*[-*+]\s/.test(x)) ? l.replace(/^(\s*)[-*+]\s+(\[[ xX]\]\s)?/, '$1') : l.replace(LIST, '$1').replace(/^(\s*)/, '$1- '))),
      ol: () => eachLine((l, i, all) => (all.every(x => /^\s*\d+[.)]\s/.test(x)) ? l.replace(LIST, '$1') : l.replace(LIST, '$1').replace(/^(\s*)/, `$1${i + 1}. `))),
      task: () => eachLine((l, _i, all) => (all.every(x => /^\s*[-*+]\s+\[[ xX]\]\s/.test(x)) ? l.replace(LIST, '$1') : l.replace(LIST, '$1').replace(/^(\s*)/, '$1- [ ] '))),
      quote: () => eachLine((l, _i, all) => (all.every(x => /^\s*>/.test(x)) ? l.replace(/^(\s*)>\s?/, '$1') : `> ${l}`)),
      ref: () => {
        const s = ta.selectionStart;
        const lead = s > 0 && !/\s/.test(ta.value[s - 1]) ? ' ' : '';
        replace(s, ta.selectionEnd, `${lead}@`);
      },
      structure: btn => {
        if (pop.mode === 'structure' && pop.ed === ed) return close();
        ta.focus();
        popEl();
        Object.assign(pop, { ed, mode: 'structure', items: STRUCTURES, idx: 0 });
        pop.el.hidden = false;
        paintPop();
        const r = btn.getBoundingClientRect();
        return place(r.left, r.top, r.bottom);
      },
    };

    // An "@" being typed opens completion for what follows it.
    const complete = async () => {
      if (document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd) { if (pop.ed === ed && pop.mode === 'refs') close(); return; }
      const c = ta.selectionStart;
      const m = ta.value.slice(Math.max(0, c - 400), c).match(TYPING_REF);
      if (!m) { if (pop.ed === ed && pop.mode === 'refs') close(); return; }
      const quoted = m[1] !== undefined;
      const query = quoted ? m[1] : m[2];
      const at = c - query.length - (quoted ? 2 : 1);
      const seq = ++pop.seq;
      let items;
      try { items = await api.invoke('fs:complete', o.cwd(), query); } catch (_) { items = []; }
      if (seq !== pop.seq || document.activeElement !== ta) return;
      popEl();
      Object.assign(pop, { ed, mode: 'refs', items, idx: 0, at, quoted });
      pop.el.hidden = false;
      paintPop();
      placeAtCaret();
    };

    const insertRefs = async paths => {
      if (!paths?.length) return;
      let shown;
      try { shown = await api.invoke('fs:display', o.cwd(), paths); } catch (_) { shown = paths; }
      const s = ta.selectionStart;
      const lead = s > 0 && !/\s/.test(ta.value[s - 1]) ? ' ' : '';
      replace(s, ta.selectionEnd, `${lead}${shown.map(refText).join(' ')} `);
    };

    const ed = {
      ta, wrap, cwd: () => o.cwd(), replace, complete,
      browse: async () => insertRefs(await api.invoke('dialog:pickFiles', o.cwd())),
      insertStructure: text => {
        const { selectionStart: s, selectionEnd: e, value: v } = ta;
        const sel = v.slice(s, e);
        const before = v.slice(0, s);
        const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
        const caret = text.indexOf('¦');
        const body = text.replace('¦', sel);
        replace(s, e, lead + body, s + lead.length + caret + sel.length);
      },
      // After a programmatic value change, or when the folder changed (references re-check).
      refresh: () => { paint(); checkRefs(); },
    };

    wrap.querySelector('.mde-bar').addEventListener('mousedown', e => { if (e.target.closest('[data-tool]')) e.preventDefault(); });
    wrap.querySelector('.mde-bar').addEventListener('click', e => {
      const b = e.target.closest('[data-tool]');
      if (b) TOOL[b.dataset.tool](b);
    });
    ta.addEventListener('input', () => { paint(); checkRefs(); complete(); });
    // The textarea is as tall as its text, so it never scrolls on its own.
    ta.addEventListener('scroll', () => { if (ta.scrollTop) ta.scrollTop = 0; });
    ta.addEventListener('click', complete);
    ta.addEventListener('keyup', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) complete(); });
    ta.addEventListener('blur', () => { if (pop.ed === ed) close(); });
    ta.addEventListener('keydown', e => {
      // While an input method composes, Enter and Tab confirm its text; they aren't ours.
      if (e.isComposing || e.keyCode === 229) return;
      if (pop.ed === ed && popKey(e)) return;
      if (modKey(e) && ['b', 'i', 'e'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        TOOL[{ b: 'bold', i: 'italic', e: 'code' }[e.key.toLowerCase()]]();
        return;
      }
      const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
      const v = ta.value;
      const c = ta.selectionStart;
      const ls = v.lastIndexOf('\n', c - 1) + 1;
      let le = v.indexOf('\n', c);
      if (le < 0) le = v.length;
      const line = v.slice(ls, le);
      // Enter in a list item starts the next one; on an empty item it ends the list.
      if (e.key === 'Enter' && plain && c === ta.selectionEnd) {
        const m = line.match(/^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s)?/) || line.match(/^(\s*)(>)(\s?)/);
        if (!m || c < ls + m[0].length) return;
        e.preventDefault();
        if (!line.slice(m[0].length).trim()) { replace(ls, le, ''); return; }
        const next = m[2] === '>' ? `${m[1]}> `
          : m[3] ? `${m[1]}${Number(m[3]) + 1}${m[4]}${m[5]}${m[6] ? '[ ] ' : ''}` : `${m[1]}${m[2]}${m[5]}${m[6] ? '[ ] ' : ''}`;
        replace(c, c, `\n${next}`);
        return;
      }
      // Tab and Shift+Tab indent list items; elsewhere Tab moves focus as usual.
      if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey && LIST.test(line)) {
        e.preventDefault();
        if (e.shiftKey) { const cut = (line.match(/^ {1,2}/) || [''])[0].length; if (cut) replace(ls, ls + cut, '', Math.max(ls, c - cut)); } else replace(ls, ls, '  ', c + 2);
      }
    });
    // A link pasted over selected text becomes [text](link).
    ta.addEventListener('paste', e => {
      const t = (e.clipboardData?.getData('text/plain') || '').trim();
      if (ta.selectionStart === ta.selectionEnd || !/^https?:\/\/\S+$/.test(t)) return;
      e.preventDefault();
      replace(ta.selectionStart, ta.selectionEnd, `[${ta.value.slice(ta.selectionStart, ta.selectionEnd)}](${t})`);
    });
    // Files dropped on the editor become @ references (not pasted into a session).
    wrap.addEventListener('dragover', e => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      wrap.classList.add('drop');
    });
    wrap.addEventListener('dragleave', e => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('drop'); });
    wrap.addEventListener('drop', e => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      e.stopPropagation();
      wrap.classList.remove('drop');
      const paths = [...e.dataTransfer.files].map(f => { try { return api.pathForFile(f); } catch (_) { return ''; } }).filter(Boolean);
      ta.focus();
      insertRefs(paths);
    });
    ed.refresh();
    return ed;
  }

  window.MdEditor = { attach, render: text => highlight(text, {}), close };
})();
