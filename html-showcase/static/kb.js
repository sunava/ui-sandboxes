/* ============================================================================
 * TraceBot knowledge base (Prolog, executed client-side via tau-prolog)
 *
 * Encodes the membrane-based sterility-testing world of the TraceBot lab:
 *   - Tracy the robot and its kinematic parts
 *   - the objects on the workbench
 *   - the sterility-testing workflow (Ph. Eur. 2.6.1 / USP <71>)
 *   - the safety / regulatory constraints that apply to each task
 *   - the CRAM action designators (from cram_cognitive_architecture / pycram)
 *     that realise each task
 *
 * The facts are intentionally readable so the graph and the query panel can be
 * derived from the same source of truth.
 * ==========================================================================*/

const KB_SOURCE = `
% ------------------------------------------------------------------ robot ----
robot(tracy).
label(tracy, 'Tracy').
kind(tracy, robot).
descr(tracy, 'Dual-arm laboratory robot: two UR10e arms on a bench with a camera pole between them.').

has_part(tracy, left_arm).
has_part(tracy, right_arm).
has_part(tracy, left_gripper).
has_part(tracy, right_gripper).
has_part(tracy, camera).

label(left_arm,  'Left UR10e arm').      kind(left_arm, arm).
label(right_arm, 'Right UR10e arm').     kind(right_arm, arm).
label(left_gripper,  'Left Robotiq 2F-85 gripper').  kind(left_gripper, gripper).
label(right_gripper, 'Right Robotiq 2F-85 gripper'). kind(right_gripper, gripper).
label(camera, 'Wrist / pole RGB-D camera').          kind(camera, sensor).

part_of(left_gripper, left_arm).
part_of(right_gripper, right_arm).

% ---------------------------------------------------------------- objects ----
object(sterility_canister). label(sterility_canister,'Steritest sterility canister'). kind(sterility_canister,object).
object(media_tsb).          label(media_tsb,'TSB media bottle (Tryptic Soy Broth)').  kind(media_tsb,object).
object(media_ftm).          label(media_ftm,'FTM media bottle (Fluid Thioglycollate)'). kind(media_ftm,object).
object(sample_product).     label(sample_product,'Product sample to be tested').       kind(sample_product,object).
object(rinse_fluid).        label(rinse_fluid,'Sterile rinsing fluid').                kind(rinse_fluid,object).
object(transfer_set).       label(transfer_set,'Transfer set / spike + tubing').       kind(transfer_set,object).
object(peristaltic_pump).   label(peristaltic_pump,'Peristaltic pump').                kind(peristaltic_pump,object).
object(forceps).            label(forceps,'Sterile forceps').                          kind(forceps,object).
object(waste_container).    label(waste_container,'Waste / biohazard container').     kind(waste_container,object).
object(workbench).          label(workbench,'Aseptic workbench (Grade A)').           kind(workbench,object).

% -------------------------------------------------------------- workflow -----
% step(Id). step_order(Id, N). label(Id, Text). Steps model the membrane-based
% sterility test as run in the TraceBot cell.
step(prep).            step_order(prep,1).            label(prep,'Prepare aseptic workspace').
step(disinfect).       step_order(disinfect,2).       label(disinfect,'Disinfect surfaces & ports').
step(open_canister).   step_order(open_canister,3).   label(open_canister,'Open / prime sterility canister').
step(spike_media).     step_order(spike_media,4).     label(spike_media,'Spike media bottles').
step(filter_transfer). step_order(filter_transfer,5). label(filter_transfer,'Filter the product sample').
step(rinse).           step_order(rinse,6).           label(rinse,'Rinse the membranes').
step(fill_media).      step_order(fill_media,7).      label(fill_media,'Fill canister with TSB & FTM').
step(incubate).        step_order(incubate,8).        label(incubate,'Transfer to incubation').
step(inspect).         step_order(inspect,9).         label(inspect,'Inspect for microbial growth').
step(document).        step_order(document,10).       label(document,'Record traceable audit trail').

kind(X,step) :- step(X).

% the overall task is the composition of all steps
task(sterility_test).
label(sterility_test,'Membrane-based sterility test').
kind(sterility_test,task).
part_of(S, sterility_test) :- step(S).

% which objects each step manipulates
step_uses(prep, workbench).
step_uses(disinfect, workbench).      step_uses(disinfect, forceps).
step_uses(open_canister, sterility_canister).
step_uses(spike_media, media_tsb).    step_uses(spike_media, media_ftm).    step_uses(spike_media, transfer_set).
step_uses(filter_transfer, sample_product). step_uses(filter_transfer, sterility_canister). step_uses(filter_transfer, peristaltic_pump).
step_uses(rinse, rinse_fluid).         step_uses(rinse, sterility_canister).
step_uses(fill_media, media_tsb).      step_uses(fill_media, media_ftm).     step_uses(fill_media, sterility_canister).
step_uses(incubate, sterility_canister).
step_uses(inspect, sterility_canister). step_uses(inspect, camera).
step_uses(document, camera).

% ----------------------------------------------- CRAM action designators -----
% action(Id). label(Id,Class). module(Id,File). purpose(Id,Text).
action(park_arms).   label(park_arms,'ParkArmsAction').   module(park_arms,'pycram/robot_plans/actions/core/robot_body.py').
action(navigate).    label(navigate,'NavigateAction').    module(navigate,'pycram/robot_plans/actions/core/navigation.py').
action(move_torso).  label(move_torso,'MoveTorsoAction'). module(move_torso,'pycram/robot_plans/actions/core/robot_body.py').
action(look_at).     label(look_at,'LookAtAction').       module(look_at,'pycram/robot_plans/actions/composite/facing.py').
action(detect).      label(detect,'DetectAction').        module(detect,'pycram/robot_plans/actions/composite/searching.py').
action(wiping).      label(wiping,'WipingAction').        module(wiping,'pycram/robot_plans/actions/composite/tool_based.py').
action(reach).       label(reach,'ReachAction').          module(reach,'pycram/robot_plans/actions/core/pick_up.py').
action(grasp).       label(grasp,'GraspingAction').       module(grasp,'pycram/robot_plans/actions/core/pick_up.py').
action(set_gripper). label(set_gripper,'SetGripperAction').module(set_gripper,'pycram/robot_plans/actions/core/robot_body.py').
action(pick_up).     label(pick_up,'PickUpAction').       module(pick_up,'pycram/robot_plans/actions/core/pick_up.py').
action(place).       label(place,'PlaceAction').          module(place,'pycram/robot_plans/actions/core/placing.py').
action(transport).   label(transport,'TransportAction').  module(transport,'pycram/robot_plans/actions/composite/transporting.py').
action(open_act).    label(open_act,'OpenAction').        module(open_act,'pycram/robot_plans/actions/core/container.py').
action(close_act).   label(close_act,'CloseAction').      module(close_act,'pycram/robot_plans/actions/core/container.py').
action(cutting).     label(cutting,'CuttingAction').      module(cutting,'pycram/robot_plans/actions/composite/tool_based.py').
action(pouring).     label(pouring,'SimplePouringAction').module(pouring,'pycram/robot_plans/actions/composite/tool_based.py').
action(follow_tcp).  label(follow_tcp,'FollowToolCenterPointPathAction'). module(follow_tcp,'pycram/robot_plans/actions/core/robot_body.py').

kind(X,action) :- action(X).

% step_action(Step, Action): which designators realise each step
step_action(prep, park_arms).       step_action(prep, move_torso).
step_action(disinfect, wiping).     step_action(disinfect, follow_tcp).
step_action(open_canister, open_act). step_action(open_canister, reach).
step_action(spike_media, pick_up).  step_action(spike_media, cutting). step_action(spike_media, set_gripper).
step_action(filter_transfer, pick_up). step_action(filter_transfer, transport). step_action(filter_transfer, follow_tcp).
step_action(rinse, pouring).        step_action(rinse, follow_tcp).
step_action(fill_media, pouring).   step_action(fill_media, place).
step_action(incubate, pick_up).     step_action(incubate, transport). step_action(incubate, place).
step_action(inspect, look_at).      step_action(inspect, detect).
step_action(document, detect).

% ------------------------------------------------------ safety / regs --------
% regulation(Id). label(Id,Short). scope(Id,Text). authority(Id,Body).
regulation(eu_gmp_annex1). label(eu_gmp_annex1,'EU GMP Annex 1').
  scope(eu_gmp_annex1,'Manufacture of sterile medicinal products; contamination control & aseptic processing.').
  authority(eu_gmp_annex1,'European Commission / EMA').
regulation(ph_eur_261). label(ph_eur_261,'Ph. Eur. 2.6.1 / USP <71>').
  scope(ph_eur_261,'The sterility test method itself: media, incubation, membrane filtration.').
  authority(ph_eur_261,'EDQM / USP').
regulation(iso14644). label(iso14644,'ISO 14644').
  scope(iso14644,'Cleanroom air cleanliness classification (Grade A/B environment).').
  authority(iso14644,'ISO').
regulation(aseptic). label(aseptic,'Aseptic technique').
  scope(aseptic,'No-touch / no-contamination handling of sterile fluid paths and product.').
  authority(aseptic,'GMP good practice').
regulation(iso10218). label(iso10218,'ISO 10218-1/2').
  scope(iso10218,'Safety requirements for industrial robots and their integration.').
  authority(iso10218,'ISO').
regulation(iso_ts_15066). label(iso_ts_15066,'ISO/TS 15066').
  scope(iso_ts_15066,'Collaborative robots: power- & force-limiting, contact safety with humans.').
  authority(iso_ts_15066,'ISO').
regulation(iso14971). label(iso14971,'ISO 14971').
  scope(iso14971,'Risk management for medical devices / processes.').
  authority(iso14971,'ISO').
regulation(iso13485). label(iso13485,'ISO 13485').
  scope(iso13485,'Quality management system for medical devices.').
  authority(iso13485,'ISO').
regulation(cfr_part11). label(cfr_part11,'FDA 21 CFR Part 11 / ALCOA+').
  scope(cfr_part11,'Electronic records, electronic signatures and data-integrity of the audit trail.').
  authority(cfr_part11,'US FDA').

kind(X,regulation) :- regulation(X).

% requires(Step, Regulation): the safety / regulatory constraints on a step
requires(prep, iso14644).      requires(prep, eu_gmp_annex1).   requires(prep, iso10218).
requires(disinfect, aseptic).  requires(disinfect, eu_gmp_annex1). requires(disinfect, iso_ts_15066).
requires(open_canister, aseptic). requires(open_canister, eu_gmp_annex1).
requires(spike_media, aseptic).   requires(spike_media, eu_gmp_annex1). requires(spike_media, iso_ts_15066).
requires(filter_transfer, aseptic). requires(filter_transfer, ph_eur_261). requires(filter_transfer, eu_gmp_annex1).
requires(rinse, aseptic).      requires(rinse, ph_eur_261).
requires(fill_media, aseptic). requires(fill_media, ph_eur_261). requires(fill_media, eu_gmp_annex1).
requires(incubate, ph_eur_261). requires(incubate, iso_ts_15066).
requires(inspect, ph_eur_261). requires(inspect, iso14971).
requires(document, cfr_part11). requires(document, iso13485).

% robot-motion safety (ISO 10218) applies whenever an arm moves near the
% operator, i.e. on every step. prep already lists it as a fact above, so the
% rule covers the remaining steps exactly once each.
requires(S, iso10218) :- step(S), S \\= prep.

% ------------------------------------------------------- rules / queries -----
% The high-value inference the demo shows off:

% which safety regulations are important for a given task/step
relevant_regulation(Step, Reg) :- requires(Step, Reg).
% ...and for the whole test, anything required by any of its steps
relevant_regulation(sterility_test, Reg) :- step(S), requires(S, Reg).

% which action designators are needed for a task/step
uses_action(Step, Action) :- step_action(Step, Action).
uses_action(sterility_test, Action) :- step(S), step_action(S, Action).

% which objects a task touches
touches(Step, Obj) :- step_uses(Step, Obj).
touches(sterility_test, Obj) :- step(S), step_uses(S, Obj).

% a step is safety-critical if it has an aseptic or human-contact constraint
safety_critical(Step) :- requires(Step, aseptic).
safety_critical(Step) :- requires(Step, iso_ts_15066).

% ordered listing helper
before(A,B) :- step_order(A,Na), step_order(B,Nb), Na < Nb.
`;

