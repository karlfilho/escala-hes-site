"use strict";
/* Escala CO/HES — site estático. Lê data.json (gerado por build.py) e desenha o mesmo calendário do PDF, interativo.
   Duas abas que nunca se misturam: Centro Obstétrico (data.meses) e Ambulatórios (data.amb.meses). */

const BRT = "America/Sao_Paulo";
const WD = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"];
const WD_LONGO = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const VCLASS = { CLT: "clt", Credenciamento: "cred", Empresa: "emp" };
const RESERVADO = "RESERVADO";
const RESIDENTES = "RESIDENTES";
const TIPOS = { PN: "Pré-natal", CG: "Cir. Gineco", AMB: "Ambulatório" };
const SETORES = {
  co: { titulo: "Centro Obstétrico", aba: "Escala CO", siglas: [["M", "Manhã"], ["T", "Tarde"], ["N", "Noite"]],
        unid: ["plantão", "plantões"],
        rodape: "Somente Centro Obstétrico — ambulatório, enfermaria e centro cirúrgico não constam nesta escala." },
  amb: { titulo: "Ambulatórios", aba: "Ambulatórios", siglas: [["M", "Manhã"], ["T", "Tarde"]],
         unid: ["turno", "turnos"],
         rodape: "Somente ambulatórios (Pré-natal e Cir. Gineco), de segunda a sexta — o Centro Obstétrico fica na outra aba." },
};
const REFRESH_MS = 5 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const el = { grade: $("grade"), kpis: $("kpis"), mesSel: $("mesSel"), mesTitulo: $("mesTitulo"), foco: $("foco"),
  busca: $("busca"), sug: $("sugestoes"), irDia: $("irDia"), lista: $("listaVagas"), aviso: $("aviso"),
  abas: $("abas"), setorTitulo: $("setorTitulo") };

const state = { data: null, setor: "co", mesId: null, foco: null, periodos: new Set(), sugIdx: -1 };

/* ── utilidades ── */
const pad = (n) => String(n).padStart(2, "0");
const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hojeISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: BRT }).format(new Date());
const iso = (ano, mes, dia) => `${ano}-${pad(mes)}-${pad(dia)}`;
const wdDe = (ano, mes, dia) => new Date(ano, mes - 1, dia).getDay();
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
const curto = (nome) => state.data.pessoas[nome]?.c ?? nome;
const fmtDataHora = (isoUtc) => new Intl.DateTimeFormat("pt-BR", { timeZone: BRT, dateStyle: "short", timeStyle: "short" }).format(new Date(isoUtc));
const reduzido = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ── setor ativo: tudo abaixo lê os meses e as posições por aqui ── */
const temAmb = () => !!state.data?.amb?.meses?.length;
const V = () => SETORES[state.setor];
const ehAmb = () => state.setor === "amb";
const meses = () => (ehAmb() ? state.data.amb.meses : state.data.meses);
const mesAtual = () => meses().find((m) => m.id === state.mesId);
const mesDeISO = (d) => meses().find((m) => m.id === d.slice(0, 7));
// no CO cada posição é o nome; no ambulatório é [tipo, nome]
const nm = (x) => (ehAmb() ? x[1] : x);
const tp = (x) => (ehAmb() ? x[0] : null);
const ehPessoa = (n) => n && n !== RESERVADO && n !== RESIDENTES;
const aparece = (m, nome) => Object.values(m.dias).some((p) => Object.values(p).some((l) => l.some((x) => nm(x) === nome)));

function avisar(msg) {
  el.aviso.textContent = msg; el.aviso.hidden = false;
  clearTimeout(avisar.t); avisar.t = setTimeout(() => (el.aviso.hidden = true), 3500);
}

/* ── hash: links diretos (#s=amb&m=2026-10&d=2026-10-24 | #p=Nome) ── */
function lerHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { s: p.get("s"), m: p.get("m"), d: p.get("d"), p: p.get("p") };
}
function gravarHash() {
  const p = new URLSearchParams();
  if (ehAmb()) p.set("s", "amb");
  p.set("m", state.mesId);
  if (state.foco?.tipo === "dia") p.set("d", state.foco.iso);
  if (state.foco?.tipo === "pessoa") p.set("p", state.foco.nome);
  history.replaceState(null, "", "#" + p.toString());
}

