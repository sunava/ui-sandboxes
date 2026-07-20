#!/usr/bin/env python3
"""
okf_prolog.py — compile the AICOR L2 ontology (OWL/TTL) + the worked-example
ABoxes into a single, self-contained Prolog fact base (`aicor-kb.pl`) that the
in-browser SWI-Prolog (swipl-wasm) workbench consults.

Why compile to plain facts instead of loading OWL in the browser? The workbench
runs SWI-Prolog in WebAssembly with no server round-trip; shipping the TBox/ABox
as ground facts (`class/1`, `subclass_of/2`, `restriction/4`, `individual/2`,
`triple/3`, ...) keeps the page offline-capable and decouples it from whether the
wasm build bundles library(semweb). OWL-DL entailment stays where it belongs — the
HermiT pass in `make owl`. This layer is for *interactive, rule-based* exploration
(the hand-written rules live alongside in `aicor-rules.pl`).

The emitted vocabulary (see aicor-rules.pl for the rule layer that sits on top):

  TBox
    class(C).                          % named owl:Class
    label(C, Text).                    % rdfs:label
    object_property(P). data_property(P).
    subclass_of(Sub, Super).           % named-class superclass only
    restriction(C, P, some|all, Filler).
    restriction_card(C, P, exactly|min|max, N, Filler).
    restriction_value(C, P, Value).    % owl:hasValue (bool / individual)
    disjoint(A, B).                    % one direction; rule layer makes it symmetric

  ABox (from L2-conceptual-framework/abox/*.yaml)
    individual(Ind, Class).            % one per asserted type
    triple(Subject, Property, Object). % object-property assertion
    in_example(Ind, ExampleTag).       % provenance of an individual

All names are the ontology's local names (IRI fragment). CamelCase class names are
single-quoted atoms; lowercase property names stay bare where they are valid atoms.

Usage:
    okf_prolog.py <ontology-dir> --out studio/kb/aicor-kb.pl \
        [--abox a.yaml --abox b.yaml] [--iri-base <ns#>]

<ontology-dir> is the L2 `-dl.md` directory; the TTL it exports is read from the
sibling out/ dir if present, otherwise the ontology is rebuilt via okf_owl.
"""

import argparse
import re
import sys
from pathlib import Path

import rdflib
from rdflib import OWL, RDF, RDFS
from rdflib.namespace import XSD

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

DEFAULT_IRI = "http://aicor.knowledge/l2-ontology.owl#"

_ATOM_RE = re.compile(r"^[a-z][a-zA-Z0-9_]*$")


def pl_atom(name: str) -> str:
    """Render a Prolog atom, single-quoting (and escaping) when necessary."""
    if _ATOM_RE.match(name):
        return name
    esc = name.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{esc}'"


def pl_string(text: str) -> str:
    esc = text.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{esc}"'


def local(uri, iri_base: str):
    """Local name for a URIRef in our namespace, else None (skip foreign terms)."""
    s = str(uri)
    if s.startswith(iri_base):
        return s[len(iri_base):]
    # Tolerate the well-known upper-ontology shims the exporter inlines as
    # `dul_Description` etc. under our namespace; anything else is skipped.
    return None


