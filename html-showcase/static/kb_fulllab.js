/* ============================================================================
 * kb_fulllab.js — knowledge base for the mobile "Full Lab" scenario.
 *
 * A mobile robot (Toyota HSR) drives around a laboratory, fetching and
 * delivering samples / reagents / cultures between stations for the routine
 * tests a lab runs. Encodes the robot, the stations, the objects, the transport
 * tasks, the CRAM action designators, and — crucially — the safety POLICIES
 * that govern a robot sharing space and handling biological material.
 * ==========================================================================*/

const KB_SOURCE = `
% ------------------------------------------------------------------ robot ----
robot(hsr).
label(hsr, 'HSR (mobile manipulator)').
kind(hsr, robot).
descr(hsr, 'Toyota Human Support Robot: an omnidirectional mobile base with a 5-DoF arm, gripper and head RGB-D camera.').

has_part(hsr, mobile_base).   label(mobile_base,'Omnidirectional base'). kind(mobile_base, base).
has_part(hsr, hsr_arm).       label(hsr_arm,'5-DoF arm').               kind(hsr_arm, arm).
has_part(hsr, hsr_gripper).   label(hsr_gripper,'Parallel gripper').    kind(hsr_gripper, gripper).
has_part(hsr, head_camera).   label(head_camera,'Head RGB-D camera').  kind(head_camera, sensor).
has_part(hsr, base_lidar).    label(base_lidar,'Base laser scanner').  kind(base_lidar, sensor).

% ---------------------------------------------------------------- stations ---
station(storage).         label(storage,'Sample storage / fridge').        kind(storage, station).
station(sample_prep).     label(sample_prep,'Sample preparation bench').   kind(sample_prep, station).
station(centrifuge).      label(centrifuge,'Centrifuge').                  kind(centrifuge, station).
station(incubator).       label(incubator,'Incubator').                    kind(incubator, station).
station(analyzer).        label(analyzer,'Analyzer / spectrometer').       kind(analyzer, station).
station(disposal).        label(disposal,'Biohazard disposal').            kind(disposal, station).
station(sterility_cell).  label(sterility_cell,'Sterility test cell (Tracy)'). kind(sterility_cell, station).

% ---------------------------------------------------------------- objects ----
object(sample_rack).  label(sample_rack,'Rack of specimen tubes'). kind(sample_rack, object).
object(reagent_kit).  label(reagent_kit,'Reagent kit').            kind(reagent_kit, object).
object(culture_plate).label(culture_plate,'Culture plates').       kind(culture_plate, object).
object(specimen).     label(specimen,'Patient specimen').          kind(specimen, object).
object(tsb_supply).   label(tsb_supply,'Sterile media supply').    kind(tsb_supply, object).
object(waste_bag).    label(waste_bag,'Biohazard waste bag').      kind(waste_bag, object).

% ------------------------------------------------------------- transport -----
% task(Id). order(Id,N). from(Id,Station). to(Id,Station). carries(Id,Object).
task(fetch_samples).        torder(fetch_samples,1).        label(fetch_samples,'Fetch samples from storage').
task(prep_to_centrifuge).   torder(prep_to_centrifuge,2).   label(prep_to_centrifuge,'Carry tubes to the centrifuge').
task(incubate_cultures).    torder(incubate_cultures,3).    label(incubate_cultures,'Deliver cultures to the incubator').
task(deliver_analysis).     torder(deliver_analysis,4).     label(deliver_analysis,'Bring spun samples to the analyzer').
task(supply_sterility).     torder(supply_sterility,5).     label(supply_sterility,'Resupply the sterility cell').
task(remove_waste).         torder(remove_waste,6).         label(remove_waste,'Take biohazard waste to disposal').

kind(X, task) :- task(X).

from(fetch_samples, storage).        to(fetch_samples, sample_prep).       carries(fetch_samples, sample_rack).
from(prep_to_centrifuge, sample_prep). to(prep_to_centrifuge, centrifuge). carries(prep_to_centrifuge, specimen).
from(incubate_cultures, sample_prep). to(incubate_cultures, incubator).    carries(incubate_cultures, culture_plate).
from(deliver_analysis, centrifuge).  to(deliver_analysis, analyzer).       carries(deliver_analysis, specimen).
from(supply_sterility, storage).     to(supply_sterility, sterility_cell). carries(supply_sterility, tsb_supply).
from(remove_waste, sample_prep).     to(remove_waste, disposal).           carries(remove_waste, waste_bag).

% ----------------------------------------------- CRAM action designators -----
action(navigate).   label(navigate,'NavigateAction').  module(navigate,'pycram/robot_plans/actions/core/navigation.py').
action(look_at).    label(look_at,'LookAtAction').      module(look_at,'pycram/robot_plans/actions/composite/facing.py').
action(detect).     label(detect,'DetectAction').       module(detect,'pycram/robot_plans/actions/composite/searching.py').
action(pick_up).    label(pick_up,'PickUpAction').      module(pick_up,'pycram/robot_plans/actions/core/pick_up.py').
action(place).      label(place,'PlaceAction').         module(place,'pycram/robot_plans/actions/core/placing.py').
action(transport).  label(transport,'TransportAction'). module(transport,'pycram/robot_plans/actions/composite/transporting.py').
action(open_act).   label(open_act,'OpenAction').       module(open_act,'pycram/robot_plans/actions/core/container.py').
action(park_arms).  label(park_arms,'ParkArmsAction').  module(park_arms,'pycram/robot_plans/actions/core/robot_body.py').
action(move_torso). label(move_torso,'MoveTorsoAction').module(move_torso,'pycram/robot_plans/actions/core/robot_body.py').

kind(X, action) :- action(X).

% every transport shares the same skeleton of designators
task_action(T, park_arms) :- task(T).
task_action(T, navigate)  :- task(T).
task_action(T, look_at)   :- task(T).
task_action(T, detect)    :- task(T).
task_action(T, pick_up)   :- task(T).
task_action(T, transport) :- task(T).
task_action(T, place)     :- task(T).
% tasks that leave a closed unit (fridge, disposal, incubator) also open it
task_action(fetch_samples, open_act).
task_action(incubate_cultures, open_act).
task_action(remove_waste, open_act).
task_action(supply_sterility, move_torso).

% ------------------------------------------------------ safety policies ------
policy(iso13482).  label(iso13482,'ISO 13482').
  scope(iso13482,'Safety of personal-care / service robots operating around people.'). authority(iso13482,'ISO').
policy(iso3691_4). label(iso3691_4,'ISO 3691-4').
  scope(iso3691_4,'Driverless industrial trucks / AMR navigation safety.'). authority(iso3691_4,'ISO').
policy(speed_zones). label(speed_zones,'Speed-zone limiting').
  scope(speed_zones,'Reduce speed in occupied / human-shared areas of the lab.'). authority(speed_zones,'Site risk assessment').
policy(right_of_way). label(right_of_way,'Yield to humans').
  scope(right_of_way,'Give way and keep safe separation from people in corridors.'). authority(right_of_way,'Operating policy').
policy(collision_avoidance). label(collision_avoidance,'Collision avoidance').
  scope(collision_avoidance,'Continuous lidar/camera obstacle detection and safe stopping.'). authority(collision_avoidance,'ISO 3691-4 / TS 15066').
policy(payload_securement). label(payload_securement,'Payload securement').
  scope(payload_securement,'Grasp and hold the load so it cannot fall or spill in transit.'). authority(payload_securement,'GMP good practice').
policy(contamination_control). label(contamination_control,'Contamination control').
  scope(contamination_control,'No cross-contamination between samples; gowning / route rules for sterile zones.'). authority(contamination_control,'EU GMP Annex 1').
policy(biohazard_handling). label(biohazard_handling,'Biohazard handling').
  scope(biohazard_handling,'Sealed transport and correct disposal of biological waste.'). authority(biohazard_handling,'Biosafety / WHO LBM').
policy(sterile_zone_entry). label(sterile_zone_entry,'Sterile-zone entry rules').
  scope(sterile_zone_entry,'Only decontaminated loads and approved routes may enter the sterility cell.'). authority(sterile_zone_entry,'EU GMP Annex 1').
policy(emergency_stop). label(emergency_stop,'Emergency stop').
  scope(emergency_stop,'Reachable e-stop and safe halt on fault or human contact.'). authority(emergency_stop,'ISO 13482').

kind(X, policy) :- policy(X).

% baseline policies apply to every mobile task…
requires(T, iso13482)           :- task(T).
requires(T, iso3691_4)          :- task(T).
requires(T, collision_avoidance):- task(T).
requires(T, speed_zones)        :- task(T).
requires(T, right_of_way)       :- task(T).
requires(T, emergency_stop)     :- task(T).
% …and task-specific ones:
requires(T, payload_securement) :- carries(T, _).
requires(T, contamination_control) :- carries(T, sample_rack).
requires(T, contamination_control) :- carries(T, specimen).
requires(T, contamination_control) :- carries(T, culture_plate).
requires(remove_waste, biohazard_handling).
requires(supply_sterility, sterile_zone_entry).
requires(supply_sterility, contamination_control).

% ------------------------------------------------------- rules / queries -----
relevant_policy(Task, P) :- requires(Task, P).
uses_action(Task, A)     :- task_action(Task, A).
route(Task, A, B)        :- from(Task, A), to(Task, B).
transports(Task, Obj)    :- carries(Task, Obj).

% a task is safety-critical if it enters a sterile zone or carries biohazard
safety_critical(T) :- requires(T, sterile_zone_entry).
safety_critical(T) :- requires(T, biohazard_handling).
`;