/* ── cálculo ── */
function kpisDoMes(m) {
  let total = 0, vagas = 0, reserv = 0, abertas = 0;
  const hoje = hojeISO();
  for (const [d, pers] of Object.entries(m.dias)) {
    const futuro = iso(m.ano, m.mes, +d) >= hoje;
    for (const lista of Object.values(pers)) {
      for (const x of lista) {
        const n = nm(x);
        total++;
        if (n === null) { vagas++; if (futuro) abertas++; }
        else if (n === RESERVADO) reserv++;
      }
    }
  }
  const primeiro = iso(m.ano, m.mes, 1);
  let rot;
  if (hoje <= primeiro) rot = "Vagas";
  else if (hoje.slice(0, 7) === m.id) rot = `Vagas a partir de ${hoje.slice(8)}/${pad(m.mes)}`;
  else rot = "Vagas (mês encerrado)";
  const preenchidas = total - vagas - reserv;
  return { total, preenchidas, abertas, reserv, rot, cob: total ? Math.round((preenchidas / total) * 100) : 0 };
}

// contagem[s] = nº de vagas no turno; tipos[s] = { PN: n, … } (só no ambulatório)
function vagasFuturas() {
  const hoje = hojeISO(), out = [];
  for (const m of meses()) {
    for (const [d, pers] of Object.entries(m.dias)) {
      const data = iso(m.ano, m.mes, +d);
      if (data < hoje) continue;
      const contagem = {}, tipos = {};
      for (const [s] of V().siglas) {
        const abertas = pers[s].filter((x) => nm(x) === null);
        if (abertas.length && (!state.periodos.size || state.periodos.has(s))) {
          contagem[s] = abertas.length;
          if (ehAmb()) tipos[s] = abertas.reduce((a, x) => ((a[tp(x)] = (a[tp(x)] || 0) + 1), a), {});
        }
      }
      if (Object.keys(contagem).length) {
        out.push({ iso: data, m, dia: +d, wd: wdDe(m.ano, m.mes, +d), contagem, tipos, fer: m.feriados[d] || null, hoje: data === hoje });
      }
    }
  }
  return out;
}
const tiposTxt = (t) => Object.entries(t).map(([k, n]) => `${n} ${TIPOS[k] || k}`).join(", ");

/* ── desenho ── */
function htmlKpis(m) {
  const k = kpisDoMes(m);
  const itens = [[k.total, "Posições"], [k.preenchidas, "Preenchidas"], [k.abertas, k.rot, "alerta"]];
  if (k.reserv) itens.push([k.reserv, "Reservadas"]);
  itens.push([k.cob + "%", "Cobertura"]);
  return itens.map(([v, l, c]) => `<div class="kpi ${c || ""}"><div class="v">${v}</div><div class="l">${esc(l)}</div></div>`).join("");
}

const htmlTipo = (t) => (t ? `<b class="tp ${t.toLowerCase()}" title="${esc(TIPOS[t] || t)}">${esc(t)}</b>` : "");

// agrupa reservados ou vagas por tipo: [[tipo|null, quantidade], …]
function porTipo(lista, alvo) {
  const c = new Map();
  for (const x of lista) if (nm(x) === alvo) c.set(tp(x), (c.get(tp(x)) || 0) + 1);
  return [...c];
}

