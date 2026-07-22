"""eql_kb.py — the Tracy demo scene as an EQL (Entity Query Language) knowledge base.

EQL is krrood's pythonic relational query language (part of the CRAM
architecture, ~/cognitive_robot_abstract_machine/krrood). This module models
the recorded pycram/giskardpy episode — bench objects, robot parts, action
episodes, per-joint motion — as plain dataclasses and exposes:

    fresh_namespace()  -> dict for evaluating one EQL query (fresh variables)
    run_query(code)    -> execute an EQL query string, return JSON-able result
    graph_payload()    -> nodes/edges/details/presets for the UI knowledge graph

Run under an interpreter that has krrood installed (the cram-env virtualenv);
server.py re-execs itself into it automatically.
"""
import ast
import json
import math
import os
from dataclasses import dataclass, fields, is_dataclass
from typing import Optional

ROOT = os.path.dirname(os.path.abspath(__file__))
DEMO_JSON = os.path.join(ROOT, "static", "tracy_demo.json")
URDF_FILE = os.path.join(ROOT, "static", "tracy.urdf")


def load_urdf():
    """Parse tracy.urdf into (links, joints) for the kinematic-tree drill view.
    links: [name]; joints: [{name, type, parent, child}]. Regex parse — the
    file is a flat, well-formed URDF, so no XML deps are needed."""
    import re
    try:
        txt = open(URDF_FILE, encoding="utf-8", errors="replace").read()
    except OSError:
        return [], []
    links = re.findall(r'<link\s+name="([^"]+)"', txt)
    joints = []
    for m in re.finditer(r'<joint\s+name="([^"]+)"\s+type="([^"]+)">(.*?)</joint>', txt, re.S):
        body = m.group(3)
        parent = re.search(r'<parent\s+link="([^"]+)"', body)
        child = re.search(r'<child\s+link="([^"]+)"', body)
        if parent and child:
            joints.append({"name": m.group(1), "type": m.group(2),
                           "parent": parent.group(1), "child": child.group(1)})
    return links, joints

# where the UI actually spawns the bench objects (standing on the bench);
# keep in sync with SPAWN_Z in static/robot.js
SPAWN_Z = {"media_tsb": 0.95, "sterility_canister": 0.96}


# ---------------------------------------------------------------- the model --
@dataclass(unsafe_hash=True)
class Position:
    x: float
    y: float
    z: float

    def __repr__(self):
        return "(%.2f, %.2f, %.2f)" % (self.x, self.y, self.z)


@dataclass(unsafe_hash=True)
class Gripper:
    name: str
    side: str
    opening_m: float = 0.085          # Robotiq 2F-85


@dataclass(unsafe_hash=True)
class Arm:
    name: str
    side: str
    robot: str
    gripper: Gripper


@dataclass(unsafe_hash=True)
class Robot:
    name: str
    arm_count: int


@dataclass(unsafe_hash=True)
class BenchObject:
    name: str
    kind: str
    label: str
    height_m: float
    position: Position


@dataclass(unsafe_hash=True)
class ActionEpisode:
    name: str
    index: int
    start_frame: int
    end_frame: int
    duration_s: float
    performed_by: Optional[Arm]
    picks: Optional[BenchObject]
    places_at: Optional[BenchObject]


@dataclass(unsafe_hash=True)
class JointMotion:
    name: str
    arm_side: str                     # 'left' | 'right'
    min_rad: float
    max_rad: float
    range_rad: float


# ---- the CRAM architecture itself, scanned from ~/cognitive_robot_abstract_machine
@dataclass(unsafe_hash=True)
class Package:
    name: str
    description: str
    module_count: int
    class_count: int


@dataclass(unsafe_hash=True)
class SubPackage:
    name: str                         # qualified, e.g. 'coraplex.plans'
    package: str
    module_count: int
    class_count: int


