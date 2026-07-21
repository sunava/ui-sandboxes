/* ============================================================================
 * robot.js — renders Tracy from her URDF with Three.js (vendored r128).
 * Exposes window.RobotView with:
 *     onReady(cb)      — called once the model is in the scene
 *     poseForStep(id)  — strike a task-specific arm pose
 *     highlight(on)    — pulse the arms (used when a query touches the robot)
 * ==========================================================================*/
(function () {
  const container = document.getElementById('viewer');
  const statusEl = document.getElementById('viewer-status');

  const scene = new THREE.Scene();
  window.__scene = scene; // TEMP DEBUG
  // transparent — the blurred lab photo behind the canvas shows through
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(2.1, 1.6, 2.1);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  // image-based lighting: a neutral studio environment gives the metal/plastic
  // parts real reflections (the single biggest "high quality" lever)
  if (THREE.RoomEnvironment && THREE.PMREMGenerator) {
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
    } catch (e) { /* IBL optional */ }
  }
  // upgrade to a real studio HDRI when it loads → photorealistic reflections
  if (THREE.RGBELoader && THREE.PMREMGenerator) {
    try {
      new THREE.RGBELoader().load('static/env/studio.hdr', function (hdr) {
        hdr.mapping = THREE.EquirectangularReflectionMapping;
        const pm = new THREE.PMREMGenerator(renderer);
        scene.environment = pm.fromEquirectangular(hdr).texture;
        hdr.dispose(); pm.dispose(); needsRender = true;
      });
    } catch (e) { /* HDRI optional, RoomEnvironment stays */ }
  }

  // ---- lighting: warm-neutral to match the real lab photo -------------------
  scene.add(new THREE.HemisphereLight(0xf4efe6, 0x2a2d33, 0.42));
  scene.add(new THREE.AmbientLight(0xfff4e6, 0.12));

  const key = new THREE.DirectionalLight(0xfff2df, 1.45);   // warm key
  key.position.set(3, 5, 2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 20;
  key.shadow.camera.left = -3; key.shadow.camera.right = 3;
  key.shadow.camera.top = 3; key.shadow.camera.bottom = -3;
  key.shadow.bias = -0.0004;
  scene.add(key);

  const back = new THREE.DirectionalLight(0xdfe6f2, 0.45);
  back.position.set(-3, 2.5, -2);
  scene.add(back);

  // kept as `fill` because the query-highlight pulse animates fill.intensity
  const fill = new THREE.PointLight(0xffffff, 0.3, 20);
  fill.position.set(0, 1.6, 2.5);
  scene.add(fill);

  // ---- ground: invisible shadow catcher so the robot "sits" in the photo ----
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.ShadowMaterial({ opacity: 0.28 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(40, 80, 0x9aa2b0, 0xb0b7c2);
  grid.material.opacity = 0.12; grid.material.transparent = true;
  grid.visible = false;                 // off by default for the sandbox look
  scene.add(grid);

  // ---- controls -------------------------------------------------------------
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.8;
  controls.maxDistance = 8;
  controls.maxPolarAngle = Math.PI * 0.52;

  // ---- load Tracy -----------------------------------------------------------
  let robot = null;
  const readyCbs = [];
  let highlightT = 0;
  const props = {};   // KB-object-id -> { group, mats:[], glow, glowTarget }

  // real giskardpy-planned trajectory playback state.
  // DEMO IS BEING REBUILT STEP BY STEP: for now the robot does nothing — the arm
  // trajectory is disabled and it just holds its home pose. Flip DEMO_ARM_MOTION
  // to true to bring the recorded arm playback back.
  const DEMO_ARM_MOTION = true;
  let traj = null, trajPlaying = false, playhead = 0, gripperLinkObj = null;

  // ---- draggable pickup object: the user can move the vial on the bench; at
  // play start the recorded grasp is retargeted to its new spot via IK ---------
  const LEFT_ARM = [
    'left_shoulder_pan_joint', 'left_shoulder_lift_joint', 'left_elbow_joint',
    'left_wrist_1_joint', 'left_wrist_2_joint', 'left_wrist_3_joint',
  ];
  const DRAG_BOUNDS = { minX: 0.60, maxX: 1.00, minY: -0.40, maxY: 0.60,   // bench area (map frame)
                        minZ: 0.95, maxZ: 1.50 };  // grasp height (vial centre; 0.95 = standing on the bench)
  let dragId = null;            // which prop is draggable (the trajectory's held object)
  let dragging = false;
  let jointOffsets = null;      // joint -> radians delta, blended into the pickup
  let gripCap = 0.25;           // max left-gripper closing (rad) — set from the grasp frame

  // both bench objects spawn ON the bench (the recording has them floating at
  // the heights the original plan reached for); the retarget solves take the
  // motion to them. Values are map-frame z of the object group's centre.
  const SPAWN_Z = { media_tsb: 0.95, sterility_canister: 0.96 };

  // pour-and-place: extra IK offset sets active during the place segment.
  // pourOffsets holds the vial above the canister for the pour, placeOffsets
  // stands it down onto the bench at the recorded release spot.
  let placeOffsets = null, pourOffsets = null;
  let pourAtFrame = 0, pourPhase = 0, pourDone = false;
  let pourTilt = 0;             // signed tilt for this playback (sign picked geometrically)
  const POUR_TILT = 1.9;        // wrist-roll tilt magnitude (rad), past horizontal so it pours
  const POUR_SECONDS = 1.8;     // how long the full tilt is held over the opening
  const POUR_CLEAR = 0.06;      // vial mouth this far above the canister opening

  // roll the gripper 180° for the grasp so its bulky side faces up. −π (not +π)
  // keeps wrist_3 inside its ±2π limit (the recorded grasp value is ~4.19 rad).
  // Applied in the gripper's local frame from approach until after release, so
  // the held vial's path through space is exactly the recorded one.
  const FLIP_JOINT = 'left_wrist_3_joint';
  const GRIP_FLIP = -Math.PI;

  // vial position API for the UI panel (sliders/number inputs in the workflow bar)
  const vialReadyCbs = [], vialMovedCbs = [];
  function getVialPos() {
    const p = dragId && props[dragId];
    return p ? { x: p.group.position.x, y: p.group.position.y, z: p.group.position.z } : null;
  }
  function setVialPos(x, y, z) {
    const p = dragId && props[dragId];
    if (!p) return null;
    if (trajPlaying) return getVialPos();     // the running pickup is already planned
    p.group.position.x = Math.min(DRAG_BOUNDS.maxX, Math.max(DRAG_BOUNDS.minX, x));
    p.group.position.y = Math.min(DRAG_BOUNDS.maxY, Math.max(DRAG_BOUNDS.minY, y));
    if (z !== undefined)
      p.group.position.z = Math.min(DRAG_BOUNDS.maxZ, Math.max(DRAG_BOUNDS.minZ, z));
    keepOut(p);
    p.homePos.copy(p.group.position);
    needsRender = true;
    return getVialPos();
  }
  function resetVial() {
    const meta = traj && dragId && traj.objects && traj.objects[dragId];
    if (!meta) return null;
    const z = SPAWN_Z[dragId] !== undefined ? SPAWN_Z[dragId] : meta.pos[2];
    return setVialPos(meta.pos[0], meta.pos[1], z);
  }

  // ---- grasp follow: while the recorded plan holds an object, the object rides
  // the gripper with the exact relative pose it had at the grasp instant -------
  const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _rq = new THREE.Quaternion(), _off = new THREE.Vector3();
  const graspPos = new THREE.Vector3(), graspRel = new THREE.Quaternion();
  let heldNow = false;                                     // is the plan currently holding its object?

  // a dedicated LoadingManager so we know when every mesh has arrived
  const manager = new THREE.LoadingManager();
  let finalized = false;

  const loader = new URDFLoader(manager);
  loader.packages = {
    ur_description: 'static/meshes/ur_description',
    robotiq_description: 'static/meshes/robotiq_description',
    iai_tracy_description: 'static/meshes/iai_tracy_description',
  };

  loader.load('static/tracy.urdf', function (model) {
    robot = model;
    robot.rotation.x = -Math.PI / 2;          // URDF Z-up → Three Y-up

    // start at the idle HOME pose (joints exist right after parse); the
    // render loop then eases toward whatever step pose is requested
    setPoseInstant(POSES.home);

    scene.add(robot);
    needsRender = true;
  },
  undefined,
  function (err) {                             // onError
    console.error(err);
    statusEl.textContent = 'Could not load the 3D model — showing the photo instead.';
    const btn = document.querySelector('.view-toggle button[data-view="photo"]');
    if (btn) btn.click();
  });

  // finalize once all meshes have loaded (or shortly after, as a fallback).
  // If the fallback fired first, late-arriving meshes (notably the big table
  // STL) still get their materials once everything is really loaded.
  manager.onLoad = function () {
    if (finalized) { applyMaterials(); frameToRobot(); needsRender = true; }
    else finalize();
  };
  setTimeout(function () { if (robot) finalize(); }, 4000);

  function applyMaterials() {
    // upgrade every mesh to a PBR material so the environment map gives it
    // realistic metal/plastic reflections
    robot.traverse(function (c) {
      if (!c.isMesh || c.userData.pickProxy) return;
      c.castShadow = true;
      c.receiveShadow = true;
      const wasArray = Array.isArray(c.material);
      const mats = wasArray ? c.material : [c.material];
      const up = mats.map(upgradeMaterial);
      c.material = wasArray ? up : up[0];
    });

    // brushed stainless bench, like the real workcell table in the photo
    const benchMat = new THREE.MeshStandardMaterial({
      color: 0x8a9098, metalness: 0.72, roughness: 0.42, envMapIntensity: 0.95,
    });
    const tableLink = robot.links && robot.links.table;
    if (tableLink) {
      // only the link's own visuals — the arms and camera pole are child links
      // of `table` in the kinematic tree and must keep their materials
      tableLink.children.forEach(function (child) {
        if (child.isURDFLink || child.isURDFJoint) return;
        child.traverse(function (c) { if (c.isMesh) c.material = benchMat; });
      });
    } else {
      // fallback: the bench is by far the largest mesh
      let bench = null, benchVol = 0;
      robot.traverse(function (c) {
        if (!c.isMesh) return;
        const b = new THREE.Box3().setFromObject(c);
        const s = b.getSize(new THREE.Vector3());
        const v = s.x * s.y * s.z;
        if (v > benchVol) { benchVol = v; bench = c; }
      });
      if (bench) bench.material = benchMat;
    }
  }

  function finalize() {
    if (finalized || !robot) return;
    finalized = true;
    applyMaterials();

    // drop the ground/grid to the robot's real base so the bench stands on it
    const rb = new THREE.Box3().setFromObject(robot);
    if (isFinite(rb.min.y)) { ground.position.y = rb.min.y; grid.position.y = rb.min.y + 0.002; }
    frameToRobot();
    statusEl.classList.add('hidden');
    readyCbs.forEach(function (cb) { cb(); });
    needsRender = true;

    // load the real CRAM/giskardpy trajectory and build the objects at the exact
    // map-frame coordinates the arm reaches for them (so arm and objects align)
    fetch('static/tracy_demo.json').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        traj = d;
        gripperLinkObj = (robot.links && robot.links[d.gripperLink]) || null;
        dragId = d.heldObject || null;
        // the recorded plan keeps commanding the gripper closed past contact
        // (0.79 rad ≈ fully shut) while it holds the vial, which visually clips
        // the fingers through it. Cap the closing at the value of the grasp
        // instant — the moment the plan considered the fingers in contact.
        const gAtt = d.frames && d.frames[d.attachFrame];
        gripCap = gAtt ? Math.abs(gAtt['left_robotiq_85_left_knuckle_joint'] || 0) || 0.25 : 0.25;
        if (d.objects) buildProps(d.objects);
        for (const sid in SPAWN_Z) {
          const sp = props[sid];
          if (sp) { sp.group.position.z = SPAWN_Z[sid]; sp.homePos.copy(sp.group.position); }
        }
        if (dragId && props[dragId]) {
          addPickProxy(props[dragId]);
          vialReadyCbs.forEach(function (cb) { cb(); });
        }
        needsRender = true;
      })
      .catch(function () {});
  }

  // ---- real trajectory playback (arm motion only) ---------------------------
  // Clean slate: this just plays the recorded joint trajectory. Object grasping,
  // pouring and placing were removed on purpose so we can rebuild them one step
  // at a time. The objects on the bench stay static during playback for now.
  let playEnd = 0, stepStartCb = function () {};

  function segByStep(step) { return traj && (traj.segments || []).filter(function (s) { return s.step === step; })[0]; }

  function resetProps() {
    for (const id in props) {
      if (props[id].homePos) props[id].group.position.copy(props[id].homePos);
      if (props[id].homeQuat) props[id].group.quaternion.copy(props[id].homeQuat);
    }
  }

  // start playback right after the arm has parked, so it begins from the idle pose
  function playStartFrame() { const p = segByStep('park'); return p ? p.end : 0; }

  function playTrajectory() {
    if (!traj || !robot) return false;
    if (dragging) endDrag();
    trajPlaying = true; heldNow = false;
    pourPhase = 0; pourDone = false;
    playhead = playStartFrame(); playEnd = traj.frames.length - 1;
    resetProps();
    computeRetarget();
    return true;
  }
  function stopTrajectory() { trajPlaying = false; heldNow = false; }

  // record the object's pose relative to the gripper at the grasp instant
  function captureGrasp(objId) {
    const p = props[objId]; if (!p || !gripperLinkObj) return;
    gripperLinkObj.getWorldQuaternion(_q);
    gripperLinkObj.getWorldPosition(_v);
    p.group.getWorldQuaternion(_q2);
    p.group.getWorldPosition(_off);
    _rq.copy(_q).invert();
    graspPos.copy(_off).sub(_v).applyQuaternion(_rq);      // offset in the gripper frame
    graspRel.copy(_rq).multiply(_q2);                      // orientation in the gripper frame
  }
  // reproduce that pose each frame → object rides the hand (and tilts with it)
  function followGrasp(objId) {
    const p = props[objId]; if (!p || !gripperLinkObj) return;
    gripperLinkObj.getWorldQuaternion(_q);
    gripperLinkObj.getWorldPosition(_v);
    _off.copy(graspPos).applyQuaternion(_q);
    _v.add(_off);
    robot.worldToLocal(_v);
    p.group.position.copy(_v);
    _q2.copy(_q).multiply(graspRel);
    robot.getWorldQuaternion(_rq).invert();
    p.group.quaternion.copy(_rq).multiply(_q2);
  }
  // set all joints for playhead position f: recorded frames + blended retarget
  // offsets + the gripper flip. Used by playback and by the collision sweep.
  function applyFrame(f) {
    const F = traj.frames;
    const i0 = Math.floor(f), i1 = Math.min(i0 + 1, F.length - 1), a = f - i0;
    const f0 = F[i0], f1 = F[i1];
    const w = jointOffsets ? retargetWeight(f) : 0;
    const wp = pourOffsets ? pourWeight(f) : 0;
    const wl = placeOffsets ? placeWeight(f) : 0;
    const wf = flipWeight(f);
    for (const k in f0) {
      const j = robot.joints[k]; if (!j) continue;
      let v = f0[k] + (f1[k] - f0[k]) * a;
      if (w && jointOffsets[k] !== undefined) v += jointOffsets[k] * w;
      if (wp && pourOffsets[k] !== undefined) v += pourOffsets[k] * wp;
      if (wl && placeOffsets[k] !== undefined) v += placeOffsets[k] * wl;
      // the tilt rides the pour weight: the vial rotates up while it glides to
      // the canister (bottom swinging away from it) and rights itself on the
      // way to the landing spot — no upright dip into the canister
      if (k === FLIP_JOINT) { if (wf) v += GRIP_FLIP * wf; if (wp) v += pourTilt * wp; }
      if (k.indexOf('left_robotiq') === 0)                // fingers stop at the vial, not through it
        v = Math.max(-gripCap, Math.min(gripCap, v));
      j.setJointValue(v);
    }
  }

  function stepTrajectory() {
    // the pour hold: freeze the playhead while the vial is fully tipped over
    // the canister opening (the tilt itself rides the pour weight in/out)
    const pouring = pourOffsets && !pourDone && heldNow && playhead >= pourAtFrame;
    if (pouring) {
      pourPhase += 1 / (60 * POUR_SECONDS);
      if (pourPhase >= 1) pourDone = true;
    }
    applyFrame(playhead);
    const i0 = Math.floor(playhead);

    const obj = traj.heldObject;
    if (obj && i0 >= traj.attachFrame && i0 < traj.detachFrame) {
      if (!heldNow) { captureGrasp(obj); heldNow = true; }
      followGrasp(obj);
    } else {
      heldNow = false;
    }

    if (!pouring)
      playhead += (traj.fps / 60) * 1.8;          // ~1.8× real-time (tick ≈ 60 fps)
    if (playhead >= playEnd) { trajPlaying = false; heldNow = false; stepStartCb('__done__'); }
  }

  // ------------------------------------------------ pickup retargeting (IK) ----
  // The trajectory is a fixed recording, so when the vial is dragged somewhere
  // else the recorded grasp would miss it. At play start we solve IK once for
  // the left arm at the grasp instant, shifted by the vial's displacement, and
  // blend the resulting joint deltas in over the reach (0 → 1 at the grasp) and
  // back out over the lift-carry (1 → 0 by the start of the place segment) —
  // so the pour/place still happens exactly on the recorded path.
  function smoothstep(t) { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); }

  function retargetWeight(f) {
    const pick = segByStep('pickup'), place = segByStep('place');
    const a = pick ? pick.start : 0;
    const b = traj.attachFrame;
    const c = place ? place.start : traj.detachFrame;
    if (f <= a || f >= c) return 0;
    if (f < b) return smoothstep((f - a) / (b - a));
    return 1 - smoothstep((f - b) / (c - b));
  }

  // the gripper flip ramps in over the reach, then HOLDS through carry, pour and
  // place (unlike the position retarget): a local-frame roll kept constant while
  // the object is attached cancels out of the object's world path — rolling back
  // mid-carry would spin the vial. It unwinds only after the release.
  function flipWeight(f) {
    if (!GRIP_FLIP) return 0;
    const pick = segByStep('pickup');
    const a = pick ? pick.start : 0;
    const b = traj.attachFrame, d = traj.detachFrame;
    const end = traj.frames.length - 1;
    if (f <= a || f >= end) return 0;
    if (f < b) return smoothstep((f - a) / (b - a));
    if (f < d) return 1;
    return 1 - smoothstep((f - d) / (end - d));
  }

  // pour offsets: carry the vial to above the canister (ramp in over the early
  // place segment), hold for the pour, then hand over to the landing offsets
  function pourWeight(f) {
    const place = segByStep('place'); if (!place) return 0;
    const a = place.start, d = traj.detachFrame, fe = d - 8;
    if (f <= a || f >= fe) return 0;
    const b = a + 0.3 * (d - a);
    if (f < b) return smoothstep((f - a) / (b - a));
    if (f <= pourAtFrame) return 1;
    return 1 - smoothstep((f - pourAtFrame) / (fe - pourAtFrame));
  }
  // landing offsets: cross-fade in from the pour spot, hold through the release,
  // unwind while the (empty) hand retreats
  function placeWeight(f) {
    const place = segByStep('place'); if (!place) return 0;
    const d = traj.detachFrame, fe = d - 8, end = traj.frames.length - 1;
    const a = pourOffsets ? pourAtFrame : place.start;
    if (f <= a) return 0;
    if (f < fe) return smoothstep((f - a) / (fe - a));
    if (f < d) return 1;
    return 1 - smoothstep((f - d) / (end - d));
  }

  // ---- table collision guard --------------------------------------------------
  // Points along the arm that must stay above the bench top, each with an
  // approximate body radius. Endpoints suffice for the straight tube segments.
  const TABLE_TOP = 0.88;        // bench surface, map frame (== world y here)
  const CLEAR_MARGIN = 0.012;
  const CLEAR_JOINTS = [
    ['left_elbow_joint', 0.06], ['left_wrist_1_joint', 0.05],
    ['left_wrist_2_joint', 0.05], ['left_wrist_3_joint', 0.05],
  ];
  const CLEAR_LINKS = [
    ['left_robotiq_85_base_link', 0.055],
    ['left_robotiq_85_left_finger_tip_link', 0.015],
    ['left_robotiq_85_right_finger_tip_link', 0.015],
  ];
  // worst signed clearance of the monitored points at the CURRENT joint state
  function tableClearance() {
    let worst = Infinity;
    CLEAR_JOINTS.forEach(function (c) {
      const o = robot.joints[c[0]];
      if (o) { o.getWorldPosition(_v); worst = Math.min(worst, _v.y - c[1] - TABLE_TOP); }
    });
    CLEAR_LINKS.forEach(function (c) {
      const o = robot.links && robot.links[c[0]];
      if (o) { o.getWorldPosition(_v); worst = Math.min(worst, _v.y - c[1] - TABLE_TOP); }
    });
    return worst;
  }
  // deepest violation (m) over the whole retargeted stretch of the playback,
  // with the candidate jointOffsets applied. 0 → everything clears the bench.
  function sweepViolation() {
    const pick = segByStep('pickup');
    const a = pick ? pick.start : 0;
    let worst = Infinity;
    for (let f = a; f <= traj.frames.length - 1; f += 8) {
      applyFrame(f);
      robot.updateMatrixWorld(true);
      worst = Math.min(worst, tableClearance());
    }
    return Math.max(0, CLEAR_MARGIN - worst);
  }

  function setFrameJoints(fr) {
    for (const k in fr) { const j = robot.joints[k]; if (j) j.setJointValue(fr[k]); }
  }
  function offsetsFrom(sol, fr) {
    const o = {};
    LEFT_ARM.forEach(function (n) { o[n] = sol[n] - (fr[n] || 0); });
    return o;
  }

  // Solve the retarget offsets for this playback: grasp the vial wherever it
  // stands, pour above the canister, stand the vial down on the bench. All
  // three targets share the recorded gripper orientation; a common grasp lift
  // (regrasp higher up the vial) is raised until the whole blended motion
  // clears the bench top.
  function computeRetarget() {
    jointOffsets = pourOffsets = placeOffsets = null;
    const id = traj && traj.heldObject, p = id && props[id];
    const meta = id && traj.objects && traj.objects[id];
    if (!p || !meta || !gripperLinkObj) return;

    const place = segByStep('place');
    pourAtFrame = place ? Math.round(place.start + 0.45 * (traj.detachFrame - place.start)) : traj.detachFrame;
    const canister = place && place.place && props[place.place];

    const saved = {};
    for (const n in robot.joints) saved[n] = robot.joints[n].angle || 0;

    // recorded gripper poses at the grasp and at the release instant
    const gA = traj.frames[traj.attachFrame] || {};
    setFrameJoints(gA); robot.updateMatrixWorld(true);
    const attPos = gripperLinkObj.getWorldPosition(new THREE.Vector3());
    const attQ = gripperLinkObj.getWorldQuaternion(new THREE.Quaternion());
    const gD = traj.frames[traj.detachFrame] || {};
    setFrameJoints(gD); robot.updateMatrixWorld(true);
    const detPos = gripperLinkObj.getWorldPosition(new THREE.Vector3());
    const detQ = gripperLinkObj.getWorldQuaternion(new THREE.Quaternion());

    // world-frame displacement of the vial from its recorded spot
    robot.getWorldQuaternion(_rq);
    const deltaW = new THREE.Vector3(
      p.group.position.x - meta.pos[0], p.group.position.y - meta.pos[1], p.group.position.z - meta.pos[2]
    ).applyQuaternion(_rq);
    const vialW = p.group.getWorldPosition(new THREE.Vector3());
    const canW = canister ? canister.group.getWorldPosition(new THREE.Vector3()) : null;
    const landY = TABLE_TOP + (p.h || 0.14) / 2 + 0.004;  // vial standing on the bench

    const MAX_LIFT = Math.min(0.09, (p.h || 0.14) * 0.55 + 0.02);
    let lift = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      // 1) grasp at the vial (skip if it stands exactly on the recorded spot)
      const graspTarget = attPos.clone().add(deltaW).addScaledVector(UP, lift);
      jointOffsets = null;
      if (deltaW.length() > 0.004 || lift > 0) {
        setFrameJoints(gA);
        const s = solveArmIK(graspTarget, attQ.clone());
        if (!s) break;                                    // unreachable → play as recorded
        jointOffsets = offsetsFrom(s, gA);
      }
      // where the vial sits relative to the gripper once grasped
      const relW = vialW.clone().sub(graspTarget);

      // 2) pour spot: the vial's MOUTH, at full tilt, sits just above the
      // canister opening. The vial pivots about the wrist roll axis (the line
      // through the grasp point), so mouth-at-tilt = pivot + R·(mouth − pivot).
      pourOffsets = null;
      if (canW && POUR_TILT) {
        setFrameJoints(gD); robot.updateMatrixWorld(true);
        const j3 = robot.joints[FLIP_JOINT];
        const axisW = j3.axis.clone().applyQuaternion(j3.getWorldQuaternion(new THREE.Quaternion()));
        // tilt sign: the bottom must swing back toward the release side, so the
        // body never sweeps across the canister while turning
        const sideDir = detPos.clone().add(relW).sub(canW); sideDir.y = 0; sideDir.normalize();
        const bottomAt = function (sgn) { return new THREE.Vector3(0, -1, 0).applyAxisAngle(axisW, sgn * POUR_TILT); };
        pourTilt = bottomAt(1).dot(sideDir) >= bottomAt(-1).dot(sideDir) ? POUR_TILT : -POUR_TILT;

        const canTopY = canW.y + (canister.h || 0.11) / 2 + 0.05;   // above the ports too
        const mouthTarget = canW.clone().setY(canTopY + POUR_CLEAR);
        // full 3-D vector from the grasp point to the vial's mouth (top when
        // upright), then rotated by the tilt. Rotating the WHOLE vector — not
        // just its vertical part — is the fix: the horizontal grasp offset also
        // swings up/down as the vial tips, which the old split-axis form dropped
        // (that was the residual y error over the canister opening).
        const graspToMouth = relW.clone().add(new THREE.Vector3(0, (p.h || 0.14) / 2, 0));
        const mouthArm = graspToMouth.applyAxisAngle(axisW, pourTilt);
        const gt = mouthTarget.clone().sub(mouthArm);
        const s2 = solveArmIK(gt, detQ.clone());
        if (s2) pourOffsets = offsetsFrom(s2, gD);
      }
      // 3) landing: recorded release spot, but the vial standing on the bench
      const gt2 = detPos.clone().setY(landY - relW.y);
      setFrameJoints(gD);
      const s3 = solveArmIK(gt2, detQ.clone());
      placeOffsets = s3 ? offsetsFrom(s3, gD) : null;

      const viol = sweepViolation();
      if (!viol || lift >= MAX_LIFT) break;               // clean (or as high as a grasp can go)
      lift = Math.min(MAX_LIFT, lift + viol + 0.01);
    }
    for (const n in saved) { const j = robot.joints[n]; if (j) j.setJointValue(saved[n]); }
  }
  const UP = new THREE.Vector3(0, 1, 0);                  // world up

  // damped-least-squares IK over the 6 left-arm joints: move the gripper base
  // link to the target pose (position + orientation). Operates on the live
  // joints; the caller saves/restores the joint state around it.
  function solveArmIK(targetPos, targetQuat) {
    const joints = LEFT_ARM.map(function (n) { return robot.joints[n]; });
    if (!gripperLinkObj || joints.some(function (j) { return !j; })) return null;
    const pe = new THREE.Vector3(), qe = new THREE.Quaternion(), qerr = new THREE.Quaternion();
    const jp = new THREE.Vector3(), jq = new THREE.Quaternion(), ax = new THREE.Vector3(), arm = new THREE.Vector3();
    const LAMBDA2 = 0.0025, STEP = 0.2;
    let perr = Infinity;
    for (let iter = 0; iter < 80; iter++) {
      robot.updateMatrixWorld(true);
      gripperLinkObj.getWorldPosition(pe);
      gripperLinkObj.getWorldQuaternion(qe);
      qerr.copy(qe).invert().premultiply(targetQuat);     // rotation still needed
      if (qerr.w < 0) { qerr.x = -qerr.x; qerr.y = -qerr.y; qerr.z = -qerr.z; qerr.w = -qerr.w; }
      const ang = 2 * Math.acos(Math.min(1, qerr.w));
      const s = Math.sqrt(Math.max(0, 1 - qerr.w * qerr.w));
      const k = s > 1e-6 ? ang / s : 2;
      const e = [targetPos.x - pe.x, targetPos.y - pe.y, targetPos.z - pe.z, qerr.x * k, qerr.y * k, qerr.z * k];
      perr = Math.hypot(e[0], e[1], e[2]);
      if (perr < 0.002 && ang < 0.01) break;
      // geometric Jacobian, one column per joint: [axis × (pe − pj); axis]
      const J = joints.map(function (j) {
        j.getWorldPosition(jp);
        j.getWorldQuaternion(jq);
        ax.copy(j.axis).applyQuaternion(jq);
        arm.copy(pe).sub(jp);
        const lin = new THREE.Vector3().crossVectors(ax, arm);
        return [lin.x, lin.y, lin.z, ax.x, ax.y, ax.z];
      });
      // dq = Jᵀ (J Jᵀ + λ²I)⁻¹ e
      const A = [];
      for (let r = 0; r < 6; r++) {
        A[r] = [];
        for (let c = 0; c < 6; c++) {
          let v = 0;
          for (let i = 0; i < 6; i++) v += J[i][r] * J[i][c];
          A[r][c] = v + (r === c ? LAMBDA2 : 0);
        }
      }
      const y = solve6(A, e);
      if (!y) return null;
      for (let c = 0; c < 6; c++) {
        let dq = 0;
        for (let r = 0; r < 6; r++) dq += J[c][r] * y[r];
        dq = Math.max(-STEP, Math.min(STEP, dq));
        joints[c].setJointValue((joints[c].angle || 0) + dq);
      }
    }
    if (perr > 0.05) return null;                         // did not get close enough
    const out = {};
    LEFT_ARM.forEach(function (n) { out[n] = robot.joints[n].angle || 0; });
    return out;
  }

  // 6×6 linear solve, Gaussian elimination with partial pivoting
  function solve6(A, b) {
    const n = 6, M = A.map(function (row, i) { return row.concat([b[i]]); });
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      const t = M[p]; M[p] = M[c]; M[c] = t;
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let v = M[r][n];
      for (let c = r + 1; c < n; c++) v -= M[r][c] * x[c];
      x[r] = v / M[r][r];
    }
    return x;
  }

  // -------------------------------------------------- drag the vial around ----
  // Left-drag the vial to move it anywhere on the bench (within DRAG_BOUNDS);
  // the next play picks it up from there. Orbit controls pause while dragging.
  // Motion is mapped from screen deltas via the camera basis instead of a
  // ray/bench-plane intersection: the default camera sits almost level with the
  // bench, where a horizontal plane is hit at grazing angles (or not at all for
  // screen-down drags), which made pulling the vial forward impossible.
  const dragRay = new THREE.Raycaster(), dragNdc = new THREE.Vector2();
  const dragStartNdc = new THREE.Vector2(), dragStartWorld = new THREE.Vector3();
  const camRight = new THREE.Vector3(), camFwd = new THREE.Vector3(), camUp = new THREE.Vector3();

  function pointerNdc(e) {
    const r = renderer.domElement.getBoundingClientRect();
    dragNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }
  function pickDraggable(e) {
    if (!dragId || !props[dragId]) return null;
    pointerNdc(e);
    dragRay.setFromCamera(dragNdc, camera);
    const meshes = [];
    props[dragId].group.traverse(function (c) { if (c.isMesh) meshes.push(c); });
    return dragRay.intersectObjects(meshes, false).length ? props[dragId] : null;
  }
  // invisible, slightly fatter cylinder so the thin vial is easy to grab
  function addPickProxy(p) {
    const r = Math.max(0.05, (p.h || 0.1) * 0.5);
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, (p.h || 0.1) * 1.6, 12),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    m.userData.pickProxy = true;
    p.group.add(m);
  }

  renderer.domElement.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    clickX = e.clientX; clickY = e.clientY; clickArmed = true;   // for click-to-inspect
    if (trajPlaying) return;
    const p = pickDraggable(e);
    if (!p) return;
    dragging = true;
    controls.enabled = false;
    renderer.domElement.setPointerCapture(e.pointerId);
    renderer.domElement.style.cursor = 'grabbing';
    dragStartNdc.copy(dragNdc);                           // pointerNdc ran in pickDraggable
    p.group.getWorldPosition(dragStartWorld);
    p.glowTarget = 1;
    if (p.label) p.label.visible = true;
    needsRender = true;
    e.preventDefault();
  });
  renderer.domElement.addEventListener('pointermove', function (e) {
    if (!dragging) {
      if (!trajPlaying && e.buttons === 0)
        renderer.domElement.style.cursor = pickDraggable(e) ? 'grab' : '';
      return;
    }
    pointerNdc(e);
    // world metres per NDC unit at the vial's distance from the (static) camera
    const dist = camera.position.distanceTo(dragStartWorld);
    const halfH = Math.tan((camera.fov * Math.PI) / 360) * dist;
    const halfW = halfH * camera.aspect;
    // horizontal camera basis: screen-x → right, screen-y → away from camera.
    // The away axis is foreshortened by the view pitch; compensate, but clamp
    // the gain so a near-level camera stays controllable.
    camera.getWorldDirection(camFwd);
    const pitch = Math.max(0.3, Math.abs(camFwd.y));
    camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    camRight.y = 0; camRight.normalize();
    // blend the horizontal parts of the view and up vectors: they point the same
    // way (away from the camera) and never vanish together, at any pitch
    camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    camFwd.y = 0; camUp.y = 0;
    camFwd.add(camUp).normalize();
    _v.copy(dragStartWorld)
      .addScaledVector(camRight, (dragNdc.x - dragStartNdc.x) * halfW)
      .addScaledVector(camFwd, (dragNdc.y - dragStartNdc.y) * (halfH / pitch));
    const p = props[dragId];
    robot.worldToLocal(_v);                               // map frame (z-up), height stays
    p.group.position.x = Math.min(DRAG_BOUNDS.maxX, Math.max(DRAG_BOUNDS.minX, _v.x));
    p.group.position.y = Math.min(DRAG_BOUNDS.maxY, Math.max(DRAG_BOUNDS.minY, _v.y));
    keepOut(p);
    p.homePos.copy(p.group.position);                     // survives resetProps()
    vialMovedCbs.forEach(function (cb) { cb(getVialPos()); });
    needsRender = true;
  });
  // don't let the vial be dropped inside another bench object — push it to the
  // rim of a small keep-out circle around each one instead
  function keepOut(p) {
    const MIN_D = 0.10;
    for (const id in props) {
      if (id === dragId) continue;
      const o = props[id].group.position;
      const dx = p.group.position.x - o.x, dy = p.group.position.y - o.y;
      const d = Math.hypot(dx, dy);
      if (d >= MIN_D) continue;
      if (d > 1e-6) {
        p.group.position.x = o.x + (dx / d) * MIN_D;
        p.group.position.y = o.y + (dy / d) * MIN_D;
      } else {
        p.group.position.y = o.y + MIN_D;
      }
    }
  }
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    controls.enabled = true;
    renderer.domElement.style.cursor = '';
    const p = props[dragId];
    if (p) {
      p.glowTarget = 0;
      if (p.label) p.label.visible = false;
    }
    needsRender = true;
  }
  renderer.domElement.addEventListener('pointerup', function (e) {
    endDrag();
    // ---- click-to-inspect: a press that barely moved is a click, not an orbit
    // drag — resolve what was hit and report the matching KB entity id
    if (!clickArmed) return;
    clickArmed = false;
    if (Math.hypot(e.clientX - clickX, e.clientY - clickY) > 5) return;
    const id = pickEntity(e);
    if (id && partClickCb) { partClickCb(id); highlight(true); needsRender = true; }
  });
  renderer.domElement.addEventListener('pointercancel', function () { clickArmed = false; endDrag(); });

  // ---- click-to-inspect helpers ----------------------------------------------
  let partClickCb = null;
  let clickX = 0, clickY = 0, clickArmed = false;

  // nearest hit under the pointer → KB entity id: a bench object (its group
  // carries userData.propId) or a robot part, classified by its URDF link name
  function pickEntity(e) {
    if (!robot) return null;
    pointerNdc(e);
    dragRay.setFromCamera(dragNdc, camera);
    const hits = dragRay.intersectObject(robot, true);
    for (let i = 0; i < hits.length; i++) {
      if (hits[i].object.isSprite) continue;              // object labels
      const id = classifyHit(hits[i].object);
      if (id) return id;
    }
    return null;
  }
  function classifyHit(obj) {
    let o = obj;
    while (o && o !== scene) {
      if (o.userData && o.userData.propId) return o.userData.propId;
      if (o.isURDFLink && o.name) {
        const n = o.name;
        if (n.indexOf('left_robotiq') === 0) return 'left_gripper';
        if (n.indexOf('right_robotiq') === 0) return 'right_gripper';
        if (n.indexOf('left_') === 0) return 'left_arm';
        if (n.indexOf('right_') === 0) return 'right_arm';
        return 'tracy';                                   // table, camera pole, base…
      }
      o = o.parent;
    }
    return null;
  }

  // --------------------------------------------------------- bench objects ----
  // Which bench objects to actually place. Kept minimal for now — expand this
  // list (ids from trajectory.json → objects) to bring more back into the scene.
  const DEMO_OBJECTS = ['sterility_canister', 'media_tsb'];

  // Build the sterility-test objects from the trajectory's object layout. Each
  // object is a child of the robot ROOT and placed at the SAME map-frame
  // coordinate the arm reaches for it, so the arm actually meets the object.
  // (the root carries rotation.x = -90°, so local z-up coords map to world y-up)
  function buildProps(objMeta) {
    if (!robot || !objMeta) return;
    for (const id in objMeta) {
      if (DEMO_OBJECTS && DEMO_OBJECTS.indexOf(id) < 0) continue;   // start with a minimal scene
      const o = objMeta[id];
      if (o.kind === 'bottle') addBottle(id, o.pos, o.h, o.r, o.color, o.liquid, o.label);
      else if (o.kind === 'canister') addCanister(id, o.pos, o.label);
      else if (o.kind === 'box') addBox(id, o.pos, o.w, o.d, o.h, o.color, o.accent, o.label);
    }
    for (const id in props) props[id].homePos = props[id].group.position.clone();

    function register(id, group, mats, h, pos, label) {
      group.rotation.x = Math.PI / 2;          // stand up along map z
      group.userData.propId = id;              // click-to-inspect resolves meshes to this
      group.position.set(pos[0], pos[1], pos[2]);
      robot.add(group);
      props[id] = { group: group, mats: mats, glow: 0, glowTarget: 0, h: h || 0, homeQuat: group.quaternion.clone() };
      addLabel(id, group, h || 0.1, label);
    }

    function addBottle(id, pos, h, r, liquidColor, level, label) {
      const g = new THREE.Group();
      // opaque, solid container coloured by its contents (not see-through glass)
      const glassMat = new THREE.MeshStandardMaterial({
        color: liquidColor, metalness: 0.0, roughness: 0.34, envMapIntensity: 0.55,
      });
      const glass = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 48), glassMat);
      const capMat = new THREE.MeshStandardMaterial({ color: 0xf2f5fa, roughness: 0.35, metalness: 0.1, envMapIntensity: 0.8 });
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.62, h * 0.12, 32), capMat);
      cap.position.y = h / 2 + h * 0.05;
      [glass, cap].forEach(function (m) { m.castShadow = true; g.add(m); });
      register(id, g, [glassMat, capMat], h, pos, label);
    }

    function addCanister(id, pos, label) {
      const g = new THREE.Group();
      const h = 0.11, r = 0.052;
      // opaque white plastic body (like a real Steritest canister), not glass
      const bodyMat = new THREE.MeshStandardMaterial({
        color: 0xeef1f5, metalness: 0.05, roughness: 0.42, envMapIntensity: 0.6,
      });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 48), bodyMat);
      const baseMat = new THREE.MeshStandardMaterial({ color: 0x2f6fb0, roughness: 0.4, metalness: 0.3, envMapIntensity: 0.9 });
      const base = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.1, r * 1.15, h * 0.28, 48), baseMat);
      base.position.y = -h / 2 - h * 0.08;
      const portMat = new THREE.MeshStandardMaterial({ color: 0xaab4c4, roughness: 0.3, metalness: 0.6, envMapIntensity: 1.0 });
      [-1, 1].forEach(function (s) {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.05, 16), portMat);
        p.position.set(s * 0.018, h / 2 + 0.025, 0); g.add(p);
      });
      [body, base].forEach(function (m) { m.castShadow = true; g.add(m); });
      register(id, g, [bodyMat, baseMat], h, pos, label);
    }

    function addBox(id, pos, w, d, h, color, accent, label) {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.6, metalness: 0.1 });
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      b.castShadow = true; g.add(b);
      const stripMat = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.25, roughness: 0.5 });
      const strip = new THREE.Mesh(new THREE.BoxGeometry(w * 1.01, h * 0.12, d * 1.01), stripMat);
      strip.position.y = h * 0.2; g.add(strip);
      register(id, g, [mat], h, pos, label);
    }

    function addLabel(id, group, h, label) {
      const text = label || (window.PROP_LABELS && window.PROP_LABELS[id]) || id;
      const pad = 16, fs = 34;
      const cv = document.createElement('canvas');
      const ctx = cv.getContext('2d');
      ctx.font = '600 ' + fs + 'px Inter, sans-serif';
      const w = ctx.measureText(text).width + pad * 2;
      cv.width = w; cv.height = fs + pad * 2;
      ctx.font = '600 ' + fs + 'px Inter, sans-serif';
      ctx.fillStyle = 'rgba(10,17,32,0.82)';
      roundRect(ctx, 0, 0, cv.width, cv.height, 12); ctx.fill();
      ctx.strokeStyle = 'rgba(57,213,200,0.5)'; ctx.lineWidth = 2;
      roundRect(ctx, 1, 1, cv.width - 2, cv.height - 2, 12); ctx.stroke();
      ctx.fillStyle = '#e8eefb'; ctx.textBaseline = 'middle';
      ctx.fillText(text, pad, cv.height / 2);
      const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4;
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
      const scale = 0.0016;
      spr.scale.set(cv.width * scale, cv.height * scale, 1);
      spr.position.y = h / 2 + 0.07;
      spr.userData.isLabel = true;
      spr.visible = false;                     // shown only when highlighted
      group.add(spr);
      props[id].label = spr;
    }

    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
  }

  // light up the objects a step touches; dim the rest
  function highlightObjects(ids) {
    const set = {}; (ids || []).forEach(function (i) { set[i] = 1; });
    for (const id in props) {
      const on = !!set[id];
      props[id].glowTarget = on ? 1 : 0;
      if (props[id].label) props[id].label.visible = on;
    }
  }

  // Map each UR10e / Robotiq DAE material to a physically plausible PBR finish so
  // the arms read like the real robot: polished aluminium tubes, satin graphite
  // joint housings, glossy blue caps, matte-black cabling. Keyed on the DAE
  // material name (LinkGrey / JointGrey / URBlue / Black) with a colour-based
  // fallback when the loader doesn't carry a usable name.
  function pbrFinish(nameRaw, color) {
    const name = (nameRaw || '').toLowerCase();
    const lum = color ? (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) : 0.5;
    const bluish = !!color && color.b > color.r + 0.12 && color.b > 0.5;
    const nearNeutral = !!color && Math.abs(color.r - color.b) < 0.06 && Math.abs(color.r - color.g) < 0.06;
    // colour drives the decision (name only overrides). CRITICAL: only the arm
    // tubes are genuinely metallic — plastics keep metalness 0 so their diffuse
    // colour stays saturated instead of washing out under the bright IBL.
    // polished aluminium arm tubes
    if (name.indexOf('link') >= 0 || (nearNeutral && lum > 0.6))
      return { metalness: 0.9, roughness: 0.33, env: 0.9, tint: 0xb9bec5 };
    // glossy UR blue caps — punchy plastic blue
    if (name.indexOf('blue') >= 0 || bluish)
      return { metalness: 0.0, roughness: 0.28, env: 0.4, tint: 0x3f9bd6 };
    // matte black plastic / rubber / cable conduit
    if (name.indexOf('black') >= 0 || lum < 0.1)
      return { metalness: 0.0, roughness: 0.5, env: 0.28 };
    // satin graphite joint housings (mid greys) + sensible default — dark plastic
    return { metalness: 0.0, roughness: 0.46, env: 0.38,
             tint: (nearNeutral && lum > 0.15 && lum < 0.6) ? 0x3a3d43 : undefined };
  }

  function upgradeMaterial(old) {
    const name = old && old.name ? old.name : '';
    const f = pbrFinish(name, old && old.color ? old.color : null);
    const m = (old && old.isMeshStandardMaterial) ? old : new THREE.MeshStandardMaterial();
    if (old && old !== m) {
      if (old.color) m.color.copy(old.color);
      if (old.map) m.map = old.map;
      if (old.emissive) m.emissive.copy(old.emissive);
      if (old.vertexColors) m.vertexColors = old.vertexColors;
      if (old.transparent) { m.transparent = true; m.opacity = old.opacity; }
      m.name = name;
    }
    if (f.tint !== undefined) m.color.setHex(f.tint);
    m.metalness = f.metalness;
    m.roughness = f.roughness;
    m.envMapIntensity = f.env;
    m.needsUpdate = true;
    return m;
  }

  function setJoint(name, v) {
    if (robot && robot.joints[name]) robot.setJointValue(name, v);
  }
  function setGripperSide(side, v) {
    // Robotiq 2F-85 driver joints for one hand (v: 0 open … ~0.8 closed)
    setJoint(side + '_robotiq_85_left_knuckle_joint', v);
    setJoint(side + '_robotiq_85_right_knuckle_joint', v);
    setJoint(side + '_robotiq_85_left_inner_knuckle_joint', v);
    setJoint(side + '_robotiq_85_right_inner_knuckle_joint', v);
    setJoint(side + '_robotiq_85_left_finger_tip_joint', -v);
    setJoint(side + '_robotiq_85_right_finger_tip_joint', -v);
  }

  function frameToRobot() {
    const box = new THREE.Box3().setFromObject(robot);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    controls.target.copy(center);

    // fit BOTH height and width for the current (often wide) viewport, with margin
    const fov = (camera.fov * Math.PI) / 180;
    const aspect = camera.aspect || (container.clientWidth / Math.max(1, container.clientHeight)) || 1.6;
    const fitH = (size.y / 2) / Math.tan(fov / 2);
    const fitW = (Math.max(size.x, size.z) / 2) / (Math.tan(fov / 2) * aspect);
    const dist = Math.max(fitH, fitW) * 1.45;

    // look slightly down from the front so the whole robot stays in frame
    camera.position.set(center.x + dist * 0.55, center.y + size.y * 0.12, center.z + dist * 0.9);
    camera.near = Math.max(0.01, dist / 100); camera.far = dist * 100;
    camera.updateProjectionMatrix();
    controls.update();
  }

  // ---------------------------------------------------------------- poses ----
  // The six controlled joints per arm. A pose is a full assignment for both
  // arms plus per-hand gripper openings, so every step is a deterministic,
  // repeatable configuration — no random motion.
  //   pan  : shoulder rotation (reach left/centre/right of the bench)
  //   lift : shoulder lift (how far the arm reaches down onto the bench)
  //   elb  : elbow bend
  //   w1   : wrist pitch (tool pointing)
  //   w2   : wrist yaw (kept near ±90°)
  //   w3   : wrist roll (used to sell pouring / twisting caps)
  //   lg/rg: left/right gripper (0 open … 0.8 closed)
  function P(o) { return o; }
  const POSES = {
    // idle / starting pose — the exact first frame of the real giskardpy
    // trajectory (static/trajectory.json), i.e. the robot's true planned start
    // pose, which reads perfectly. Keep in sync if the trajectory is replaced.
    home:            P({ lpan: 2.620, llift:-1.035, lelb:1.130, lw1:-0.966, lw2:-0.880, lw3:2.070, rpan: 3.707, rlift:-2.070, relb:-1.170, rw1:4.000, rw2:0.820, rw3:0.750, lg:.02, rg:.02 }),
    // ready — both arms reach forward & down over the bench (REAL giskardpy
    // joint values captured from a two-arm reach; matches the robot photos)
    prep:            P({ lpan: 2.939, llift:-1.473, lelb:2.132, lw1:-1.879, lw2:-0.558, lw3:2.739, rpan: 3.345, rlift:-1.668, relb:-2.131, rw1:5.018, rw2:0.558, rw3:-2.737, lg:.08, rg:.08 }),
    // wiping the bench surface — both hands low, sweeping outward
    disinfect:       P({ lpan: .35, llift:-1.30, lelb:1.20, lw1:-1.45, lw2:-1.57, lw3:.35, rpan:-.35, rlift:-1.30, relb:-1.20, rw1:-1.45, rw2:1.57, rw3:-.35, lg:.25, rg:.25 }),
    // meet in the centre, right hand twists the canister cap open
    open_canister:   P({ lpan: .18, llift:-1.65, lelb:1.55, lw1:-1.50, lw2:-1.57, lw3:0,   rpan:-.16, rlift:-1.55, relb:-1.55, rw1:-1.40, rw2:1.57, rw3:1.1, lg:.75, rg:.80 }),
    // left holds a media bottle up, right inserts the spike / transfer set
    spike_media:     P({ lpan: .50, llift:-1.55, lelb:1.55, lw1:-1.45, lw2:-1.57, lw3:0,   rpan:-.22, rlift:-1.30, relb:-1.60, rw1:-1.30, rw2:1.57, rw3:0,  lg:.80, rg:.85 }),
    // both hands over the canister while the pump pulls the sample through
    filter_transfer: P({ lpan: .20, llift:-1.15, lelb:1.25, lw1:-1.50, lw2:-1.57, lw3:0,   rpan:-.20, rlift:-1.15, relb:-1.25, rw1:-1.50, rw2:1.57, rw3:0,  lg:.70, rg:.70 }),
    // rinsing — right wrist rolls to pour rinsing fluid through the membrane
    rinse:           P({ lpan: .28, llift:-1.40, lelb:1.40, lw1:-1.50, lw2:-1.57, lw3:0,   rpan:-.14, rlift:-1.35, relb:-1.50, rw1:-1.15, rw2:1.57, rw3:1.2, lg:.45, rg:.85 }),
    // fill the two chambers — both wrists roll to pour TSB & FTM
    fill_media:      P({ lpan: .16, llift:-1.55, lelb:1.55, lw1:-1.35, lw2:-1.57, lw3:-1.0,rpan:-.16, rlift:-1.50, relb:-1.55, rw1:-1.35, rw2:1.57, rw3:1.0, lg:.80, rg:.80 }),
    // carry the sealed canister across to incubation
    incubate:        P({ lpan: .95, llift:-1.10, lelb:1.05, lw1:-1.50, lw2:-1.57, lw3:0,   rpan:-.95, rlift:-1.05, relb:-1.05, rw1:-1.50, rw2:1.57, rw3:0,  lg:.85, rg:.85 }),
    // retract low & back so the pole camera has a clear look at the canister
    inspect:         P({ lpan: .80, llift:-2.20, lelb:2.05, lw1:-1.35, lw2:-1.57, lw3:0,   rpan:-.80, rlift:-2.15, relb:-2.05, rw1:-1.35, rw2:1.57, rw3:0,  lg:.10, rg:.10 }),
    // back to the ready-over-bench pose while the audit trail is written
    document:        P({ lpan: 2.939, llift:-1.473, lelb:2.132, lw1:-1.879, lw2:-0.558, lw3:2.739, rpan: 3.345, rlift:-1.668, relb:-2.131, rw1:5.018, rw2:0.558, rw3:-2.737, lg:.08, rg:.08 }),
  };

  const JMAP = {
    lpan:'left_shoulder_pan_joint',  llift:'left_shoulder_lift_joint',  lelb:'left_elbow_joint',
    lw1:'left_wrist_1_joint',        lw2:'left_wrist_2_joint',          lw3:'left_wrist_3_joint',
    rpan:'right_shoulder_pan_joint', rlift:'right_shoulder_lift_joint', relb:'right_elbow_joint',
    rw1:'right_wrist_1_joint',       rw2:'right_wrist_2_joint',         rw3:'right_wrist_3_joint',
  };

  // desired configuration the render loop eases toward
  let target = Object.assign({}, POSES.home);

  function poseForStep(id) {
    if (!POSES[id] || !robot) return;
    target = Object.assign({}, POSES[id]);   // full pose → no leftover jitter
    highlight(true);
  }

  // snap instantly (used once on load so there is no opening lurch)
  function setPoseInstant(pose) {
    target = Object.assign({}, pose);
    for (const k in JMAP) setJoint(JMAP[k], pose[k]);
    setGripperSide('left', pose.lg);
    setGripperSide('right', pose.rg);
  }

  function highlight(on) { highlightT = on ? 1.6 : 0; }

  // ---- render loop ----------------------------------------------------------
  const clock = new THREE.Clock();
  const EASE = 0.07;
  let needsRender = true;                     // render on demand; idle = GPU free
  controls.addEventListener('change', function () { needsRender = true; });

  // is anything actually animating right now? (pose easing, glow, trajectory…)
  function animating() {
    if (!robot) return false;
    if (trajPlaying || controls.autoRotate || highlightT > 0) return true;
    for (const k in JMAP) {
      const j = robot.joints[JMAP[k]];
      if (j && Math.abs((j.angle || 0) - target[k]) > 1e-3) return true;
    }
    if (Math.abs(lg - target.lg) > 1e-3 || Math.abs(rg - target.rg) > 1e-3) return true;
    for (const id in props) {
      const p = props[id];
      if (p.glow > 1e-3 || Math.abs(p.glow - p.glowTarget) > 1e-3) return true;
    }
    return false;
  }

  function tick() {
    requestAnimationFrame(tick);
    const t = clock.getElapsedTime();
    const active = animating();
    const moved = controls.update();          // true while orbiting / damping
    // skip the (transmission-heavy) render entirely when nothing changed —
    // this frees the GPU so dragging the knowledge graph stays smooth
    if (!active && !moved && !needsRender) return;

    if (DEMO_ARM_MOTION && robot && trajPlaying && traj) {
      stepTrajectory();
    } else if (robot) {
      for (const k in JMAP) {
        const j = robot.joints[JMAP[k]];
        if (!j) continue;
        const cur = j.angle || 0;
        j.setJointValue(cur + (target[k] - cur) * EASE);
      }
      lg += (target.lg - lg) * EASE; rg += (target.rg - rg) * EASE;
      setGripperSide('left', lg); setGripperSide('right', rg);
    }
    if (robot) {
      if (highlightT > 0) {
        highlightT -= 0.016;
        fill.intensity = 0.5 + Math.abs(Math.sin(t * 6)) * 1.2;
      } else {
        fill.intensity += (0.5 - fill.intensity) * 0.1;
      }
      const pulse = 0.6 + 0.4 * Math.abs(Math.sin(t * 3));
      for (const id in props) {
        const p = props[id];
        p.glow += (p.glowTarget - p.glow) * 0.12;
        const gi = p.glow * pulse;
        p.mats.forEach(function (m) {
          if (!m.emissive) m.emissive = new THREE.Color(0x39d5c8);
          else m.emissive.setHex(0x39d5c8);
          m.emissiveIntensity = gi * 0.9;
        });
        if (p.label) p.label.material.opacity = Math.min(1, p.glow * 1.5);
      }
    }

    renderer.render(scene, camera);
    needsRender = false;
  }
  let lg = POSES.prep.lg, rg = POSES.prep.rg;
  tick();

  // ---- resize ---------------------------------------------------------------
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix(); needsRender = true;
  }
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(container);
  resize();

  // ---- view toggles for the floating LAYERS panel ---------------------------
  function setPropsVisible(on) { for (const id in props) props[id].group.visible = on; needsRender = true; }
  function setLabelsAlways(on) { for (const id in props) if (props[id].label) props[id].label.visible = on; needsRender = true; }
  function setAutoRotate(on) { controls.autoRotate = on; controls.autoRotateSpeed = 0.6; }
  function setFloorVisible(on) { ground.visible = on; grid.visible = on; needsRender = true; }

  window.RobotView = {
    onReady: function (cb) { if (robot) cb(); else readyCbs.push(cb); },
    poseForStep: poseForStep,
    highlight: highlight,
    highlightObjects: highlightObjects,
    setPropsVisible: setPropsVisible,
    setLabelsAlways: setLabelsAlways,
    setAutoRotate: setAutoRotate,
    setFloorVisible: setFloorVisible,
    hasTrajectory: function () { return DEMO_ARM_MOTION && !!traj; },
    onPartClick: function (cb) { partClickCb = cb; },
    onVialReady: function (cb) { if (dragId && props[dragId]) cb(); else vialReadyCbs.push(cb); },
    onVialMoved: function (cb) { vialMovedCbs.push(cb); },
    getVialPos: getVialPos,
    setVialPos: setVialPos,
    resetVial: resetVial,
    getVialBounds: function () { return Object.assign({}, DRAG_BOUNDS); },
    hasSegment: function (step) { return !!segByStep(step); },
    playTrajectory: playTrajectory,
    stopTrajectory: stopTrajectory,
    isPlayingTrajectory: function () { return trajPlaying; },
    onStepStart: function (cb) { stepStartCb = cb; },
  };
})();
