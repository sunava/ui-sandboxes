% ============================================================================
% kb_owl.pl — ontology-driven knowledge base for the AICOR scene (SWI-Prolog).
%
% The SWI WASM build does NOT ship the C semweb/rdf_db store, so we implement a
% small, self-contained OWL/RDFS layer over a plain triple store. This keeps
% ontologies EXCHANGEABLE and EXTENDABLE: load any ontology as t/3 triples
% (T-box) and any scene as t/3 triples (A-box), and every class/property becomes
% usable as a Prolog predicate automatically.
%
% Scene-graph nodes are SYMBOLIC IDENTIFIERS (atoms) so they live in the A-box.
% Manipulation predicates (highlight/1, make_grasp/2, make_trajectory/3) use
% procedural attachment: they assert effect facts the host (JS/USD/EQL) executes.
% ============================================================================

:- dynamic t/3.            % t(Subject, Predicate, Object) — the RDF-ish store
:- dynamic effect/1.       % procedural-attachment effects the host consumes
:- dynamic id_counter/1.

assert_t(S,P,O) :- ( t(S,P,O) -> true ; assertz(t(S,P,O)) ).

% ----------------------------------------------------------------- RDFS/OWL ---
class(C) :- t(C, rdf_type, owl_class).

subclass(C, C) :- class(C).                 % reflexive (once)
subclass(C, D) :- strict_subclass(C, D).    % proper ancestors (each once)
strict_subclass(C, D) :- t(C, subclass_of, D).
strict_subclass(C, E) :- t(C, subclass_of, D), strict_subclass(D, E).

% type with subsumption: an individual's asserted type and all its superclasses
% (subclass/2 is reflexive, so C0 itself is included — no duplicate branch)
isa(I, C) :- t(I, rdf_type, C0), C0 \== owl_class, subclass(C0, C).

individual(I) :- t(I, rdf_type, C), class(C).

% property helpers ----------------------------------------------------------
object_property(P)   :- t(P, rdf_type, owl_object_property).
datatype_property(P) :- t(P, rdf_type, owl_datatype_property).
property(P) :- object_property(P) ; datatype_property(P).

% generic accessor — every ontology property is queryable as prop/3
prop(I, P, V) :- t(I, P, V), property(P).

% ---- auto-generate concept & property predicates from the loaded ontology ---
% After loading an ontology, call bootstrap_predicates/0. Then e.g. reagent(X),
% vial(X), located_at(I,V), has_part(I,V) all work — straight from the ontology.
bootstrap_predicates :-
    forall(class(C), define_concept(C)),
    forall(property(P), define_property(P)).

define_concept(C) :-
    ( \+ current_predicate(C/1)
    -> ( H =.. [C, X], assertz((H :- isa(X, C))) )
    ;  true ).

define_property(P) :-
    ( \+ current_predicate(P/2)
    -> ( H =.. [P, I, V], assertz((H :- prop(I, P, V))) )
    ;  true ).

% ----------------------------------------------------- symbolic id minting ---
new_id(Prefix, Id) :-
    ( retract(id_counter(N)) -> true ; N = 0 ),
    N1 is N + 1, assertz(id_counter(N1)),
    atom_concat(Prefix, N1, Id).

% ------------------------------------------- procedural attachment / effects --
% highlight/1: mark a scene node for the host to highlight. The node MUST be a
% symbolic individual that exists in the A-box.
highlight(Node) :-
    individual(Node),
    assertz(effect(highlight(Node))).

% make_grasp/2: instantiate an artificial grasp pose for an object. The approach
% and offset are DERIVED from the object's ontology attributes (procedural
% attachment for instantiation). Returns a fresh symbolic grasp id.
make_grasp(Object, Grasp) :-
    isa(Object, lab_object),
    new_id(grasp_, Grasp),
    ( prop(Object, graspable_from, Dir) -> true ; Dir = top ),
    ( prop(Object, grasp_offset_m, Off) -> true ; Off = 0.02 ),
    assert_t(Grasp, rdf_type, grasp_pose),
    assert_t(Grasp, grasp_of, Object),
    assert_t(Grasp, approach_direction, Dir),
    assert_t(Grasp, approach_offset_m, Off),
    assertz(effect(spawn_grasp(Grasp, Object, Dir, Off))).

