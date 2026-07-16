/* ============================================================================
 * graph.js — the interactive knowledge graph (vis-network).
 * Data is handed in from main.js after it queries the Prolog KB, so the graph
 * and the reasoning share one source of truth.
 * ==========================================================================*/
(function () {
  const el = document.getElementById('graph');
  const legendEl = document.getElementById('legend');

  const GROUP_STYLE = {
    task:       { color: '#e8eefb', ring: '#ffffff', size: 26, label: 'Task' },
    step:       { color: '#39d5c8', ring: '#8ff0e7', size: 20, label: 'Workflow step' },
    action:     { color: '#b98cff', ring: '#d9c2ff', size: 15, label: 'CRAM action designator' },
    regulation: { color: '#ffb648', ring: '#ffd89a', size: 16, label: 'Safety / regulation' },
    policy:     { color: '#ffb648', ring: '#ffd89a', size: 16, label: 'Safety policy' },
    object:     { color: '#5b8cff', ring: '#a9c2ff', size: 15, label: 'Object' },
    station:    { color: '#4bd38a', ring: '#a6ecc6', size: 20, label: 'Lab station' },
    robot:      { color: '#ff7a9c', ring: '#ffb3c6', size: 22, label: 'Robot' },
  };
  // fold the fine-grained kinds into display groups
  const GROUP_MAP = { robot: 'robot', arm: 'robot', gripper: 'robot', sensor: 'robot' };
  function toGroup(kind) { return GROUP_MAP[kind] || kind; }

  let network = null, nodes = null, edges = null, allNodeIds = [];
  let selectCb = function () {};

  function build(data) {
    const visNodes = data.nodes.map(function (n) {
      const g = toGroup(n.group);
      const st = GROUP_STYLE[g] || GROUP_STYLE.object;
      return {
        id: n.id, label: n.label, group: g,
        title: n.title || n.label,
        value: st.size,
      };
    });
    const seen = {};
    const visEdges = data.edges
      .filter(function (e) { const k = e.from + '>' + e.to; if (seen[k]) return false; seen[k] = 1; return true; })
      .map(function (e) {
        const style = EDGE_STYLE[e.kind] || EDGE_STYLE.default;
        return { from: e.from, to: e.to, color: { color: style.c, opacity: style.o }, width: style.w, dashes: style.d || false };
      });

    nodes = new vis.DataSet(visNodes);
    edges = new vis.DataSet(visEdges);
    allNodeIds = visNodes.map(function (n) { return n.id; });

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
      nodes: { scaling: { min: 12, max: 34 } },
      edges: { smooth: { type: 'continuous', roundness: 0.4 }, arrows: { to: { enabled: true, scaleFactor: 0.4 } } },
      physics: {
        stabilization: { iterations: 220 },
        barnesHut: { gravitationalConstant: -6500, springLength: 130, springConstant: 0.03, damping: 0.4, avoidOverlap: 0.4 },
      },
      interaction: { hover: true, tooltipDelay: 120, navigationButtons: false },
      layout: { improvedLayout: true },
    });

    network.on('click', function (params) {
      if (params.nodes.length) selectCb(params.nodes[0]);
    });

    buildLegend(data);
  }

  const EDGE_STYLE = {
    has_part:   { c: '#ff7a9c', o: 0.55, w: 2 },
    'task_step':{ c: '#39d5c8', o: 0.5,  w: 2 },
    seq:        { c: '#39d5c8', o: 0.9,  w: 2.5 },
    step_action:{ c: '#b98cff', o: 0.4,  w: 1.3 },
    requires:   { c: '#ffb648', o: 0.45, w: 1.3, d: [4, 3] },
    step_uses:  { c: '#5b8cff', o: 0.35, w: 1.3 },
    default:    { c: '#3a4c6e', o: 0.4,  w: 1 },
  };

  function buildLegend(data) {
    legendEl.innerHTML = '';
    // only show the groups actually present in this graph, in a stable order
    const present = {};
    data.nodes.forEach(function (n) { present[toGroup(n.group)] = 1; });
    ['robot', 'task', 'step', 'station', 'action', 'regulation', 'policy', 'object']
      .filter(function (g) { return present[g]; })
      .forEach(function (g) {
        const st = GROUP_STYLE[g];
        const d = document.createElement('div');
        d.className = 'li';
        d.innerHTML = '<span class="dot" style="background:' + st.color + '"></span>' + st.label;
        legendEl.appendChild(d);
      });
  }

  // dim everything, then spotlight the given ids (plus keep their labels)
  function highlight(ids) {
    if (!nodes) return;
    const set = {}; ids.forEach(function (i) { set[i] = 1; });
    nodes.update(allNodeIds.map(function (id) {
      const on = set[id];
      return { id: id, opacity: on ? 1 : 0.18, font: { color: on ? '#ffffff' : '#5f7196' } };
    }));
    if (ids.length) {
      network.selectNodes(ids.filter(function (i) { return set[i]; }));
      network.fit({ nodes: ids, animation: { duration: 600, easingFunction: 'easeInOutQuad' } });
    }
  }

  function reset() {
    if (!nodes) return;
    nodes.update(allNodeIds.map(function (id) { return { id: id, opacity: 1, font: { color: '#dfe8fb' } }; }));
    network.unselectAll();
    network.fit({ animation: { duration: 500 } });
  }

  function focus(id) {
    if (network) network.focus(id, { scale: 1.1, animation: { duration: 500 } });
  }

  window.Graph = {
    build: build,
    highlight: highlight,
    reset: reset,
    focus: focus,
    onSelect: function (cb) { selectCb = cb; },
  };
})();