/* station positions on the lab floor (world X,Z metres) for the 3D scene */
const STATIONS = {
  storage:        { x: -3.2, z: -2.0, color: 0x4bd38a, label: 'Storage' },
  sample_prep:    { x:  0.0, z: -3.2, color: 0x39d5c8, label: 'Sample prep' },
  centrifuge:     { x:  3.2, z: -1.8, color: 0x5b8cff, label: 'Centrifuge' },
  incubator:      { x:  3.4, z:  1.4, color: 0xffb648, label: 'Incubator' },
  analyzer:       { x:  1.4, z:  3.2, color: 0xb98cff, label: 'Analyzer' },
  disposal:       { x: -3.2, z:  2.2, color: 0xff6b8b, label: 'Disposal' },
  sterility_cell: { x: -1.6, z:  3.2, color: 0x8ff0e7, label: 'Sterility cell' },
};
const OBJECT_COLORS = {
  sample_rack: 0x9fd3e6, reagent_kit: 0xcf9a3a, culture_plate: 0xd98aa6,
  specimen: 0x7fb2e6, tsb_supply: 0xeef2f7, waste_bag: 0xff6b8b,
};
if (typeof window !== 'undefined') { window.STATIONS = STATIONS; window.OBJECT_COLORS = OBJECT_COLORS; }