class Compiler:
    def __init__(self, iri_base: str):
        self.iri = iri_base
        self.classes = set()
        self.labels = {}
        self.obj_props = set()
        self.data_props = set()
        self.subclass = set()          # (sub, super)
        self.restr = set()             # (c, p, kind, filler)
        self.restr_card = set()        # (c, p, kind, n, filler)
        self.restr_val = set()         # (c, p, value_atom)
        self.disjoint = set()          # (a, b) with a < b
        self.ex_individuals = []       # (tag, ind, class)
        self.ex_triples = []           # (tag, s, p, o)
        self.in_example = []           # (ind, tag)

    # ---- TBox -------------------------------------------------------------
    def load_tbox(self, ttl_path: Path):
        g = rdflib.Graph()
        g.parse(str(ttl_path), format="turtle")
        L = lambda u: local(u, self.iri)

        for c in g.subjects(RDF.type, OWL.Class):
            n = L(c)
            if n:
                self.classes.add(n)
        for p in g.subjects(RDF.type, OWL.ObjectProperty):
            n = L(p)
            if n:
                self.obj_props.add(n)
        for p in g.subjects(RDF.type, OWL.DatatypeProperty):
            n = L(p)
            if n:
                self.data_props.add(n)
        for c, lit in g.subject_objects(RDFS.label):
            n = L(c)
            if n and n not in self.labels:
                self.labels[n] = str(lit)

        for c, sup in g.subject_objects(RDFS.subClassOf):
            cn = L(c)
            if not cn:
                continue
            if isinstance(sup, rdflib.URIRef):
                sn = L(sup)
                if sn and sn != cn:
                    self.subclass.add((cn, sn))
            elif isinstance(sup, rdflib.BNode):
                self._restriction(g, cn, sup)

        for a, b in g.subject_objects(OWL.disjointWith):
            an, bn = L(a), L(b)
            if an and bn and an != bn:
                self.disjoint.add(tuple(sorted((an, bn))))
        for node in g.subjects(RDF.type, OWL.AllDisjointClasses):
            members = [L(m) for m in _rdf_list(g, g.value(node, OWL.members))]
            members = [m for m in members if m]
            for i in range(len(members)):
                for j in range(i + 1, len(members)):
                    self.disjoint.add(tuple(sorted((members[i], members[j]))))

    def _restriction(self, g, cn, bnode):
        if (bnode, RDF.type, OWL.Restriction) not in g:
            return
        p = g.value(bnode, OWL.onProperty)
        pn = local(p, self.iri) if p is not None else None
        if not pn:
            return
        sv = g.value(bnode, OWL.someValuesFrom)
        av = g.value(bnode, OWL.allValuesFrom)
        hv = g.value(bnode, OWL.hasValue)
        if sv is not None:
            self.restr.add((cn, pn, "some", self._filler(sv)))
            return
        if av is not None:
            self.restr.add((cn, pn, "all", self._filler(av)))
            return
        if hv is not None:
            self.restr_val.add((cn, pn, self._value(hv)))
            return
        for kind, pred, onpred in (
            ("exactly", OWL.qualifiedCardinality, OWL.onClass),
            ("min", OWL.minQualifiedCardinality, OWL.onClass),
            ("max", OWL.maxQualifiedCardinality, OWL.onClass),
        ):
            n = g.value(bnode, pred)
            if n is not None:
                filler = self._filler(g.value(bnode, onpred))
                self.restr_card.add((cn, pn, kind, int(n), filler))
                return
        for kind, pred in (("exactly", OWL.cardinality),
                           ("min", OWL.minCardinality),
                           ("max", OWL.maxCardinality)):
            n = g.value(bnode, pred)
            if n is not None:
                self.restr_card.add((cn, pn, kind, int(n), "Thing"))
                return

    def _filler(self, node):
        if node is None:
            return "Thing"
        n = local(node, self.iri) if isinstance(node, rdflib.URIRef) else None
        return n or "Anon"

    def _value(self, lit):
        if isinstance(lit, rdflib.URIRef):
            return local(lit, self.iri) or "Anon"
        if getattr(lit, "datatype", None) == XSD.boolean:
            return "true" if str(lit).lower() in ("true", "1") else "false"
        return str(lit)

    # ---- ABox -------------------------------------------------------------
    def load_abox(self, path: Path, tag: str):
        if yaml is None:
            print("okf_prolog: PyYAML missing; skipping ABox", file=sys.stderr)
            return
        spec = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for name, typs in (spec.get("individuals") or {}).items():
            typs = typs or ["Thing"]
            for t in typs:
                self.ex_individuals.append((tag, name, t))
            self.in_example.append((name, tag))
        for tr in (spec.get("relations") or []):
            if len(tr) == 3:
                s, p, o = (str(x) for x in tr)
                self.ex_triples.append((tag, s, p, o))

    # ---- emit -------------------------------------------------------------
    def emit(self) -> str:
        out = []
        w = out.append
        w("% aicor-kb.pl — GENERATED by L2-conceptual-framework/scripts/okf_prolog.py")
        w("% Do not hand-edit. Regenerate with `make prolog`.")
        w("% AICOR L2 ontology (TBox) + worked-example ABoxes, as Prolog facts.")
        w("% The rule layer + query library lives in aicor-rules.pl.")
        w("")
        w(f"% counts: {len(self.classes)} classes, "
          f"{len(self.obj_props)} object-properties, "
          f"{len(self.subclass)} subclass edges, "
          f"{len(self.restr) + len(self.restr_card) + len(self.restr_val)} restrictions, "
          f"{len(self.disjoint)} disjointness pairs, "
          f"{len(self.ex_individuals)} individual-typings.")
        w("")
        w(":- discontiguous class/1, label/2, object_property/1, data_property/1.")
        w(":- discontiguous subclass_of/2, restriction/4, restriction_card/5.")
        w(":- discontiguous restriction_value/3, disjoint/2.")
        w(":- discontiguous ex_individual/3, ex_triple/4, in_example/2.")
        w("")

        def section(title):
            w("")
            w(f"% ---- {title} " + "-" * max(0, 62 - len(title)))

        section("classes")
        for c in sorted(self.classes):
            w(f"class({pl_atom(c)}).")
        section("labels")
        for c in sorted(self.labels):
            if self.labels[c] != c:
                w(f"label({pl_atom(c)}, {pl_string(self.labels[c])}).")
        section("object properties")
        for p in sorted(self.obj_props):
            w(f"object_property({pl_atom(p)}).")
        if self.data_props:
            section("data properties")
            for p in sorted(self.data_props):
                w(f"data_property({pl_atom(p)}).")
        section("subclass edges (named superclass)")
        for sub, sup in sorted(self.subclass):
            w(f"subclass_of({pl_atom(sub)}, {pl_atom(sup)}).")
        section("existential / universal restrictions")
        for c, p, k, f in sorted(self.restr):
            w(f"restriction({pl_atom(c)}, {pl_atom(p)}, {k}, {pl_atom(f)}).")
        section("cardinality restrictions")
        for c, p, k, n, f in sorted(self.restr_card):
            w(f"restriction_card({pl_atom(c)}, {pl_atom(p)}, {k}, {n}, {pl_atom(f)}).")
        section("value restrictions (owl:hasValue)")
        for c, p, v in sorted(self.restr_val):
            vv = v if v in ("true", "false") else pl_atom(v)
            w(f"restriction_value({pl_atom(c)}, {pl_atom(p)}, {vv}).")
        section("disjointness (one direction; symmetric in the rule layer)")
        for a, b in sorted(self.disjoint):
            w(f"disjoint({pl_atom(a)}, {pl_atom(b)}).")

        section("ABox — individuals (example-tagged; globals derived in aicor-rules.pl)")
        for tag, ind, cls in dict.fromkeys(self.ex_individuals):
            w(f"ex_individual({pl_atom(tag)}, {pl_atom(ind)}, {pl_atom(cls)}).")
        section("ABox — provenance (individual → example)")
        for ind, tag in dict.fromkeys(self.in_example):
            w(f"in_example({pl_atom(ind)}, {pl_atom(tag)}).")
        section("ABox — object-property assertions (example-tagged)")
        for tag, s, p, o in dict.fromkeys(self.ex_triples):
            w(f"ex_triple({pl_atom(tag)}, {pl_atom(s)}, {pl_atom(p)}, {pl_atom(o)}).")
        w("")
        return "\n".join(out) + "\n"


