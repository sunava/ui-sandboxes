/* ============================================================================
 * turbine.js — plays the real CRAM/giskardpy wind-turbine assembly in the
 * browser. Loads turbine_trajectory.json (joints + every part's pose per frame,
 * captured from the pycram sim) and replays it: the arm follows the recorded
 * joint angles and each part sits exactly where the sim put it (so grasped
 * parts move with the gripper and stack into a turbine).
 * ==========================================================================*/
(function () {
  const container = document.getElementById('viewer');
  const statusEl = document.getElementById('viewer-status');

  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(2.0, 1.6, 2.2);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1b2233, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(3, 5, 2); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 20;
  key.shadow.camera.left = -3; key.shadow.camera.right = 3;
  key.shadow.camera.top = 3; key.shadow.camera.bottom = -3;
  key.shadow.bias = -0.0004; scene.add(key);
  const rim = new THREE.DirectionalLight(0x5b8cff, 0.7); rim.position.set(-3, 2, -2); scene.add(rim);
  const fill = new THREE.PointLight(0x39d5c8, 0.4, 20); fill.position.set(0, 1.5, 3); scene.add(fill);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.32 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const grid = new THREE.GridHelper(40, 80, 0x25406b, 0x18283f);
  grid.material.opacity = 0.28; grid.material.transparent = true; scene.add(grid);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 0.8; controls.maxDistance = 8; controls.maxPolarAngle = Math.PI * 0.52;

  // ---- state ----------------------------------------------------------------
  let robot = null, traj = null, parts = {};
  let playing = false, playhead = 0, curStep = -1;
  const readyCbs = [];
  let stepCb = function () {};
  const SPEED = 6;                         // ~real-time × 6 (keeps the demo ~1 min)

  const manager = new THREE.LoadingManager();
  const loader = new URDFLoader(manager);
  loader.packages = {
    ur_description: 'static/meshes/ur_description',
    robotiq_description: 'static/meshes/robotiq_description',
    iai_tracy_description: 'static/meshes/iai_tracy_description',
  };
  loader.load('static/tracy.urdf', function (model) {
    robot = model; robot.rotation.x = -Math.PI / 2; scene.add(robot);
  }, undefined, function (err) {
    console.error(err); statusEl.textContent = 'Could not load Tracy.';
  });

  let finalized = false;
  manager.onLoad = finalize;
  setTimeout(function () { if (robot) finalize(); }, 4000);
  function finalize() {
    if (finalized || !robot) return;
    finalized = true;
    robot.traverse(function (c) { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
    const rb = new THREE.Box3().setFromObject(robot);
    if (isFinite(rb.min.y)) { ground.position.y = rb.min.y; grid.position.y = rb.min.y + 0.002; }
    frameToRobot();
    statusEl.classList.add('hidden');
    fetch('static/turbine_trajectory.json').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) { traj = d; buildParts(); readyCbs.forEach(function (cb) { cb(); }); } })
      .catch(function () {});
  }

  function frameToRobot() {
    const box = new THREE.Box3().setFromObject(robot);
    const size = box.getSize(new THREE.Vector3()); const center = box.getCenter(new THREE.Vector3());
    controls.target.copy(center);
    const fov = (camera.fov * Math.PI) / 180;
    const aspect = camera.aspect || (container.clientWidth / Math.max(1, container.clientHeight)) || 1.6;
    const fitH = (size.y / 2) / Math.tan(fov / 2);
    const fitW = (Math.max(size.x, size.z) / 2) / (Math.tan(fov / 2) * aspect);
    const dist = Math.max(fitH, fitW) * 1.45;
    camera.position.set(center.x + dist * 0.55, center.y + size.y * 0.12, center.z + dist * 0.9);
    camera.near = Math.max(0.01, dist / 100); camera.far = dist * 100; camera.updateProjectionMatrix();
    controls.update();
  }

  // build one THREE object per part; SDT cylinders are Z-up, so rotate the
  // three cylinder (Y-up) by +90° X inside a group that carries the pose
  function buildParts() {
    for (const id in traj.parts) {
      const m = traj.parts[id];
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: m.color, roughness: 0.55, metalness: 0.15 });
      let mesh;
      if (m.kind === 'cyl') {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(m.r, m.r, m.h, 28), mat);
        mesh.rotation.x = Math.PI / 2;       // align three Y-axis to SDT Z-axis
      } else {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(m.size[0], m.size[1], m.size[2]), mat);
      }
      mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh);
      robot.add(g);                          // child of robot root (map frame)
      parts[id] = g;
    }
    applyFrame(0);
  }

  function applyFrame(i) {
    const f = traj.frames[i]; if (!f) return;
    for (const jn in f.j) { const j = robot.joints[jn]; if (j) j.setJointValue(f.j[jn]); }
    for (const id in f.p) {
      const p = f.p[id], g = parts[id]; if (!g) continue;
      g.position.set(p[0], p[1], p[2]);
      g.quaternion.set(p[3], p[4], p[5], p[6]);   // [x,y,z,w], map frame
    }
  }

  function applyLerp(h) {
    const F = traj.frames, i0 = Math.floor(h), i1 = Math.min(i0 + 1, F.length - 1), a = h - i0;
    const f0 = F[i0], f1 = F[i1];
    for (const jn in f0.j) { const j = robot.joints[jn]; if (j) j.setJointValue(f0.j[jn] + ((f1.j[jn] || f0.j[jn]) - f0.j[jn]) * a); }
    for (const id in f0.p) {
      const g = parts[id]; if (!g) continue;
      const a0 = f0.p[id], a1 = f1.p[id] || f0.p[id];
      g.position.set(a0[0] + (a1[0] - a0[0]) * a, a0[1] + (a1[1] - a0[1]) * a, a0[2] + (a1[2] - a0[2]) * a);
      g.quaternion.set(a0[3], a0[4], a0[5], a0[6]).slerp(new THREE.Quaternion(a1[3], a1[4], a1[5], a1[6]), a);
    }
  }

  function currentStep() {
    const s = traj.steps; let idx = 0;
    for (let i = 0; i < s.length; i++) if (playhead >= s[i].startFrame) idx = i;
    return idx;
  }

  // ---- render loop ----------------------------------------------------------
  const clock = new THREE.Clock();
  function tick() {
    requestAnimationFrame(tick);
    const t = clock.getElapsedTime();
    if (robot && traj && playing) {
      applyLerp(playhead);
      const si = currentStep();
      if (si !== curStep) { curStep = si; stepCb(traj.steps[si], si); }
      playhead += (traj.fps / 60) * SPEED;
      if (playhead >= traj.frames.length - 1) { playing = false; stepCb('__done__', -1); }
    }
    fill.intensity += (0.4 - fill.intensity) * 0.1;
    controls.update();
    renderer.render(scene, camera);
  }
  tick();

  function resize() {
    const w = container.clientWidth, h = container.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(container);
  resize();

  window.Turbine = {
    onReady: function (cb) { if (traj) cb(); else readyCbs.push(cb); },
    steps: function () { return traj ? traj.steps : []; },
    parts: function () { return traj ? traj.parts : {}; },
    play: function () { if (traj) { if (playhead >= traj.frames.length - 1) playhead = 0; playing = true; } },
    pause: function () { playing = false; },
    isPlaying: function () { return playing; },
    seekStep: function (i) { if (traj && traj.steps[i]) { playhead = traj.steps[i].startFrame; playing = true; } },
    onStepStart: function (cb) { stepCb = cb; },
  };
})();
