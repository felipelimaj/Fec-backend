import MDP from './mdp.js';

// ── Jogo sintético: 2 blocos (1tempo 45 min, 2tempo 45 min) a 10 Hz ─────────
// Base: trote leve constante. Enxertos programados:
//   - 1tempo: um trecho de 60 s MUITO intenso (o pico de 1 min)
//   - 1tempo: dois trechos de 60 s a ~85% do pico
//   - 2tempo: um trecho de 60 s a ~70% (não deve entrar em nenhuma faixa)
//   - 12 sprints de 4 s espalhados, cada um com acel e decel acima de 3 m/s²

const T0 = 1700000000;
const HZ = 10, DT = 0.1;

function bloco(inicioTs, durS, perfil) {
  const pts = [];
  const n = Math.round(durS * HZ);
  for (let i = 0; i < n; i++) {
    const t = inicioTs + i * DT;
    pts.push({ ts: +t.toFixed(1), v: perfil(i * DT), hdop: 1.0 });
  }
  return pts;
}

// sprint trapezoidal: sobe a 4 m/s², segura, desce a -4 m/s²
function sprintEm(tRel, tSprint, vPico) {
  const d = tRel - tSprint;
  if (d < 0 || d > 4) return null;
  if (d < 1) return d * vPico;             // aceleração ~ vPico m/s²
  if (d < 3) return vPico;
  return vPico * (1 - (d - 3));            // desaceleração
}

const SPRINTS_T1 = [300, 600, 900, 1200, 1500, 1800];
const SPRINTS_T2 = [200, 500, 800, 1100, 1400, 1700];

function perfilT1(tRel) {
  let v = 2.0;                                          // trote leve ~7 km/h
  if (tRel >= 1000 && tRel < 1060) v = 5.6;             // PICO de 1 min
  else if (tRel >= 1500 && tRel < 1560) v = 4.8;        // ~85% do pico
  else if (tRel >= 2000 && tRel < 2060) v = 4.8;        // ~85% do pico
  for (const s of SPRINTS_T1) { const sv = sprintEm(tRel, s, 8.0); if (sv != null) v = Math.max(v, sv); }
  return v;
}
function perfilT2(tRel) {
  let v = 2.0;
  if (tRel >= 900 && tRel < 960) v = 3.9;               // ~70% do pico
  for (const s of SPRINTS_T2) { const sv = sprintEm(tRel, s, 8.0); if (sv != null) v = Math.max(v, sv); }
  return v;
}

const t1Ini = T0, t1Dur = 2700;
const t2Ini = T0 + 4000, t2Dur = 2700;

const pontos = [].concat(
  bloco(t1Ini, t1Dur, perfilT1),
  bloco(t2Ini, t2Dur, perfilT2)
);

// períodos aninhados de propósito, para testar a mesclagem
const brutos = [
  { ini: t1Ini, fim: t1Ini + t1Dur, rotulo: '1tempo', dur: t1Dur },
  { ini: t2Ini, fim: t2Ini + t2Dur, rotulo: '2tempo', dur: t2Dur },
  { ini: t2Ini + 1000, fim: t2Ini + t2Dur, rotulo: '2tempo2', dur: t2Dur - 1000 },
];
const t1 = MDP.mesclarIntervalos(brutos.filter(b => b.rotulo.includes('1tempo')));
const t2 = MDP.mesclarIntervalos(brutos.filter(b => b.rotulo.includes('2tempo')));
const blocos = t1.concat(t2);

console.log('Blocos após mesclagem (esperado: 2):', blocos.length,
  blocos.map(b => b.rotulo + ' ' + ((b.fim - b.ini) / 60).toFixed(1) + ' min').join(' | '));

const r = MDP.calcularAtleta(pontos, blocos, { '1tempo': t1Dur, '2tempo': t2Dur });

console.log('\nMin jogados:', r.minJogados);
console.log('Participação:', JSON.stringify(r.participacao, null, 1));
console.log('\nTotais:', JSON.stringify(r.totais));

console.log('\n── Picos ──');
for (const W of [60, 180, 300]) {
  const p = r.picos[W];
  console.log(`\nJanela ${W / 60} min:`);
  for (const v of MDP.VARIAVEIS) {
    if (!p[v]) { console.log(`  ${v}: (sem janela)`); continue; }
    console.log(`  ${v.padEnd(7)} abs=${String(p[v].absoluto).padStart(9)}  /min=${String(p[v].porMinuto).padStart(9)}  ${p[v].periodo}`);
  }
}

console.log('\n── Repetição (janelas independentes) ──');
for (const W of [60, 180]) {
  console.log(`\nJanela ${W / 60} min:`);
  for (const v of MDP.VARIAVEIS) {
    if (!r.repeticoes[W][v]) continue;
    const rep = r.repeticoes[W][v];
    console.log(`  ${v.padEnd(7)} ≥80%: ${rep[80].n}   ≥85%: ${rep[85].n}   ≥90%: ${rep[90].n}`);
  }
}

// ── Verificação do risco de sobreposição ───────────────────────────────────
// Sem o filtro de independência, quantas janelas cruas de 1 min ficam ≥90%?
const bins = MDP.binar(
  MDP.normalizarStream(pontos),
  MDP.derivarAceleracao(MDP.normalizarStream(pontos)),
  { ini: t1Ini, fim: t1Ini + t1Dur }
);
const js = MDP.janelasDeslizantes(bins.dist, 60, 1);
const max = Math.max(...js.map(j => j.valor));
const cruas = js.filter(j => j.valor >= 0.9 * max).length;
const indep = MDP.janelasIndependentes(js, 0.9 * max, 60).length;
console.log(`\nJanelas de 1 min ≥90% no 1tempo — cruas: ${cruas}  |  independentes: ${indep}`);