function htmlDia(m, d, i, hoje) {
  const data = iso(m.ano, m.mes, d), wd = wdDe(m.ano, m.mes, d), fer = m.feriados[String(d)];
  const pers = m.dias[String(d)];
  const fechado = ehAmb() && V().siglas.every(([s]) => !pers[s].length);
  const cls = ["dia", wd === 0 || wd === 6 ? "fds" : "", fer ? "feriado" : "", data < hoje ? "passado" : "",
    data === hoje ? "eh-hoje" : "", fechado ? "fechado" : ""];
  let h = `<article class="${cls.filter(Boolean).join(" ")}" data-iso="${data}" style="--i:${i}">` +
    `<header class="cab"><span class="num">${d}</span><span class="wd">${WD[wd]}</span>` +
    (fer ? `<span class="fer-rot" title="Feriado (nacional ou HES)">Feriado · ${esc(fer)}</span>` : "") +
    (data === hoje ? `<span class="hoje-tag">hoje</span>` : "") + `</header>`;
  if (fechado) return h + `<div class="sem">sem ambulatório</div></article>`;
  for (const [s] of V().siglas) {
    const lista = pers[s];
    h += `<div class="per p${s}"><span class="sig">${s}</span><div class="nomes">`;
    for (const x of lista) {
      const n = nm(x), t = tp(x);
      if (ehPessoa(n)) {
        const titulo = t ? `${n} · ${TIPOS[t] || t}` : n;
        h += `<span class="n ${VCLASS[state.data.pessoas[n].v]}" data-p="${esc(n)}" title="${esc(titulo)}">${htmlTipo(t)}${esc(curto(n))}</span>`;
      } else if (n === RESIDENTES) {
        h += `<span class="n resid" title="Residentes · ${esc(TIPOS[t] || t)}">${htmlTipo(t)}Residentes</span>`;
      }
    }
    for (const [t, q] of porTipo(lista, RESERVADO)) h += `<span class="n reserv">${htmlTipo(t)}${q === 1 ? "reservado" : q + " reservados"}</span>`;
    for (const [t, q] of porTipo(lista, null)) h += `<span class="n vaga">${htmlTipo(t)}${plural(q, "vaga", "vagas")}</span>`;
    if (!lista.length) h += `<span class="n reserv">—</span>`;
    h += `</div></div>`;
  }
  return h + `</article>`;
}

function renderCabecalho() {
  const m = mesAtual();
  document.body.classList.toggle("setor-amb", ehAmb());
  el.setorTitulo.textContent = V().titulo;
  el.mesTitulo.textContent = `· ${MESES[m.mes - 1]} ${m.ano}`;
  document.title = `${V().aba} · ${MESES[m.mes - 1]} ${m.ano}`;
  $("rodapeTxt").textContent = V().rodape;
  el.abas.hidden = !temAmb();
  el.abas.querySelectorAll("[data-s]").forEach((b) => b.setAttribute("aria-selected", b.dataset.s === state.setor));
  $("filtroPer").querySelectorAll("button").forEach((b) => (b.hidden = !V().siglas.some(([s]) => s === b.dataset.p)));
}

function renderMes() {
  const m = mesAtual(), hoje = hojeISO();
  renderCabecalho();
  el.mesSel.value = m.id;
  el.kpis.innerHTML = htmlKpis(m);

  const dias = Object.keys(m.dias).length;
  const inicio = wdDe(m.ano, m.mes, 1);
  const vazio = '<div class="vazio"></div>';
  let h = vazio.repeat(inicio);
  for (let d = 1; d <= dias; d++) h += htmlDia(m, d, d + inicio, hoje);
  h += vazio.repeat((7 - ((inicio + dias) % 7)) % 7);
  el.grade.innerHTML = h;

  const lista = meses(), i = lista.findIndex((x) => x.id === m.id);
  $("prev").disabled = i <= 0; $("next").disabled = i >= lista.length - 1;
  el.irDia.min = iso(lista[0].ano, lista[0].mes, 1);
  const ult = lista.at(-1);
  el.irDia.max = iso(ult.ano, ult.mes, Object.keys(ult.dias).length);
  aplicarFoco(false);
}

