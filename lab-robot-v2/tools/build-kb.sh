#!/usr/bin/env bash
# Regenerate static/aicor-kb.pl from the real AICOR L2 ontology + worked-example
# ABoxes using the framework's own compiler (tools/okf_prolog.py).
#
# Source of truth (vendored here so the project is self-contained):
#   tools/aicor-ontology.ttl   — the AICOR L2 TBox (from L2-conceptual-framework/out)
#   tools/abox/*.yaml          — the worked-example ABoxes
#
# The compiler emits SWI-flavoured `:- discontiguous …` directives; tau-prolog
# (what the browser page uses) doesn't parse `discontiguous` as a prefix
# operator, so we strip those lines — they're only advisory and tau-prolog
# allows discontiguous clauses anyway.
#
# Needs: python3 with rdflib + pyyaml. Any of the user's ~/.virtualenvs envs
# (cram-env, cramy, thesis-cram, …) already have them.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../static/aicor-kb.pl"
py="${PYTHON:-python3}"

abox_args=()
for f in "$here"/abox/*.yaml; do abox_args+=(--abox "$f"); done

tmp="$(mktemp)"
"$py" "$here/okf_prolog.py" "$here/abox" \
  --ttl "$here/aicor-ontology.ttl" \
  --out "$tmp" \
  "${abox_args[@]}"

# strip the SWI-only discontiguous directives for tau-prolog compatibility
grep -v '^:- discontiguous' "$tmp" > "$out"
rm -f "$tmp"
echo "wrote $out"
