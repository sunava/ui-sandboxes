/* ============================================================================
 * graph.js — the interactive knowledge graph (vis-network).
 *
 * Data is handed in from main.js after it queries the Prolog KB (the real AICOR
 * L2 ontology), so the graph and the reasoning share one source of truth. Two
 * kinds of graph are rendered through the same API:
 *   - the class taxonomy (TBox): class nodes + subClassOf edges
 *   - a worked example (ABox):   individual nodes + object-property triples
 * ==========================================================================*/
(function () {
  const el = document.getElementById('graph');
  const legendEl = document.getElementById('legend');

  const GROUP_STYLE = {
    // ---- TBox ----
    root:    { color: '#e8eefb', ring: '#ffffff', size: 24, label: 'Root concept' },
    klass:   { color: '#5b8cff', ring: '#a9c2ff', size: 15, label: 'Subpackage' },
    pyclass: { color: '#ffb648', ring: '#ffd89a', size: 13, label: 'Python class' },
    upper:   { color: '#8c9bbd', ring: '#c3ccdf', size: 14, label: 'Upper ontology (DUL)' },
    // ---- ABox individuals, bucketed by their asserted type ----
    robot:   { color: '#ff7a9c', ring: '#ffb3c6', size: 20, label: 'Robot / body' },
    object:  { color: '#39d5c8', ring: '#8ff0e7', size: 15, label: 'Object / substance' },
    event:   { color: '#b98cff', ring: '#d9c2ff', size: 16, label: 'Event / episode' },
    goal:    { color: '#ffb648', ring: '#ffd89a', size: 15, label: 'Goal' },
    concept: { color: '#4bd38a', ring: '#a6ecc6', size: 14, label: 'Problem / phase / fluent' },
    ind:     { color: '#7f8db0', ring: '#b6c0d8', size: 13, label: 'Individual' },
  };

  const EDGE_STYLE = {
    isa:         { c: '#39d5c8', o: 0.5,  w: 1.6 },                          // subClassOf
    type:        { c: '#7f9cc9', o: 0.5,  w: 1.1, d: [3, 3] },               // rdf:type (instanceOf)
    prop:        { c: '#b98cff', o: 0.55, w: 1.4 },                          // object-property triple
    restriction: { c: '#ffb648', o: 0.5,  w: 1.3, d: [4, 3] },               // OWL restriction
    disjoint:    { c: '#ff6b8b', o: 0.4,  w: 1.2, d: [2, 3], noArrow: true },// owl:disjointWith (symmetric)
    default:     { c: '#3a4c6e', o: 0.4,  w: 1 },
  };

  let network = null, nodes = null, edges = null, allNodeIds = [];
  let selectCb = function () {};
  let dblCb = function () {};
  let freezeTimer = null;   // re-freeze physics a moment after a node drag ends

  function build(data) {
    const visNodes = data.nodes.map(function (n) {
      const st = GROUP_STYLE[n.group] || GROUP_STYLE.ind;
      return { id: n.id, label: n.label, group: n.group, title: n.title || n.label, value: st.size };
    });
    const seen = {};
    const rawEdges = data.edges.filter(function (e) {
      const k = e.from + '>' + e.to + '>' + (e.label || ''); if (seen[k]) return false; seen[k] = 1; return true;
    });
    // plain lines: no edge labels, no arrowheads — the relation name only shows
    // as a hover tooltip, and in the answer panel when a node is clicked
    const visEdges = rawEdges.map(function (e) {
      const s = EDGE_STYLE[e.kind] || EDGE_STYLE.default;
      return {
        from: e.from, to: e.to,
        title: e.label || undefined,
        color: { color: s.c, opacity: s.o }, width: s.w, dashes: s.d || false,
      };
    });

    nodes = new vis.DataSet(visNodes);
    edges = new vis.DataSet(visEdges);
    allNodeIds = visNodes.map(function (n) { return n.id; });
    const bigGraph = visNodes.length > 170;

    const groups = {};
    Object.keys(GROUP_STYLE).forEach(function (g) {
      const st = GROUP_STYLE[g];
      groups[g] = {
        shape: 'dot',
        color: { background: st.color, border: st.ring, highlight: { background: st.ring, border: '#fff' } },
        font: { color: '#dfe8fb', size: 13, face: 'Inter', strokeWidth: 3, strokeColor: '#0b1220' },
        borderWidth: 2,
      };
    });

    network = new vis.Network(el, { nodes: nodes, edges: edges }, {
      groups: groups,
      nodes: { scaling: { min: 12, max: 30 } },
      // straight edges render far cheaper than smooth curves at hundreds of edges
      edges: { smooth: false, arrows: { to: { enabled: false } } },
      physics: {
        // fewer settle iterations; physics is switched OFF once stable (below)
        stabilization: { iterations: bigGraph ? 120 : 200, updateInterval: 25 },
        barnesHut: { gravitationalConstant: -7000, springLength: 120, springConstant: 0.03, damping: 0.5, avoidOverlap: 0 },
      },
      interaction: { hover: !bigGraph, tooltipDelay: 150, navigationButtons: false, dragNodes: true },
      // improvedLayout runs an expensive pre-solve; skip it on large graphs
      layout: { improvedLayout: !bigGraph },
    });

    // freeze the simulation once it has settled — this is the key win: without it
    // vis keeps simulating forever, so every hover/redraw stays laggy.
    // Then fit the whole (now expanded) layout into the viewport: the initial
    // zoom is from before the physics spread the nodes out, so without this
    // the outer nodes end up outside the visible area.
    network.once('stabilizationIterationsDone', function () {
      network.setOptions({ physics: false });
      network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
    });

    // …but re-animate while a node is being dragged, so neighbours spring along
    // (that's the fun bit), then freeze again shortly after the drag ends.
    if (freezeTimer) { clearTimeout(freezeTimer); freezeTimer = null; }
    network.on('dragStart', function (params) {
      if (!params.nodes || !params.nodes.length) return;   // node drag, not a pan
      if (freezeTimer) { clearTimeout(freezeTimer); freezeTimer = null; }
      network.setOptions({ physics: true });
    });
    network.on('dragEnd', function (params) {
      if (!params.nodes || !params.nodes.length) return;
      if (freezeTimer) clearTimeout(freezeTimer);
      freezeTimer = setTimeout(function () { if (network) network.setOptions({ physics: false }); }, 1000);
    });

    network.on('click', function (params) {
      if (params.nodes.length) selectCb(params.nodes[0]);
    });
    // double-click: on a node → drill into it; on empty space → fit the view
    network.on('doubleClick', function (params) {
      if (params.nodes.length) dblCb(params.nodes[0]);
      else if (!params.edges.length)
        network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
    });

    buildLegend(data);
  }

  function buildLegend(data) {
    legendEl.innerHTML = '';
    // a view can override the legend labels (e.g. the URDF tree relabels the
    // reused group colours as left arm / right arm / gripper / camera / base)
    if (data.legend) {
      data.legend.forEach(function (row) {
        const st = GROUP_STYLE[row.group];
        if (!st) return;
        const d = document.createElement('div');
        d.className = 'li';
        d.innerHTML = '<span class="dot" style="background:' + st.color + '"></span>' + row.label;
        legendEl.appendChild(d);
      });
      return;
    }
    const present = {};
    data.nodes.forEach(function (n) { present[n.group] = 1; });
    ['root', 'klass', 'pyclass', 'upper', 'robot', 'object', 'event', 'goal', 'concept', 'ind']
      .filter(function (g) { return present[g]; })
      .forEach(function (g) {
        const st = GROUP_STYLE[g];
        const d = document.createElement('div');
        d.className = 'li';
        d.innerHTML = '<span class="dot" style="background:' + st.color + '"></span>' + st.label;
        legendEl.appendChild(d);
      });
  }

  // dim everything, then spotlight the given ids
  function highlight(ids) {
    if (!nodes) return;
    const set = {}; ids.forEach(function (i) { set[i] = 1; });
    nodes.update(allNodeIds.map(function (id) {
      const on = set[id];
      return { id: id, opacity: on ? 1 : 0.16, font: { color: on ? '#ffffff' : '#5f7196' } };
    }));
    const present = ids.filter(function (i) { return set[i] && allNodeIds.indexOf(i) >= 0; });
    if (present.length) {
      network.selectNodes(present);
      network.fit({ nodes: present, animation: { duration: 600, easingFunction: 'easeInOutQuad' } });
    }
  }

  function reset() {
    if (!nodes) return;
    nodes.update(allNodeIds.map(function (id) { return { id: id, opacity: 1, font: { color: '#dfe8fb' } }; }));
    network.unselectAll();
    network.fit({ animation: { duration: 500 } });
  }

  function focus(id) {
    if (network && allNodeIds.indexOf(id) >= 0) network.focus(id, { scale: 1.1, animation: { duration: 500 } });
  }

  // re-fit after the container changes size (e.g. graph maximised to fullscreen)
  function resize() {
    if (!network) return;
    network.redraw();
    network.fit({ animation: { duration: 300, easingFunction: 'easeInOutQuad' } });
  }

  window.Graph = {
    build: build,
    highlight: highlight,
    reset: reset,
    focus: focus,
    resize: resize,
    onSelect: function (cb) { selectCb = cb; },
    onDoubleSelect: function (cb) { dblCb = cb; },
  };
})();
