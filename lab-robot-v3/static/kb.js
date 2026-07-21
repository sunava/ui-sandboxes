/* ============================================================================
 * kb.js — wiring for the REAL AICOR L2 knowledge base.
 *
 * The knowledge base is no longer hand-written here. It is the actual AICOR L2
 * ontology, compiled to Prolog facts by the framework's own tool:
 *
 *     static/aicor-kb.pl     GENERATED — TBox (class/1, subclass_of/2, the
 *                            restriction facts, disjoint/2) + the worked-example
 *                            ABoxes (ex_individual/3, ex_triple/4, in_example/2).
 *                            Regenerate with  tools/build-kb.sh.
 *     static/aicor-rules.pl  the portable rule / query layer (subclass/2, isa/2,
 *                            constraint/4, triple/3, …) that sits on top.
 *
 * This module just loads those two files into a tau-prolog session and exposes
 * the catalogue of worked examples + the query presets the UI shows.
 * ==========================================================================*/

const AICOR_KB_FILES = ['static/aicor-rules.pl', 'static/aicor-kb.pl'];

/* Fetch + consult the KB into a tau-prolog session. Resolves when ready. */
function loadAicorKB(session) {
  return Promise.all(AICOR_KB_FILES.map(function (f) {
    return fetch(f).then(function (r) {
      if (!r.ok) throw new Error('cannot load ' + f + ' (' + r.status + ')');
      return r.text();
    });
  })).then(function (parts) {
    const program = parts.join('\n');
    return new Promise(function (resolve, reject) {
      session.consult(program, {
        success: function () { resolve(); },
        error: function (e) { reject(pl.format_answer(e)); },
      });
    });
  });
}

/* The worked-example ABoxes shipped with the ontology (the `in_example/2` tags).
 * `focus` is the individual we centre the view on when the example is opened. */
const KB_EXAMPLES = [
  { tag: 'tracy',               label: 'Tracy · the robot',       focus: 'tracy',         blurb: 'The dual-arm workcell itself — links, joints, grippers and camera from tracy.urdf, as a kinematic tree instantiating the L2 body model.' },
  { tag: 'egg-crack',           label: 'Crack an egg',            focus: 'E_egg_crack',   blurb: 'Fracture a shell over a bowl without contaminating the yolk.' },
  { tag: 'egg-inspect',         label: 'Inspect an egg',          focus: 'E_egg_inspect', blurb: 'Look the egg over before committing to a manipulation.' },
  { tag: 'egg-lift',            label: 'Lift an egg',             focus: 'E_egg_lift',    blurb: 'Grasp-and-lift a fragile object under a force corridor.' },
  { tag: 'pour',                label: 'Pour (continuous flow)',  focus: 'E',             blurb: 'The bare pouring baseline: tip → flow → stop.' },
  { tag: 'milk',                label: 'Pour milk (baseline)',    focus: 'E_milk_1',      blurb: 'A concrete milk pour into an empty receiver.' },
  { tag: 'pour-milk-coffee',    label: 'Pour milk into coffee',   focus: 'E_mc_ok',       blurb: 'Miscible pour to a ratio target, coffee already in the mug.' },
  { tag: 'pour-beer-glass',     label: 'Pour beer into a glass',  focus: 'E_beer_ok',     blurb: 'Pour with a foam head — a two-phase substance.' },
  { tag: 'pour-pancake-pan',    label: 'Pour batter onto a pan',  focus: null,            blurb: 'Open-surface spreading of a viscous substance.' },
  { tag: 'fetch-milk-pipeline', label: 'Fetch the milk (pipeline)', focus: null,          blurb: 'A full proposal → commitment → execution transport pipeline.' },
];
if (typeof window !== 'undefined') {
  window.loadAicorKB = loadAicorKB;
  window.KB_EXAMPLES = KB_EXAMPLES;
}

/* One-click query presets. `goal` is a raw Prolog goal; `focus` names the
 * variable whose bindings we spotlight in the graph (a list var is rendered
 * as a list). These exercise both the TBox and the ABox. */
const KB_PRESETS = [
  { id: 'tracy_parts', text: 'Which parts does Tracy have?',
    goal: 'robot_part(tracy, P).', focus: 'P', example: 'tracy' },
  { id: 'tracy_actuated', text: 'Which of Tracy’s joints are actuated?',
    goal: 'triple(J, actuatedBy, M).', focus: 'J', example: 'tracy' },
  { id: 'roots',   text: 'What are the top-level (root) concepts?',
    goal: 'root_class(C).', focus: 'C' },
  { id: 'supers',  text: 'What is an AchievementGoal, ontologically? (its superclasses)',
    goal: "superclasses('AchievementGoal', L).", focus: 'L' },
  { id: 'constr',  text: 'What must an ArticulatedObject have? (its OWL restrictions)',
    goal: "constraint('ArticulatedObject', P, K, F).", focus: 'F' },
  { id: 'episodes',text: 'Which individuals are manipulation episodes?',
    goal: "isa(I, 'ManipulationEpisode').", focus: 'I' },
  { id: 'goals',   text: 'Which goals does the egg-crack problem carry?',
    goal: "ex_triple('egg-crack', P_egg_crack, hasGoal, G).", focus: 'G' },
  { id: 'disjoint',text: 'What is declared disjoint from PhysicalEntity?',
    goal: "incompatible('PhysicalEntity', X).", focus: 'X' },
];
if (typeof window !== 'undefined') window.KB_PRESETS = KB_PRESETS;

/* Short labels for the 3D bench objects (used by robot.js for floating tags).
 * Kept from the lab render; independent of the ontology KB above. */
const PROP_LABELS = {
  sterility_canister: 'Sterility canister',
  media_tsb: 'TSB media',
  media_ftm: 'FTM media',
  sample_product: 'Product sample',
  rinse_fluid: 'Rinsing fluid',
  waste_container: 'Waste',
  peristaltic_pump: 'Pump',
};
if (typeof window !== 'undefined') window.PROP_LABELS = PROP_LABELS;
