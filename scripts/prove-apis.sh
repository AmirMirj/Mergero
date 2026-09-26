#!/usr/bin/env bash
# Proves the live integrations behind the Desk with real API calls, printing what came back.
# Usage: scripts/prove-apis.sh [base-url] [--send]     (default base http://localhost:3000; --send also emails you once)
B="${1:-http://localhost:3000}"; SEND="$2"
j() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const x=JSON.parse(d);console.log(eval(process.argv[1]))}catch(e){console.log('  (not JSON) '+d.slice(0,160))}})" "$1"; }
step() { printf "\n\033[1m%s\033[0m\n" "$1"; }

step "1. Model provider — GET /api/llm/status"
curl -s -m 40 "$B/api/llm/status" | j "'  provider='+x.provider+' model='+x.model+' | anthropic key='+x.anthropic_configured+' | verda: '+(x.verda.ok?'answered in '+x.verda.ms+' ms':x.verda.reason)"

step "2. Claude call — POST /api/companies/c_01/score (readiness + valuation from the model)"
T0=$(date +%s); curl -s -m 200 -X POST "$B/api/companies/c_01/score" | j "'  readiness='+x.score.readiness+' attractiveness='+x.score.attractiveness+' timing='+x.score.recommended_timing+' | why now: '+x.score.why_now.slice(0,120)+'…'"; echo "  ($(( $(date +%s) - T0 )) s)"

step "3. Metered spend — GET /api/stats (every model call is counted)"
curl -s "$B/api/stats" | j "'  api spend so far: \$'+x.scale.api_spend_usd+' | cost/prospect: '+(x.scale.cost_per_prospect_usd==null?'n/a':'\$'+x.scale.cost_per_prospect_usd)+' | hours saved: '+x.hours_saved"

step "4. Norwegian register — GET /api/registry/search (live Brønnøysund)"
curl -s -m 30 "$B/api/registry/search?country=NO&industry_code=28&employees_min=20" | j "'  '+x.total+' companies in the register; first: '+x.results[0].name+' ('+x.results[0].city+', '+x.results[0].employees+' staff, founded '+x.results[0].founded+')'"

step "5. Finnish register — GET /api/registry/search (live PRH)"
curl -s -m 30 "$B/api/registry/search?country=FI&industry_code=28&city=Tampere&founded_before=2005" | j "'  '+x.total+' companies; first: '+x.results[0].name+' ('+x.results[0].industry+')'"

step "6. Registry reach — GET /api/registry/reach"
curl -s -m 40 "$B/api/registry/reach" | j "x.countries.map(c=>'  '+c.country+': '+(c.companies==null?'n/a':c.companies)+' — '+c.basis).join('\n')"

step "7. Owner age from the roles register — POST /api/companies/<NO company>/people"
NOID=$(curl -s "$B/api/engine/companies" | j "(x.find(c=>c.country==='NO'&&c.registry_id)||{}).id||''")
if [ -n "$NOID" ]; then curl -s -m 60 -X POST "$B/api/companies/$NOID/people" | j "'  '+x.name+': '+(x.people||[]).slice(0,3).map(p=>p.role_code+' '+p.name+' '+(p.age||'?')).join(' | ')"; else echo "  (import a Norwegian company from Registry lookup first)"; fi

step "8. Email — GET /api/mail/status (Resend)"
curl -s "$B/api/mail/status" | j "'  configured='+x.configured+' from='+x.from+' | scheduled follow-ups: '+x.scheduled+' due: '+x.due"
if [ "$SEND" = "--send" ]; then
  step "8b. One real email through Resend (demo mode → your inbox)"
  MID=$(curl -s "$B/api/engine/companies/c_01" | j "(x.messages.find(m=>m.step===1&&['draft','approved'].includes(m.status))||{}).id||''")
  if [ -n "$MID" ]; then curl -s -X POST "$B/api/messages/$MID/approve" >/dev/null; curl -s -X POST "$B/api/messages/$MID/send" | j "'  status='+(x.message||{}).status+' provider='+((x.message||{}).delivery||{}).provider+' resend id='+((x.message||{}).delivery||{}).id"; else echo "  (no unsent first touch on c_01 — draft outreach first)"; fi
fi

step "9. Finnish profiler (Son, Python) — via the Desk's enrich on a Finnish company"
FID=$(curl -s "$B/api/companies" | j "(x.data.find(c=>c.country==='FI')||{}).company_id||''")
[ -n "$FID" ] && curl -s -m 120 -X POST "$B/api/companies/$FID/enrich" | j "'  sources used: '+x.data.sources_used.join(', ')+' | new signals: '+x.data.new_signals.length"

step "10. Desk sources — GET /api/sources (live status of every source)"
curl -s -m 40 "$B/api/sources" | j "x.data.map(s=>'  '+s.name+': '+s.count+' · '+s.status).join('\n')"

step "11. Learning loop — GET /api/learning"
curl -s "$B/api/learning" | j "'  first touches: '+x.overall.n+' | reply '+Math.round(x.overall.reply_rate*100)+'% meeting '+Math.round(x.overall.meeting_rate*100)+'% mandate '+Math.round(x.overall.mandate_rate*100)+'%'+(x.sample_included?' (includes labelled sample history)':'')"
echo
