#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gera site/data.json (a escala do CO/HES e os ambulatórios, em formato leve) a partir do Notion.

    NOTION_TOKEN=secret_xxx python3 build.py            # produção (GitHub Action)
    python3 build.py --local ~/Documents/HES/Escalas/_dados   # teste com os JSONs do PDF

Entram as linhas do CO (Name = 'CO') e, à parte, as dos ambulatórios (Pré-natal,
Cir. Gineco, Cir. Gineco - Residentes e o antigo Ambulatório), que nunca se misturam.
Dos plantonistas só saem Nome e Tipo (vínculo):
CRM, DN, aniversário, férias etc. nunca são lidos para o arquivo de saída.

Falha em vez de publicar dado duvidoso (período irregular, plantonista sem
vínculo, nome curto repetido): o site continua com a última versão boa.
"""
import argparse
import calendar
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
SAIDA = RAIZ / "site" / "data.json"
NOMES_CURTOS = RAIZ / "nomes_curtos.json"

DS_ESCALA = "3b296f0a-3487-80f4-85fb-000bba7de545"
DS_PLANTONISTAS = "3b296f0a-3487-80c4-9f65-000b2b511e9d"
NOTION_VERSION = "2025-09-03"

PERIODO = {"Manhã": "M", "Tarde": "T", "Noite": "N"}
VINCULOS = {"CLT", "Credenciamento", "Empresa"}
RESERVADO = "RESERVADO"
RESIDENTES = "RESIDENTES"
# setor do ambulatório no Notion → sigla no site; "Residentes" não tem plantonista vinculado
AMB_TIPOS = {"Pré-natal": "PN", "Cir. Gineco": "CG", "Cir. Gineco - Residentes": "CG", "Ambulatório": "AMB"}
AMB_PERIODOS = "MT"
PARTICULAS = {"de", "da", "do", "dos", "das", "e", "del"}

# Feriados nacionais (Lei 662/1949, 6.802/1980, 14.759/2023). Carnaval e Corpus
# Christi são ponto facultativo e ficam de fora, como no PDF.
FERIADOS_FIXOS = {(1, 1): "Confraternização Universal", (4, 21): "Tiradentes",
                  (5, 1): "Dia do Trabalho", (9, 7): "Independência",
                  (10, 12): "N. Sra. Aparecida", (11, 2): "Finados",
                  (11, 15): "Proclamação da República", (11, 20): "Consciência Negra",
                  (12, 25): "Natal",
                  # feriados só do HES (definidos pela coordenação em 14/10/2026)
                  (12, 24): "Véspera de Natal", (12, 31): "Réveillon"}


def pascoa(ano):
    a, b, c = ano % 19, ano // 100, ano % 100
    d, e = b // 4, b % 4
    g = (8 * b + 13) // 25
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 19 * l + 163) // 5089
    return dt.date(ano, (h + l - 7 * m + 114) // 31, (h + l - 7 * m + 114) % 31 + 1)


def feriados(ano, mes):
    out = {d: n for (m, d), n in FERIADOS_FIXOS.items() if m == mes}
    sexta_santa = pascoa(ano) - dt.timedelta(days=2)
    if sexta_santa.month == mes:
        out[sexta_santa.day] = "Paixão de Cristo"
    if ano < 2024 and mes == 11:
        out.pop(20, None)
    return {str(d): n for d, n in sorted(out.items())}


def nomes_curtos(nomes):
    # nomes_curtos.json não vai para o repositório público: no Actions vem do secret NOMES_CURTOS
    overrides = json.loads(NOMES_CURTOS.read_text(encoding="utf-8")) if NOMES_CURTOS.exists() else {}

    def curto(full):
        if full in overrides:
            return overrides[full]
        toks = [t for t in full.split() if t.lower() not in PARTICULAS]
        return toks[0] if len(toks) == 1 else f"{toks[0]} {toks[-1]}"

    m = {n: curto(n) for n in nomes}
    dup = [c for c, k in Counter(m.values()).items() if k > 1]
    if dup:
        quem = [f"{n} → {c}" for n, c in m.items() if c in dup]
        sys.exit("❌ nomes curtos colidem, adicione em nomes_curtos.json:\n  " + "\n  ".join(quem))
    return m


# ── Notion ───────────────────────────────────────────────────────────────────
def notion_query(token, ds, corpo):
    resultados, cursor = [], None
    while True:
        b = dict(corpo, page_size=100)
        if cursor:
            b["start_cursor"] = cursor
        req = urllib.request.Request(
            f"https://api.notion.com/v1/data_sources/{ds}/query",
            data=json.dumps(b).encode(), method="POST",
            headers={"Authorization": f"Bearer {token}", "Notion-Version": NOTION_VERSION,
                     "Content-Type": "application/json"})
        for tentativa in range(5):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    j = json.load(r)
                break
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 504) and tentativa < 4:
                    time.sleep(float(e.headers.get("Retry-After", 2 * (tentativa + 1))))
                    continue
                sys.exit(f"❌ Notion respondeu {e.code}: {e.read().decode()[:400]}")
        resultados += j["results"]
        if not j.get("has_more"):
            return resultados
        cursor = j["next_cursor"]


def texto(prop):
    return "".join(t.get("plain_text", "") for t in prop.get("title", [])).strip()


def ler_notion(token):
    """→ (meses, amb, vinculos).
    meses[(ano, mes)][dia][sigla] = [nome | None | RESERVADO, ...]
    amb[(ano, mes)][dia][sigla] = [[tipo, nome | None | RESERVADO | RESIDENTES], ...]"""
    pessoas = {}
    for p in notion_query(token, DS_PLANTONISTAS, {}):
        nome = texto(p["properties"]["Name"])
        tipo = (p["properties"]["Tipo"].get("select") or {}).get("name")
        pessoas[p["id"].replace("-", "")] = (nome, tipo)

    hoje = dt.date.today()
    desde = (hoje.replace(day=1) - dt.timedelta(days=1)).replace(day=1)   # mês anterior
    setores = [{"property": "Name", "title": {"equals": n}} for n in ["CO", *AMB_TIPOS]]
    filtro = {"and": [{"or": setores},
                      {"property": "Date", "date": {"on_or_after": desde.isoformat()}}]}
    linhas = notion_query(token, DS_ESCALA, {"filter": filtro})

    meses, amb, vinculos = {}, {}, {}
    for l in linhas:
        pr = l["properties"]
        data = (pr["Date"].get("date") or {}).get("start")
        if not data:
            continue
        setor = texto(pr["Name"])
        ano, mes, dia = int(data[0:4]), int(data[5:7]), int(data[8:10])
        pers = [o["name"] for o in pr["Período"]["multi_select"]]
        validos = PERIODO if setor == "CO" else {k: v for k, v in PERIODO.items() if v in AMB_PERIODOS}
        if len(pers) != 1 or pers[0] not in validos:
            sys.exit(f"❌ linha de {setor} em {dia:02d}/{mes:02d} com período irregular {pers}: {l['url']}")
        sigla = PERIODO[pers[0]]
        rel = pr["Plantonistas GO do HES"]["relation"]
        if rel:
            pid = rel[0]["id"].replace("-", "")
            if pid not in pessoas:
                sys.exit(f"❌ plantonista da linha {l['url']} não está no cadastro lido")
            nome, tipo = pessoas[pid]
            vinculos[nome] = tipo
        elif setor == "Cir. Gineco - Residentes":
            nome = RESIDENTES
        elif ((pr["Status"].get("status") or {}).get("name")) == "Reservada":
            nome = RESERVADO
        else:
            nome = None
        if setor == "CO":
            meses.setdefault((ano, mes), {}).setdefault(dia, {}).setdefault(sigla, []).append(nome)
        else:
            amb.setdefault((ano, mes), {}).setdefault(dia, {}).setdefault(sigla, []).append([AMB_TIPOS[setor], nome])
    return meses, amb, vinculos


def ler_local(pasta):
    """Modo de teste: só o CO (os JSONs do PDF não trazem ambulatório)."""
    meses, vinculos = {}, {}
    for f in sorted(Path(pasta).expanduser().glob("escala_*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        meses[(d["ano"], d["mes"])] = {int(k): v for k, v in d["escala"].items()}
        for n, (v, _) in d["conferencia"]["plantonistas"].items():
            vinculos[n] = v
    return meses, {}, vinculos


# ── montagem ─────────────────────────────────────────────────────────────────
def ordenar(lista):
    """Nomes em ordem binária (como o ORDER BY da consulta do PDF), vagas por último."""
    return sorted(n for n in lista if n is not None) + [None] * lista.count(None)


def ordenar_amb(lista):
    """Nomes por tipo e nome, depois residentes, reservados e vagas."""
    rank = lambda n: 3 if n is None else 2 if n == RESERVADO else 1 if n == RESIDENTES else 0
    return sorted(lista, key=lambda x: (rank(x[1]), x[0], x[1] or ""))


def montar(meses, amb, vinculos):
    erros = [f"{n}: vínculo '{v}' inválido (sem Tipo no cadastro?)"
             for n, v in sorted(vinculos.items()) if v not in VINCULOS]
    if erros:
        sys.exit("❌ " + "\n❌ ".join(erros))
    curtos = nomes_curtos(vinculos)
    fora = sorted(k for k in amb if k not in meses)
    if fora:
        print("⚠️  ambulatório sem escala do CO no mesmo mês, fica de fora: "
              + ", ".join(f"{m:02d}/{a}" for a, m in fora))
    saida_meses, saida_amb = [], []
    for (ano, mes), dias in sorted(meses.items()):
        n = calendar.monthrange(ano, mes)[1]
        fora = [d for d in dias if not 1 <= d <= n]
        if fora:
            sys.exit(f"❌ dias fora do mês {mes:02d}/{ano}: {fora}")
        saida_meses.append({
            "id": f"{ano}-{mes:02d}", "ano": ano, "mes": mes, "feriados": feriados(ano, mes),
            "dias": {str(d): {s: ordenar(dias.get(d, {}).get(s, [])) for s in "MTN"}
                     for d in range(1, n + 1)}})
        a_dias = amb.get((ano, mes), {})
        fora = [d for d in a_dias if not 1 <= d <= n]
        if fora:
            sys.exit(f"❌ ambulatório com dias fora do mês {mes:02d}/{ano}: {fora}")
        saida_amb.append({
            "id": f"{ano}-{mes:02d}", "ano": ano, "mes": mes, "feriados": feriados(ano, mes),
            "dias": {str(d): {s: ordenar_amb(a_dias.get(d, {}).get(s, [])) for s in AMB_PERIODOS}
                     for d in range(1, n + 1)}})
    usados = {nome for m in saida_meses for p in m["dias"].values()
              for l in p.values() for nome in l if nome and nome != RESERVADO}
    usados |= {nome for m in saida_amb for p in m["dias"].values()
               for l in p.values() for _, nome in l if nome and nome not in (RESERVADO, RESIDENTES)}
    return {"pessoas": {n: {"c": curtos[n], "v": vinculos[n]} for n in sorted(usados)},
            "meses": saida_meses, "amb": {"meses": saida_amb}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", help="pasta com escala_AAAA_MM.json (modo de teste)")
    ap.add_argument("--saida", type=Path, default=SAIDA)
    args = ap.parse_args()

    if args.local:
        meses, amb, vinculos = ler_local(args.local)
    else:
        token = os.environ.get("NOTION_TOKEN")
        if not token:
            sys.exit("❌ defina NOTION_TOKEN (ou use --local)")
        meses, amb, vinculos = ler_notion(token)
    if not meses:
        sys.exit("❌ nenhum plantão do CO encontrado: não vou publicar um site vazio")

    novo = montar(meses, amb, vinculos)
    agora = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    novo["alterado_em"] = agora
    if args.saida.exists():
        antigo = json.loads(args.saida.read_text(encoding="utf-8"))
        if {k: v for k, v in antigo.items() if k != "alterado_em"} == \
           {k: v for k, v in novo.items() if k != "alterado_em"}:
            print("sem mudanças na escala")
            return
    args.saida.parent.mkdir(parents=True, exist_ok=True)
    args.saida.write_text(json.dumps(novo, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    pos = sum(len(l) for m in novo["meses"] for p in m["dias"].values() for l in p.values())
    pos_amb = sum(len(l) for m in novo["amb"]["meses"] for p in m["dias"].values() for l in p.values())
    print(f"✅ {args.saida} — {len(novo['meses'])} meses, {pos} posições no CO, "
          f"{pos_amb} no ambulatório, {len(novo['pessoas'])} plantonistas")


if __name__ == "__main__":
    main()