/* Short labels for the 3D bench objects (floating tags in the scene). Ids match
 * the object nodes in the knowledge base so highlighting stays in sync. */
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

/* CRAM designator templates per action id (see designators.js for the format).
 * These are rendered in LISP style in the answer panel. */
const ACTION_DESIGNATORS = {
  park_arms:  ['parking-arms', [['arms', '(:left :right)']]],
  navigate:   ['navigating', [['location', '(a location (pose $LOC))']]],
  move_torso: ['moving-torso', [['position', ':upper-limit']]],
  look_at:    ['looking', [['target', '(a location (object (an object (type $OBJ))))']]],
  detect:     ['detecting', [['object', '(an object (type $OBJ))'], ['using', ':robokudo']]],
  wiping:     ['wiping', [['arm', '$ARM'], ['surface', '(an object (type workbench))'], ['tool', '(an object (type wipe))']]],
  reach:      ['reaching', [['arm', '$ARM'], ['target', '(a location (object (an object (type $OBJ))))']]],
  grasp:      ['grasping', [['arm', '$ARM'], ['object', '(an object (type $OBJ))'], ['grasp', ':front']]],
  set_gripper:['setting-gripper', [['gripper', '$ARM'], ['motion', ':close']]],
  pick_up:    ['picking-up', [['arm', '$ARM'], ['object', '(an object (type $OBJ))'], ['grasp', ':top']]],
  place:      ['placing', [['arm', '$ARM'], ['object', '(an object (type $OBJ))'], ['target', '(a location (pose $LOC))']]],
  transport:  ['transporting', [['object', '(an object (type $OBJ))'], ['arm', '$ARM'], ['target', '(a location (pose $LOC))']]],
  open_act:   ['opening', [['arm', '$ARM'], ['object', '(an object (type $OBJ) (part-of container))']]],
  close_act:  ['closing', [['arm', '$ARM'], ['object', '(an object (type $OBJ) (part-of container))']]],
  cutting:    ['piercing', [['arm', '$ARM'], ['object', '(an object (type $OBJ))'], ['tool', '(an object (type transfer-set))']]],
  pouring:    ['pouring', [['arm', '$ARM'], ['source', '(an object (type $SRC))'], ['target', '(an object (type sterility-canister))']]],
  follow_tcp: ['following-tcp-path', [['arm', '$ARM'], ['poses', '(the trajectory)']]],
};
if (typeof window !== 'undefined') window.ACTION_DESIGNATORS = ACTION_DESIGNATORS;

/* Presets shown as one-click chips in the query panel. `goal` is the raw
 * Prolog goal; `vars` are the variables to report. */
const KB_PRESETS = [
  { id: 'reg_task',   text: 'Which safety regulations matter for the sterility test?',
    goal: 'relevant_regulation(sterility_test, R).', focus: 'R' },
  { id: 'reg_step',   text: 'Which regulations apply when spiking the media bottles?',
    goal: 'relevant_regulation(spike_media, R).', focus: 'R' },
  { id: 'actions',    text: 'Which CRAM action designators realise the filtering step?',
    goal: 'uses_action(filter_transfer, A).', focus: 'A' },
  { id: 'safety_crit',text: 'Which steps are safety-critical?',
    goal: 'safety_critical(S).', focus: 'S' },
  { id: 'touch',      text: 'Which objects does the whole test touch?',
    goal: 'touches(sterility_test, O).', focus: 'O' },
  { id: 'parts',      text: 'What parts does Tracy have?',
    goal: 'has_part(tracy, P).', focus: 'P' },
];
