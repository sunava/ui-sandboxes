% ============================================================================
% aicor-rules.pl — the rule / query layer over the generated aicor-kb.pl facts.
%
% aicor-kb.pl ships the AICOR L2 ontology as GROUND facts (class/1, subclass_of/2,
% restriction/4, restriction_card/5, restriction_value/3, disjoint/2) plus the
% worked-example ABoxes (ex_individual/3, ex_triple/4, in_example/2). This file
% adds the small, portable rule layer that makes them queryable — RDFS-style
% subsumption, a single readable `constraint/4` view over the OWL restrictions,
% and ABox accessors.
%
% Written to the subset of Prolog that tau-prolog supports (the in-browser
% engine): no aggregate_all/3, no discontiguous prefix directive.
% ============================================================================

:- set_prolog_flag(double_quotes, atom).
:- use_module(library(lists)).

% ---- RDFS subsumption (reflexive + transitive over named subclass edges) ----
% subclass/2 is reflexive for ANY type atom (ABox-local types such as Substance
% are not asserted as class/1, so we must not gate reflexivity on class/1).
subclass(C, C).
subclass(C, D) :- subclass_of(C, D).
subclass(C, E) :- subclass_of(C, D), subclass(D, E).

% de-duplicated ancestor / descendant lists (excluding the class itself)
superclasses(C, L) :- ( setof(S, ( subclass(C, S), S \= C ), L) -> true ; L = [] ).
subclasses(C, L)   :- ( setof(S, ( subclass(S, C), S \= C ), L) -> true ; L = [] ).

% direct (named) parent / child edges and taxonomy roots
parent(C, D)  :- subclass_of(C, D).
child(C, D)   :- subclass_of(D, C).
root_class(C) :- class(C), \+ subclass_of(C, _).

% ---- OWL restrictions, as one readable relation ----------------------------
% constraint(Class, Property, Kind, Filler) where Kind is one of:
%   some | all | exactly | min | max | value
constraint(C, P, some,  F) :- restriction(C, P, some, F).
constraint(C, P, all,   F) :- restriction(C, P, all,  F).
constraint(C, P, Kind,  F) :- restriction_card(C, P, Kind, _, F).
constraint(C, P, value, V) :- restriction_value(C, P, V).

% cardinality kept with its number when you want it
constraint_card(C, P, Kind, N, F) :- restriction_card(C, P, Kind, N, F).

% ---- ABox (worked examples) -------------------------------------------------
individual(I)         :- ex_individual(_, I, _).
individual_type(I, C) :- ex_individual(_, I, C).

% typed membership with subsumption: isa(egg, PhysicalEntity) etc.
isa(I, C) :- ex_individual(_, I, C0), subclass(C0, C).

% object-property assertions between individuals
triple(S, P, O) :- ex_triple(_, S, P, O).

% provenance: which worked example an individual belongs to
example(I, Tag) :- in_example(I, Tag).

% ---- robot body parts (works for any Robot ABox, e.g. Tracy) ----------------
% a body's direct components: its links, joints, end-effectors and sensors
has_component(Body, C) :- triple(Body, hasLink, C).
has_component(Body, C) :- triple(Body, hasJoint, C).
has_component(Body, C) :- triple(Body, hasEndEffector, C).
has_component(Body, C) :- triple(Body, hasSensor, C).

% robot_part(Robot, Part): the robot's body plus everything it is composed of
robot_part(R, Body) :- triple(R, hasProperPart, Body).
robot_part(R, C)    :- triple(R, hasProperPart, Body), has_component(Body, C).

% ---- disjointness, made symmetric ------------------------------------------
incompatible(A, B) :- disjoint(A, B).
incompatible(A, B) :- disjoint(B, A).