@dataclass(unsafe_hash=True)
class PythonClass:
    name: str
    package: str
    subpackage: str                   # 'coraplex.plans' (== package for top-level modules)
    module: str                       # repo-relative module path
    bases: tuple                      # names of direct base classes
    methods: int
    doc: str                          # first docstring line ('' if none)


# -------------------------------------------- scan the CRAM architecture ----
CRAM_ROOT = os.path.expanduser("~/cognitive_robot_abstract_machine")
ARCH_CACHE = os.path.join(ROOT, ".eql_arch_cache.json")
SKIP_DIRS = {"__pycache__", "node_modules", "doc", "docs", "resources", "build", "dist", "plugins"}
PKG_DESCRIPTIONS = {
    "krrood": "knowledge representation & reasoning through OO design (home of EQL)",
    "coraplex": "the plan executive: designators, plans, locations",
    "pycram": "legacy plan executive (resources/demos)",
    "giskardpy": "constraint-based motion planning and control",
    "robokudo": "perception framework",
    "semantic_digital_twin": "semantic world model / digital twin",
    "segmind": "segmentation / vision models",
    "probabilistic_model": "probabilistic models and inference",
    "random_events": "sigma-algebra & random events for probabilistic reasoning",
    "physics_simulators": "physics simulator bindings",
    "experiments": "experiment scripts (incl. EQL experiments)",
    "test": "the test suites of all packages",
    "scripts": "maintenance scripts",
    "root": "top-level demo scripts (sterility test, wind turbine…)",
}


def _first_readme_line(d):
    for name in ("README.md", "readme.md"):
        p = os.path.join(d, name)
        if os.path.exists(p):
            for line in open(p, encoding="utf-8", errors="replace"):
                line = line.strip().lstrip("#").strip()
                if line:
                    return line[:120]
    return ""


def scan_architecture():
    """AST-scan the CRAM repo: packages, classes, cross-package imports.
    Static parse only — nothing is imported. Cached to disk keyed by file count."""
    packages, classes, imports = [], [], {}
    if not os.path.isdir(CRAM_ROOT):
        return packages, classes, []

    pkg_dirs = {"root": CRAM_ROOT}
    for e in sorted(os.listdir(CRAM_ROOT)):
        d = os.path.join(CRAM_ROOT, e)
        if os.path.isdir(d) and not e.startswith(".") and e not in SKIP_DIRS and "egg-info" not in e:
            pkg_dirs[e] = d
    pkg_names = set(pkg_dirs)

    per_pkg = {}
    for pkg, base in pkg_dirs.items():
        mods = 0
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames if not x.startswith(".") and x not in SKIP_DIRS]
            if pkg == "root":
                dirnames[:] = []                    # root package = top-level scripts only
            for fn in filenames:
                if not fn.endswith(".py"):
                    continue
                path = os.path.join(dirpath, fn)
                try:
                    tree = ast.parse(open(path, encoding="utf-8", errors="replace").read())
                except SyntaxError:
                    continue
                mods += 1
                rel = os.path.relpath(path, CRAM_ROOT)[:-3].replace(os.sep, ".")
                for node in ast.walk(tree):
                    if isinstance(node, ast.ClassDef):
                        bases = tuple(
                            b.id if isinstance(b, ast.Name) else (b.attr if isinstance(b, ast.Attribute) else "?")
                            for b in node.bases
                        )
                        doc = (ast.get_docstring(node) or "").strip().split("\n")[0][:140]
                        methods = sum(1 for x in node.body
                                      if isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef)))
                        classes.append(dict(name=node.name, package=pkg, module=rel,
                                            bases=list(bases), methods=methods, doc=doc))
                    elif isinstance(node, (ast.Import, ast.ImportFrom)):
                        roots = ([a.name.split(".")[0] for a in node.names]
                                 if isinstance(node, ast.Import)
                                 else [(node.module or "").split(".")[0]] if node.level == 0 else [])
                        for r in roots:
                            if r in pkg_names and r != pkg:
                                imports.setdefault(pkg, set()).add(r)
        per_pkg[pkg] = mods

    from collections import Counter
    ccount = Counter(c["package"] for c in classes)
    for pkg in pkg_dirs:
        desc = PKG_DESCRIPTIONS.get(pkg) or _first_readme_line(pkg_dirs[pkg])
        packages.append(dict(name=pkg, description=desc,
                             module_count=per_pkg.get(pkg, 0), class_count=ccount.get(pkg, 0)))
    dep_edges = sorted((a, b) for a, deps in imports.items() for b in deps)
    return packages, classes, dep_edges