function renderVagas() {
  const itens = vagasFuturas(), hoje = hojeISO();
  $("vagasSub").textContent = itens.length
    ? `${plural(itens.reduce((a, x) => a + Object.values(x.contagem).reduce((s, n) => s + n, 0), 0), "vaga", "vagas")} em ${plural(itens.length, "dia", "dias")}, a partir de hoje (${hoje.slice(8)}/${hoje.slice(5, 7)}). Toque em um dia para ver no calendário.`
    : "Nenhuma vaga em aberto a partir de hoje.";
  if (!itens.length) {
    el.lista.innerHTML = `<div class="vazio-msg">Sem vagas abertas${state.periodos.size ? " para o período escolhido" : ""}. 🎉</div>`;
    return;
  }
  let h = "", mesId = "", i = 0;
  for (const x of itens) {
    if (x.m.id !== mesId) { mesId = x.m.id; h += `<div class="mes-tit">${MESES[x.m.mes - 1]} ${x.m.ano}</div>`; }
    const pills = V().siglas.filter(([s]) => x.contagem[s])
      .map(([s, nome]) => `<span class="pill${x.hoje ? " hoje" : ""}">${nome} · ${ehAmb() ? tiposTxt(x.tipos[s]) : x.contagem[s]}</span>`).join("");
    const cls = ["vaga-item", x.wd === 0 || x.wd === 6 ? "fds" : "", x.fer ? "is-fer" : ""].filter(Boolean).join(" ");
    h += `<button class="${cls}" data-iso="${x.iso}" style="--i:${Math.min(i++, 24)}" title="${x.fer ? "Feriado · " + esc(x.fer) : ""}">` +
      `<div class="data"><b>${x.dia}</b><span>${WD[x.wd]}</span></div><div class="pers">${pills}</div></button>`;
  }
  el.lista.innerHTML = h;
}

/* ── foco: um dia ou um plantonista; o resto do calendário fica cinza ── */
function aplicarFoco(rolar) {
  const f = state.foco, grade = el.grade;
  document.body.classList.toggle("com-foco", !!f);
  document.body.classList.toggle("foco-pessoa", f?.tipo === "pessoa");
  let primeiro = null;
  grade.querySelectorAll(".dia").forEach((d) => {
    let sel = false;
    if (f?.tipo === "dia") sel = d.dataset.iso === f.iso;
    d.querySelectorAll(".n[data-p]").forEach((n) => n.classList.remove("hit"));
    d.querySelectorAll(".per").forEach((p) => p.classList.remove("tem"));
    if (f?.tipo === "pessoa") {
      d.querySelectorAll(".n[data-p]").forEach((n) => {
        if (n.dataset.p === f.nome) { n.classList.add("hit"); n.closest(".per").classList.add("tem"); sel = true; }
      });
    }
    d.classList.toggle("sel", sel);
    if (sel && !primeiro) primeiro = d;
  });
  renderFoco();
  gravarHash();
  if (rolar && primeiro) primeiro.scrollIntoView({ behavior: reduzido ? "auto" : "smooth", block: "center" });
}

function renderFoco() {
  const f = state.foco, box = el.foco;
  if (!f) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  if (f.tipo === "dia") {
    const [a, mm, dd] = f.iso.split("-").map(Number), m = mesAtual(), pers = m?.dias[String(dd)];
    const wd = WD_LONGO[wdDe(a, mm, dd)];
    const fechado = ehAmb() && pers && V().siglas.every(([s]) => !pers[s].length);
    const resumo = !pers ? "" : fechado ? "Sem ambulatório neste dia." : V().siglas.map(([s, nome]) => {
      const n = pers[s].map(nm); const v = n.filter((x) => x === null).length;
      return `${nome}: ${plural(n.filter((x) => x && x !== RESERVADO).length, "escalado", "escalados")}${v ? `, <b style="color:var(--vaga-fg)">${plural(v, "vaga", "vagas")}</b>` : ""}`;
    }).join(" · ");
    box.innerHTML = `<span><strong>${wd[0].toUpperCase() + wd.slice(1)}, ${pad(dd)}/${pad(mm)}/${a}</strong></span><span class="sub" style="margin:0">${resumo}</span>` +
      `<button class="btn limpar" id="limpar">Limpar ✕</button>`;
  } else {
    const [um, varios] = V().unid;
    const contagens = meses().map((m) => {
      let n = 0;
      for (const pers of Object.values(m.dias)) for (const l of Object.values(pers)) n += l.filter((x) => nm(x) === f.nome).length;
      return { m, n };
    }).filter((x) => x.n);
    const v = state.data.pessoas[f.nome];
    const chips = contagens.map(({ m, n }) =>
      `<button class="chip${m.id === state.mesId ? " on" : ""}" data-mes="${m.id}">${MESES[m.mes - 1].slice(0, 3)}: ${plural(n, um, varios)}</button>`).join("");
    box.innerHTML = `<span><strong>${esc(f.nome)}</strong> · ${esc(v?.v || "")}</span><span class="chips">${chips || `<span class='sub' style='margin:0'>Sem ${varios} nos meses carregados.</span>`}</span>` +
      `<button class="btn limpar" id="limpar">Limpar ✕</button>`;
  }
}

