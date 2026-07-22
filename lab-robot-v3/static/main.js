/* ============================================================================
 * main.js — wires the EQL (Entity Query Language) panel to the server.
 *
 * The knowledge side is krrood's EQL (part of the CRAM architecture), executed
 * server-side against the recorded demo episode (eql_kb.py): bench objects,
 * robot parts, action episodes and per-joint motion. This file:
 *   - loads the entity graph from  GET /api/kb  and renders it (graph.js)
 *   - sends queries typed (or picked from presets) to  POST /api/eql
 *   - renders the result rows and highlights returned entities in the graph
 * The 3D robot (robot.js) renders alongside, driven by the same recording.
 * ==========================================================================*/
(function () {
  const kbStatus = document.getElementById('kb-status');
  const answerEl = document.getElementById('answer');
  const input = document.getElementById('query-input');
  const runBtn = document.getElementById('query-run');
  const presetsEl = document.getElementById('presets');
  const playBtn = document.getElementById('play-btn');

  let kb = null;              // overview payload from /api/kb (has presets, status)
  let view = null;            // the currently rendered view (overview or a drill-down)
  let viewStack = [];         // parent views for the back button
  let inGraphSet = {};

  // ---- boot -----------------------------------------------------------------
  fetch('/api/kb').then(function (r) { return r.json(); }).then(boot).catch(function (err) {
    kbStatus.textContent = 'KB error';
    answerEl.innerHTML = '<div class="qerr">Failed to reach the EQL server:\n' + esc(String(err)) + '</div>';
  });

  function boot(payload) {
    if (!payload.ok) {
      kbStatus.textContent = 'EQL unavailable';
      answerEl.innerHTML = '<div class="qerr">' + esc(payload.error || 'unknown error') +
        '\n\nStart the server with the cram-env interpreter:\n' +
        '~/.virtualenvs/cram-env/bin/python server.py</div>';
      return;
    }
    kb = payload;
    kb.crumb = 'overview';
    kbStatus.textContent = payload.status;
    kbStatus.classList.add('ready');

    setView(kb);
    Graph.onSelect(describeNode);
    Graph.onDoubleSelect(drill);
    buildPresets(payload.presets || []);
    welcome();

    // clicking the vial/canister or a part of Tracy in the 3D view selects the
    // matching entity here: details in the answer panel + graph highlight
    if (window.RobotView && RobotView.onPartClick) RobotView.onPartClick(function (id) {
      if (!view.details[id] && kb.details[id]) goHome();   // 3D parts live in the overview
      describeNode(id);
    });
  }

  // ---- drill-down navigation (double-click a package / subpackage / class) ---
  const navEl = document.getElementById('graph-nav');
  const navUp = document.getElementById('gnav-up');
  const navHome = document.getElementById('gnav-home');
  const navPath = document.getElementById('gnav-path');

  function setView(payload) {
    view = payload;
    inGraphSet = {};
    payload.nodes.forEach(function (n) { inGraphSet[n.id] = 1; });
    Graph.build({ nodes: payload.nodes, edges: payload.edges, legend: payload.legend });
    updateNav();
  }
  function updateNav() {
    if (!navEl) return;
    const inside = viewStack.length > 0;
    navEl.style.display = inside ? '' : 'none';
    if (inside) {
      const path = viewStack.slice(1).map(function (v) { return v.crumb; }).concat([view.crumb]);
      navPath.textContent = path.join(' / ');
    }
  }
  async function drill(id) {
    if (!view.details[id]) return;
    try {
      const r = await fetch('/api/kb/expand?node=' + encodeURIComponent(id));
      const p = await r.json();
      if (!p.ok) return;                       // node has no inside view
      viewStack.push(view);
      setView(p);
      describeNode(id);
    } catch (err) { /* server unreachable — stay where we are */ }
  }
  function goBack() {
    if (viewStack.length) setView(viewStack.pop());
  }
  function goHome() {
    if (!viewStack.length) return;
    viewStack = [];
    setView(kb);
  }
  if (navUp) navUp.addEventListener('click', goBack);
  if (navHome) navHome.addEventListener('click', goHome);

  function welcome() {
    answerEl.innerHTML =
      '<div class="goal">EQL · knowledge &amp; reasoning</div>' +
      '<p class="headline"><b>Correctness, concepts and specifications</b> are captured as ' +
      '<b>rules</b> and <b>description-logic axioms / predicates</b>, and made explorable as a ' +
      '<b>graph</b> — queried with <b>EQL</b>, krrood’s pythonic entity query language from the ' +
      'CRAM architecture.</p>' +
      '<p class="hint-txt">Ready-made variables: <code>obj</code> (bench objects), <code>ep</code> ' +
      '(action episodes), <code>arm</code>, <code>j</code> (joint motion), <code>rob</code>, ' +
      '<code>pkg</code> / <code>sub</code> / <code>cls</code> (CRAM packages, subpackages, classes). ' +
      'Build queries like <code>an(entity(obj).where(obj.kind == \'bottle\'))</code> — ' +
      'or click a preset below, or a node in the graph.</p>';
  }

  // ---- node click: describe the entity ---------------------------------------
  function describeNode(id) {
    const d = view && view.details && view.details[id];
    if (!d) return;
    let html = '<div class="goal">entity · ' + esc(id) + '</div>';
    html += '<div class="ansrow"><span class="tag" style="background:' + groupColor(d.group) + '">' +
      esc(d.group) + '</span><div class="body"><span class="name">' + esc(d.label) + '</span></div></div>';
    (d.lines || []).forEach(function (l) {
      html += '<div class="ansrow"><div class="body"><span class="name">' + esc(l) + '</span></div></div>';
    });
    // relations from the graph
    const rel = (view.edges || []).filter(function (e) { return e.from === id || e.to === id; });
    if (rel.length) {
      html += subhead('Relations');
      rel.slice(0, 40).forEach(function (e) {
        html += relRow(labelOf(e.from), e.label || e.kind, labelOf(e.to));
      });
      if (rel.length > 40) html += '<div class="ansrow"><div class="body"><span class="sub">… ' + (rel.length - 40) + ' more</span></div></div>';
    }
    answerEl.innerHTML = html;
    Graph.highlight([id].concat(rel.map(function (e) { return e.from === id ? e.to : e.from; })));
    // and the reverse direction: glow the matching bench object in the 3D view
    if (window.RobotView && RobotView.highlightObjects) RobotView.highlightObjects([id]);
  }
  function labelOf(id) { return (view.details[id] && view.details[id].label) || id; }

  // ---- presets ----------------------------------------------------------------
  function buildPresets(presets) {
    presetsEl.innerHTML = '';
    presets.forEach(function (p) {
      const b = document.createElement('div');
      b.className = 'preset'; b.textContent = p.text;
      b.title = p.code;
      b.addEventListener('click', function () {
        input.value = p.code;
        runQuery(p.code);
      });
      presetsEl.appendChild(b);
    });
  }

  // ---- run an EQL query --------------------------------------------------------
  let running = false;
  async function runQuery(code) {
    code = (code || '').trim(); if (!code || running) return;
    running = true;
    runBtn.textContent = '…';
    try {
      const r = await fetch('/api/eql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code }),
      });
      render(code, await r.json());
    } catch (err) {
      render(code, { ok: false, error: String(err) });
    }
    running = false;
    runBtn.textContent = 'Run';
  }

  function render(code, res) {
    let html = '<div class="goal">&gt;&gt;&gt; ' + esc(code) + '</div>';
    if (!res.ok) {
      answerEl.innerHTML = html + '<div class="qerr">' + esc(res.error || 'query failed') + '</div>';
      Graph.reset();
      return;
    }
    if (!res.count) {
      answerEl.innerHTML = html + '<div class="nores">No solutions — the query returned nothing.</div>';
      Graph.reset();
      return;
    }
    html += '<p class="headline"><b>' + res.count + '</b> result' + (res.count === 1 ? '' : 's') +
      (res.more ? ' (truncated)' : '') + '.</p>';
    res.rows.forEach(function (row) {
      if (row.__entity__ !== undefined) html += entityRow(row);
      else html += valueRow(row);
    });
    answerEl.innerHTML = html;

    const hi = (res.highlight || []).filter(function (id) { return inGraphSet[id]; });
    if (hi.length) Graph.highlight(hi); else Graph.reset();
  }

  function entityRow(row) {
    const g = groupOfType(row.__type__);
    let sub = [];
    for (const k in row) {
      if (k.indexOf('__') === 0 || row[k] === null || row[k] === undefined) continue;
      sub.push(k + ': ' + row[k]);
    }
    return '<div class="ansrow"><span class="tag" style="background:' + groupColor(g) + '">' +
      esc(row.__type__) + '</span><div class="body"><span class="name">' + esc(row.__entity__) +
      '</span><span class="sub">' + esc(sub.join('  ·  ')) + '</span></div></div>';
  }
  function valueRow(row) {
    const parts = Object.keys(row).map(function (k) {
      return '<code>' + esc(k) + ' = ' + esc(String(row[k])) + '</code>';
    }).join(' ');
    return '<div class="ansrow"><div class="body">' + parts + '</div></div>';
  }

  runBtn.addEventListener('click', function () { runQuery(input.value); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runQuery(input.value); }
  });

  // ---- rendering helpers ------------------------------------------------------
  function subhead(t) { return '<div class="ansub">' + esc(t) + '</div>'; }
  function relRow(s, p, o) {
    return '<div class="ansrow"><div class="body"><span class="name">' + esc(s) +
      ' <span class="rel">' + esc(p) + '</span> ' + esc(o) + '</span></div></div>';
  }
  const TYPE_GROUP = {
    BenchObject: 'object', ActionEpisode: 'event', Arm: 'robot', Gripper: 'robot',
    Robot: 'robot', JointMotion: 'robot', Position: 'concept',
    Package: 'concept', SubPackage: 'klass', PythonClass: 'klass',
  };
  function groupOfType(t) { return TYPE_GROUP[t] || 'ind'; }
  const GROUP_COLOR = {
    root: '#e8eefb', klass: '#5b8cff', upper: '#8c9bbd',
    robot: '#ff7a9c', object: '#39d5c8', event: '#b98cff', goal: '#ffb648', concept: '#4bd38a', ind: '#7f8db0',
  };
  function groupColor(g) { return GROUP_COLOR[g] || '#5b8cff'; }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  // ---- robot: trajectory playback (unchanged from the Prolog version) --------
  function trajRunning() { return window.RobotView && RobotView.isPlayingTrajectory && RobotView.isPlayingTrajectory(); }
  if (playBtn) {
    playBtn.addEventListener('click', function () {
      if (!window.RobotView || !RobotView.hasTrajectory || !RobotView.hasTrajectory()) return;
      if (trajRunning()) { RobotView.stopTrajectory(); playBtn.classList.remove('playing'); playBtn.textContent = '▶ Play robot motion'; }
      else { RobotView.playTrajectory(); playBtn.classList.add('playing'); playBtn.textContent = '⏸ Stop'; }
    });
    if (window.RobotView && RobotView.onStepStart) RobotView.onStepStart(function (step) {
      if (step === '__done__') { playBtn.classList.remove('playing'); playBtn.textContent = '▶ Play robot motion'; }
    });
  }

  // ---- vial position panel: sliders/numbers synced with dragging in 3D ------
  (function () {
    const ctl = document.getElementById('vial-ctl');
    if (!ctl || !window.RobotView || !RobotView.onVialReady) return;
    const sx = document.getElementById('vial-x'), nx = document.getElementById('vial-x-num');
    const sy = document.getElementById('vial-y'), ny = document.getElementById('vial-y-num');
    const sz = document.getElementById('vial-z'), nz = document.getElementById('vial-z-num');
    const reset = document.getElementById('vial-reset');

    function sync(pos) {
      if (!pos) return;
      sx.value = nx.value = pos.x.toFixed(2);
      sy.value = ny.value = pos.y.toFixed(2);
      sz.value = nz.value = pos.z.toFixed(2);
    }
    function apply() {
      const x = parseFloat(nx.value !== '' ? nx.value : sx.value);
      const y = parseFloat(ny.value !== '' ? ny.value : sy.value);
      const z = parseFloat(nz.value !== '' ? nz.value : sz.value);
      if (isFinite(x) && isFinite(y) && isFinite(z)) sync(RobotView.setVialPos(x, y, z));
      else sync(RobotView.getVialPos());
    }

    RobotView.onVialReady(function () {
      const b = RobotView.getVialBounds();
      [sx, nx].forEach(function (i) { i.min = b.minX; i.max = b.maxX; i.step = 0.01; });
      [sy, ny].forEach(function (i) { i.min = b.minY; i.max = b.maxY; i.step = 0.01; });
      [sz, nz].forEach(function (i) { i.min = b.minZ; i.max = b.maxZ; i.step = 0.01; });
      sync(RobotView.getVialPos());
      ctl.style.display = '';
    });
    RobotView.onVialMoved(sync);

    [sx, sy, sz].forEach(function (s, i) {
      s.addEventListener('input', function () {
        [nx, ny, nz][i].value = s.value;
        apply();
      });
    });
    [nx, ny, nz].forEach(function (n) { n.addEventListener('change', apply); });
    reset.addEventListener('click', function () { sync(RobotView.resetVial()); });
  })();

  // ---- view toggle 3D / photo ----------------------------------------------
  function showView(v) {
    const is3d = v === '3d';
    const set = function (id, on) { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
    set('viewer', is3d); set('stage-bg', is3d); set('layers-panel', is3d);
    const ph = document.getElementById('photo');
    if (ph) { ph.style.display = is3d ? 'none' : 'block'; ph.classList.remove('hidden'); }
    document.querySelectorAll('.view-toggle button').forEach(function (x) { x.classList.toggle('active', x.dataset.view === v); });
  }
  document.querySelectorAll('.view-toggle button').forEach(function (b) {
    b.addEventListener('click', function () { showView(b.dataset.view); });
  });
  showView('3d');

  // ---- floating LAYERS panel ------------------------------------------------
  function bindLayer(id, method) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', function () { if (window.RobotView && RobotView[method]) RobotView[method](el.checked); });
  }
  bindLayer('lyr-objects', 'setPropsVisible');
  bindLayer('lyr-labels', 'setLabelsAlways');
  bindLayer('lyr-floor', 'setFloorVisible');
  bindLayer('lyr-rotate', 'setAutoRotate');
  const leg = document.getElementById('lp-legend');
  if (leg) leg.innerHTML = [['#cf9a3a', 'Media (TSB / FTM)'], ['#9fd3e6', 'Sample / rinse'], ['#cfe6ef', 'Sterility canister']]
    .map(function (r) { return '<div class="li"><span class="dot" style="background:' + r[0] + '"></span>' + r[1] + '</div>'; }).join('');
})();