def load_architecture():
    """scan_architecture() with a JSON disk cache (a full scan takes seconds)."""
    try:
        cached = json.load(open(ARCH_CACHE))
        if cached.get("cram_root") == CRAM_ROOT and cached.get("version") == 2:
            return cached["packages"], cached["classes"], [tuple(e) for e in cached["deps"]]
    except Exception:
        pass
    packages, classes, deps = scan_architecture()
    try:
        json.dump({"version": 2, "cram_root": CRAM_ROOT, "packages": packages,
                   "classes": classes, "deps": deps}, open(ARCH_CACHE, "w"))
    except Exception:
        pass
    return packages, classes, deps


class KB:
    def __init__(self):
        with open(DEMO_JSON) as f:
            d = json.load(f)
        fps = d.get("fps", 20)

        self.objects = []
        by_id = {}
        for oid, o in (d.get("objects") or {}).items():
            pos = list(o.get("pos", [0, 0, 0]))
            if oid in SPAWN_Z:
                pos[2] = SPAWN_Z[oid]
            obj = BenchObject(
                name=oid, kind=o.get("kind", "object"), label=o.get("label", oid),
                height_m=o.get("h", 0.11), position=Position(*[round(v, 3) for v in pos]),
            )
            self.objects.append(obj)
            by_id[oid] = obj

        left_gripper = Gripper("left_gripper", "left")
        right_gripper = Gripper("right_gripper", "right")
        self.grippers = [left_gripper, right_gripper]
        self.arms = [
            Arm("left_arm", "left", "tracy", left_gripper),
            Arm("right_arm", "right", "tracy", right_gripper),
        ]
        self.robot = Robot("tracy", arm_count=2)
        arm_by_side = {a.side: a for a in self.arms}
        acting_side = "left" if str(d.get("gripperLink", "")).startswith("left") else "right"

        self.episodes = []
        for i, s in enumerate(d.get("segments") or []):
            self.episodes.append(ActionEpisode(
                name=s["step"], index=i,
                start_frame=s["start"], end_frame=s["end"],
                duration_s=round((s["end"] - s["start"]) / fps, 1),
                performed_by=arm_by_side[acting_side] if s.get("pick") or s.get("place") else None,
                picks=by_id.get(s.get("pick")),
                places_at=by_id.get(s.get("place")),
            ))

        # per-joint motion statistics over the whole recorded trajectory
        lo, hi = {}, {}
        for fr in d.get("frames") or []:
            for k, v in fr.items():
                if k not in lo or v < lo[k]:
                    lo[k] = v
                if k not in hi or v > hi[k]:
                    hi[k] = v
        self.joints = [
            JointMotion(
                name=k, arm_side="left" if k.startswith("left") else "right",
                min_rad=round(lo[k], 3), max_rad=round(hi[k], 3),
                range_rad=round(hi[k] - lo[k], 3),
            )
            for k in sorted(lo)
        ]

        # the CRAM architecture itself: packages + every Python class in the repo
        pkgs, clss, deps = load_architecture()
        self.packages = [Package(**p) for p in pkgs]

        def sub_of(pkg, module):
            # 'coraplex.src.coraplex.plans.designator' -> 'coraplex.plans';
            # top-level modules collapse onto the package itself
            parts = module.split(".")
            if parts and parts[0] == pkg:
                parts = parts[1:]
            while parts and parts[0] in ("src", pkg):
                parts = parts[1:]
            return pkg + "." + parts[0] if len(parts) >= 2 else pkg

        self.classes = [PythonClass(name=c["name"], package=c["package"],
                                    subpackage=sub_of(c["package"], c["module"]),
                                    module=c["module"], bases=tuple(c["bases"]),
                                    methods=c["methods"], doc=c["doc"])
                        for c in clss]
        self.package_deps = deps

        from collections import defaultdict
        mods, ccnt = defaultdict(set), defaultdict(int)
        for c in self.classes:
            if c.subpackage != c.package:
                mods[(c.package, c.subpackage)].add(c.module)
                ccnt[c.subpackage] += 1
        self.subpackages = [
            SubPackage(name=s, package=p, module_count=len(mods[(p, s)]), class_count=ccnt[s])
            for (p, s) in sorted(mods)
        ]


