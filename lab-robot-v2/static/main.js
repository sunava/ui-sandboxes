/* ============================================================================
 * main.js — boots the Prolog session over the REAL AICOR L2 ontology, derives
 * the knowledge graph from it, and wires the query panel + worked-example strip.
 *
 * Two graph modes share one renderer:
 *   - taxonomy: the class hierarchy (TBox) — class nodes, subClassOf edges
 *   - example:  one worked-example ABox     — individual nodes, property triples
 * The 3D robot (robot.js) renders alongside but is decoupled from the KB: the
 * real ontology is domain-general (its ABoxes are kitchen manipulations, not the
 * sterility workflow the mesh depicts), so Tracy is an ambient render here.
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

  // ---- Prolog session -------------------------------------------------------
  const session = pl.create(8000000);

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

  // ---- derived KB state -----------------------------------------------------
  const classSet = new Set();
  const rootSet = new Set();
  const upperSet = new Set();          // dul_* upper-ontology shim classes
  const labelMap = {};                 // id -> explicit rdfs:label (if any)
  const parents = {};                  // class -> [named superclasses]
  const children = {};                 // class -> [named subclasses]
  const constraints = {};              // class -> [{p, k, f}]
  let indRows = [];                    // ex_individual(Tag, I, C) rows
  let tripRows = [];                   // ex_triple(Tag, S, P, O) rows
  let relEdges = [];                   // object-property (some/all) edges between classes
  let restrEdges = [];                 // cardinality-restriction edges between classes
  let disjEdges = [];                  // owl:disjointWith edges between classes

  let mode = 'taxonomy';               // 'taxonomy' | <example tag>
  let showRel = false, showRestr = false, showDisj = false;   // taxonomy edge layers (toggles)
  let currentNodes = new Set();        // ids currently in the graph

  // ---- boot -----------------------------------------------------------------
  loadAicorKB(session).then(boot).catch(function (err) {
    kbStatus.textContent = 'KB error';
    answerEl.innerHTML = '<div class="qerr">Failed to load the AICOR ontology:\n' + esc(String(err)) + '</div>';
  });

  async function boot() {
    kbStatus.textContent = 'reasoning ready · AICOR L2 ontology loaded';
    kbStatus.classList.add('ready');

    (await askAll('class(C).')).forEach(function (r) { classSet.add(r.C); if (r.C.indexOf('dul_') === 0) upperSet.add(r.C); });
    (await askAll('root_class(C).')).forEach(function (r) { rootSet.add(r.C); });
    (await askAll('label(C, L).')).forEach(function (r) { labelMap[r.C] = strip(r.L); });
    (await askAll('subclass_of(C, D).')).forEach(function (r) {
      (parents[r.C] = parents[r.C] || []).push(r.D);
      (children[r.D] = children[r.D] || []).push(r.C);
    });
    (await askAll('constraint(C, P, K, F).')).forEach(function (r) {
      (constraints[r.C] = constraints[r.C] || []).push({ p: r.P, k: r.K, f: r.F });
    });
    // relationship edges: someValuesFrom / allValuesFrom whose filler is a class
    (await askAll('restriction(C, P, K, F).')).forEach(function (r) {
      if (classSet.has(r.F)) relEdges.push({ from: r.C, to: r.F, kind: 'prop', label: propLabel(r.P) });
    });
    // restriction edges: cardinality (exactly/min/max) whose filler is a class
    (await askAll('restriction_card(C, P, K, N, F).')).forEach(function (r) {
      if (classSet.has(r.F)) restrEdges.push({ from: r.C, to: r.F, kind: 'restriction', label: propLabel(r.P) + ' ' + cardSym(r.K) + r.N });
    });
    // disjointness edges (symmetric; facts are stored one direction)
    (await askAll('disjoint(A, B).')).forEach(function (r) {
      if (classSet.has(r.A) && classSet.has(r.B)) disjEdges.push({ from: r.A, to: r.B, kind: 'disjoint' });
    });
    indRows = await askAll('ex_individual(Tag, I, C).');
    tripRows = await askAll('ex_triple(Tag, S, P, O).');

    buildStrip();
    buildPresets();
    buildModes();
    Graph.onSelect(describeNode);
    showTaxonomy();
  }

  function cardSym(k) { return k === 'exactly' ? '=' : k === 'min' ? '≥' : k === 'max' ? '≤' : ''; }

  // ---- graph: taxonomy (TBox) ----------------------------------------------
  function showTaxonomy() {
    mode = 'taxonomy';
    markStrip(null);
    captionEl.classList.add('hidden');

    // assemble the edges for the currently active layers first…
    const edges = [];
    Object.keys(parents).forEach(function (c) {
      parents[c].forEach(function (d) { if (classSet.has(d)) edges.push({ from: c, to: d, kind: 'isa' }); });
    });
    if (showRel) relEdges.forEach(function (e) { edges.push(e); });
    if (showRestr) restrEdges.forEach(function (e) { edges.push(e); });
    if (showDisj) disjEdges.forEach(function (e) { edges.push(e); });

    // …then render only the classes that actually take part in a shown edge, so
    // there are never floating, unconnected nodes in the current view.
    const shown = new Set();
    edges.forEach(function (e) { shown.add(e.from); shown.add(e.to); });
    const nodes = [];
    currentNodes = new Set();
    classSet.forEach(function (c) {
      if (!shown.has(c)) return;
      nodes.push({ id: c, label: classLabel(c), group: classGroup(c), title: classTooltip(c) });
      currentNodes.add(c);
    });
    setModesVisible(true);
    Graph.build({ nodes: nodes, edges: edges });

    answerEl.innerHTML =
      '<div class="goal">?- the AICOR L2 ontology</div>' +
      '<p class="headline">The knowledge base is the real <b>AICOR L2 conceptual framework</b>: <b>' +
      classSet.size + '</b> classes, <b>' + edgeCount() + '</b> subclass edges, <b>' +
      countConstraints() + '</b> OWL restrictions, over <b>' + Object.keys(groupByTag()).length +
      '</b> worked-example ABoxes.</p>' +
      '<p class="hint-txt">Click a class in the graph to see its place in the hierarchy and what it must have. ' +
      'Open a worked example on the left to switch the graph to that scenario. Or ask a Prolog goal above.</p>';
    Graph.reset();
  }

  // ---- graph: one worked example (ABox) ------------------------------------
  function showExample(tag) {
    mode = tag;
    markStrip(tag);
    setModesVisible(false);
    const ex = (window.KB_EXAMPLES || []).find(function (e) { return e.tag === tag; }) || { tag: tag, label: tag, blurb: '' };
    captionEl.innerHTML = '<b>' + esc(ex.label) + '</b> — ' + esc(ex.blurb || '');
    captionEl.classList.remove('hidden');

    const inds = indRows.filter(function (r) { return r.Tag === tag; });
    const trips = tripRows.filter(function (r) { return r.Tag === tag; });

    const typesOf = {};
    inds.forEach(function (r) { (typesOf[r.I] = typesOf[r.I] || []).push(r.C); });

    const nodes = [];
    currentNodes = new Set();
    Object.keys(typesOf).forEach(function (i) {
      nodes.push({ id: i, label: indLabel(i), group: indGroup(typesOf[i]), title: indTooltip(i, typesOf[i], tag) });
      currentNodes.add(i);
    });
    const edges = trips.map(function (r) { return { from: r.S, to: r.O, kind: 'prop', label: propLabel(r.P) }; });

    // ground the ABox in the ontology: for every individual, add an instanceOf
    // edge to each class it is typed with, and pull those class nodes in — so
    // e.g. tracy_description connects to the URDF class node, every link to Link.
    const usedClasses = new Set();
    Object.keys(typesOf).forEach(function (i) {
      uniq(typesOf[i]).forEach(function (c) {
        if (!classSet.has(c)) return;
        edges.push({ from: i, to: c, kind: 'type' });
        usedClasses.add(c);
      });
    });
    usedClasses.forEach(function (c) {
      nodes.push({ id: c, label: classLabel(c), group: classGroup(c), title: classTooltip(c) });
      currentNodes.add(c);
    });
    Graph.build({ nodes: nodes, edges: edges });

    // summary in the answer panel: the problem, its goals, the episodes
    const problems = Object.keys(typesOf).filter(function (i) { return (typesOf[i] || []).indexOf('ManipulationProblem') >= 0; });
    const episodes = Object.keys(typesOf).filter(function (i) { return (typesOf[i] || []).indexOf('ManipulationEpisode') >= 0; });
    let html = '<div class="goal">?- example = ' + esc(tag) + '</div>';
    html += '<p class="headline"><b>' + esc(ex.label) + '</b> — ' + Object.keys(typesOf).length +
      ' individuals, ' + trips.length + ' relations, grounded in <b>' + usedClasses.size +
      '</b> ontology classes.</p>';
    if (problems.length) {
      const goals = trips.filter(function (r) { return problems.indexOf(r.S) >= 0 && r.P === 'hasGoal'; }).map(function (r) { return r.O; });
      html += indSection('Manipulation problem', problems);
      if (goals.length) html += indSection('Goals it carries', uniq(goals));
    }
    if (episodes.length) html += indSection('Episodes that address it', episodes);
    html += '<p class="hint-txt">Dashed edges are <b>instanceOf</b> links to the ontology classes (URDF, Robot, Link…) these individuals realise — click a class node to explore the concept.</p>';
    answerEl.innerHTML = html;

    if (ex.focus && currentNodes.has(ex.focus)) Graph.highlight([ex.focus].concat(neighbours(ex.focus)));
  }

  // ---- node click: explain + trace -----------------------------------------
  async function describeNode(id) {
    if (classSet.has(id)) return describeClass(id);
    return describeIndividual(id);
  }

  function describeClass(id) {
    const par = uniq(parents[id] || []);
    const ch = uniq(children[id] || []);
    const cons = constraints[id] || [];

    let html = '<div class="goal">?- class ' + esc(id) + '</div>';
    html += renderClassRow(id);
    if (cons.length) {
      html += subhead('Must satisfy (OWL restrictions)');
      cons.forEach(function (c) { html += '<div class="ansrow"><div class="body"><span class="name">' + esc(constraintPhrase(c)) + '</span></div></div>'; });
    }
    if (par.length) html += classSection('Is a kind of (superclasses)', par);
    if (ch.length) html += classSection('Specialised by (' + ch.length + ' subclasses)', ch.slice(0, 24));
    answerEl.innerHTML = html;

    Graph.highlight([id].concat(par.filter(inGraph), ch.filter(inGraph)));
  }

  function describeIndividual(id) {
    const tag = mode;
    const types = uniq(indRows.filter(function (r) { return r.Tag === tag && r.I === id; }).map(function (r) { return r.C; }));
    const asSubj = tripRows.filter(function (r) { return r.Tag === tag && r.S === id; });
    const asObj = tripRows.filter(function (r) { return r.Tag === tag && r.O === id; });

    let html = '<div class="goal">?- individual ' + esc(id) + '</div>';
    html += '<div class="ansrow"><span class="tag" style="background:' + groupColor(indGroup(types)) + '">individual</span>' +
      '<div class="body"><span class="name">' + esc(indLabel(id)) + '</span>' +
      (types.length ? '<span class="sub">a ' + types.map(esc).join(', ') + '  ·  in ' + esc(tag) + '</span>' : '') + '</div></div>';
    if (asSubj.length) {
      html += subhead('Relations (as subject)');
      asSubj.forEach(function (r) { html += relRow(indLabel(id), propLabel(r.P), indLabel(r.O)); });
    }
    if (asObj.length) {
      html += subhead('Referenced by');
      asObj.forEach(function (r) { html += relRow(indLabel(r.S), propLabel(r.P), indLabel(id)); });
    }
    answerEl.innerHTML = html;

    Graph.highlight([id].concat(neighbours(id)));
  }

  // ---- presets & free-text queries -----------------------------------------
  function buildPresets() {
    presetsEl.innerHTML = '';
    (window.KB_PRESETS || []).forEach(function (p) {
      const b = document.createElement('div');
      b.className = 'preset'; b.textContent = p.text;
      b.addEventListener('click', function () {
        input.value = p.goal;
        // put the graph in the right scope first: an example-scoped preset opens
        // its scenario, a plain one returns to the taxonomy — so a preset always
        // takes you somewhere sensible instead of stranding you in a scenario.
        const target = p.example || 'taxonomy';
        if (mode !== target) { target === 'taxonomy' ? showTaxonomy() : showExample(target); }
        runGoal(p.goal, p.focus);
      });
      presetsEl.appendChild(b);
    });
  }

  async function runGoal(goal, focusVar) {
    goal = (goal || '').trim(); if (!goal) return;
    if (!/\.\s*$/.test(goal)) goal += '.';
    const res = await askAll(goal);
    if (res && res.error) {
      answerEl.innerHTML = '<div class="goal">?- ' + esc(goal) + '</div><div class="qerr">' + esc(res.error) + '</div>';
      return;
    }
    if (!res.length) {
      answerEl.innerHTML = '<div class="goal">?- ' + esc(goal) + '</div><div class="nores">No solutions — the ontology says <b>false</b>.</div>';
      Graph.reset();
      return;
    }

    const varsSeen = Object.keys(res[0]);
    const focus = (focusVar && varsSeen.indexOf(focusVar) >= 0) ? focusVar : varsSeen[0];

    let html = '<div class="goal">?- ' + esc(goal) + '</div>';

    // a single list binding (e.g. superclasses/2) → render the list items
    if (res.length === 1 && focus && isList(res[0][focus])) {
      const items = parseList(res[0][focus]);
      html += '<p class="headline"><b>' + items.length + '</b> in <b>' + esc(focus) + '</b>.</p>';
      items.forEach(function (v) { html += entityRow(v); });
      answerEl.innerHTML = html;
      Graph.highlight(items.filter(inGraph));
      return;
    }

    const vals = uniq(res.map(function (r) { return r[focus]; }));
    html += '<p class="headline"><b>' + vals.length + '</b> answer' + (vals.length === 1 ? '' : 's') +
      (focus ? ' for <b>' + esc(focus) + '</b>' : '') + '.</p>';

    const allEntities = vals.every(function (v) { return classSet.has(v) || currentNodes.has(v); });
    if (allEntities && varsSeen.length === 1) {
      vals.forEach(function (v) { html += entityRow(v); });
    } else {
      res.slice(0, 60).forEach(function (r) {
        const parts = varsSeen.map(function (v) { return '<code>' + esc(v) + ' = ' + esc(r[v]) + '</code>'; }).join(' ');
        html += '<div class="ansrow"><div class="body">' + parts + '</div></div>';
      });
    }
    answerEl.innerHTML = html;

    const hi = uniq(res.flatMap(function (r) { return Object.values(r); })).filter(inGraph);
    if (hi.length) Graph.highlight(hi); else Graph.reset();
  }

  runBtn.addEventListener('click', function () { runGoal(input.value); });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') runGoal(input.value); });

  // ---- worked-example strip -------------------------------------------------
  function buildStrip() {
    stripEl.innerHTML = '';
    const tax = document.createElement('div');
    tax.className = 'wstep tax'; tax.dataset.tag = '__tax__';
    tax.title = 'Back to the full class taxonomy';
    tax.innerHTML = '<span class="num">⌂</span><span class="txt">Class taxonomy</span>';
    tax.addEventListener('click', showTaxonomy);
    stripEl.appendChild(tax);

    (window.KB_EXAMPLES || []).forEach(function (ex, i) {
      const chip = document.createElement('div');
      chip.className = 'wstep'; chip.dataset.tag = ex.tag;
      chip.innerHTML = '<span class="num">' + (i + 1) + '</span><span class="txt">' + esc(ex.label) + '</span>';
      chip.addEventListener('click', function () { showExample(ex.tag); });
      stripEl.appendChild(chip);
    });
  }
  function markStrip(tag) {
    document.querySelectorAll('.wstep').forEach(function (c) {
      const on = (tag === null && c.dataset.tag === '__tax__') || c.dataset.tag === tag;
      c.classList.toggle('active', on);
    });
  }

  // ---- taxonomy edge-layer toggles ------------------------------------------
  function buildModes() {
    const rel = document.getElementById('mode-rel');
    const restr = document.getElementById('mode-restr');
    if (rel) {
      rel.parentElement.querySelector('small').textContent = '(' + relEdges.length + ' object properties)';
      rel.addEventListener('change', function () { showRel = rel.checked; if (mode === 'taxonomy') showTaxonomy(); });
    }
    if (restr) {
      restr.parentElement.querySelector('small').textContent = '(' + restrEdges.length + ' cardinality)';
      restr.addEventListener('change', function () { showRestr = restr.checked; if (mode === 'taxonomy') showTaxonomy(); });
    }
    const disj = document.getElementById('mode-disj');
    if (disj) {
      disj.parentElement.querySelector('small').textContent = '(' + disjEdges.length + ' pairs)';
      disj.addEventListener('change', function () { showDisj = disj.checked; if (mode === 'taxonomy') showTaxonomy(); });
    }
  }
  function setModesVisible(on) {
    const el = document.getElementById('graph-modes');
    if (el) el.style.display = on ? '' : 'none';
  }

  // ---- rendering helpers ----------------------------------------------------
  function classSection(title, ids) {
    let h = subhead(title);
    ids.forEach(function (id) { h += renderClassRow(id); });
    return h;
  }
  function indSection(title, ids) {
    let h = subhead(title);
    ids.forEach(function (id) { h += entityRow(id); });
    return h;
  }
  function subhead(t) {
    return '<div class="ansub">' + esc(t) + '</div>';
  }
  function renderClassRow(id) {
    const g = classGroup(id);
    return '<div class="ansrow"><span class="tag" style="background:' + groupColor(g) + '">' +
      (g === 'root' ? 'root concept' : g === 'upper' ? 'upper (DUL)' : 'class') + '</span>' +
      '<div class="body"><span class="name">' + esc(classLabel(id)) + '</span>' +
      '<span class="sub">' + esc(id) + '</span></div></div>';
  }
  // entity row that works for a class OR an individual (whatever the id is)
  function entityRow(id) {
    if (classSet.has(id)) return renderClassRow(id);
    const g = currentNodes.has(id) ? indGroup(typesOfCurrent(id)) : 'ind';
    return '<div class="ansrow"><span class="tag" style="background:' + groupColor(g) + '">' +
      (currentNodes.has(id) ? 'individual' : 'value') + '</span>' +
      '<div class="body"><span class="name">' + esc(currentNodes.has(id) ? indLabel(id) : id) + '</span></div></div>';
  }
  function relRow(s, p, o) {
    return '<div class="ansrow"><div class="body"><span class="name">' + esc(s) +
      ' <span class="rel">' + esc(p) + '</span> ' + esc(o) + '</span></div></div>';
  }

  // ---- labels / grouping ----------------------------------------------------
  function classLabel(id) { return labelMap[id] || spaceCamel(id); }
  function indLabel(id) { return id.replace(/_/g, ' '); }
  function propLabel(p) { return spaceCamel(p).toLowerCase(); }
  function spaceCamel(s) { return String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2'); }

  function classGroup(id) { return rootSet.has(id) ? 'root' : upperSet.has(id) ? 'upper' : 'klass'; }

  const IND_BUCKETS = [
    { g: 'robot',   re: /RobotBody|EndEffector|Effector|Gripper|Motor|Sensor|Link|Joint/ },
    { g: 'goal',    re: /Goal/ },
    { g: 'event',   re: /Episode|Occurrence|Event|Phase|Motion|Chronicle/ },
    { g: 'concept', re: /Problem|Fluent|Interval|Constraint|Region|Description|Specification|Signal/ },
    { g: 'object',  re: /PhysicalObject|ArticulatedObject|Substance|Object|Body/ },
  ];
  function indGroup(types) {
    const t = (types || []).join(' ');
    for (const b of IND_BUCKETS) if (b.re.test(t)) return b.g;
    return 'ind';
  }
  function typesOfCurrent(id) {
    return indRows.filter(function (r) { return r.Tag === mode && r.I === id; }).map(function (r) { return r.C; });
  }

  const GROUP_COLOR = {
    root: '#e8eefb', klass: '#5b8cff', upper: '#8c9bbd',
    robot: '#ff7a9c', object: '#39d5c8', event: '#b98cff', goal: '#ffb648', concept: '#4bd38a', ind: '#7f8db0',
  };
  function groupColor(g) { return GROUP_COLOR[g] || '#5b8cff'; }

  // ---- tooltips -------------------------------------------------------------
  function classTooltip(id) {
    let t = classLabel(id) + '  (' + (classGroup(id) === 'root' ? 'root concept' : 'class') + ')';
    const par = uniq(parents[id] || []);
    if (par.length) t += '\nsubClassOf: ' + par.map(spaceCamel).join(', ');
    const cons = constraints[id] || [];
    cons.slice(0, 4).forEach(function (c) { t += '\n· ' + constraintPhrase(c); });
    if (cons.length > 4) t += '\n· …';
    return t;
  }
  function indTooltip(id, types, tag) {
    return indLabel(id) + '\na ' + (types || []).map(spaceCamel).join(', ') + '\nin example: ' + tag;
  }
  function constraintPhrase(c) {
    const p = propLabel(c.p), f = spaceCamel(c.f);
    if (c.k === 'some') return p + ' some ' + f;
    if (c.k === 'all') return p + ' only ' + f;
    if (c.k === 'value') return p + ' = ' + f;
    return p + ' ' + c.k + ' ' + f;   // exactly / min / max
  }

  // ---- misc helpers ---------------------------------------------------------
  function neighbours(id) {
    const out = [];
    tripRows.forEach(function (r) {
      if (r.Tag !== mode) return;
      if (r.S === id) out.push(r.O);
      if (r.O === id) out.push(r.S);
    });
    return uniq(out);
  }
  function inGraph(id) { return currentNodes.has(id); }
  function edgeCount() { let n = 0; Object.keys(parents).forEach(function (c) { n += parents[c].length; }); return n; }
  function countConstraints() { let n = 0; Object.keys(constraints).forEach(function (c) { n += constraints[c].length; }); return n; }
  function groupByTag() { const o = {}; indRows.forEach(function (r) { o[r.Tag] = 1; }); return o; }

  function isList(s) { return typeof s === 'string' && s.charAt(0) === '['; }
  function parseList(s) {
    const inner = s.replace(/^\[/, '').replace(/\]$/, '').trim();
    if (!inner) return [];
    return inner.split(',').map(function (x) { return x.trim(); });
  }
  function uniq(a) { const s = {}, o = []; a.forEach(function (x) { if (!s[x]) { s[x] = 1; o.push(x); } }); return o; }
  function strip(s) { return String(s).replace(/^["']/, '').replace(/["']$/, ''); }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  // ---- robot: ambient render, trajectory playback only ----------------------
  // The real ontology has no sterility workflow, so the robot is not driven by
  // the KB. Keep the "play" button as a pure trajectory demo when one is present.
  if (window.RobotView && RobotView.onStepStart) RobotView.onStepStart(function () {});
  function trajRunning() { return window.RobotView && RobotView.isPlayingTrajectory && RobotView.isPlayingTrajectory(); }
  function labelPlay() { playBtn.textContent = (window.RobotView && RobotView.hasTrajectory && RobotView.hasTrajectory()) ? '▶ Play robot motion' : '▶ Play robot motion'; }
  if (playBtn) {
    playBtn.addEventListener('click', function () {
      if (!window.RobotView || !RobotView.hasTrajectory || !RobotView.hasTrajectory()) return;
      if (trajRunning()) { RobotView.stopTrajectory(); playBtn.classList.remove('playing'); playBtn.textContent = '▶ Play robot motion'; }
      else { RobotView.playTrajectory(); playBtn.classList.add('playing'); playBtn.textContent = '⏸ Stop'; }
    });
    if (window.RobotView && RobotView.onReady) RobotView.onReady(labelPlay);
  }

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
