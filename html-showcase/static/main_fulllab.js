/* ============================================================================
 * main_fulllab.js — boots the mobile-lab Prolog KB, derives the graph, and
 * wires the transport tasks to the HSR navigation scene.
 * ==========================================================================*/
(function () {
  const kbStatus = document.getElementById('kb-status');
  const answerEl = document.getElementById('answer');
  const input = document.getElementById('query-input');
  const runBtn = document.getElementById('query-run');
  const presetsEl = document.getElementById('presets');
  const stripEl = document.getElementById('workflow-strip');
  const captionEl = document.getElementById('step-caption');
  const playBtn = document.getElementById('play-btn');

  const GROUP_LABEL = { task: 'Transport', action: 'CRAM action', policy: 'Safety policy',
    object: 'Object', station: 'Station', robot: 'Robot', base: 'Robot', arm: 'Robot', gripper: 'Robot', sensor: 'Sensor' };
  const GROUP_COLOR = { task: '#e8eefb', action: '#b98cff', policy: '#ffb648',
    object: '#5b8cff', station: '#4bd38a', robot: '#ff7a9c', base: '#ff7a9c', arm: '#ff7a9c', gripper: '#ff7a9c', sensor: '#ff7a9c' };

  const session = pl.create(50000);
  const meta = {};

  function askAll(goal) {
    return new Promise(function (resolve) {
      const rows = [];
      session.query(goal, {
        success: function () {
          const step = function () {
            session.answer({
              success: function (ans) { const r = {}; for (const k in ans.links) r[k] = ans.links[k].toString(); rows.push(r); step(); },
              fail: function () { resolve(rows); },
              error: function (e) { resolve({ error: pl.format_answer(e) }); },
              limit: function () { resolve(rows); },
            });
          };
          step();
        },
        error: function (e) { resolve({ error: pl.format_answer(e) }); },
      });
    });
  }

  session.consult(KB_SOURCE, {
    success: function () { kbStatus.textContent = 'Prolog ready · lab knowledge loaded'; kbStatus.classList.add('ready'); boot(); },
    error: function (e) { kbStatus.textContent = 'KB error'; answerEl.innerHTML = '<div class="qerr">' + pl.format_answer(e) + '</div>'; },
  });

  async function boot() {
    const kinds = await askAll('kind(X, K).');
    const labels = await askAll('label(X, L).');
    const descrs = await askAll('descr(X, D).');
    const scopes = await askAll('scope(X, S).');
    const auths = await askAll('authority(X, A).');
    const mods = await askAll('module(X, M).');
    const lm = {}, dm = {}, sm = {}, am = {}, mm = {};
    labels.forEach(function (r) { lm[r.X] = strip(r.L); });
    descrs.forEach(function (r) { dm[r.X] = strip(r.D); });
    scopes.forEach(function (r) { sm[r.X] = strip(r.S); });
    auths.forEach(function (r) { am[r.X] = strip(r.A); });
    mods.forEach(function (r) { mm[r.X] = strip(r.M); });
    kinds.forEach(function (r) {
      if (meta[r.X]) return;
      meta[r.X] = { id: r.X, group: r.K, label: lm[r.X] || r.X, descr: dm[r.X], scope: sm[r.X], authority: am[r.X], module: mm[r.X] };
    });

    const E = [];
    (await askAll('has_part(hsr, P).')).forEach(function (r) { E.push({ from: 'hsr', to: r.P, kind: 'has_part' }); });
    (await askAll('from(T, S).')).forEach(function (r) { E.push({ from: r.T, to: r.S, kind: 'route' }); });
    (await askAll('to(T, S).')).forEach(function (r) { E.push({ from: r.T, to: r.S, kind: 'route' }); });
    (await askAll('carries(T, O).')).forEach(function (r) { E.push({ from: r.T, to: r.O, kind: 'step_uses' }); });
    (await askAll('task_action(T, A).')).forEach(function (r) { E.push({ from: r.T, to: r.A, kind: 'step_action' }); });
    (await askAll('requires(T, P).')).forEach(function (r) { E.push({ from: r.T, to: r.P, kind: 'requires' }); });

    const order = (await askAll('torder(T, N).')).map(function (r) { return { s: r.T, n: parseInt(r.N, 10) }; }).sort(function (a, b) { return a.n - b.n; });

    const graphNodes = Object.keys(meta).map(function (id) { return { id: id, label: meta[id].label, group: meta[id].group, title: tooltip(id) }; });
    Graph.build({ nodes: graphNodes, edges: E });
    Graph.onSelect(describeNode);

    buildStrip(order);
    buildPresets();
    if (window.RobotView) RobotView.onCaption(setCaption);
  }

  function strip(s) { return String(s).replace(/^'/, '').replace(/'$/, ''); }
  function tooltip(id) {
    const m = meta[id]; if (!m) return id;
    let t = m.label + '  (' + (GROUP_LABEL[m.group] || m.group) + ')';
    if (m.descr) t += '\n' + m.descr;
    if (m.scope) t += '\n' + m.scope;
    if (m.authority) t += '\nAuthority: ' + m.authority;
    if (m.module) t += '\n' + m.module;
    return t;
  }

  // ---- captions from the robot ----------------------------------------------
  function setCaption(phase, stationId, objId) {
    const st = meta[stationId] ? meta[stationId].label : stationId;
    const ob = meta[objId] ? meta[objId].label : objId;
    const txt = phase === 'pick' ? 'Picking up <b>' + ob + '</b> at ' + st + '.'
                                 : 'Delivering <b>' + ob + '</b> to <b>' + st + '</b>.';
    captionEl.innerHTML = txt; captionEl.classList.remove('hidden');
  }

  // ---- workflow strip = transport tasks -------------------------------------
  let activeTask = null, taskIds = [];
  function buildStrip(order) {
    taskIds = order.map(function (o) { return o.s; });
    stripEl.innerHTML = '';
    order.forEach(function (o) {
      const chip = document.createElement('div');
      chip.className = 'wstep'; chip.dataset.step = o.s;
      chip.innerHTML = '<span class="num">' + o.n + '</span><span class="txt">' + meta[o.s].label + '</span>';
      chip.addEventListener('click', function () { setActiveTask(o.s); });
      stripEl.appendChild(chip);
    });
  }

  async function ctxForTask(id) {
    const obj = (await askAll('carries(' + id + ', O).')).map(function (r) { return r.O; })[0];
    const to = (await askAll('to(' + id + ', S).')).map(function (r) { return r.S; })[0];
    const from = (await askAll('from(' + id + ', S).')).map(function (r) { return r.S; })[0];
    return {
      OBJ: obj ? obj.replace(/_/g, '-') : null,
      TGT: to ? to.replace(/_/g, '-') : null,
      SRC: from ? from.replace(/_/g, '-') : null,
      ARM: ':left',
    };
  }

  async function setActiveTask(id) {
    activeTask = id;
    document.querySelectorAll('.wstep').forEach(function (c) { c.classList.toggle('active', c.dataset.step === id); });
    highlightChips([]);

    const from = (await askAll('from(' + id + ', S).')).map(function (r) { return r.S; })[0];
    const to = (await askAll('to(' + id + ', S).')).map(function (r) { return r.S; })[0];
    const obj = (await askAll('carries(' + id + ', O).')).map(function (r) { return r.O; })[0];
    if (window.RobotView && from && to) RobotView.runTask(from, to, obj);

    const pol = uniq((await askAll('relevant_policy(' + id + ', P).')).map(function (r) { return r.P; }));
    const act = uniq((await askAll('uses_action(' + id + ', A).')).map(function (r) { return r.A; }));
    const ctx = await ctxForTask(id);
    const m = meta[id];

    let html = '<div class="goal">?- task = ' + id + '</div>';
    html += '<p class="headline"><b>' + m.label + '</b> — route <b>' + (meta[from] ? meta[from].label : from) +
      '</b> → <b>' + (meta[to] ? meta[to].label : to) + '</b>, carrying ' + (meta[obj] ? meta[obj].label : obj) +
      '. It must satisfy <b>' + pol.length + '</b> safety policies.</p>';
    html += section('Safety policies that govern this run', pol);
    html += section('CRAM action designators', act, ctx);
    answerEl.innerHTML = html;

    Graph.highlight([id, from, to, obj].concat(pol, act).filter(Boolean));
  }

  function highlightChips(ids) {
    const set = {}; (ids || []).forEach(function (i) { set[i] = 1; });
    document.querySelectorAll('.wstep').forEach(function (c) { c.classList.toggle('related', !!set[c.dataset.step]); });
  }

  // ---- shared row / section renderers ---------------------------------------
  function section(title, ids, ctx) {
    if (!ids.length) return '';
    let h = '<div style="font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:#93a4c4;margin:12px 0 6px">' + title + '</div>';
    ids.forEach(function (id) { h += renderRow(id, ctx); });
    return h;
  }
  function renderRow(id, ctx) {
    const m = meta[id] || { label: id, group: 'object' };
    const color = GROUP_COLOR[m.group] || '#5b8cff';
    let sub = '';
    if (m.scope) sub = m.scope + (m.authority ? '  ·  ' + m.authority : '');
    else if (m.group !== 'action' && m.descr) sub = m.descr;
    let row = '<div class="ansrow"><span class="tag" style="background:' + color + '">' +
      (GROUP_LABEL[m.group] || m.group) + '</span><div class="body"><span class="name">' + m.label + '</span>' +
      (sub ? '<span class="sub">' + sub + '</span>' : '') + '</div></div>';
    if (m.group === 'action' && window.Designators && window.ACTION_DESIGNATORS && window.ACTION_DESIGNATORS[id]) {
      row += '<div class="designator"><pre>' + Designators.html(window.ACTION_DESIGNATORS[id], ctx || {}) + '</pre></div>';
      if (m.module) row += '<div class="desig-file">' + esc(m.module) + '</div>';
    }
    return row;
  }

  // ---- presets & free queries -----------------------------------------------
  function buildPresets() {
    presetsEl.innerHTML = '';
    KB_PRESETS.forEach(function (p) {
      const b = document.createElement('div'); b.className = 'preset'; b.textContent = p.text;
      b.addEventListener('click', function () { input.value = p.goal; runGoal(p.goal, p.focus); });
      presetsEl.appendChild(b);
    });
  }

  async function runGoal(goal, focusVar) {
    goal = goal.trim(); if (!goal) return;
    if (!/\.\s*$/.test(goal)) goal += '.';
    const res = await askAll(goal);
    if (res && res.error) { answerEl.innerHTML = '<div class="goal">?- ' + esc(goal) + '</div><div class="qerr">' + esc(res.error) + '</div>'; return; }
    if (!res.length) { answerEl.innerHTML = '<div class="goal">?- ' + esc(goal) + '</div><div class="nores">No solutions — the world says <b>false</b>.</div>'; Graph.reset(); return; }
    const varsSeen = Object.keys(res[0]);
    const focus = (focusVar && varsSeen.indexOf(focusVar) >= 0) ? focusVar : varsSeen[0];
    const vals = uniq(res.map(function (r) { return r[focus]; }));
    const nodeVals = vals.filter(function (v) { return meta[v]; });
    let html = '<div class="goal">?- ' + esc(goal) + '</div>';
    html += '<p class="headline"><b>' + vals.length + '</b> answer' + (vals.length === 1 ? '' : 's') + (focus ? ' for <b>' + focus + '</b>' : '') + '.</p>';
    if (nodeVals.length === vals.length) { vals.forEach(function (v) { html += renderRow(v); }); }
    else { res.slice(0, 50).forEach(function (r) { const parts = varsSeen.map(function (v) { return '<code>' + esc(v) + ' = ' + esc(r[v]) + '</code>'; }).join(' '); html += '<div class="ansrow"><div class="body">' + parts + '</div></div>'; }); }
    answerEl.innerHTML = html;
    const hi = uniq(res.flatMap(function (r) { return Object.values(r); })).filter(function (v) { return meta[v]; });
    if (hi.length) Graph.highlight(hi); else Graph.reset();
    const stations = hi.filter(function (v) { return (meta[v] || {}).group === 'station'; });
    if (window.RobotView && stations.length) RobotView.highlightStations(stations);
  }

  // ---- click a graph node ---------------------------------------------------
  async function describeNode(id) {
    const m = meta[id]; if (!m) return;
    if (m.group === 'task') { setActiveTask(id); return; }

    let goal, rel = [], relTasks = [];
    if (m.group === 'action') { relTasks = uniq((await askAll('task_action(T, ' + id + ').')).map(function (r) { return r.T; })); rel = relTasks; goal = 'task_action(T, ' + id + ').'; }
    else if (m.group === 'policy') { relTasks = uniq((await askAll('requires(T, ' + id + ').')).map(function (r) { return r.T; })); rel = relTasks; goal = 'requires(T, ' + id + ').'; }
    else if (m.group === 'object') { relTasks = uniq((await askAll('carries(T, ' + id + ').')).map(function (r) { return r.T; })); rel = relTasks; goal = 'carries(T, ' + id + ').'; }
    else if (m.group === 'station') {
      const f = (await askAll('from(T, ' + id + ').')).map(function (r) { return r.T; });
      const t = (await askAll('to(T, ' + id + ').')).map(function (r) { return r.T; });
      relTasks = uniq(f.concat(t)); rel = relTasks; goal = 'from(T, ' + id + ') ; to(T, ' + id + ').';
      if (window.RobotView) RobotView.highlightStations([id]);
    } else { rel = uniq((await askAll('has_part(' + id + ', P).')).map(function (r) { return r.P; })); goal = 'has_part(' + id + ', P).'; }

    if (relTasks.length) highlightChips(relTasks); else highlightChips([]);

    let ctx = {};
    if (m.group === 'action' && relTasks.length) ctx = await ctxForTask(relTasks[0]);

    let html = '<div class="goal">?- ' + esc(goal) + '</div>';
    html += renderRow(id, ctx);
    if (rel.length) {
      const noun = m.group === 'action' ? 'Executed within transports (highlighted left)' :
                   m.group === 'policy' ? 'Governs these transports (highlighted left)' :
                   m.group === 'object' ? 'Carried during transports (highlighted left)' :
                   m.group === 'station' ? 'Involved in transports (highlighted left)' : 'Parts';
      html += section(noun, rel);
    }
    answerEl.innerHTML = html;
    Graph.highlight([id].concat(rel));
  }

  // ---- helpers & UI ---------------------------------------------------------
  function uniq(a) { const s = {}; const o = []; a.forEach(function (x) { if (!s[x]) { s[x] = 1; o.push(x); } }); return o; }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  runBtn.addEventListener('click', function () { runGoal(input.value); });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') runGoal(input.value); });

  // ---- play all transports in sequence --------------------------------------
  let playTimer = null, playIdx = 0;
  const TASK_MS = 7000;
  function stopPlay() { if (playTimer) { clearTimeout(playTimer); playTimer = null; } playBtn.classList.remove('playing'); playBtn.textContent = '▶ Run the lab'; }
  function startPlay() { if (!taskIds.length) return; playIdx = 0; playBtn.classList.add('playing'); playBtn.textContent = '⏸ Stop'; advance(); }
  function advance() { if (playIdx >= taskIds.length) { stopPlay(); if (window.RobotView) RobotView.goHome(); return; } setActiveTask(taskIds[playIdx]); playIdx++; playTimer = setTimeout(advance, TASK_MS); }
  playBtn.addEventListener('click', function () { if (playTimer) stopPlay(); else startPlay(); });
  stripEl.addEventListener('click', function () { if (playTimer) stopPlay(); }, true);

  // view toggle (3D only here, but keep the photo button harmless)
  document.querySelectorAll('.view-toggle button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.view-toggle button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      const v = b.dataset.view;
      document.getElementById('viewer').classList.toggle('hidden', v !== '3d');
      const ph = document.getElementById('photo'); if (ph) ph.classList.toggle('hidden', v !== 'photo');
    });
  });
})();