_kb = None


def get_kb():
    global _kb
    if _kb is None:
        _kb = KB()
    return _kb


# -------------------------------------------------------------- EQL session --
# factories re-exported into every query namespace
_FACTORY_NAMES = [
    "entity", "set_of", "variable", "an", "a", "the", "and_", "or_", "not_",
    "contains", "in_", "exists", "for_all", "count", "count_all", "average",
    "sum", "min", "max", "mode", "distinct", "flat_variable", "variable_from",
]


def fresh_namespace():
    from krrood.entity_query_language import factories as F
    kb = get_kb()
    ns = {n: getattr(F, n) for n in _FACTORY_NAMES if hasattr(F, n)}
    ns.update(
        Position=Position, Gripper=Gripper, Arm=Arm, Robot=Robot,
        BenchObject=BenchObject, ActionEpisode=ActionEpisode, JointMotion=JointMotion,
        Package=Package, SubPackage=SubPackage, PythonClass=PythonClass,
        objects=kb.objects, episodes=kb.episodes, arms=kb.arms,
        grippers=kb.grippers, joints=kb.joints, robots=[kb.robot],
        packages=kb.packages, subpackages=kb.subpackages, classes=kb.classes,
    )
    # ready-made query variables so one-liners stay short
    ns["obj"] = F.variable(BenchObject, domain=kb.objects)
    ns["ep"] = F.variable(ActionEpisode, domain=kb.episodes)
    ns["arm"] = F.variable(Arm, domain=kb.arms)
    ns["j"] = F.variable(JointMotion, domain=kb.joints)
    ns["rob"] = F.variable(Robot, domain=[kb.robot])
    ns["pkg"] = F.variable(Package, domain=kb.packages)
    ns["sub"] = F.variable(SubPackage, domain=kb.subpackages)
    ns["cls"] = F.variable(PythonClass, domain=kb.classes)
    return ns


def _entity_name(v):
    return getattr(v, "name", None)


def _jsonable(v):
    if is_dataclass(v) and not isinstance(v, type):
        return _entity_name(v) or repr(v)
    if isinstance(v, float):
        return round(v, 4)
    if isinstance(v, (str, int, bool)) or v is None:
        return v
    return repr(v)


def run_query(code, limit=200):
    """Execute an EQL query string; the last expression is the query."""
    ns = fresh_namespace()
    tree = ast.parse(code, mode="exec")
    if not tree.body:
        raise ValueError("empty query")
    last = tree.body[-1]
    if isinstance(last, ast.Expr):
        if len(tree.body) > 1:
            pre = ast.Module(body=tree.body[:-1], type_ignores=[])
            exec(compile(pre, "<eql>", "exec"), ns)
        result = eval(compile(ast.Expression(last.value), "<eql>", "eval"), ns)
    else:
        exec(compile(tree, "<eql>", "exec"), ns)
        result = ns.get("result")

    if hasattr(result, "evaluate"):
        result = result.evaluate()

    rows, highlight, more = [], [], False
    if result is None:
        pass
    elif isinstance(result, (str, int, float, bool)):
        rows.append({"value": _jsonable(result)})
    elif is_dataclass(result) and not isinstance(result, type):
        rows.append(_entity_row(result, highlight))
    else:
        try:
            it = iter(result)
        except TypeError:
            rows.append({"value": _jsonable(result)})
            it = None
        if it is not None:
            for item in it:
                if len(rows) >= limit:
                    more = True
                    break
                rows.append(_item_row(item, highlight))
    kind = "rows" if rows and "__entity__" not in rows[0] else "entities"
    return {"ok": True, "kind": kind, "rows": rows, "count": len(rows),
            "more": more, "highlight": sorted(set(highlight))}


