/* main_turbine.js — wires the wind-turbine assembly scene: step strip, play,
 * captions and a parts / sequence panel. Playback is the real recorded
 * pycram+giskardpy trajectory (see turbine.js). */
(function () {
  const answerEl = document.getElementById('answer');
  const stripEl = document.getElementById('workflow-strip');
  const captionEl = document.getElementById('step-caption');
  const playBtn = document.getElementById('play-btn');

  function hex(c) { return '#' + ('000000' + c.toString(16)).slice(-6); }

  window.Turbine.onReady(function () {
    const steps = Turbine.steps();
    const parts = Turbine.parts();

    // ---- left: assembly step strip ----
    stripEl.innerHTML = '';
    steps.forEach(function (s, i) {
      const chip = document.createElement('div');
      chip.className = 'wstep'; chip.dataset.idx = i;
      chip.innerHTML = '<span class="num">' + (i + 1) + '</span><span class="txt">' + s.label + '</span>';
      chip.addEventListener('click', function () { Turbine.seekStep(i); setPlaying(true); });
      stripEl.appendChild(chip);
    });

    // ---- right: parts + sequence panel ----
    let html = '<p class="headline">Tracy assembles a wind turbine from parts on the bench. ' +
      'Every joint angle is a <b>real trajectory</b> planned by pycram + giskardpy; each grasped ' +
      'part is attached to the gripper and stacked into place.</p>';
    html += '<div style="font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:#93a4c4;margin:12px 0 6px">Parts</div>';
    Object.keys(parts).forEach(function (id) {
      const p = parts[id];
      html += '<div class="ansrow"><span class="tag" style="background:' + hex(p.color) + ';color:#0b1220">' +
        (p.kind === 'cyl' ? 'cylinder' : 'box') + '</span><div class="body"><span class="name">' + p.label + '</span></div></div>';
    });
    html += '<div style="font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:#93a4c4;margin:14px 0 6px">Assembly sequence</div>';
    html += '<ol id="seq" style="margin:0;padding-left:20px;color:#c7d4ec;font-size:13px;line-height:1.9">';
    steps.forEach(function (s, i) { html += '<li data-seq="' + i + '">' + s.label + '</li>'; });
    html += '</ol>';
    answerEl.innerHTML = html;

    // ---- sync UI to playback ----
    Turbine.onStepStart(function (step, i) {
      if (step === '__done__') { setPlaying(false); return; }
      document.querySelectorAll('.wstep').forEach(function (c) { c.classList.toggle('active', +c.dataset.idx === i); });
      document.querySelectorAll('#seq li').forEach(function (li) {
        li.style.color = (+li.dataset.seq === i) ? '#39d5c8' : (+li.dataset.seq < i ? '#5f7196' : '#c7d4ec');
        li.style.fontWeight = (+li.dataset.seq === i) ? '700' : '400';
      });
      if (step && step.label) { captionEl.innerHTML = step.label + '.'; captionEl.classList.remove('hidden'); }
    });

    playBtn.addEventListener('click', function () { setPlaying(!Turbine.isPlaying()); });
  });

  function setPlaying(on) {
    if (on) { Turbine.play(); playBtn.classList.add('playing'); playBtn.textContent = '⏸ Stop'; }
    else { Turbine.pause(); playBtn.classList.remove('playing'); playBtn.textContent = '▶ Assemble the turbine'; }
  }
})();
