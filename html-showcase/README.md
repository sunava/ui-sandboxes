# TraceBot showcase — Tracy & the Knowledge Graph

An outreach web app for the TraceBot laboratory. **Left:** Tracy (the dual-arm
UR10e sterility-testing robot) rendered live in 3D from her real URDF, plus the
membrane-based sterility-testing workflow. **Right:** an interactive knowledge
graph you can query with Prolog — including *"which safety regulators matter for
this task?"* — which then surfaces the CRAM action designators that realise it.

## Run

```bash
cd ~/tracebot_showcase
python3 server.py            # http://localhost:8711  (add a port arg to change)
```

No build step, no internet needed at runtime — everything is vendored.

## How it works

- **3D robot** — `static/robot.js` loads `static/tracy.urdf` (copied from
  `cram_cognitive_architecture/pycram/resources/robots/tracy.urdf`) with
  `urdf-loader` on top of Three.js r128. Meshes live under `static/meshes/`
  (UR10e, Robotiq 2F-85, the TraceBot bench), served locally.
- **Reasoning** — `static/kb.js` is a Prolog knowledge base run client-side by
  tau-prolog. It encodes Tracy, the 10 workflow steps, the objects, the safety
  regulations (EU GMP Annex 1, Ph. Eur. 2.6.1 / USP <71>, ISO 14644, ISO 10218,
  ISO/TS 15066, ISO 14971, ISO 13485, FDA 21 CFR Part 11, aseptic technique),
  and the CRAM action designators from `pycram/robot_plans/actions/…`.
- **Graph** — `static/graph.js` (vis-network) is derived from the same KB, so
  the picture and the reasoning never drift apart.
- **Server** — `server.py` is a dependency-free static file server (only needed
  because browsers block `file://` XHR for the meshes).

## Try these

- Click any workflow step → Tracy poses for it and the panel lists the safety
  regulators + CRAM action designators + objects for that task.
- Query box (Prolog goals):
  - `relevant_regulation(spike_media, R).`
  - `uses_action(filter_transfer, A).`
  - `safety_critical(S).`
  - `has_part(tracy, P).`
- Click any node in the graph to explore its relations.

## Editing the knowledge

All facts and rules are in `static/kb.js` (`KB_SOURCE`). Add objects, steps,
regulations or `requires/2` and `step_action/2` edges there — the graph, the
workflow strip and the queries all pick them up automatically on reload.