def _entity_row(item, highlight):
    name = _entity_name(item)
    if name:
        highlight.append(name)
    if isinstance(item, PythonClass):
        # classes aren't graph nodes — light up their subpackage + package instead
        highlight.append(item.subpackage)
        highlight.append(item.package)
    row = {"__entity__": name or repr(item), "__type__": type(item).__name__}
    for f in fields(item):
        if f.name != "name":
            row[f.name] = _jsonable(getattr(item, f.name))
    return row


def _item_row(item, highlight):
    if is_dataclass(item) and not isinstance(item, type):
        return _entity_row(item, highlight)
    if hasattr(item, "items"):                 # UnificationDict from set_of()
        row = {}
        for k, v in item.items():
            if is_dataclass(v) and not isinstance(v, type) and _entity_name(v):
                highlight.append(_entity_name(v))
            row[str(k)] = _jsonable(v)
        return row
    return {"value": _jsonable(item)}


# ------------------------------------------------------------ the UI graph --
def graph_payload():
    kb = get_kb()
    nodes, edges, details = [], [], {}

    def add(nid, label, group, lines):
        nodes.append({"id": nid, "label": label, "group": group,
                      "title": "\n".join([label] + lines)})
        details[nid] = {"label": label, "group": group, "lines": lines}

    add("tracy", "tracy", "robot",
        ["a Robot", "dual-arm UR10e lab robot", "arms: 2", "double-click: full URDF tree"])
    for a in kb.arms:
        add(a.name, a.name.replace("_", " "), "robot",
            ["an Arm", "side: " + a.side, "gripper: " + a.gripper.name])
        edges.append({"from": "tracy", "to": a.name, "kind": "prop", "label": "has part"})
        add(a.gripper.name, a.gripper.name.replace("_", " "), "robot",
            ["a Gripper", "side: " + a.gripper.side, "opening: %.3f m" % a.gripper.opening_m])
        edges.append({"from": a.name, "to": a.gripper.name, "kind": "prop", "label": "has part"})

    for o in kb.objects:
        add(o.name, o.label, "object",
            ["a BenchObject", "kind: " + o.kind, "position: " + repr(o.position),
             "height: %.2f m" % o.height_m])

    prev = None
    for e in kb.episodes:
        add(e.name, e.name, "event",
            ["an ActionEpisode", "frames %d–%d" % (e.start_frame, e.end_frame),
             "duration: %.1f s" % e.duration_s]
            + (["picks: " + e.picks.name] if e.picks else [])
            + (["places at: " + e.places_at.name] if e.places_at else []))
        if prev:
            edges.append({"from": prev, "to": e.name, "kind": "type", "label": "precedes"})
        prev = e.name
        # the ROBOT performs the episode (with its arm); don't wire the episode
        # straight to the arm — the arm hangs off tracy, so the chain reads
        # pickup → tracy → left_arm → left_gripper
        if e.performed_by:
            edges.append({"from": e.name, "to": e.performed_by.robot, "kind": "prop", "label": "performed by"})
        if e.picks:
            edges.append({"from": e.name, "to": e.picks.name, "kind": "prop", "label": "picks"})
        if e.places_at:
            edges.append({"from": e.name, "to": e.places_at.name, "kind": "prop", "label": "places at"})

    # the CRAM architecture cluster: repo root → packages, plus import edges
    if kb.packages:
        add("cram", "CRAM architecture", "root",
            ["~/cognitive_robot_abstract_machine",
             "%d packages · %d Python classes" % (len(kb.packages), len(kb.classes))])
        for p in kb.packages:
            add(p.name, p.name, "concept",
                ["a Package", p.description,
                 "%d modules · %d classes" % (p.module_count, p.class_count),
                 "double-click to open"])
            edges.append({"from": "cram", "to": p.name, "kind": "prop", "label": "contains"})
        for s in kb.subpackages:
            add(s.name, s.name.split(".", 1)[1], "klass",
                ["a SubPackage of " + s.package,
                 "%d modules · %d classes" % (s.module_count, s.class_count),
                 "double-click to open"])
            edges.append({"from": s.package, "to": s.name, "kind": "prop", "label": "contains"})
        for a, b in kb.package_deps:
            edges.append({"from": a, "to": b, "kind": "type", "label": "imports"})

        # ground the demo in the architecture at the SUBPACKAGE that actually
        # realises each part (only wire to a node that exists in this view)
        def link(src, dst, label):
            if any(n["id"] == dst for n in nodes):
                edges.append({"from": src, "to": dst, "kind": "type", "label": label})

        link("pickup", "coraplex.plans", "planned by")            # the plan / designator layer
        link("pickup", "giskardpy.motion_statechart", "motion by")  # the motion execution layer
        # every physical thing in the scene is modelled in the semantic digital twin
        link("tracy", "semantic_digital_twin", "modelled in")
        for o in kb.objects:
            link(o.name, "semantic_digital_twin", "modelled in")

    status = "EQL ready · %d graph nodes · %d joints · %d CRAM classes" % (
        len(nodes), len(kb.joints), len(kb.classes))
    return {"ok": True, "status": status, "nodes": nodes, "edges": edges,
            "details": details, "presets": PRESETS}