def _rdf_list(g, head):
    items = []
    while head and head != RDF.nil:
        first = g.value(head, RDF.first)
        if first is not None:
            items.append(first)
        head = g.value(head, RDF.rest)
    return items


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("onto_dir", help="L2 ontology dir (the -dl.md directory)")
    ap.add_argument("--out", required=True, help="output aicor-kb.pl path")
    ap.add_argument("--ttl", help="explicit TTL path (default: <onto>/../out/aicor-ontology.ttl)")
    ap.add_argument("--abox", action="append", default=[],
                    help="ABox YAML (repeatable); tag is the file stem")
    ap.add_argument("--iri-base", default=DEFAULT_IRI)
    args = ap.parse_args(argv)

    onto_dir = Path(args.onto_dir)
    ttl = Path(args.ttl) if args.ttl else onto_dir.parent / "out" / "aicor-ontology.ttl"
    if not ttl.exists():
        sys.exit(f"okf_prolog: TTL not found at {ttl}. Run `make owl` first.")

    c = Compiler(args.iri_base)
    c.load_tbox(ttl)
    for a in args.abox:
        p = Path(a)
        tag = p.stem.replace("-example", "")
        c.load_abox(p, tag)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(c.emit(), encoding="utf-8")
    print(f"okf_prolog: wrote {out} "
          f"({len(c.classes)} classes, {len(c.obj_props)} props, "
          f"{len(c.ex_individuals)} individual-typings, {len(c.ex_triples)} triples)")


if __name__ == "__main__":
    main()