function definirFoco(foco, { rolar = true } = {}) {
  state.foco = foco;
  if (foco?.tipo === "dia") {
    const m = mesDeISO(foco.iso);
    if (!m) { avisar("Esse dia está fora do período carregado."); state.foco = null; return aplicarFoco(false); }
    if (m.id !== state.mesId) { state.mesId = m.id; renderMes(); }
    el.irDia.value = foco.iso; el.busca.value = "";
  } else if (foco?.tipo === "pessoa") {
    el.busca.value = curto(foco.nome); el.irDia.value = "";
  } else { el.busca.value = ""; el.irDia.value = ""; }
  aplicarFoco(rolar);
}

function irParaMes(id, manterFoco = false) {
  if (id === state.mesId) return;
  state.mesId = id;
  if (!manterFoco && state.foco?.tipo === "dia" && !state.foco.iso.startsWith(id)) { state.foco = null; el.irDia.value = ""; }
  renderMes();
  if (!reduzido) el.grade.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 260, easing: "ease-out" });
}

/* ── troca de aba: mesmo mês e mesmo foco quando fizer sentido ── */
function trocarSetor(s) {
  if (s === state.setor || !SETORES[s] || (s === "amb" && !temAmb())) return;
  state.setor = s;
  if (!mesAtual()) state.mesId = (mesDeISO(hojeISO()) || meses()[0]).id;
  if (state.foco?.tipo === "pessoa" && !meses().some((m) => aparece(m, state.foco.nome))) { state.foco = null; el.busca.value = ""; }
  for (const p of [...state.periodos]) if (!V().siglas.some(([x]) => x === p)) state.periodos.delete(p);
  $("filtroPer").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", state.periodos.has(b.dataset.p)));
  fecharSug();
  renderMes(); renderVagas();
  if (!reduzido) el.grade.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 260, easing: "ease-out" });
}

/* ── busca de plantonista (só quem aparece na aba aberta) ── */
function sugestoes(q) {
  const nq = norm(q.trim());
  const presentes = new Set();
  for (const m of meses()) for (const p of Object.values(m.dias)) for (const l of Object.values(p)) for (const x of l) if (ehPessoa(nm(x))) presentes.add(nm(x));
  const todos = [...presentes].map((nome) => { const p = state.data.pessoas[nome]; return { nome, c: p.c, v: p.v, key: norm(nome + " " + p.c) }; });
  const achados = nq ? todos.filter((p) => nq.split(/\s+/).every((t) => p.key.includes(t))) : todos;
  return achados.sort((a, b) => a.c.localeCompare(b.c, "pt-BR")).slice(0, 12);
}
function mostrarSug() {
  const itens = sugestoes(el.busca.value);
  state.sugIdx = itens.length ? 0 : -1;
  el.sug.innerHTML = itens.length
    ? itens.map((p, i) => `<li role="option" data-nome="${esc(p.nome)}" aria-selected="${i === 0}"><span class="pt ${VCLASS[p.v]}"></span>${esc(p.c)}<small>${esc(p.nome === p.c ? p.v : p.nome)}</small></li>`).join("")
    : `<li class="vazio">Nenhum plantonista encontrado</li>`;
  el.sug.hidden = false; el.busca.setAttribute("aria-expanded", "true");
}
function fecharSug() { el.sug.hidden = true; el.busca.setAttribute("aria-expanded", "false"); }
function moverSug(delta) {
  const lis = [...el.sug.querySelectorAll("li[data-nome]")];
  if (!lis.length) return;
  state.sugIdx = (state.sugIdx + delta + lis.length) % lis.length;
  lis.forEach((li, i) => li.setAttribute("aria-selected", i === state.sugIdx));
  lis[state.sugIdx].scrollIntoView({ block: "nearest" });
}
function escolherPessoa(nome) {
  fecharSug(); el.busca.blur();
  // se não há plantão no mês aberto, vai para o primeiro mês em que a pessoa aparece
  if (!aparece(mesAtual(), nome)) { const alvo = meses().find((m) => aparece(m, nome)); if (alvo) { state.mesId = alvo.id; renderMes(); } }
  definirFoco({ tipo: "pessoa", nome });
}