# ---------------------------------------------------- drill-down subgraphs --
# Double-clicking a node in the UI asks for its inside view: package → its
# subpackages + top-level classes, subpackage → its classes (with inheritance
# edges), class → its base classes and every subclass in the repo.
CLASS_CAP = 150


def _view():
    nodes, edges, details = [], [], {}

    def add(nid, label, group, lines):
        nodes.append({"id": nid, "label": label, "group": group,
                      "title": "\n".join([label] + lines)})
        details[nid] = {"label": label, "group": group, "lines": lines}
    return nodes, edges, details, add


def _class_id(c):
    return c.module + "." + c.name


def _class_lines(c, drill_hint=True):
    lines = ["a PythonClass", "package: " + c.package, "module: " + c.module,
             "methods: %d" % c.methods]
    if c.bases:
        lines.append("bases: " + ", ".join(c.bases))
    if c.doc:
        lines.append(c.doc)
    if drill_hint:
        lines.append("double-click: inheritance view")
    return lines


def _add_classes(add, edges, parent_id, shown, total):
    name_to_id = {}
    for c in shown:
        cid = _class_id(c)
        add(cid, c.name, "pyclass", _class_lines(c))
        edges.append({"from": parent_id, "to": cid, "kind": "prop", "label": "defines"})
        name_to_id.setdefault(c.name, cid)
    # inheritance edges among the classes on screen
    for c in shown:
        for b in c.bases:
            if b in name_to_id and name_to_id[b] != _class_id(c):
                edges.append({"from": _class_id(c), "to": name_to_id[b], "kind": "type", "label": "inherits"})
    if total > len(shown):
        return ["showing the %d largest of %d classes (by method count)" % (len(shown), total)]
    return []


