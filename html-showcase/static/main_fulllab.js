/* ============================================================================
 * main_fulllab.js — "Pharma-Lab Automation" tycoon.
 * Events pop up at lab stations with a countdown. Click one → the HSR drives
 * there and resolves it (and the safety policies / CRAM actions it obeys light
 * up in the knowledge graph). Ignore it too long → compliance drops.
 * ==========================================================================*/
(function () {
  const answerEl = document.getElementById('answer');
  const eventsEl = document.getElementById('events');
  const captionEl = document.getElementById('step-caption');
  const gameBtn = document.getElementById('game-btn');
  const legendEl = document.getElementById('game-legend');
  const kbStatus = document.getElementById('kb-status');
  const complianceBar = document.getElementById('compliance-bar');
  const scoreEl = document.getElementById('hud-score');
  const missedEl = document.getElementById('hud-missed');

  const EV = window.STATION_EVENTS || {};
  const GROUP_LABEL = { task: 'Transport', action: 'CRAM action', policy: 'Safety policy',
    object: 'Object', station: 'Station', robot: 'Robot', base: 'Robot', arm: 'Robot', gripper: 'Robot', sensor: 'Sensor' };
  const GROUP_COLOR = { task: '#e8eefb', action: '#b98cff', policy: '#ffb648',
    object: '#5b8cff', station: '#4bd38a', robot: '#ff7a9c' };

  // ---- Prolog + knowledge graph (shared derivation) -------------------------
  const session = pl.create(50000);
  const meta = {};
  function askAll(goal) {
    return new Promise(function (resolve) {
      const rows = [];
      session.query(goal, { success: function () {
        const step = function () { session.answer({
          success: function (a) { const r = {}; for (const k in a.links) r[k] = a.links[k].toString(); rows.push(r); step(); },
          fail: function () { resolve(rows); }, error: function () { resolve(rows); }, limit: function () { resolve(rows); } }); };
        step();
      }, error: function () { resolve([]); } });
    });
  }
  const strip = function (s) { return String(s).replace(/^'/, '').replace(/'$/, ''); };
  const uniq = function (a) { const s = {}, o = []; a.forEach(function (x) { if (!s[x]) { s[x] = 1; o.push(x); } }); return o; };

  session.consult(KB_SOURCE, {
    success: function () { kbStatus.textContent = 'Prolog ready · lab knowledge loaded'; kbStatus.classList.add('ready'); bootGraph(); },
    error: function (e) { kbStatus.textContent = 'KB error'; },
  });

  async function bootGraph() {
    const kinds = await askAll('kind(X, K).');
    const labels = await askAll('label(X, L).'), scopes = await askAll('scope(X, S).'), auths = await askAll('authority(X, A).');
    const lm = {}, sm = {}, am = {};
    labels.forEach(function (r) { lm[r.X] = strip(r.L); });
    scopes.forEach(function (r) { sm[r.X] = strip(r.S); });
    auths.forEach(function (r) { am[r.X] = strip(r.A); });
    kinds.forEach(function (r) { if (!meta[r.X]) meta[r.X] = { id: r.X, group: r.K, label: lm[r.X] || r.X, scope: sm[r.X], authority: am[r.X] }; });
    const E = [];
    (await askAll('has_part(hsr, P).')).forEach(function (r) { E.push({ from: 'hsr', to: r.P, kind: 'has_part' }); });
    (await askAll('from(T, S).')).forEach(function (r) { E.push({ from: r.T, to: r.S, kind: 'route' }); });
    (await askAll('to(T, S).')).forEach(function (r) { E.push({ from: r.T, to: r.S, kind: 'route' }); });
    (await askAll('carries(T, O).')).forEach(function (r) { E.push({ from: r.T, to: r.O, kind: 'step_uses' }); });
    (await askAll('task_action(T, A).')).forEach(function (r) { E.push({ from: r.T, to: r.A, kind: 'step_action' }); });
    (await askAll('requires(T, P).')).forEach(function (r) { E.push({ from: r.T, to: r.P, kind: 'requires' }); });
    const nodes = Object.keys(meta).map(function (id) { return { id: id, label: meta[id].label, group: meta[id].group }; });
    Graph.build({ nodes: nodes, edges: E });
  }

  // ---- game state -----------------------------------------------------------
  let running = false, compliance = 100, score = 0, missed = 0;
  const active = {};          // stationId -> { el, ring, task, obj, title, born, deadline, state }
  const queue = [];           // stationIds the operator clicked, waiting for the robot
  let spawnTimer = null;
  const EVENT_MS = 11000;     // time to react before it fails
  const MAX_ACTIVE = 4;

  function setCompliance(v) {
    compliance = Math.max(0, Math.min(100, v));
    complianceBar.style.width = compliance + '%';
    complianceBar.style.background = compliance > 60 ? 'linear-gradient(90deg,#39d5c8,#4bd38a)'
      : compliance > 30 ? 'linear-gradient(90deg,#ffb648,#ff9d3a)' : 'linear-gradient(90deg,#ff6b8b,#ff3b5c)';
  }

  function startGame() {
    running = true; compliance = 100; score = 0; missed = 0;
    setCompliance(100); scoreEl.textContent = '0'; missedEl.textContent = '0';
    Object.keys(active).forEach(removeEvent);
    queue.length = 0;
    gameBtn.textContent = '⏸ End shift'; gameBtn.classList.add('playing');
    scheduleSpawn(1200);
  }
  function stopGame() {
    running = false;
    if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null; }
    Object.keys(active).forEach(removeEvent);
    gameBtn.textContent = '▶ Start shift'; gameBtn.classList.remove('playing');
  }

  function scheduleSpawn(ms) {
    if (!running) return;
    spawnTimer = setTimeout(function () {
      spawnEvent();
      // gentle ramp: faster as the score climbs
      const base = Math.max(1800, 3800 - score * 120);
      scheduleSpawn(base + Math.floor(seededRand() * 1500));
    }, ms);
  }

  // deterministic-ish randomness (Math.random is fine in the browser)
  function seededRand() { return Math.random(); }

  function spawnEvent() {
    const free = Object.keys(EV).filter(function (s) { return !active[s]; });
    if (!free.length || Object.keys(active).length >= MAX_ACTIVE) return;
    const station = free[Math.floor(seededRand() * free.length)];
    const cfg = EV[station];
    const el = document.createElement('div');
    el.className = 'ev';
    el.innerHTML = '<div class="ev-ring"></div><div class="ev-icon">' + cfg.icon + '</div>';
    el.title = cfg.title;
    el.addEventListener('click', function () { onClickEvent(station); });
    eventsEl.appendChild(el);
    active[station] = { el: el, ring: el.querySelector('.ev-ring'), task: cfg.task, obj: cfg.obj,
      title: cfg.title, fail: cfg.fail, born: performance.now(), deadline: performance.now() + EVENT_MS, state: 'waiting' };
  }

  function removeEvent(station) {
    const ev = active[station]; if (!ev) return;
    if (ev.el && ev.el.parentNode) ev.el.parentNode.removeChild(ev.el);
    delete active[station];
    const qi = queue.indexOf(station); if (qi >= 0) queue.splice(qi, 1);
  }

  function onClickEvent(station) {
    const ev = active[station]; if (!ev || ev.state !== 'waiting') return;
    ev.state = 'queued'; ev.el.classList.add('queued');
    if (queue.indexOf(station) < 0) queue.push(station);
    dispatch();
  }

  function dispatch() {
    if (!window.RobotView || RobotView.isBusy() || !queue.length) return;
    const station = queue.shift();
    const ev = active[station]; if (!ev) { dispatch(); return; }
    ev.state = 'serving'; ev.el.classList.remove('queued'); ev.el.classList.add('serving');
    RobotView.serve(station, ev.obj, function () {
      resolveEvent(station);
      dispatch();   // next queued event
    });
  }

  function resolveEvent(station) {
    const ev = active[station]; if (!ev) return;
    score += 1; scoreEl.textContent = String(score);
    setCompliance(compliance + 2);
    showPanel(ev, 'resolved');
    removeEvent(station);
  }

  function failEvent(station) {
    const ev = active[station]; if (!ev) return;
    missed += 1; missedEl.textContent = String(missed);
    setCompliance(compliance - 14);
    flashFail();
    showPanel(ev, 'missed');
    removeEvent(station);
    if (compliance <= 0) gameOver();
  }

  function gameOver() {
    stopGame();
    captionEl.innerHTML = '<b>Shift over</b> — compliance hit zero. Resolved ' + score + ', missed ' + missed + '. Press “Start shift” to retry.';
    captionEl.classList.remove('hidden');
  }

  function flashFail() {
    document.querySelector('.stage').classList.add('flash-fail');
    setTimeout(function () { document.querySelector('.stage').classList.remove('flash-fail'); }, 350);
  }

  // ---- per-frame: position bubbles + run countdowns -------------------------
  function frame() {
    requestAnimationFrame(frame);
    if (!window.RobotView || !RobotView.projectToScreen) return;
    const now = performance.now();
    for (const station in active) {
      const ev = active[station];
      const p = RobotView.projectToScreen(station);
      if (p && p.visible) { ev.el.style.display = ''; ev.el.style.left = p.x + 'px'; ev.el.style.top = p.y + 'px'; }
      else { ev.el.style.display = 'none'; }
      if (ev.state === 'waiting' || ev.state === 'queued') {
        const frac = Math.max(0, (ev.deadline - now) / EVENT_MS);
        const deg = frac * 360;
        const col = frac > 0.5 ? '#39d5c8' : frac > 0.25 ? '#ffb648' : '#ff6b8b';
        ev.ring.style.background = 'conic-gradient(' + col + ' ' + deg + 'deg, rgba(255,255,255,.12) 0)';
        if (now >= ev.deadline) failEvent(station);
      }
    }
    // keep trying to dispatch queued work as the robot frees up
    if (queue.length) dispatch();
  }
  frame();

  // ---- panel: show the policies / actions the robot obeyed ------------------
  async function showPanel(ev, status) {
    const pol = uniq((await askAll('relevant_policy(' + ev.task + ', P).')).map(function (r) { return r.P; }));
    const act = uniq((await askAll('uses_action(' + ev.task + ', A).')).map(function (r) { return r.A; }));
    const from = (await askAll('from(' + ev.task + ', S).')).map(function (r) { return r.S; })[0];
    const to = (await askAll('to(' + ev.task + ', S).')).map(function (r) { return r.S; })[0];
    const obj = (await askAll('carries(' + ev.task + ', O).')).map(function (r) { return r.O; })[0];

    const ok = status === 'resolved';
    let html = '<div class="ev-head ' + (ok ? 'ok' : 'bad') + '">' + (ok ? '✓ Resolved' : '✕ Missed') + ' — ' + ev.title + '</div>';
    if (!ok) html += '<p class="headline" style="color:#ff9db1">Consequence: ' + ev.fail + '</p>';
    else html += '<p class="headline">The robot handled it while satisfying <b>' + pol.length + '</b> safety policies.</p>';
    html += section('Safety policies enforced', pol);
    html += section('CRAM action designators used', act, { OBJ: obj ? obj.replace(/_/g, '-') : null, TGT: to ? to.replace(/_/g, '-') : null, SRC: from ? from.replace(/_/g, '-') : null, ARM: ':left' });
    answerEl.innerHTML = html;
    Graph.highlight([ev.task, from, to, obj].concat(pol, act).filter(Boolean));
  }

  function section(title, ids, ctx) {
    if (!ids.length) return '';
    let h = '<div style="font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:#8b93a3;margin:12px 0 6px">' + title + '</div>';
    ids.forEach(function (id) { h += renderRow(id, ctx); });
    return h;
  }
  function renderRow(id, ctx) {
    const m = meta[id] || { label: id, group: 'object' };
    const color = GROUP_COLOR[m.group] || '#5b8cff';
    let sub = m.scope ? m.scope + (m.authority ? '  ·  ' + m.authority : '') : '';
    let row = '<div class="ansrow"><span class="tag" style="background:' + color + '">' + (GROUP_LABEL[m.group] || m.group) +
      '</span><div class="body"><span class="name">' + m.label + '</span>' + (sub ? '<span class="sub">' + sub + '</span>' : '') + '</div></div>';
    if (m.group === 'action' && window.Designators && window.ACTION_DESIGNATORS && window.ACTION_DESIGNATORS[id]) {
      row += '<div class="designator"><pre>' + Designators.html(window.ACTION_DESIGNATORS[id], ctx || {}) + '</pre></div>';
    }
    return row;
  }

  // ---- legend of possible events -------------------------------------------
  function buildLegend() {
    legendEl.innerHTML = Object.keys(EV).map(function (s) {
      return '<span class="gl-item"><span class="gl-ic">' + EV[s].icon + '</span>' + EV[s].title + '</span>';
    }).join('');
  }
  buildLegend();

  // ---- graph node click → show that node's relations ------------------------
  function describeNode(id) {
    const m = meta[id]; if (!m) return;
    Graph.highlight([id]);
    if (m.group === 'station' && window.RobotView) RobotView.highlightStations([id]);
  }

  // ---- free-text query ------------------------------------------------------
  const input = document.getElementById('query-input'), runBtn = document.getElementById('query-run');
  async function runGoal(goal) {
    goal = (goal || '').trim(); if (!goal) return; if (!/\.\s*$/.test(goal)) goal += '.';
    const res = await askAll(goal);
    if (!res.length) { answerEl.innerHTML = '<div class="goal">?- ' + esc(goal) + '</div><div class="nores">No solutions.</div>'; return; }
    const vars = Object.keys(res[0]); const vals = uniq(res.map(function (r) { return r[vars[0]]; }));
    let html = '<div class="goal">?- ' + esc(goal) + '</div>';
    vals.forEach(function (v) { html += renderRow(v); });
    answerEl.innerHTML = html;
    Graph.highlight(vals.filter(function (v) { return meta[v]; }));
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  if (runBtn) runBtn.addEventListener('click', function () { runGoal(input.value); });
  if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') runGoal(input.value); });

  // presets
  const presetsEl = document.getElementById('presets');
  if (presetsEl && window.KB_PRESETS) KB_PRESETS.forEach(function (p) {
    const b = document.createElement('div'); b.className = 'preset'; b.textContent = p.text;
    b.addEventListener('click', function () { input.value = p.goal; runGoal(p.goal); });
    presetsEl.appendChild(b);
  });

  // ---- wire up --------------------------------------------------------------
  if (window.Graph) Graph.onSelect(describeNode);
  gameBtn.addEventListener('click', function () { if (running) stopGame(); else startGame(); });
})();