/* ── eventos ── */
el.busca.addEventListener("input", mostrarSug);
el.busca.addEventListener("focus", () => { el.busca.select(); mostrarSug(); });
el.busca.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); moverSug(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moverSug(-1); }
  else if (e.key === "Enter") { const li = el.sug.querySelectorAll("li[data-nome]")[state.sugIdx]; if (li) escolherPessoa(li.dataset.nome); }
  else if (e.key === "Escape") { fecharSug(); el.busca.blur(); }
});
el.sug.addEventListener("mousedown", (e) => { const li = e.target.closest("li[data-nome]"); if (li) { e.preventDefault(); escolherPessoa(li.dataset.nome); } });
document.addEventListener("click", (e) => { if (!e.target.closest(".campo-busca")) fecharSug(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); el.busca.focus(); }
  else if (e.key === "Escape" && state.foco && document.activeElement === document.body) definirFoco(null);
  else if (!/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && !e.target.closest?.("#abas")) {
    if (e.key === "ArrowLeft") $("prev").click(); else if (e.key === "ArrowRight") $("next").click();
  }
});
el.abas.addEventListener("click", (e) => { const b = e.target.closest("[data-s]"); if (b) trocarSetor(b.dataset.s); });
el.abas.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const bs = [...el.abas.querySelectorAll("[data-s]")], i = bs.findIndex((b) => b.dataset.s === state.setor);
  const alvo = bs[(i + (e.key === "ArrowRight" ? 1 : -1) + bs.length) % bs.length];
  trocarSetor(alvo.dataset.s); alvo.focus();
});
el.irDia.addEventListener("change", () => { if (el.irDia.value) definirFoco({ tipo: "dia", iso: el.irDia.value }); else definirFoco(null); });
el.mesSel.addEventListener("change", () => irParaMes(el.mesSel.value));
$("prev").addEventListener("click", () => { const i = meses().findIndex((m) => m.id === state.mesId); if (i > 0) irParaMes(meses()[i - 1].id); });
$("next").addEventListener("click", () => { const i = meses().findIndex((m) => m.id === state.mesId); if (i < meses().length - 1) irParaMes(meses()[i + 1].id); });
$("hoje").addEventListener("click", () => {
  const h = hojeISO(), m = mesDeISO(h);
  if (m) definirFoco({ tipo: "dia", iso: h }); else avisar("Hoje está fora do período carregado.");
});
el.foco.addEventListener("click", (e) => {
  if (e.target.closest("#limpar")) return definirFoco(null);
  const chip = e.target.closest(".chip");
  if (chip) { irParaMes(chip.dataset.mes, true); aplicarFoco(true); }
});
el.grade.addEventListener("click", (e) => {
  const n = e.target.closest(".n[data-p]");
  if (n) return definirFoco({ tipo: "pessoa", nome: n.dataset.p }, { rolar: false });
  const d = e.target.closest(".dia");
  if (d) definirFoco(state.foco?.tipo === "dia" && state.foco.iso === d.dataset.iso ? null : { tipo: "dia", iso: d.dataset.iso }, { rolar: false });
});
el.lista.addEventListener("click", (e) => {
  const b = e.target.closest(".vaga-item");
  if (b) { definirFoco({ tipo: "dia", iso: b.dataset.iso }); scrollTo({ top: 0, behavior: "smooth" }); }
});
$("filtroPer").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const p = b.dataset.p; state.periodos.has(p) ? state.periodos.delete(p) : state.periodos.add(p);
  b.setAttribute("aria-pressed", state.periodos.has(p)); renderVagas();
});
$("copiar").addEventListener("click", async () => {
  const itens = vagasFuturas();
  if (!itens.length) return avisar("Não há vagas para copiar.");
  let t = `*Vagas abertas — ${V().titulo} HES*\n`, mesId = "";
  for (const x of itens) {
    if (x.m.id !== mesId) { mesId = x.m.id; t += `\n*${MESES[x.m.mes - 1]}*\n`; }
    const per = V().siglas.filter(([s]) => x.contagem[s]).map(([s, nome]) => `${nome} (${ehAmb() ? tiposTxt(x.tipos[s]) : x.contagem[s]})`).join(", ");
    t += `• ${WD[x.wd][0] + WD[x.wd].slice(1).toLowerCase()} ${pad(x.dia)}/${pad(x.m.mes)}: ${per}${x.fer ? " — feriado" : ""}\n`;
  }
  t += `\n${location.origin}${location.pathname}${ehAmb() ? "#s=amb" : ""}`;
  try { await navigator.clipboard.writeText(t); avisar("Lista copiada. É só colar no WhatsApp."); }
  catch { const ta = document.createElement("textarea"); ta.value = t; document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove(); avisar("Lista copiada."); }
});

