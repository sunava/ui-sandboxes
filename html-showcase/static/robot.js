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
        hdr.dispose(); pm.dispose();
      });
    } catch (e) { /* HDRI optional, RoomEnvironment stays */ }
  }

  // ---- lighting: warm-neutral to match the real lab photo -------------------
  scene.add(new THREE.HemisphereLight(0xf4efe6, 0x2a2d33, 0.7));
  scene.add(new THREE.AmbientLight(0xfff4e6, 0.28));

  const key = new THREE.DirectionalLight(0xfff2df, 1.2);   // warm key
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

  // real giskardpy-planned trajectory playback state
  let traj = null, trajPlaying = false, playhead = 0, held = false, gripperLinkObj = null;
  const _v = new THREE.Vector3();
  // steps whose held reagent is poured into the canister (fill / rinse / spike / filter)
  const POUR_STEPS = { spike_media: 1, filter_transfer: 1, rinse: 1, fill_media: 1 };
  const POUR_WIN = 30;            // frames before release during which we pour
  let streamGroup = null, streamMesh = null;

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

    // start at the neutral HOME pose (joints exist right after parse); the
    // render loop then eases toward whatever step pose is requested
    setPoseInstant(POSES.prep);

    scene.add(robot);
  },
  undefined,
  function (err) {                             // onError
    console.error(err);
    statusEl.textContent = 'Could not load the 3D model — showing the photo instead.';
    const btn = document.querySelector('.view-toggle button[data-view="photo"]');
    if (btn) btn.click();
  });

  // finalize once all meshes have loaded (or shortly after, as a fallback)
  manager.onLoad = finalize;
  setTimeout(function () { if (robot) finalize(); }, 4000);

  function finalize() {
    if (finalized || !robot) return;
    finalized = true;
    // upgrade every mesh to a PBR material so the environment map gives it
    // realistic metal/plastic reflections
    robot.traverse(function (c) {
      if (!c.isMesh) return;
      c.castShadow = true;
      c.receiveShadow = true;
      const wasArray = Array.isArray(c.material);
      const mats = wasArray ? c.material : [c.material];
      const up = mats.map(upgradeMaterial);
      c.material = wasArray ? up : up[0];
    });

    // give the bench (by far the largest mesh) a grey brushed-metal look
    let bench = null, benchVol = 0;
    robot.traverse(function (c) {
      if (!c.isMesh) return;
      const b = new THREE.Box3().setFromObject(c);
      const s = b.getSize(new THREE.Vector3());
      const v = s.x * s.y * s.z;
      if (v > benchVol) { benchVol = v; bench = c; }
    });
    if (bench) {
      // darker polished silver: lower base colour, high metalness, low roughness
      bench.material = new THREE.MeshStandardMaterial({
        color: 0x5f6670, metalness: 0.85, roughness: 0.22, envMapIntensity: 1.1,
      });
    }

    // drop the ground/grid to the robot's real base so the bench stands on it
    const rb = new THREE.Box3().setFromObject(robot);
    if (isFinite(rb.min.y)) { ground.position.y = rb.min.y; grid.position.y = rb.min.y + 0.002; }
    frameToRobot();
    statusEl.classList.add('hidden');
    readyCbs.forEach(function (cb) { cb(); });

    // load the real CRAM/giskardpy trajectory and build the objects at the exact
    // map-frame coordinates the arm reaches for them (so arm and objects align)
    fetch('static/trajectory.json').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        traj = d;
        gripperLinkObj = (robot.links && robot.links[d.gripperLink]) || null;
        if (d.objects) buildProps(d.objects);
      })
      .catch(function () {});
  }

  // ---- real trajectory playback ---------------------------------------------
  let curSeg = -1, playEnd = 0, heldObj = null, stepStartCb = function () {};

  function segByStep(step) { return traj && (traj.segments || []).filter(function (s) { return s.step === step; })[0]; }

  function resetProps() {
    for (const id in props) if (props[id].homePos) props[id].group.position.copy(props[id].homePos);
  }

  // play the whole membrane-test trajectory, or just one step's segment
  function playTrajectory(fromStep) {
    if (!traj || !robot) return false;
    const seg = fromStep ? segByStep(fromStep) : null;
    if (fromStep && !seg) return false;
    trajPlaying = true; held = false; heldObj = null; curSeg = -1;
    if (seg) { playhead = seg.start; playEnd = seg.end; }
    else { playhead = 0; playEnd = traj.frames.length - 1; resetProps(); resetCanister(); }
    return true;
  }
  function stopTrajectory() {
    if (!trajPlaying) return;
    trajPlaying = false; held = false; heldObj = null;
    highlightObjects([]); hideStream();
  }
  function currentSegmentIndex() {
    const segs = traj.segments || [];
    for (let i = 0; i < segs.length; i++) if (playhead >= segs[i].start && playhead < segs[i].end) return i;
    return segs.length ? segs.length - 1 : -1;
  }
  function stepTrajectory() {
    const F = traj.frames;
    const i0 = Math.floor(playhead), i1 = Math.min(i0 + 1, F.length - 1), a = playhead - i0;
    const f0 = F[i0], f1 = F[i1];
    for (const k in f0) { const j = robot.joints[k]; if (j) j.setJointValue(f0[k] + (f1[k] - f0[k]) * a); }

    const si = currentSegmentIndex();
    if (si !== curSeg) {                          // entered a new workflow step
      curSeg = si; held = false; heldObj = null;
      const seg = traj.segments[si];
      if (seg) stepStartCb(seg.step);
    }
    const seg = traj.segments[si];
    if (seg) {
      if (!held && seg.attach >= 0 && playhead >= seg.attach) { held = true; heldObj = seg.pick; if (heldObj) highlightObjects([heldObj]); }
      if (held && seg.detach >= 0 && playhead >= seg.detach) { held = false; dropHeld(heldObj, seg.place); heldObj = null; }
      if (held && heldObj) followGripper(heldObj);
      // pour reagents into the canister for fill / rinse / spike / filter steps
      if (held && heldObj && POUR_STEPS[seg.step] && seg.detach >= 0 && playhead >= seg.detach - POUR_WIN) {
        doPour(heldObj);
      } else {
        hideStream();
      }
    } else {
      hideStream();
    }

    playhead += (traj.fps / 60) * 1.8;            // ~1.8× real-time (tick ≈ 60 fps)
    if (playhead >= playEnd) { trajPlaying = false; stepStartCb('__done__'); }
  }
  function followGripper(objId) {
    if (!gripperLinkObj || !props[objId]) return;
    // object is a child of the robot root; express the gripper there
    gripperLinkObj.getWorldPosition(_v); robot.worldToLocal(_v);
    props[objId].group.position.set(_v.x, _v.y, _v.z - 0.03);
  }
  function dropHeld(objId, placeId) {
    const p = props[objId]; if (!p) return;
    if (placeId && props[placeId]) {
      const c = props[placeId].group.position;
      p.group.position.set(c.x, c.y, c.z + 0.06);   // resting on the canister
    } else if (p.homePos) {
      p.group.position.copy(p.homePos);
    }
  }

  // set the liquid level inside the canister (0..1)
  function setCanisterFill(level) {
    const c = props['sterility_canister']; if (!c || !c.canLiquid) return;
    const hh = Math.max(0.001, level * c.canH * 0.85);
    c.canLiquid.scale.y = hh;
    c.canLiquid.position.y = -c.canH / 2 + hh / 2 + c.canH * 0.06;
    c.canLiquid.visible = level > 0.01;
  }
  // draw a stream from the held bottle down into the canister and fill it a bit
  function doPour(objId) {
    const b = props[objId], can = props['sterility_canister'];
    if (!b || !can || !streamGroup) return;
    const bp = b.group.position, cp = can.group.position;
    const topZ = cp.z + can.canH / 2;
    const botZ = bp.z - (b.h ? b.h / 2 : 0.08);
    const len = Math.max(0.015, botZ - topZ);
    streamGroup.position.set(cp.x, cp.y, topZ + len / 2);
    streamMesh.scale.y = len;
    const col = (traj && traj.objects && traj.objects[objId] && traj.objects[objId].color) || 0x8fd0e0;
    streamMesh.material.color.setHex(col);
    if (can.canLiquid) can.canLiquid.material.color.setHex(col);
    streamGroup.visible = true;
    can.fill = Math.min(1, (can.fill || 0) + 0.02);
    setCanisterFill(can.fill);
  }
  function hideStream() { if (streamGroup) streamGroup.visible = false; }
  function resetCanister() {
    const c = props['sterility_canister']; if (c) { c.fill = 0; setCanisterFill(0); }
    hideStream();
  }

  // --------------------------------------------------------- bench objects ----
  // Build the sterility-test objects from the trajectory's object layout. Each
  // object is a child of the robot ROOT and placed at the SAME map-frame
  // coordinate the arm reaches for it, so the arm actually meets the object.
  // (the root carries rotation.x = -90°, so local z-up coords map to world y-up)
  function buildProps(objMeta) {
    if (!robot || !objMeta) return;
    for (const id in objMeta) {
      const o = objMeta[id];
      if (o.kind === 'bottle') addBottle(id, o.pos, o.h, o.r, o.color, o.liquid, o.label);
      else if (o.kind === 'canister') addCanister(id, o.pos, o.label);
      else if (o.kind === 'box') addBox(id, o.pos, o.w, o.d, o.h, o.color, o.accent, o.label);
    }
    for (const id in props) props[id].homePos = props[id].group.position.clone();

    // a thin liquid stream, reused for every pour (child of robot root, map frame)
    if (!streamGroup) {
      streamGroup = new THREE.Group();
      streamGroup.rotation.x = Math.PI / 2;      // cylinder Y → map z
      streamMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.006, 0.006, 1, 10),
        new THREE.MeshStandardMaterial({ color: 0x8fd0e0, transparent: true, opacity: 0.85, emissive: 0x2a6070, emissiveIntensity: 0.5 })
      );
      streamGroup.add(streamMesh);
      streamGroup.visible = false;
      robot.add(streamGroup);
    }

    function register(id, group, mats, h, pos, label) {
      group.rotation.x = Math.PI / 2;          // stand up along map z
      group.position.set(pos[0], pos[1], pos[2]);
      robot.add(group);
      props[id] = { group: group, mats: mats, glow: 0, glowTarget: 0, h: h || 0 };
      addLabel(id, group, h || 0.1, label);
    }

    function addBottle(id, pos, h, r, liquidColor, level, label) {
      const g = new THREE.Group();
      // real glass: physical transmission + refraction (needs scene.environment)
      const glassMat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff, metalness: 0, roughness: 0.04,
        transmission: 1.0, ior: 1.5, thickness: r * 1.6,
        transparent: true, envMapIntensity: 1.2,
        clearcoat: 0.4, clearcoatRoughness: 0.08,
      });
      const glass = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 48), glassMat);
      // OPAQUE liquid — transmission only refracts opaque objects, so a
      // transparent liquid would vanish behind the glass. Opaque = visible.
      const liqMat = new THREE.MeshStandardMaterial({
        color: liquidColor, metalness: 0.0, roughness: 0.25, envMapIntensity: 0.5,
      });
      const lh = h * level;
      const liq = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.9, r * 0.9, lh, 48), liqMat);
      liq.position.y = -h / 2 + lh / 2;
      const capMat = new THREE.MeshStandardMaterial({ color: 0xf2f5fa, roughness: 0.35, metalness: 0.1, envMapIntensity: 0.8 });
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.62, h * 0.12, 32), capMat);
      cap.position.y = h / 2 + h * 0.05;
      [glass, liq, cap].forEach(function (m) { m.castShadow = true; g.add(m); });
      register(id, g, [glassMat, liqMat], h, pos, label);
    }

    function addCanister(id, pos, label) {
      const g = new THREE.Group();
      const h = 0.11, r = 0.052;
      const bodyMat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff, metalness: 0, roughness: 0.06,
        transmission: 0.95, ior: 1.5, thickness: 0.01,
        transparent: true, envMapIntensity: 1.1, clearcoat: 0.4, clearcoatRoughness: 0.1,
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
      // growable liquid column inside the canister (opaque so it shows through
      // the transmissive glass body)
      const liqMat = new THREE.MeshStandardMaterial({
        color: 0x8fd0e0, metalness: 0, roughness: 0.25, envMapIntensity: 0.5,
      });
      const liquid = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.9, r * 0.9, 1, 48), liqMat);
      liquid.visible = false; g.add(liquid);
      register(id, g, [bodyMat, baseMat], h, pos, label);
      props[id].canLiquid = liquid; props[id].canH = h; props[id].fill = 0;
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

  // Give materials a subtle PBR sheen from the environment map WITHOUT changing
  // their colour. The DAE meshes load with correct colours; we must preserve
  // them (low metalness so the diffuse colour dominates, never a white mirror).
  function upgradeMaterial(old) {
    if (old && old.isMeshStandardMaterial) {     // already PBR → just a light sheen
      old.envMapIntensity = 0.55;
      old.roughness = Math.min(old.roughness == null ? 0.6 : old.roughness, 0.85);
      return old;
    }
    const m = new THREE.MeshStandardMaterial();
    if (old) {
      if (old.color) m.color.copy(old.color);    // keep the real colour
      if (old.map) m.map = old.map;              // keep the texture
      if (old.emissive) m.emissive.copy(old.emissive);
      if (old.vertexColors) m.vertexColors = old.vertexColors;
      if (old.transparent) { m.transparent = true; m.opacity = old.opacity; }
      m.name = old.name || '';
    }
    m.metalness = 0.1;                            // low → colour is preserved
    m.roughness = 0.6;
    m.envMapIntensity = 0.55;                     // gentle reflections only
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
  let target = Object.assign({}, POSES.prep);

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
  function tick() {
    requestAnimationFrame(tick);
    const t = clock.getElapsedTime();

    if (robot && trajPlaying && traj) {
      // play the real giskardpy trajectory frame-by-frame (overrides poses)
      stepTrajectory();
    } else if (robot) {
      // ease every controlled arm joint toward its target (deterministic)
      for (const k in JMAP) {
        const j = robot.joints[JMAP[k]];
        if (!j) continue;
        const cur = j.angle || 0;
        j.setJointValue(cur + (target[k] - cur) * EASE);
      }
      // ease the grippers too
      lg += (target.lg - lg) * EASE; rg += (target.rg - rg) * EASE;
      setGripperSide('left', lg); setGripperSide('right', rg);
    }
    if (robot) {

      // highlight = a brief teal glow from the fill light (no arm motion)
      if (highlightT > 0) {
        highlightT -= 0.016;
        fill.intensity = 0.5 + Math.abs(Math.sin(t * 6)) * 1.2;
      } else {
        fill.intensity += (0.5 - fill.intensity) * 0.1;
      }

      // ease each bench object's glow toward its target
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

    controls.update();
    renderer.render(scene, camera);
  }
  let lg = POSES.prep.lg, rg = POSES.prep.rg;
  tick();

  // ---- resize ---------------------------------------------------------------
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(container);
  resize();

  // ---- view toggles for the floating LAYERS panel ---------------------------
  function setPropsVisible(on) { for (const id in props) props[id].group.visible = on; }
  function setLabelsAlways(on) { for (const id in props) if (props[id].label) props[id].label.visible = on; }
  function setAutoRotate(on) { controls.autoRotate = on; controls.autoRotateSpeed = 0.6; }
  function setFloorVisible(on) { ground.visible = on; grid.visible = on; }

  window.RobotView = {
    onReady: function (cb) { if (robot) cb(); else readyCbs.push(cb); },
    poseForStep: poseForStep,
    highlight: highlight,
    highlightObjects: highlightObjects,
    setPropsVisible: setPropsVisible,
    setLabelsAlways: setLabelsAlways,
    setAutoRotate: setAutoRotate,
    setFloorVisible: setFloorVisible,
    hasTrajectory: function () { return !!traj; },
    hasSegment: function (step) { return !!segByStep(step); },
    playTrajectory: playTrajectory,
    stopTrajectory: stopTrajectory,
    isPlayingTrajectory: function () { return trajPlaying; },
    onStepStart: function (cb) { stepStartCb = cb; },
  };
})();