/* Pharma-lab tycoon: an event that can pop up at each station. `task` links to
 * the KB task whose safety policies/actions are shown when the robot handles it;
 * `fail` is the consequence if the operator ignores it too long. */
const STATION_EVENTS = {
  storage:        { icon: '🧴', obj: 'reagent_kit',   title: 'Reagent restock needed',   task: 'fetch_samples',      fail: 'Reagent ran out — batch delayed' },
  sample_prep:    { icon: '🧪', obj: 'sample_rack',   title: 'New samples to prepare',   task: 'prep_to_centrifuge', fail: 'Samples degraded on the bench' },
  centrifuge:     { icon: '⚗️', obj: 'specimen',      title: 'Spin-down complete',       task: 'deliver_analysis',   fail: 'Pellet resuspended — re-run needed' },
  incubator:      { icon: '🧫', obj: 'culture_plate', title: 'Cultures ready to move',   task: 'incubate_cultures',  fail: 'Over-incubation — cultures spoiled' },
  analyzer:       { icon: '📊', obj: 'specimen',      title: 'Result ready to log',      task: 'deliver_analysis',   fail: 'Result lost — data-integrity flag' },
  disposal:       { icon: '☣️', obj: 'waste_bag',     title: 'Biohazard waste is full',  task: 'remove_waste',       fail: 'Biohazard spill!' },
  sterility_cell: { icon: '🧼', obj: 'tsb_supply',    title: 'Resupply the sterility cell', task: 'supply_sterility', fail: 'Sterility breach in the cell' },
};
if (typeof window !== 'undefined') window.STATION_EVENTS = STATION_EVENTS;

/* CRAM designator templates for the mobile actions */
const ACTION_DESIGNATORS = {
  park_arms:  ['parking-arms', [['arms', '(:left)']]],
  move_torso: ['moving-torso', [['position', ':upper-limit']]],
  navigate:   ['navigating', [['location', '(a location (of (a station (name $TGT))))']]],
  look_at:    ['looking', [['target', '(a location (object (an object (type $OBJ))))']]],
  detect:     ['detecting', [['object', '(an object (type $OBJ))'], ['using', ':robokudo']]],
  pick_up:    ['picking-up', [['arm', ':left'], ['object', '(an object (type $OBJ))'], ['grasp', ':top']]],
  place:      ['placing', [['arm', ':left'], ['object', '(an object (type $OBJ))'], ['target', '(a location (of (a station (name $TGT))))']]],
  transport:  ['transporting', [['object', '(an object (type $OBJ))'], ['arm', ':left'], ['target', '(a location (of (a station (name $TGT))))']]],
  open_act:   ['opening', [['arm', ':left'], ['object', '(an object (type $SRC) (part-of container))']]],
};
if (typeof window !== 'undefined') window.ACTION_DESIGNATORS = ACTION_DESIGNATORS;

const KB_PRESETS = [
  { id: 'pol_task', text: 'Which safety policies govern the waste-disposal run?',
    goal: 'relevant_policy(remove_waste, P).', focus: 'P' },
  { id: 'pol_sterile', text: 'What rules apply when resupplying the sterility cell?',
    goal: 'relevant_policy(supply_sterility, P).', focus: 'P' },
  { id: 'route', text: 'Where does each transport go (A → B)?',
    goal: 'route(T, A, B).', focus: 'T' },
  { id: 'actions', text: 'Which action designators build a transport?',
    goal: 'uses_action(fetch_samples, A).', focus: 'A' },
  { id: 'crit', text: 'Which tasks are safety-critical?',
    goal: 'safety_critical(T).', focus: 'T' },
  { id: 'carry', text: 'What does the robot carry, and for which task?',
    goal: 'transports(T, O).', focus: 'O' },
];
