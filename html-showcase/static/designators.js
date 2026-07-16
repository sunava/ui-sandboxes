/* ============================================================================
 * designators.js — render CRAM-style action designators in LISP syntax.
 *
 * A template is  [ type-keyword, [ [slot, valueTemplate], ... ] ].
 * valueTemplate may contain placeholders that are filled from `ctx`:
 *     $OBJ  primary object      $ARM  arm            $LOC  target location
 *     $SRC  source container    $TGT  target         $TOOL tool
 * Missing values fall back to a readable "?slot".
 * ==========================================================================*/
(function () {
  function fill(tpl, ctx) {
    return tpl.replace(/\$([A-Z]+)/g, function (_, key) {
      const map = { OBJ: 'OBJ', ARM: 'ARM', LOC: 'LOC', SRC: 'SRC', TGT: 'TGT', TOOL: 'TOOL' };
      const v = ctx[map[key]] !== undefined ? ctx[map[key]] : ctx[key];
      return (v === undefined || v === null || v === '') ? '?' + key.toLowerCase() : v;
    });
  }

  // build the plain LISP text
  function text(entry, ctx) {
    ctx = ctx || {};
    const type = entry[0], slots = entry[1] || [];
    const lines = ['(an action', '    (type :' + type + ')'];
    slots.forEach(function (s) {
      lines.push('    (' + s[0] + ' ' + fill(s[1], ctx) + ')');
    });
    let out = lines.join('\n');
    // close the final paren on the last line
    return out.replace(/\)\s*$/, '))');
  }

  // escape + light syntax highlighting → HTML
  function html(entry, ctx) {
    const raw = text(entry, ctx);
    let h = raw.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
    // :keywords
    h = h.replace(/:[a-z0-9-]+/g, function (m) { return '<span class="d-kw">' + m + '</span>'; });
    // designator heads: "an action", "an object", "a location", "a motion"
    h = h.replace(/\b(an|a) (action|object|location|motion|pose)\b/g,
      function (m) { return '<span class="d-head">' + m + '</span>'; });
    return h;
  }

  window.Designators = { text: text, html: html };
})();
