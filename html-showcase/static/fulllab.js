/* ============================================================================
 * fulllab.js — the mobile "Full Lab": HSR drives between lab stations.
 * Exposes window.RobotView:
 *     onReady(cb)
 *     runTask(fromId, toId, objId)   drive A→pick→B→place
 *     goHome()
 *     highlightStations(ids)
 *     onCaption(cb)                  caption text as the robot acts
 * ==========================================================================*/
(function () {
  const container = document.getElementById('viewer');
  const statusEl = document.getElementById('viewer-status');
  const STATIONS = window.STATIONS || {};
  const OBJECT_COLORS = window.OBJECT_COLORS || {};

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
  camera.position.set(7, 9.5, 7);   // high isometric look-down (lab-overview style)

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1b2233, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(6, 10, 4); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 40;
  key.shadow.camera.left = -8; key.shadow.camera.right = 8;
  key.shadow.camera.top = 8; key.shadow.camera.bottom = -8;
  key.shadow.bias = -0.0004;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x5b8cff, 0.5);
  rim.position.set(-5, 3, -4);
  scene.add(rim);

  // ---- lab floor ------------------------------------------------------------
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 16),
    new THREE.MeshStandardMaterial({ color: 0x0e1728, roughness: 0.95, metalness: 0 })
  );
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const grid = new THREE.GridHelper(16, 32, 0x25406b, 0x162236);
  grid.material.opacity = 0.5; grid.material.transparent = true; scene.add(grid);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 3; controls.maxDistance = 22;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.target.set(0, 0.4, 0);

  // ---- station markers ------------------------------------------------------
  const stationMeshes = {};   // id -> { disc, mats:[], glow, glowTarget }
  function makeLabel(text, color) {
    const pad = 14, fs = 30;
    const cv = document.createElement('canvas');
    let ctx = cv.getContext('2d');
    ctx.font = '600 ' + fs + 'px Inter, sans-serif';
    cv.width = ctx.measureText(text).width + pad * 2; cv.height = fs + pad * 2;
    ctx = cv.getContext('2d');
    ctx.font = '600 ' + fs + 'px Inter, sans-serif';
    ctx.fillStyle = 'rgba(10,17,32,0.85)';
    rr(ctx, 0, 0, cv.width, cv.height, 10); ctx.fill();
    ctx.strokeStyle = 'rgba(' + hex2rgb(color) + ',0.7)'; ctx.lineWidth = 2;
    rr(ctx, 1, 1, cv.width - 2, cv.height - 2, 10); ctx.stroke();
    ctx.fillStyle = '#e8eefb'; ctx.textBaseline = 'middle';
    ctx.fillText(text, pad, cv.height / 2);
    const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.scale.set(cv.width * 0.006, cv.height * 0.006, 1);
    return spr;
  }
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function hex2rgb(h) { return [(h >> 16) & 255, (h >> 8) & 255, h & 255].join(','); }

  Object.keys(STATIONS).forEach(function (id) {
    const s = STATIONS[id];
    const grp = new THREE.Group(); grp.position.set(s.x, 0, s.z);
    // floor disc
    const discMat = new THREE.MeshStandardMaterial({ color: s.color, roughness: 0.5, emissive: s.color, emissiveIntensity: 0.12 });
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.03, 40), discMat);
    disc.position.y = 0.015; disc.receiveShadow = true; grp.add(disc);
    // furniture block
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.5), new THREE.MeshStandardMaterial({ color: 0x28344f, roughness: 0.7, metalness: 0.1 }));
    box.position.set(0, 0.35, -0.35); box.castShadow = true; grp.add(box);
    const accent = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.08, 0.52), new THREE.MeshStandardMaterial({ color: s.color, emissive: s.color, emissiveIntensity: 0.3, roughness: 0.5 }));
    accent.position.set(0, 0.6, -0.35); grp.add(accent);
    // label
    const lab = makeLabel(s.label, s.color); lab.position.set(0, 1.05, -0.35); grp.add(lab);
    scene.add(grp);
    stationMeshes[id] = { grp: grp, mats: [discMat], glow: 0, glowTarget: 0 };
  });

  // ---- payload the robot carries -------------------------------------------
  const payload = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.16, 0.16),
    new THREE.MeshStandardMaterial({ color: 0x9fd3e6, roughness: 0.4, emissive: 0x9fd3e6, emissiveIntensity: 0.25 })
  );
  payload.castShadow = true; payload.visible = false;

  // ---- load HSR -------------------------------------------------------------
  let robot = null, chassis = null;
  const readyCbs = [];
  let captionCb = function () {};

  const manager = new THREE.LoadingManager();
  const loader = new URDFLoader(manager);
  loader.packages = { hsr_description: 'static/meshes/hsr_description' };
  loader.load('static/hsrb.urdf', function (model) {
    robot = model;
    robot.rotation.x = -Math.PI / 2;          // Z-up → Y-up
    // a neutral "carrying" arm pose
    setJoint('arm_lift_joint', 0.15);
    setJoint('arm_flex_joint', -0.6);
    setJoint('arm_roll_joint', 0.0);
    setJoint('wrist_flex_joint', -0.9);
    setJoint('head_tilt_joint', -0.3);
    chassis = new THREE.Group();
    chassis.add(robot);
    chassis.add(payload);
    payload.position.set(0.22, 0.55, 0);      // held in front of the base
    chassis.position.set(0, 0, 0);
    scene.add(chassis);

    // Reveal the scene NOW — the kinematic tree is ready; the (heavy) DAE
    // meshes stream in over the next frames instead of blocking the overlay.
    reveal();
  }, undefined, function (err) {
    console.error(err);
    statusEl.textContent = 'Could not load the HSR model.';
  });

  let revealed = false;
  manager.onLoad = function () {                // shadows once all meshes are in
    if (robot) robot.traverse(function (c) { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
  };
  setTimeout(function () { if (robot) reveal(); }, 3000);   // safety net
  function reveal() {
    if (revealed || !robot) return;
    revealed = true;
    statusEl.classList.add('hidden');
    readyCbs.forEach(function (cb) { cb(); });
  }

  function setJoint(n, v) { if (robot && robot.joints[n]) robot.setJointValue(n, v); }

  // ---- navigation -----------------------------------------------------------
  // queue of waypoints; each frame the chassis eases toward the head waypoint,
  // firing its onArrive callback when close enough.
  const nav = { queue: [], cur: null };
  let px = 0, pz = 0, heading = 0;            // current chassis x,z and heading

  function approach(id) {                       // stop just short of the station
    const s = STATIONS[id];
    const len = Math.hypot(s.x, s.z) || 1;
    const back = 1.05;                          // stand ~1 m out from the pad
    return { x: s.x - (s.x / len) * back, z: s.z - (s.z / len) * back };
  }

  function runTask(fromId, toId, objId) {
    if (!STATIONS[fromId] || !STATIONS[toId]) return;
    nav.queue = []; nav.cur = null;
    const a = approach(fromId), b = approach(toId);
    nav.queue.push({ x: a.x, z: a.z, face: fromId, on: function () {
      highlightStations([fromId]);
      showPayload(objId);
      captionCb('pick', fromId, objId);
    }});
    nav.queue.push({ x: b.x, z: b.z, face: toId, on: function () {
      highlightStations([toId]);
      captionCb('place', toId, objId);
      setTimeout(function () { payload.visible = false; }, 900);
    }});
  }

  function goHome() { nav.queue = [{ x: 0, z: 0, face: null, on: function () { highlightStations([]); payload.visible = false; } }]; nav.cur = null; }

  // ---- game: drive to a station, "work" briefly, then report done -----------
  let busy = false;
  function serve(id, objId, cb) {
    if (!STATIONS[id]) { if (cb) cb(); return; }
    busy = true;
    const a = approach(id);
    nav.queue = [{ x: a.x, z: a.z, face: id, on: function () {
      highlightStations([id]);
      if (objId) showPayload(objId);
      captionCb('serve', id, objId);
      setTimeout(function () {
        payload.visible = false; highlightStations([]); busy = false;
        if (cb) cb();
      }, 800);
    } }];
    nav.cur = null;
  }
  function isBusy() { return busy; }

  // project a station's world position to viewer pixel coords (for HTML bubbles)
  const _pv = new THREE.Vector3();
  function projectToScreen(id) {
    const s = STATIONS[id]; if (!s || !camera) return null;
    _pv.set(s.x, 1.7, s.z).project(camera);   // float the bubble above the station
    const w = container.clientWidth, h = container.clientHeight;
    return { x: (_pv.x * 0.5 + 0.5) * w, y: (-_pv.y * 0.5 + 0.5) * h, visible: _pv.z < 1 };
  }

  function showPayload(objId) {
    const c = OBJECT_COLORS[objId] || 0x9fd3e6;
    payload.material.color.setHex(c);
    payload.material.emissive.setHex(c);
    payload.visible = true;
  }

  function highlightStations(ids) {
    const set = {}; (ids || []).forEach(function (i) { set[i] = 1; });
    for (const id in stationMeshes) stationMeshes[id].glowTarget = set[id] ? 1 : 0;
  }

  // ---- render loop ----------------------------------------------------------
  const clock = new THREE.Clock();
  function tick() {
    requestAnimationFrame(tick);
    const t = clock.getElapsedTime();

    // drive toward the current waypoint
    if (!nav.cur && nav.queue.length) nav.cur = nav.queue.shift();
    if (nav.cur && chassis) {
      const dx = nav.cur.x - px, dz = nav.cur.z - pz;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.03) {
        const step = Math.min(0.035, dist);   // ~constant cruise speed
        px += (dx / dist) * step;
        pz += (dz / dist) * step;
        heading += angleDelta(heading, Math.atan2(-dz, dx)) * 0.15;
        chassis.position.set(px, 0, pz);
        chassis.rotation.y = heading;
      } else {
        const cb = nav.cur.on; nav.cur = null; if (cb) cb();
      }
    }

    // station glow pulse
    const pulse = 0.5 + 0.5 * Math.abs(Math.sin(t * 3));
    for (const id in stationMeshes) {
      const sm = stationMeshes[id];
      sm.glow += (sm.glowTarget - sm.glow) * 0.1;
      sm.mats.forEach(function (m) { m.emissiveIntensity = 0.12 + sm.glow * pulse * 0.8; });
    }
    if (payload.visible) payload.rotation.y = t * 0.6;

    controls.update();
    renderer.render(scene, camera);
  }

  function angleDelta(a, b) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }

  tick();

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(container);
  resize();

  window.RobotView = {
    onReady: function (cb) { if (robot) cb(); else readyCbs.push(cb); },
    runTask: runTask,
    goHome: goHome,
    serve: serve,
    isBusy: isBusy,
    projectToScreen: projectToScreen,
    stations: function () { return STATIONS; },
    highlightStations: highlightStations,
    onCaption: function (cb) { captionCb = cb; },
  };
})();