% make_trajectory/3: instantiate an artificial trajectory between two nodes.
make_trajectory(From, To, Traj) :-
    individual(From), individual(To),
    new_id(traj_, Traj),
    assert_t(Traj, rdf_type, trajectory),
    assert_t(Traj, traj_from, From),
    assert_t(Traj, traj_to, To),
    assertz(effect(spawn_trajectory(Traj, From, To))).

% the host drains effects after running a goal
take_effects(Es) :- findall(E, effect(E), Es), retractall(effect(_)).

% ============================================================================
%                       SAMPLE ONTOLOGY  (T-box)  — swappable
% ============================================================================
% classes
t(entity, rdf_type, owl_class).
t(physical_object, rdf_type, owl_class).  t(physical_object, subclass_of, entity).
t(lab_object, rdf_type, owl_class).       t(lab_object, subclass_of, physical_object).
t(reagent, rdf_type, owl_class).          t(reagent, subclass_of, lab_object).
t(media, rdf_type, owl_class).            t(media, subclass_of, reagent).
t(vial, rdf_type, owl_class).             t(vial, subclass_of, lab_object).
t(sample, rdf_type, owl_class).           t(sample, subclass_of, lab_object).
t(canister, rdf_type, owl_class).         t(canister, subclass_of, lab_object).
t(robot, rdf_type, owl_class).            t(robot, subclass_of, physical_object).
t(robot_part, rdf_type, owl_class).       t(robot_part, subclass_of, physical_object).
t(arm, rdf_type, owl_class).              t(arm, subclass_of, robot_part).
t(gripper, rdf_type, owl_class).          t(gripper, subclass_of, robot_part).
t(sensor, rdf_type, owl_class).           t(sensor, subclass_of, robot_part).
t(station, rdf_type, owl_class).          t(station, subclass_of, physical_object).
t(grasp_pose, rdf_type, owl_class).       t(grasp_pose, subclass_of, entity).
t(trajectory, rdf_type, owl_class).       t(trajectory, subclass_of, entity).
% properties
t(has_part, rdf_type, owl_object_property).
t(located_at, rdf_type, owl_object_property).
t(graspable_from, rdf_type, owl_datatype_property).
t(grasp_offset_m, rdf_type, owl_datatype_property).
t(has_color, rdf_type, owl_datatype_property).
t(grasp_of, rdf_type, owl_object_property).
t(approach_direction, rdf_type, owl_datatype_property).
t(approach_offset_m, rdf_type, owl_datatype_property).
t(traj_from, rdf_type, owl_object_property).
t(traj_to, rdf_type, owl_object_property).

% ============================================================================
%                    SAMPLE SCENE  (A-box)  — symbolic node ids
% ============================================================================
% robot & parts
t(tracy, rdf_type, robot).
t(tracy_left_arm, rdf_type, arm).          t(tracy, has_part, tracy_left_arm).
t(tracy_right_arm, rdf_type, arm).         t(tracy, has_part, tracy_right_arm).
t(tracy_left_gripper, rdf_type, gripper).  t(tracy_left_arm, has_part, tracy_left_gripper).
t(tracy_right_gripper, rdf_type, gripper). t(tracy_right_arm, has_part, tracy_right_gripper).
t(tracy_cam, rdf_type, sensor).            t(tracy, has_part, tracy_cam).
% bench objects (unique symbolic ids)
t(vial_tsb_01, rdf_type, media).           t(vial_tsb_01, has_color, amber).
  t(vial_tsb_01, graspable_from, front).   t(vial_tsb_01, grasp_offset_m, 0.03).
t(vial_ftm_01, rdf_type, media).           t(vial_ftm_01, has_color, pink).
  t(vial_ftm_01, graspable_from, front).   t(vial_ftm_01, grasp_offset_m, 0.03).
t(sample_01, rdf_type, sample).            t(sample_01, has_color, clear).
  t(sample_01, graspable_from, top).
t(canister_01, rdf_type, canister).        t(canister_01, has_color, blue).