/* ── dados ── */
async function carregar(primeira) {
  const r = await fetch("data.json", { cache: "no-cache" });
  if (!r.ok) throw new Error("data.json " + r.status);
  const d = await r.json();
  if (!primeira && state.data && d.alterado_em === state.data.alterado_em) return;
  const mudou = !primeira;
  state.data = d;
  if (ehAmb() && !temAmb()) state.setor = "co";
  // os dois setores têm os mesmos meses (build.py monta o ambulatório nos meses do CO)
  el.mesSel.innerHTML = d.meses.map((m) => `<option value="${m.id}">${MESES[m.mes - 1]} ${m.ano}</option>`).join("");
  $("atualizado").textContent = `Última alteração na escala: ${fmtDataHora(d.alterado_em)} · atualização automática`;
  if (primeira) return;
  if (!mesAtual()) state.mesId = meses()[0].id;
  if (state.foco?.tipo === "pessoa" && !d.pessoas[state.foco.nome]) state.foco = null;
  renderMes(); renderVagas();
  if (mudou) avisar("A escala foi atualizada.");
}

function aplicarHash() {
  const h = lerHash();
  const s = h.s === "amb" && temAmb() ? "amb" : "co";
  if (s !== state.setor) trocarSetor(s);
  if (h.m && meses().some((m) => m.id === h.m) && h.m !== state.mesId) { state.mesId = h.m; renderMes(); }
  if (h.d && mesDeISO(h.d)) definirFoco({ tipo: "dia", iso: h.d });
  else if (h.p && state.data.pessoas[h.p]) definirFoco({ tipo: "pessoa", nome: h.p });
  else if (!h.d && !h.p && state.foco) definirFoco(null);
}

async function iniciar() {
  try { await carregar(true); }
  catch (e) { el.grade.innerHTML = `<div class="vazio-msg" style="grid-column:1/-1">Não consegui carregar a escala. Tente recarregar a página.</div>`; console.error(e); return; }
  const h = lerHash(), hoje = hojeISO();
  state.setor = h.s === "amb" && temAmb() ? "amb" : "co";
  state.mesId = (h.m && meses().some((m) => m.id === h.m) && h.m)
    || (mesDeISO(hoje)?.id) || meses().find((m) => iso(m.ano, m.mes, 28) >= hoje)?.id || meses().at(-1).id;
  renderMes(); renderVagas();
  if (h.d && mesDeISO(h.d)) definirFoco({ tipo: "dia", iso: h.d });
  else if (h.p && state.data.pessoas[h.p]) definirFoco({ tipo: "pessoa", nome: h.p });
  addEventListener("hashchange", aplicarHash);
  setInterval(() => { if (!document.hidden) carregar(false).catch(() => {}); }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) carregar(false).catch(() => {}); });
}
iniciar();
