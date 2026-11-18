/* Camada de dados do Radar ELO: liga o app ao banco (Firebase) e ao login.
   Fica publicada junto com a tela de senha; não contém dados do Radar.

   Leitura econômica: cada coleção de marcações tem uma cópia em poucos documentos de
   "resumo" (resumo/<coleção>_<n>). Quem abre o Radar escuta só esses blocos (uns 20),
   em vez de ler marcação por marcação. Toda gravação vai para a marcação e para o bloco. */
(function () {
  'use strict';
  var CFG = window.ELO_CONFIG || {};
  var CONSULTA = CFG.consultaEmail || 'consulta@radar.elo';
  var V = '10.14.1', B = 'https://www.gstatic.com/firebasejs/' + V + '/';
  var BLOCOS = {conf: 8};                       // coleções grandes ganham mais blocos
  var nBlocos = function (c) { return BLOCOS[c] || 2; };
  function blocoDe(c, id) { var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0; return c + '_' + (Math.abs(h) % nBlocos(c)); }

  function ler(k) { try { return localStorage.getItem(k) || sessionStorage.getItem(k); } catch (e) { return null; } }
  function gravar(k, v, lembrar) { try { sessionStorage.setItem(k, v); if (lembrar) localStorage.setItem(k, v); } catch (e) {} }
  function apagar(k) { try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch (e) {} }
  function load(src) {
    return new Promise(function (ok, no) {
      var s = document.createElement('script'); s.src = src; s.onload = ok;
      s.onerror = function () { no(new Error('rede')); }; document.head.appendChild(s);
    });
  }

  var pronto = null, auth = null, fs = null, editor = false, uid = null;

  function iniciar() {
    if (pronto) return pronto;
    pronto = (async function () {
      if (!CFG.firebase) throw new Error('sem configuração');
      if (!window.firebase) {
        await load(B + 'firebase-app-compat.js');
        await load(B + 'firebase-auth-compat.js');
        await load(B + 'firebase-firestore-compat.js');
      }
      if (!firebase.apps.length) firebase.initializeApp(CFG.firebase);
      auth = firebase.auth(); fs = firebase.firestore();
      try { fs.settings({ignoreUndefinedProperties: true}); } catch (e) {}
      var eu = ler('elo_eu'), es = ler('elo_es'), sen = ler('elo_s');
      var feito = false;
      if (eu && es) {
        try { await auth.signInWithEmailAndPassword(eu, es); editor = true; feito = true; }
        catch (e) { apagar('elo_eu'); apagar('elo_es'); avisar('E-mail ou senha de marcação incorretos. Entrando só para consulta.'); }
      }
      if (!feito && sen) { await auth.signInWithEmailAndPassword(CONSULTA, sen); editor = false; }
      var u = auth.currentUser; uid = u ? u.uid : null;
      if (editor && uid) { await garantirPerfil(u); migrarAntigas(); }
      return true;
    })();
    pronto.catch(function () {});
    return pronto;
  }

  async function garantirPerfil(u) {
    try {
      var ref = fs.doc('perfis/' + u.uid), d = await ref.get();
      if (d.exists && d.data() && d.data().name) { gravar('elo_nome', d.data().name, true); return; }
      var nome = (ler('elo_nome') || '').trim();
      if (!nome) nome = (window.prompt('Seu nome (aparece nas marcações que você fizer):') || '').trim();
      if (!nome) nome = (u.email || '').split('@')[0];
      gravar('elo_nome', nome, true);
      await ref.set({name: nome});
    } catch (e) {}
  }

  function mapErr(e) {
    // sem login de marcação = só consulta; com login, a recusa é de área (as regras limitam cada um à sua parte)
    if (e && e.code === 'permission-denied') { var x = new Error(e.message); x.code = editor ? 'area' : 'invalid_argument'; throw x; }
    throw e;
  }

  /* ---------- blocos de resumo ---------- */
  function campo(id) { return new firebase.firestore.FieldPath('d', id); }
  async function noBloco(c, id, valor) {          // valor === null apaga
    var ref = fs.doc('resumo/' + blocoDe(c, id));
    var v = valor === null ? firebase.firestore.FieldValue.delete() : valor;
    try { await ref.update(campo(id), v); }
    catch (e) {
      if (e && e.code === 'not-found' && valor !== null) { var o = {}; o[id] = valor; await ref.set({d: o}, {merge: true}); }
      else throw e;
    }
  }
  function fotoDe(mapa) {                          // imita o "snapshot" que o Radar espera
    var docs = Object.keys(mapa).map(function (id) { var d = mapa[id]; return {id: id, data: function () { return d; }, exists: true}; });
    return {docs: docs, size: docs.length, empty: !docs.length, forEach: function (f) { docs.forEach(f); }};
  }
  function juntar(partes) { var m = {}; partes.forEach(function (p) { if (p) Object.keys(p).forEach(function (k) { m[k] = p[k]; }); }); return m; }

  var dbw = {
    collection: function (n) {
      var refs = []; for (var i = 0; i < nBlocos(n); i++) refs.push(fs.doc('resumo/' + n + '_' + i));
      return {
        onSnapshot: function (ok, erro) {
          var partes = new Array(refs.length), chegou = 0, vistos = {};
          var paradas = refs.map(function (r, i) {
            return r.onSnapshot(function (s) {
              partes[i] = s.exists ? ((s.data() || {}).d || {}) : {};
              if (!vistos[i]) { vistos[i] = 1; chegou++; }
              if (chegou === refs.length) ok(fotoDe(juntar(partes)));
            }, function (e) { if (erro) erro(e); });
          });
          return function () { paradas.forEach(function (p) { try { p(); } catch (e) {} }); };
        },
        get: async function () {
          var ss = await Promise.all(refs.map(function (r) { return r.get(); }));
          return fotoDe(juntar(ss.map(function (s) { return s.exists ? ((s.data() || {}).d || {}) : {}; })));
        }
      };
    },
    doc: function (p) {
      var partes = String(p).split('/'), c = partes[0], id = partes.slice(1).join('/');
      var d = fs.doc(p);
      return {
        set: function (v) { return d.set(v).then(function () { return noBloco(c, id, v); }).catch(mapErr); },
        delete: function () { return d.delete().then(function () { return noBloco(c, id, null); }).catch(mapErr); },
        get: function () { return d.get(); }
      };
    }
  };

  /* ---------- passagem única das marcações antigas (feita pela 1ª pessoa que entrar para marcar) ---------- */
  async function migrarAntigas() {
    try {
      var flag = fs.doc('sistema/migracao');
      if ((await flag.get()).exists) return;
      var r = await fetch('marcas_antigas.json'); if (!r.ok) return;
      var M = await r.json(), cols = M.colecoes || {}, ops = [];
      for (var c in cols) {
        var porBloco = {};
        // o que já foi marcado no aplicativo vale mais que o antigo
        for (var i = 0; i < nBlocos(c); i++) { var s = await fs.doc('resumo/' + c + '_' + i).get(); porBloco[c + '_' + i] = s.exists ? ((s.data() || {}).d || {}) : {}; }
        // marcações feitas no aplicativo antes desta versão (só no documento, sem bloco)
        (await fs.collection(c).get()).docs.forEach(function (d) { var b = blocoDe(c, d.id); if (!porBloco[b][d.id]) porBloco[b][d.id] = d.data(); });
        for (var id in cols[c]) {
          var b = blocoDe(c, id);
          if (porBloco[b][id]) continue;
          porBloco[b][id] = cols[c][id];
          ops.push(['set', 'doc', c + '/' + id, cols[c][id]]);
        }
        for (var bl in porBloco) ops.push(['set', 'doc', 'resumo/' + bl, {d: porBloco[bl]}]);
      }
      for (var k = 0; k < ops.length; k += 400) {
        var lote = fs.batch();
        ops.slice(k, k + 400).forEach(function (o) { lote.set(fs.doc(o[2]), o[3]); });
        await lote.commit();
      }
      await flag.set({em: new Date().toISOString(), por: uid, n: ops.length});
      avisar('Marcações antigas copiadas para o aplicativo.');
    } catch (e) { /* tenta de novo na próxima entrada */ }
  }

  // nomes de quem marcou antes do aplicativo (arquivo protegido, atualizado a cada montagem)
  var nomesAntigos = null;
  function antigos() {
    if (!nomesAntigos) nomesAntigos = fetch('nomes_antigos.json').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; });
    return nomesAntigos;
  }
  var cachePerfis = {};
  var usuario = {
    id: async function () { return uid; },
    can: async function (p) { return p === 'data.write' ? editor : true; },
    profiles: async function (ids) {
      var out = {}, velhos = await antigos();
      await Promise.all((ids || []).map(async function (i) {
        if (cachePerfis[i]) { out[i] = cachePerfis[i]; return; }
        if (velhos[i]) { cachePerfis[i] = {name: velhos[i]}; out[i] = cachePerfis[i]; return; }
        try {
          var d = await fs.doc('perfis/' + i).get();
          if (d.exists) { cachePerfis[i] = {name: (d.data() || {}).name || ''}; out[i] = cachePerfis[i]; }
        } catch (e) {}
      }));
      return out;
    }
  };

  var downloads = {
    save: function (o) {
      return new Promise(function (ok) {
        var d = o && o.data, b = (typeof Blob !== 'undefined' && d instanceof Blob) ? d : new Blob([d == null ? '' : d], {type: (o && o.type) || 'application/octet-stream'});
        var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = (o && o.filename) || 'arquivo';
        document.body.appendChild(a); a.click();
        setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} ok(); }, 800);
      });
    }
  };

  window.ELOX = {
    use: async function (nome) {
      if (nome === 'downloads') return downloads;
      try { await iniciar(); } catch (e) { return null; }
      if (nome === 'db') return dbw;
      if (nome === 'user') return usuario;
      return null;
    }
  };

  /* ---------- aviso e botão "Entrar" (login de quem faz marcações) ---------- */
  function avisar(t) {
    try {
      var el = document.createElement('div'); el.setAttribute('role', 'status'); el.textContent = t;
      el.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:100001;background:#1B2833;color:#EEF3F6;padding:10px 16px;border-radius:8px;font:15px system-ui,sans-serif;max-width:90vw;box-shadow:0 8px 24px rgba(0,0,0,.35)';
      (document.body || document.documentElement).appendChild(el); setTimeout(function () { el.remove(); }, 6000);
    } catch (e) {}
  }

  /* O botão "Entrar" fica na tela inicial (ao lado de "Baixar marcações"); o texto dele vem daqui. */
  function logadoMarcando() { return !!(ler('elo_eu') && ler('elo_es')); }
  window.ELOX_ROTULO = function () {
    if (!logadoMarcando()) return 'Entrar';
    var nome = ler('elo_nome');
    return 'Marcando' + (nome ? ': ' + nome : '') + ' · Sair';
  };
  function montarEntrar() {
    document.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('#btentrar') : null;
      if (!b) return;
      ev.preventDefault();
      if (logadoMarcando()) { apagar('elo_eu'); apagar('elo_es'); apagar('elo_nome'); location.reload(); } else abrirDialogo();
    });
    var st = document.createElement('style'); st.textContent = '@media print{#elo-dlg{display:none!important}}';
    document.head.appendChild(st);
  }

  function abrirDialogo() {
    var w = document.createElement('div'); w.id = 'elo-dlg';
    w.style.cssText = 'position:fixed;inset:0;z-index:100002;background:rgba(5,11,24,.72);display:grid;place-items:center;padding:16px';
    w.innerHTML = '<form style="width:100%;max-width:340px;background:#16212A;color:#EEF3F6;border:1px solid #2E3E4B;border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:12px;font-family:system-ui,sans-serif">' +
      '<b style="font-size:18px">Entrar para marcar</b>' +
      '<span style="font-size:14px;color:#9DAEBB">Use o e-mail e a senha de marcação que você recebeu.</span>' +
      '<input id="elo-e" type="email" autocomplete="username" placeholder="E-mail" required style="font:inherit;font-size:16px;padding:11px 12px;border-radius:8px;border:1px solid #2E3E4B;background:#0E151B;color:#fff">' +
      '<input id="elo-p" type="password" autocomplete="current-password" placeholder="Senha" required style="font:inherit;font-size:16px;padding:11px 12px;border-radius:8px;border:1px solid #2E3E4B;background:#0E151B;color:#fff">' +
      '<div style="display:flex;gap:10px"><button type="button" id="elo-c" style="flex:1;font:600 15px system-ui;padding:11px;border-radius:8px;border:1px solid #2E3E4B;background:transparent;color:#EEF3F6;cursor:pointer">Cancelar</button>' +
      '<button type="submit" style="flex:1;font:700 15px system-ui;padding:11px;border-radius:8px;border:0;background:#7DB8E8;color:#0E151B;cursor:pointer">Entrar</button></div></form>';
    document.body.appendChild(w);
    var fm = w.querySelector('form');
    w.querySelector('#elo-c').onclick = function () { w.remove(); };
    fm.onsubmit = function (ev) {
      ev.preventDefault();
      gravar('elo_eu', w.querySelector('#elo-e').value.trim(), true);
      gravar('elo_es', w.querySelector('#elo-p').value, true);
      location.reload();
    };
    w.querySelector('#elo-e').focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montarEntrar); else montarEntrar();

  /* Primeira abertura num aparelho: se o Radar abriu antes de o ajudante (que desembaralha desenhos e dados)
     assumir a página, recarrega uma vez quando ele ficar pronto. Sem isso, desenhos e normas não aparecem. */
  try {
    if ('serviceWorker' in navigator && !navigator.serviceWorker.controller) {
      var recarregar = function () {
        try { if (sessionStorage.getItem('elo_rl')) return; sessionStorage.setItem('elo_rl', '1'); } catch (e) { return; }
        location.reload();
      };
      navigator.serviceWorker.addEventListener('controllerchange', recarregar);
      // ajudante já ativo mas página sem ele (ex.: recarga forçada): uma recarga normal resolve
      navigator.serviceWorker.ready.then(function () { setTimeout(function () { if (!navigator.serviceWorker.controller) recarregar(); }, 800); });
    }
  } catch (e) {}
})();