def expand_node(node_id):
    kb = get_kb()
    if node_id == kb.robot.name:                      # tracy → full URDF kinematic tree
        return _urdf_view(kb)
    pkg = next((p for p in kb.packages if p.name == node_id), None)
    if pkg:
        return _package_view(kb, pkg)
    sub = next((s for s in kb.subpackages if s.name == node_id), None)
    if sub:
        return _subpackage_view(kb, sub)
    cls = next((c for c in kb.classes if _class_id(c) == node_id), None)
    if cls:
        return _class_view(kb, cls)
    return None


def _urdf_view(kb):
    """The complete tracy.urdf as a kinematic tree: every link a node, every
    joint an edge (parent → child). Movable joints are solid edges, fixed ones
    dashed; links are coloured by which chain (left/right arm, camera, base)."""
    links, joints = load_urdf()
    nodes, edges, details, add = _view()
    if not links:
        return {"ok": True, "crumb": "tracy · URDF (not found)", "nodes": [], "edges": [], "details": {}}

    def chain_group(name):
        if name.startswith("left_robotiq") or name.startswith("right_robotiq"):
            return "object"                            # grippers (teal)
        if name.startswith("left_"):
            return "robot"                             # left arm (pink)
        if name.startswith("right_"):
            return "event"                             # right arm (purple)
        if name.startswith("camera"):
            return "goal"                              # camera (amber)
        return "concept"                               # base: map, table (green)

    # which joint drives each link (child link → its parent joint), for tooltips
    parent_joint = {j["child"]: j for j in joints}
    for ln in links:
        pj = parent_joint.get(ln)
        lines = ["a URDF Link"]
        if pj:
            lines.append("joint: %s (%s)" % (pj["name"], pj["type"]))
            lines.append("parent link: " + pj["parent"])
        else:
            lines.append("root link")
        add("urdf:" + ln, ln, chain_group(ln), lines)
    for j in joints:
        if ("urdf:" + j["parent"]) in details and ("urdf:" + j["child"]) in details:
            movable = j["type"] not in ("fixed",)
            edges.append({"from": "urdf:" + j["parent"], "to": "urdf:" + j["child"],
                          "kind": "prop" if movable else "type",
                          "label": "%s (%s)" % (j["name"], j["type"])})
    revolute = sum(1 for j in joints if j["type"] == "revolute")
    details["urdf:" + links[0]]["lines"].append(
        "%d links · %d joints (%d movable)" % (len(links), len(joints), revolute))
    legend = [
        {"group": "concept", "label": "Base (map / table)"},
        {"group": "robot", "label": "Left arm"},
        {"group": "event", "label": "Right arm"},
        {"group": "object", "label": "Grippers"},
        {"group": "goal", "label": "Camera"},
    ]
    return {"ok": True, "crumb": "tracy · URDF", "nodes": nodes, "edges": edges,
            "details": details, "legend": legend}


def _package_view(kb, pkg):
    nodes, edges, details, add = _view()
    subs = [s for s in kb.subpackages if s.package == pkg.name]
    top = sorted((c for c in kb.classes if c.package == pkg.name and c.subpackage == pkg.name),
                 key=lambda c: -c.methods)
    shown = top[:CLASS_CAP]
    note = []
    add(pkg.name, pkg.name, "concept",
        ["a Package", pkg.description,
         "%d modules · %d classes" % (pkg.module_count, pkg.class_count)] + note)
    for s in subs:
        add(s.name, s.name.split(".", 1)[1], "klass",
            ["a SubPackage of " + s.package,
             "%d modules · %d classes" % (s.module_count, s.class_count),
             "double-click to open"])
        edges.append({"from": pkg.name, "to": s.name, "kind": "prop", "label": "contains"})
    note = _add_classes(add, edges, pkg.name, shown, len(top))
    if note:
        details[pkg.name]["lines"] += note
    return {"ok": True, "crumb": pkg.name, "nodes": nodes, "edges": edges, "details": details}


