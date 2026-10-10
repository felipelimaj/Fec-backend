// Uso: node gerar_base.js <export_catapult.xlsx> <grupos_tag.xlsx|csv> [saida=dados.js]
const XLSX = require('xlsx'), fs = require('fs'), C = require('./converter.js');
const [,, fCat, fTag, out = 'dados.js'] = process.argv;
const ler = (f, aba) => { const wb = XLSX.readFile(f, { cellDates: true }); const ws = wb.Sheets[aba || wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }); };
const cat = C.lerCatapult(ler(fCat), console.log);
const tg = C.lerTag(ler(fTag, 'Página1'));
let jogos = []; try { jogos = C.lerJogos(ler(fTag, 'Jogos 2026')); } catch (e) { console.log('Aviso: aba Jogos 2026 não lida —', e.message); }
const base = C.montar(cat, tg, jogos);
fs.writeFileSync(out, '/* Gerado por atualizar.html a partir do export da Catapult + GRUPOS TAG. Não editar à mão. */\nwindow.CARGA = ' + JSON.stringify(base) + ';\n');
console.log(JSON.stringify(base.stats, null, 1), Object.keys(base.atletas).length, 'atletas', Object.keys(base.jogos).length, 'jogos');
