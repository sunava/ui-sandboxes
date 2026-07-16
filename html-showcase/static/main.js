/* ============================================================================
 * main.js — boots the Prolog session, derives the graph from it, and wires the
 * query panel + workflow strip + robot together.
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

  // short "what Tracy is doing" phrases shown over the 3D view
  const CAPTIONS = {
    prep:            'Preparing the aseptic workspace and parking both arms.',
    disinfect:       'Wiping down the bench surface and canister ports.',
    open_canister:   'Twisting open and priming the <b>sterility canister</b>.',
    spike_media:     'Holding a media bottle and <b>spiking</b> it with the transfer set.',
    filter_transfer: 'Pumping the product sample through the <b>membrane filter</b>.',
    rinse:           'Pouring sterile fluid to <b>rinse the membranes</b>.',
    fill_media:      'Filling the two chambers with <b>TSB &amp; FTM</b> media.',
    incubate:        'Carrying the sealed canister to <b>incubation</b>.',
    inspect:         'Retracting so the pole camera can <b>inspect for growth</b>.',
    document:        'Arms parked while the <b>traceable audit trail</b> is written.',
  };

  const GROUP_LABEL = { step: 'Step', action: 'CRAM action', regulation: 'Regulation',
    object: 'Object', robot: 'Robot', arm: 'Robot', gripper: 'Robot', sensor: 'Sensor', task: 'Task' };
  const GROUP_COLOR = { step: '#39d5c8', action: '#b98cff', regulation: '#ffb648',
    object: '#5b8cff', robot: '#ff7a9c', arm: '#ff7a9c', gripper: '#ff7a9c', sensor: '#ff7a9c', task: '#e8eefb' };

  // ---- Prolog session -------------------------------------------------------
  const session = pl.create(50000);
  const meta = {};   // id -> {label, group, descr, scope, authority, module}

  function askAll(goal) {
    return new Promise(function (resolve) {
      const rows = [];
      session.query(goal, {
        success: function () {
          const step = function () {
            session.answer({
              success: function (ans) {
                const row = {};
                for (const k in ans.links) row[k] = ans.links[k].toString();
                rows.push(row); step();
              },
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
    success: function () {
      kbStatus.textContent = 'Prolog ready · knowledge base loaded';
      kbStatus.classList.add('ready');
      boot();
    },
    error: function (e) {
      kbStatus.textContent = 'KB error';
      answerEl.innerHTML = '<div class="qerr">Failed to load knowledge base:\n' + pl.format_answer(e) + '</div>';
    },
  });

  // ---- derive metadata + graph from the KB ----------------------------------
  async function boot() {
    const kinds = await askAll('kind(X, K).');
    const labels = await askAll('label(X, L).');
    const descrs = await askAll('descr(X, D).');
    const scopes = await askAll('scope(X, S).');
    const auths  = await askAll('authority(X, A).');
    const mods   = await askAll('module(X, M).');

    const labelMap = {}; labels.forEach(function (r) { labelMap[r.X] = strip(r.L); });
    const descrMap = {}; descrs.forEach(function (r) { descrMap[r.X] = strip(r.D); });
    const scopeMap = {}; scopes.forEach(function (r) { scopeMap[r.X] = strip(r.S); });
    const authMap  = {}; auths.forEach(function (r) { authMap[r.X] = strip(r.A); });
    const modMap   = {}; mods.forEach(function (r) { modMap[r.X] = strip(r.M); });

    kinds.forEach(function (r) {
      if (meta[r.X]) return;                       // first kind wins
      meta[r.X] = {
        id: r.X, group: r.K, label: labelMap[r.X] || r.X,
        descr: descrMap[r.X], scope: scopeMap[r.X], authority: authMap[r.X], module: modMap[r.X],
      };
    });

    // edges
    const E = [];
    (await askAll('has_part(tracy, P).')).forEach(function (r) { E.push({ from: 'tracy', to: r.P, kind: 'has_part' }); });
    (await askAll('step(S).')).forEach(function (r) { E.push({ from: 'sterility_test', to: r.S, kind: 'task_step' }); });
    (await askAll('step_action(S, A).')).forEach(function (r) { E.push({ from: r.S, to: r.A, kind: 'step_action' }); });
    (await askAll('requires(S, R).')).forEach(function (r) { E.push({ from: r.S, to: r.R, kind: 'requires' }); });
    (await askAll('step_uses(S, O).')).forEach(function (r) { E.push({ from: r.S, to: r.O, kind: 'step_uses' }); });

    // sequence edges between consecutive steps
    const order = (await askAll('step_order(S, N).'))
      .map(function (r) { return { s: r.S, n: parseInt(r.N, 10) }; })
      .sort(function (a, b) { return a.n - b.n; });
    for (let i = 0; i < order.length - 1; i++) E.push({ from: order[i].s, to: order[i + 1].s, kind: 'seq' });

    const graphNodes = Object.keys(meta).map(function (id) {
      return { id: id, label: meta[id].label, group: meta[id].group, title: tooltip(id) };
    });
    Graph.build({ nodes: graphNodes, edges: E });
    Graph.onSelect(describeNode);

    buildStrip(order);
    buildPresets();
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

  // ---- workflow strip -------------------------------------------------------
  let activeStep = null;
  let stepIds = [];
  function buildStrip(order) {
    stepIds = order.map(function (o) { return o.s; });
    stripEl.innerHTML = '';
    order.forEach(function (o) {
      const m = meta[o.s];
      const chip = document.createElement('div');
      chip.className = 'wstep'; chip.dataset.step = o.s;
      chip.innerHTML = '<span class="num">' + o.n + '</span><span class="txt">' + m.label + '</span>';
      chip.addEventListener('click', function () { setActiveStep(o.s); });
      stripEl.appendChild(chip);
    });
  }

  // manual click on a step: drive the robot, then show the step's info
  async function setActiveStep(id) {
    if (playTimer) stopPlay();
    if (window.RobotView) {
      if (RobotView.isPlayingTrajectory()) RobotView.stopTrajectory();
      // play the real CRAM/giskardpy segment for this step if we have one,
      // otherwise fall back to the choreographed pose
      if (RobotView.hasSegment && RobotView.hasSegment(id)) RobotView.playTrajectory(id);
      else RobotView.poseForStep(id);
    }
    showStepInfo(id, true);
  }

  // update chips / caption / panel / graph for a step (no robot driving here);
  // used both by manual clicks and by trajectory playback crossing a step.
  async function showStepInfo(id, manual) {
    activeStep = id;
    document.querySelectorAll('.wstep').forEach(function (c) {
      c.classList.toggle('active', c.dataset.step === id);
    });
    if (CAPTIONS[id]) { captionEl.innerHTML = CAPTIONS[id]; captionEl.classList.remove('hidden'); }

    const regs = (await askAll('relevant_regulation(' + id + ', R).')).map(function (r) { return r.R; });
    const acts = (await askAll('uses_action(' + id + ', A).')).map(function (r) { return r.A; });
    const objs = (await askAll('touches(' + id + ', O).')).map(function (r) { return r.O; });
    const uReg = uniq(regs), uAct = uniq(acts), uObj = uniq(objs);

    const ctx = await ctxForStep(id);
    const m = meta[id];
    let html = '<div class="goal">?- task = ' + id + '</div>';
    html += '<p class="headline"><b>' + m.label + '</b> — Tracy needs to satisfy <b>' + uReg.length +
      '</b> safety constraint(s) and execute <b>' + uAct.length + '</b> CRAM action designator(s).</p>';
    html += section('Safety regulators that matter here', uReg);
    html += section('CRAM action designators', uAct, ctx);
    html += section('Objects involved', uObj);
    answerEl.innerHTML = html;

    highlightChips([]);
    Graph.highlight([id].concat(uReg, uAct, uObj));
    // while a trajectory plays, the robot controls object glow (the held item);
    // only drive object glow from here for the pose fallback
    if (window.RobotView && !RobotView.isPlayingTrajectory()) RobotView.highlightObjects(uObj);
  }

  // highlight related workflow chips on the left (traceability from the graph)
  function highlightChips(ids) {
    const set = {}; (ids || []).forEach(function (i) { set[i] = 1; });
    document.querySelectorAll('.wstep').forEach(function (c) {
      c.classList.toggle('related', !!set[c.dataset.step]);
    });
  }

  async function objectsForSteps(steps) {
    let all = [];
    for (const s of steps) {
      (await askAll('touches(' + s + ', O).')).forEach(function (r) { all.push(r.O); });
    }
    return uniq(all);
  }

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

    // for CRAM actions, show the full designator in LISP style + its module
    if (m.group === 'action' && window.Designators && window.ACTION_DESIGNATORS && window.ACTION_DESIGNATORS[id]) {
      row += '<div class="designator"><pre>' + Designators.html(window.ACTION_DESIGNATORS[id], ctx || {}) + '</pre></div>';
      if (m.module) row += '<div class="desig-file">' + esc(m.module) + '</div>';
    }
    return row;
  }

  // build a designator context (object type, arm, ...) from a step
  async function ctxForStep(stepId) {
    const objs = uniq((await askAll('touches(' + stepId + ', O).')).map(function (r) { return r.O; }));
    const primary = objs.find(function (o) { return o !== 'workbench'; }) || objs[0];
    return {
      OBJ: primary ? primary.replace(/_/g, '-') : null,
      SRC: primary ? primary.replace(/_/g, '-') : null,
      ARM: '(:left :right)',
      LOC: 'bench-frame',
      TGT: 'sterility-canister',
    };
  }

  // ---- presets & free-text queries ------------------------------------------
  function buildPresets() {
    presetsEl.innerHTML = '';
    KB_PRESETS.forEach(function (p) {
      const b = document.createElement('div');
      b.className = 'preset'; b.textContent = p.text;
      b.addEventListener('click', function () { input.value = p.goal; runGoal(p.goal, p.focus); });
      presetsEl.appendChild(b);
    });
  }

  async function runGoal(goal, focusVar) {
    goal = goal.trim(); if (!goal) return;
    if (!/\.\s*$/.test(goal)) goal += '.';
    const res = await askAll(goal);
    if (res && res.error) {
      answerEl.innerHTML = '<div class="goal">?- ' + esc(goal) + '</div><div class="qerr">' + esc(res.error) + '</div>';
      return;
    }
    if (!res.length) {
      answerEl.innerHTML = '<div class="goal">?- ' + esc(goal) + '</div><div class="nores">No solutions — the world says <b>false</b>.</div>';
      Graph.reset();
      return;
    }

    // choose which variable to report: explicit focus, else the first var seen
    const varsSeen = Object.keys(res[0]);
    const focus = (focusVar && varsSeen.indexOf(focusVar) >= 0) ? focusVar : varsSeen[0];

    // distinct focus values, in order
    const vals = uniq(res.map(function (r) { return r[focus]; }));
    const nodeVals = vals.filter(function (v) { return meta[v]; });

    let html = '<div class="goal">?- ' + esc(goal) + '</div>';
    html += '<p class="headline"><b>' + vals.length + '</b> answer' + (vals.length === 1 ? '' : 's') +
      (focus ? ' for <b>' + focus + '</b>' : '') + '.</p>';

    if (nodeVals.length === vals.length) {
      vals.forEach(function (v) { html += renderRow(v); });
    } else {
      // generic binding rows for non-entity results
      res.slice(0, 50).forEach(function (r) {
        const parts = varsSeen.map(function (v) { return '<code>' + esc(v) + ' = ' + esc(r[v]) + '</code>'; }).join(' ');
        html += '<div class="ansrow"><div class="body">' + parts + '</div></div>';
      });
    }
    answerEl.innerHTML = html;

    // highlight any entity results in the graph; pulse the robot if a part shows up
    const hi = uniq(res.flatMap(function (r) { return Object.values(r); })).filter(function (v) { return meta[v]; });
    if (hi.length) Graph.highlight(hi); else Graph.reset();
    if (window.RobotView && hi.some(function (id) { return ['robot','arm','gripper','sensor'].indexOf((meta[id]||{}).group) >= 0; }))
      RobotView.highlight(true);
  }

  // ---- click a graph node → explain it AND trace it back to the left --------
  async function describeNode(id) {
    const m = meta[id]; if (!m) return;
    if (m.group === 'step') { setActiveStep(id); return; }

    let goal, rel = [], relSteps = [];
    if (m.group === 'action') {
      relSteps = uniq((await askAll('step_action(S, ' + id + ').')).map(function (r) { return r.S; }));
      rel = relSteps; goal = 'step_action(S, ' + id + ').';
    } else if (m.group === 'regulation') {
      relSteps = uniq((await askAll('requires(S, ' + id + ').')).map(function (r) { return r.S; }));
      rel = relSteps; goal = 'requires(S, ' + id + ').';
    } else if (m.group === 'object') {
      relSteps = uniq((await askAll('step_uses(S, ' + id + ').')).map(function (r) { return r.S; }));
      rel = relSteps; goal = 'step_uses(S, ' + id + ').';
    } else { // robot / part / task
      rel = uniq((await askAll('has_part(' + id + ', P).')).map(function (r) { return r.P; }));
      goal = 'has_part(' + id + ', P).';
    }

    // ---- left-side traceability ----
    let ctx = {};
    if (relSteps.length) {
      highlightChips(relSteps);
      if (window.RobotView) RobotView.poseForStep(relSteps[0]);   // strike a pose that uses it
      ctx = await ctxForStep(relSteps[0]);
    } else {
      highlightChips([]);
    }
    if (m.group === 'object') {
      if (window.RobotView) RobotView.highlightObjects([id]);
    } else if (relSteps.length) {
      const objs = await objectsForSteps(relSteps);
      if (window.RobotView) RobotView.highlightObjects(objs);
    } else if (window.RobotView) {
      RobotView.highlight(true);                                   // robot / part / task
    }

    // ---- answer panel ----
    let html = '<div class="goal">?- ' + esc(goal) + '</div>';
    html += renderRow(id, ctx);
    if (rel.length) {
      const noun = m.group === 'action' ? 'Executed within steps (highlighted left)' :
                   m.group === 'regulation' ? 'Governs these steps (highlighted left)' :
                   m.group === 'object' ? 'Handled during steps (highlighted left)' : 'Parts';
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

  // ---- play the whole membrane test ----------------------------------------
  // Prefers the REAL CRAM/giskardpy trajectory (all 10 steps). Falls back to the
  // choreographed poses only if trajectory.json is missing.
  let playTimer = null, playIdx = 0;
  const STEP_MS = 2800;

  const usingReal = function () { return window.RobotView && RobotView.hasTrajectory && RobotView.hasTrajectory(); };

  function stopPlay() {
    if (playTimer) { clearTimeout(playTimer); playTimer = null; }
    if (window.RobotView && RobotView.isPlayingTrajectory()) RobotView.stopTrajectory();
    playBtn.classList.remove('playing');
    playBtn.textContent = usingReal() ? '▶ Run the real test' : '▶ Play the test';
  }
  function startPlay() {
    playBtn.classList.add('playing');
    playBtn.textContent = '⏸ Stop';
    if (usingReal()) {
      RobotView.playTrajectory();               // whole trajectory; step sync via onStepStart
    } else {
      if (!stepIds.length) { stopPlay(); return; }
      playIdx = 0; advance();                   // scripted fallback
    }
  }
  function advance() {
    if (playIdx >= stepIds.length) { stopPlay(); return; }
    setActiveStep(stepIds[playIdx]);
    playIdx++;
    playTimer = setTimeout(advance, STEP_MS);
  }
  playBtn.addEventListener('click', function () {
    const running = playTimer || (window.RobotView && RobotView.isPlayingTrajectory());
    if (running) stopPlay(); else startPlay();
  });

  // real-trajectory playback: sync the UI as the robot crosses each step
  if (window.RobotView && RobotView.onStepStart) {
    RobotView.onStepStart(function (step) {
      if (step === '__done__') {
        playBtn.classList.remove('playing');
        playBtn.textContent = usingReal() ? '▶ Run the real test' : '▶ Play the test';
        return;
      }
      showStepInfo(step);
    });
  }

  // label the button for whichever mode is available, once the robot is ready
  if (window.RobotView) RobotView.onReady(function () {
    playBtn.textContent = usingReal() ? '▶ Run the real test' : '▶ Play the test';
  });

  // clicking a step by hand stops any autoplay/trajectory (then setActiveStep runs)
  stripEl.addEventListener('click', function () {
    if (playTimer) { clearTimeout(playTimer); playTimer = null; playBtn.classList.remove('playing'); playBtn.textContent = usingReal() ? '▶ Run the real test' : '▶ Play the test'; }
  }, true);

  // view toggle 3D / photo — set display directly so nothing in the stacking
  // order can leave it "stuck"
  function showView(v) {
    const is3d = v === '3d';
    const set = function (id, on) { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
    set('viewer', is3d);
    set('stage-bg', is3d);          // hide the blurred backdrop behind the photo
    set('layers-panel', is3d);
    const ph = document.getElementById('photo');
    if (ph) { ph.style.display = is3d ? 'none' : 'block'; ph.classList.remove('hidden'); }
    document.querySelectorAll('.view-toggle button').forEach(function (x) {
      x.classList.toggle('active', x.dataset.view === v);
    });
  }
  document.querySelectorAll('.view-toggle button').forEach(function (b) {
    b.addEventListener('click', function () { showView(b.dataset.view); });
  });
  showView('3d');   // initial state

  // ---- floating LAYERS panel (studio render controls) -----------------------
  function bindLayer(id, method) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', function () {
      if (window.RobotView && RobotView[method]) RobotView[method](el.checked);
    });
  }
  bindLayer('lyr-objects', 'setPropsVisible');
  bindLayer('lyr-labels', 'setLabelsAlways');
  bindLayer('lyr-floor', 'setFloorVisible');
  bindLayer('lyr-rotate', 'setAutoRotate');
  const leg = document.getElementById('lp-legend');
  if (leg) leg.innerHTML = [['#cf9a3a', 'Media (TSB / FTM)'], ['#9fd3e6', 'Sample / rinse'], ['#cfe6ef', 'Sterility canister']]
    .map(function (r) { return '<div class="li"><span class="dot" style="background:' + r[0] + '"></span>' + r[1] + '</div>'; }).join('');
})();
