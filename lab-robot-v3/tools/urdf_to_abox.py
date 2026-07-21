#!/usr/bin/env python3
"""
urdf_to_abox.py — turn a URDF robot description into an AICOR L2 ABox (YAML),
in the same format the worked-example ABoxes use (see tools/abox/*.yaml).

The robot's kinematics is instantiated against the real L2 classes/properties:

  tracy               : Robot            hasProperPart -> tracy_body
  tracy_description   : RobotDescription, URDF   describes -> tracy_body
  tracy_body          : RobotBody
  <link>              : Link             (RobotBody hasLink; Link partOf RobotBody)
                        + EndEffector for gripper base links (hasEndEffector)
                        + Sensor        for the camera link  (hasSensor)
  <joint>             : Joint            (RobotBody hasJoint; connects the 2 links;
                                          hasJointType <type>)
  <type>              : JointType        (fixed | revolute | system | …)
  <joint>_motor       : Motor            actuatedBy, for independently actuated
                                          (revolute & non-mimic) joints only

Usage:
    urdf_to_abox.py <robot.urdf> --name tracy --out tools/abox/tracy.yaml
"""

import argparse
import xml.etree.ElementTree as ET
from pathlib import Path

# link-name heuristics for the two specialised roles the L2 body model knows
GRIPPER_BASE = 'robotiq_85_base_link'   # substring → EndEffector
CAMERA_LINK = 'camera_link'             # exact → Sensor


def q(name: str) -> str:
    """YAML-safe scalar: quote anything that isn't a plain [A-Za-z0-9_] token."""
    return name if name.replace('_', '').isalnum() else "'" + name.replace("'", "''") + "'"


def parse(urdf: Path):
    root = ET.parse(str(urdf)).getroot()
    links = [l.get('name') for l in root.findall('link')]
    joints = []
    for j in root.findall('joint'):
        parent = j.find('parent')
        child = j.find('child')
        joints.append({
            'name': j.get('name'),
            'type': j.get('type'),
            'parent': parent.get('link') if parent is not None else None,
            'child': child.get('link') if child is not None else None,
            'mimic': j.find('mimic') is not None,
        })
    return links, joints


def build(name: str, links, joints):
    body = f'{name}_body'
    desc = f'{name}_description'
    inds = {}          # ordered dict of name -> [types]
    rels = []          # list of [s, p, o]

    def ind(n, *types):
        inds.setdefault(n, [])
        for t in types:
            if t not in inds[n]:
                inds[n].append(t)

    ind(name, 'Robot')
    ind(body, 'RobotBody')
    ind(desc, 'RobotDescription', 'URDF')
    rels += [[name, 'hasProperPart', body], [desc, 'describes', body]]

    for l in links:
        types = ['Link']
        if GRIPPER_BASE in l:
            types.append('EndEffector')
        if l == CAMERA_LINK:
            types.append('Sensor')
        ind(l, *types)
        rels += [[body, 'hasLink', l], [l, 'partOf', body]]
        if 'EndEffector' in types:
            rels.append([body, 'hasEndEffector', l])
        if 'Sensor' in types:
            rels.append([body, 'hasSensor', l])

    jtypes = set()
    for j in joints:
        jn, jt = j['name'], j['type']
        ind(jn, 'Joint')
        rels.append([body, 'hasJoint', jn])
        if jt:
            jtypes.add(jt)
            rels.append([jn, 'hasJointType', jt])
        for link in (j['parent'], j['child']):
            if link:
                rels.append([jn, 'connects', link])
        # only independently actuated joints get a motor (skip fixed & mimic)
        if jt == 'revolute' and not j['mimic']:
            motor = f'{jn}_motor'
            ind(motor, 'Motor')
            rels.append([jn, 'actuatedBy', motor])

    for jt in sorted(jtypes):
        ind(jt, 'JointType')

    return inds, rels


def emit(name, urdf_path, inds, rels):
    out = []
    out.append(f'# ABox for the {name} robot — GENERATED from {urdf_path.name} by')
    out.append('# tools/urdf_to_abox.py. Do not hand-edit; regenerate via tools/build-kb.sh.')
    out.append(f'# The kinematic tree instantiated against the AICOR L2 body model.')
    out.append('')
    out.append('individuals:')
    for n, types in inds.items():
        out.append(f'  {q(n)}: [{", ".join(types)}]')
    out.append('')
    out.append('relations:')
    for s, p, o in rels:
        out.append(f'  - [{q(s)}, {p}, {q(o)}]')
    out.append('')
    return '\n'.join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('urdf')
    ap.add_argument('--name', default='tracy')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    urdf = Path(args.urdf)
    links, joints = parse(urdf)
    inds, rels = build(args.name, links, joints)
    Path(args.out).write_text(emit(args.name, urdf, inds, rels), encoding='utf-8')
    n_motor = sum(1 for r in rels if r[1] == 'actuatedBy')
    print(f'urdf_to_abox: {len(links)} links, {len(joints)} joints, {n_motor} actuated → '
          f'{len(inds)} individuals, {len(rels)} relations → {args.out}')


if __name__ == '__main__':
    main()