def _subpackage_view(kb, sub):
    nodes, edges, details, add = _view()
    cls = sorted((c for c in kb.classes if c.subpackage == sub.name), key=lambda c: -c.methods)
    shown = cls[:CLASS_CAP]
    add(sub.name, sub.name.split(".", 1)[1], "klass",
        ["a SubPackage of " + sub.package,
         "%d modules · %d classes" % (sub.module_count, sub.class_count)])
    note = _add_classes(add, edges, sub.name, shown, len(cls))
    if note:
        details[sub.name]["lines"] += note
    return {"ok": True, "crumb": sub.name.split(".", 1)[1], "nodes": nodes, "edges": edges, "details": details}


def _class_view(kb, cls):
    nodes, edges, details, add = _view()
    cid = _class_id(cls)
    add(cid, cls.name, "pyclass", _class_lines(cls, drill_hint=False))
    # direct base classes: resolve inside the repo (same package preferred),
    # otherwise show them as external
    for b in cls.bases:
        cands = [c for c in kb.classes if c.name == b]
        pick = next((c for c in cands if c.package == cls.package), cands[0] if cands else None)
        if pick:
            bid = _class_id(pick)
            if bid not in details:
                add(bid, pick.name, "pyclass", _class_lines(pick))
        else:
            bid = "ext:" + b
            if bid not in details:
                add(bid, b, "upper", ["external base class (outside the repo)"])
        edges.append({"from": cid, "to": bid, "kind": "type", "label": "inherits"})
    # every subclass in the repo (matched by base name)
    subs = [c for c in kb.classes if cls.name in c.bases and _class_id(c) != cid]
    for c in subs[:80]:
        scid = _class_id(c)
        if scid not in details:
            add(scid, c.name, "pyclass", _class_lines(c))
        edges.append({"from": scid, "to": cid, "kind": "type", "label": "inherits"})
    if len(subs) > 80:
        details[cid]["lines"].append("showing 80 of %d subclasses" % len(subs))
    return {"ok": True, "crumb": cls.name, "nodes": nodes, "edges": edges, "details": details}


PRESETS = [
    # --- the scene: which robot, how many arms, which objects ---
    {"text": "which robot is this?",
     "code": "the(entity(rob))"},
    {"text": "how many arms does it have?",
     "code": "the(rob.arm_count)"},
    {"text": "each arm and its gripper",
     "code": "set_of(arm.side, arm.gripper)"},
    {"text": "which objects are on the bench?",
     "code": "an(entity(obj))"},
    {"text": "the yellow vial",
     "code": "the(entity(obj).where(obj.kind == 'bottle'))"},
    {"text": "what does it pick up?",
     "code": "the(entity(ep.picks).where(ep.name == 'pickup'))"},
    {"text": "where does it place it?",
     "code": "the(entity(ep.places_at).where(ep.name == 'place'))"},
    {"text": "which arm does the pickup?",
     "code": "the(entity(ep.performed_by).where(ep.name == 'pickup'))"},
    # --- the CRAM architecture behind the demo ---
    {"text": "CRAM packages by size",
     "code": "set_of(pkg.name, pkg.class_count).ordered_by(pkg.class_count, descending=True)"},
    {"text": "all Designator classes",
     "code": "an(entity(cls).where(cls.name.endswith('Designator')))"},
    {"text": "where does EQL live?",
     "code": "set_of(cls.name, cls.module).where(in_('entity_query_language', cls.module)).limit(15)"},
    {"text": "subclasses of Symbol",
     "code": "an(entity(cls).where(in_('Symbol', cls.bases)))"},
    {"text": "inside coraplex",
     "code": "an(entity(sub).where(sub.package == 'coraplex'))"},
]


if __name__ == "__main__":
    # smoke test: run every preset
    for p in PRESETS:
        try:
            r = run_query(p["code"])
            print("OK   %-32s -> %d rows  %s" % (p["text"], r["count"], r["rows"][:2]))
        except Exception as ex:
            print("FAIL %-32s -> %s: %s" % (p["text"], type(ex).__name__, ex))
