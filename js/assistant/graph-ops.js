/* ============================================================
   graph-ops.js — operações do assistente no grafo aberto
   ============================================================
   Tudo é validado antes (num modelo simulado) e aplicado de uma vez:
   se qualquer operação do lote falhar, nada muda e todos os erros voltam
   juntos. Nodes novos são posicionados automaticamente.
   ============================================================ */

import { app } from "./bridge.js";
import { optionList, visibleWhen, USER_ONLY_WIDGETS } from "./catalog.js";

const GAP_X = 70;
const GAP_Y = 40;
const DEFAULT_SIZE = { w: 260, h: 220 };
const PROMPT_REF = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;

/* params que aceitam valores fora da lista (ex.: tamanho livre dos modelos de imagem novos) */
function isFree(p, params) {
  if (typeof p.freeFn !== "function") return false;
  try { return Boolean(p.freeFn(params)); } catch { return false; }
}

function safeCheck(p, value, params) {
  try { return p.checkFn(value, params) || ""; } catch { return ""; }
}

// opções que dependem do servidor local ou do arquivo carregado: fora da lista vira só aviso
const SOFT_OPTION_FNS = new Set(["localVoiceOptions", "voiceTargetOptions", "jsonListOptions", "jsonFieldOptions",
  "claudeEffortOptions"]);

export function defaultParams(type) {
  const params = {};
  for (const p of app.NODE_DEFS[type].params) params[p.key] = p.default ?? "";
  return params;
}

/* ---------- params ---------- */

function coerceParam(type, p, value, ctx, errors, warnings) {
  const where = `${type}.${p.key}`;
  if (p.widget === "select") {
    const opts = optionList(p, ctx);
    const v = value == null ? "" : String(value).trim();
    if (opts.some(o => o.value === v)) return v;
    const byLabel = opts.find(o => String(o.label).toLowerCase() === v.toLowerCase());
    if (byLabel) return byLabel.value;
    // freeFn: o param aceita valores fora da lista, desde que no formato certo
    if (isFree(p, ctx)) {
      const problem = typeof p.checkFn === "function" ? safeCheck(p, v, ctx) : "";
      if (!problem) return v;
      errors.push(`${where} = “${v}”: ${problem}`);
      return undefined;
    }
    if (SOFT_OPTION_FNS.has(p.optionsFn?.name)) {
      warnings.push(`${where} = “${v}”: não está na lista atual (depende do servidor local ou do arquivo) — confira no node.`);
      return v;
    }
    const shown = opts.slice(0, 20).map(o => (o.value === "" ? '""' : o.value)).join(", ");
    errors.push(`${where} = “${v}” não é uma opção válida. Opções: ${shown || "nenhuma"}`);
    return undefined;
  }
  if (p.widget === "multicheck") {
    let list = value;
    if (typeof list === "string") {
      try { list = JSON.parse(list); } catch { list = list.split(",").map(s => s.trim()).filter(Boolean); }
    }
    if (!Array.isArray(list)) { errors.push(`${where} precisa ser uma lista.`); return undefined; }
    const opts = new Set(optionList(p, ctx).map(o => o.value));
    const unknown = list.filter(v => !opts.has(v));
    if (unknown.length) warnings.push(`${where}: ${unknown.join(", ")} não estão na lista atual — confira no node.`);
    return list.map(String);
  }
  if (p.widget === "number") {
    const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
    if (!Number.isFinite(n)) { errors.push(`${where} precisa ser um número (recebido “${value}”).`); return undefined; }
    if ((p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max)) {
      errors.push(`${where} = ${n} fora da faixa ${p.min ?? "−∞"}..${p.max ?? "∞"}.`);
      return undefined;
    }
    return n;
  }
  if (p.widget === "checkbox") {
    if (typeof value === "boolean") return value;
    const s = String(value).toLowerCase();
    if (["true", "1", "sim", "yes"].includes(s)) return true;
    if (["false", "0", "não", "nao", "no", ""].includes(s)) return false;
    errors.push(`${where} precisa ser true ou false.`);
    return undefined;
  }
  return value == null ? "" : String(value);
}

/* valida e converte params brutos contra NODE_DEFS; current = params atuais do node (edição) */
export function resolveParams(type, raw, current = null) {
  const def = app.NODE_DEFS[type];
  const errors = [];
  const warnings = [];
  const params = {};
  if (raw == null || raw === "") return { params, errors, warnings };
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch (err) {
      errors.push(`params de ${type} não é um JSON válido: ${err.message}`);
      return { params, errors, warnings };
    }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`params de ${type} precisa ser um objeto { "chave": valor }.`);
    return { params, errors, warnings };
  }
  const byKey = new Map(def.params.map(p => [p.key, p]));
  const ctx = { ...defaultParams(type), ...(current || {}), ...raw };
  for (const [key, value] of Object.entries(raw)) {
    const p = byKey.get(key);
    if (!p) {
      errors.push(`${type} não tem o param “${key}”. Params válidos: ${[...byKey.keys()].join(", ") || "nenhum"}.`);
      continue;
    }
    if (USER_ONLY_WIDGETS.has(p.widget)) {
      errors.push(`${type}.${key} é preenchido só pelo usuário (arquivo/pasta) — peça para ele carregar no node.`);
      continue;
    }
    const v = coerceParam(type, p, value, ctx, errors, warnings);
    if (v !== undefined) { params[key] = v; ctx[key] = v; }
  }
  for (const key of Object.keys(params)) {
    const p = byKey.get(key);
    if (typeof p.showIf === "function" && !safeShowIf(p, ctx)) {
      warnings.push(`${type}.${key} fica escondido enquanto “${visibleWhen(p)}” não for verdade.`);
    }
  }
  warnings.push(...unknownPromptRefs(params).map(n => `{{${n}}} não existe na Biblioteca (prompts/prompts de agentes) — ficará como texto.`));
  return { params, errors, warnings };
}

function safeShowIf(p, params) {
  try { return p.showIf(params); } catch { return true; }
}

function unknownPromptRefs(params) {
  const known = new Set([...app.getSavedPrompts(), ...app.getAgentPrompts()].map(p => p.name));
  const missing = new Set();
  for (const v of Object.values(params)) {
    if (typeof v !== "string") continue;
    for (const [, name] of v.matchAll(PROMPT_REF)) if (name !== "input" && !known.has(name)) missing.add(name);
  }
  return [...missing];
}

/* ---------- modelo simulado ---------- */

function modelFromState() {
  const s = app.state;
  return {
    nextId: s.nextId,
    nodes: new Map(s.nodes.map(n => [n.id, { id: n.id, type: n.type, params: { ...n.params } }])),
    edges: s.edges.map(e => ({ id: e.id, from: { ...e.from }, to: { ...e.to } })),
    groups: new Map(s.groups.map(g => [g.id, { ...g }])),
  };
}

function portsText(type, dir) {
  const ports = app.NODE_DEFS[type][dir === "in" ? "inputs" : "outputs"];
  return ports.length ? ports.map(p => `${p.key}:${p.dtype}`).join(", ") : "nenhuma";
}

/* "n3.text" / "ref.text" → { node, port } (resolve refs do lote) */
function parsePortRef(text, refMap) {
  const m = /^\s*([^.\s]+)\.([^.\s]+)\s*$/.exec(String(text || ""));
  if (!m) return null;
  return { node: refMap[m[1]] || m[1], port: m[2] };
}

function reaches(model, startId, targetId) {
  const seen = new Set();
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop();
    if (id === targetId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of model.edges) if (e.from.node === id) stack.push(e.to.node);
  }
  return false;
}

/* valida uma conexão no modelo: { ok, error?, replaces: [ids das arestas substituídas] } */
export function checkConnect(model, from, to) {
  const fromNode = model.nodes.get(from.node);
  const toNode = model.nodes.get(to.node);
  if (!fromNode) return { ok: false, error: `node de origem “${from.node}” não existe.` };
  if (!toNode) return { ok: false, error: `node de destino “${to.node}” não existe.` };
  if (from.node === to.node) return { ok: false, error: "um node não pode se conectar a ele mesmo." };
  const outDef = app.NODE_DEFS[fromNode.type].outputs.find(o => o.key === from.port);
  const inDef = app.NODE_DEFS[toNode.type].inputs.find(i => i.key === to.port);
  if (!outDef) return { ok: false, error: `${from.node} (${fromNode.type}) não tem a saída “${from.port}”. Saídas: ${portsText(fromNode.type, "out")}.` };
  if (!inDef) return { ok: false, error: `${to.node} (${toNode.type}) não tem a entrada “${to.port}”. Entradas: ${portsText(toNode.type, "in")}.` };
  if (!(inDef.dtype === "any" || outDef.dtype === "any" || outDef.dtype === inDef.dtype)) {
    return { ok: false, error: `tipos incompatíveis: ${from.node}.${from.port} é ${outDef.dtype}, ${to.node}.${to.port} espera ${inDef.dtype}.` };
  }
  if (reaches(model, to.node, from.node)) return { ok: false, error: `${from.node} → ${to.node} criaria um ciclo.` };
  const intoPort = (e) => e.to.node === to.node && e.to.port === to.port;
  const same = (e) => e.from.node === from.node && e.from.port === from.port;
  const replaces = model.edges.filter(e => intoPort(e) && (!inDef.multi || same(e))).map(e => e.id);
  return { ok: true, replaces, multi: Boolean(inDef.multi) };
}

const edgeText = (e) => `${e.from.node}.${e.from.port} → ${e.to.node}.${e.to.port}`;

/* ---------- aplicação atômica ---------- */

const OPS = new Set(["add_node", "update_params", "remove_node", "connect", "disconnect", "move_node", "add_group", "update_group", "remove_group"]);

/* valida o lote inteiro; devolve { errors, actions, refMap } sem tocar no app */
export function planOps(ops) {
  const model = modelFromState();
  const refMap = {};
  const errors = [];
  const warnings = [];
  const actions = [];
  const resolveNode = (v) => refMap[v] || v;
  ops.forEach((op, i) => {
    const tag = `op ${i + 1} (${op?.op})`;
    const fail = (msg) => errors.push(`${tag}: ${msg}`);
    if (!op || !OPS.has(op.op)) return fail(`operação desconhecida. Use: ${[...OPS].join(", ")}.`);
    switch (op.op) {
      case "add_node": {
        const def = app.NODE_DEFS[op.type];
        if (!def) return fail(`tipo “${op.type}” não existe. Tipos: ${Object.keys(app.NODE_DEFS).join(", ")}.`);
        if (op.ref && (refMap[op.ref] || model.nodes.has(op.ref))) return fail(`ref “${op.ref}” repetida ou igual a um id existente.`);
        const r = resolveParams(op.type, op.params, null);
        r.errors.forEach(fail);
        warnings.push(...r.warnings.map(w => `${tag}: ${w}`));
        const id = "n" + model.nextId++;
        if (op.ref) refMap[op.ref] = id;
        model.nodes.set(id, { id, type: op.type, params: { ...defaultParams(op.type), ...r.params } });
        const hasPos = Number.isFinite(op.x) && Number.isFinite(op.y);
        actions.push({ kind: "add_node", id, type: op.type, params: r.params, x: hasPos ? op.x : null, y: hasPos ? op.y : null });
        break;
      }
      case "update_params": {
        const id = resolveNode(op.node);
        const node = model.nodes.get(id);
        if (!node) return fail(`node “${op.node}” não existe.`);
        const r = resolveParams(node.type, op.params, node.params);
        r.errors.forEach(fail);
        warnings.push(...r.warnings.map(w => `${tag}: ${w}`));
        Object.assign(node.params, r.params);
        actions.push({ kind: "update_params", id, params: r.params });
        break;
      }
      case "remove_node": {
        const id = resolveNode(op.node);
        if (!model.nodes.has(id)) return fail(`node “${op.node}” não existe.`);
        model.nodes.delete(id);
        model.edges = model.edges.filter(e => e.from.node !== id && e.to.node !== id);
        actions.push({ kind: "remove_node", id });
        break;
      }
      case "connect": {
        const from = parsePortRef(op.from, refMap);
        const to = parsePortRef(op.to, refMap);
        if (!from || !to) return fail(`use from/to no formato "node.porta" (ex.: "n3.text" → "n4.prompt").`);
        const c = checkConnect(model, from, to);
        if (!c.ok) return fail(c.error);
        const replaced = model.edges.filter(e => c.replaces.includes(e.id));
        model.edges = model.edges.filter(e => !c.replaces.includes(e.id));
        model.edges.push({ id: "e" + model.nextId++, from, to });
        actions.push({ kind: "connect", from, to, replaced: replaced.filter(e => e.from.node !== from.node || e.from.port !== from.port) });
        break;
      }
      case "disconnect": {
        const from = op.from ? parsePortRef(op.from, refMap) : null;
        const to = op.to ? parsePortRef(op.to, refMap) : null;
        if (!from && !to) return fail(`informe from e/ou to no formato "node.porta".`);
        const match = (e) => (!from || (e.from.node === from.node && e.from.port === from.port)) &&
          (!to || (e.to.node === to.node && e.to.port === to.port));
        const found = model.edges.filter(match);
        if (!found.length) return fail(`nenhuma conexão ${op.from || "*"} → ${op.to || "*"}.`);
        model.edges = model.edges.filter(e => !match(e));
        actions.push({ kind: "disconnect", edges: found });
        break;
      }
      case "move_node": {
        const id = resolveNode(op.node);
        if (!model.nodes.has(id)) return fail(`node “${op.node}” não existe.`);
        if (!Number.isFinite(op.x) || !Number.isFinite(op.y)) return fail("move_node precisa de x e y numéricos.");
        actions.push({ kind: "move_node", id, x: op.x, y: op.y });
        break;
      }
      case "add_group": {
        const nodes = (op.nodes || []).map(resolveNode);
        const missing = nodes.filter(id => !model.nodes.has(id));
        if (missing.length) return fail(`nodes inexistentes: ${missing.join(", ")}.`);
        if (!nodes.length && !(Number.isFinite(op.x) && Number.isFinite(op.y))) return fail("add_group precisa de nodes (para envolver) ou de x/y.");
        if (op.color && !/^#[0-9a-f]{6}$/i.test(op.color)) return fail("color precisa ser #rrggbb.");
        const id = "g" + model.nextId++;
        if (op.ref) refMap[op.ref] = id;
        model.groups.set(id, { id });
        actions.push({ kind: "add_group", id, nodes, title: op.title, desc: op.desc, color: op.color, x: op.x, y: op.y, w: op.w, h: op.h });
        break;
      }
      case "update_group": {
        const id = resolveNode(op.group || op.node);
        if (!model.groups.has(id)) return fail(`grupo “${op.group || op.node}” não existe.`);
        if (op.color && !/^#[0-9a-f]{6}$/i.test(op.color)) return fail("color precisa ser #rrggbb.");
        const nodes = op.nodes ? op.nodes.map(resolveNode) : null;
        if (nodes?.some(n => !model.nodes.has(n))) return fail("nodes inexistentes no grupo.");
        actions.push({ kind: "update_group", id, title: op.title, desc: op.desc, color: op.color, nodes });
        break;
      }
      case "remove_group": {
        const id = resolveNode(op.group || op.node);
        if (!model.groups.has(id)) return fail(`grupo “${op.group || op.node}” não existe.`);
        model.groups.delete(id);
        actions.push({ kind: "remove_group", id });
        break;
      }
    }
  });
  return { errors, warnings, actions, refMap };
}

function nodeEl(id) { return document.getElementById("node-" + id); }

function nodeSize(id) {
  const el = nodeEl(id);
  return el ? { w: el.offsetWidth || DEFAULT_SIZE.w, h: el.offsetHeight || DEFAULT_SIZE.h } : { ...DEFAULT_SIZE };
}

function setNodePos(node, x, y) {
  node.x = Math.round(x);
  node.y = Math.round(y);
  const el = nodeEl(node.id);
  if (el) { el.style.left = node.x + "px"; el.style.top = node.y + "px"; }
}

function groupBoxFor(ids) {
  const nodes = ids.map(id => app.state.nodes.find(n => n.id === id)).filter(Boolean);
  const boxes = nodes.map(n => ({ ...nodeSize(n.id), x: n.x, y: n.y }));
  const x = Math.min(...boxes.map(b => b.x)) - 24;
  const y = Math.min(...boxes.map(b => b.y)) - 72;
  const w = Math.max(...boxes.map(b => b.x + b.w)) + 24 - x;
  const h = Math.max(...boxes.map(b => b.y + b.h)) + 28 - y;
  return { x, y, w, h };
}

/* aplica um lote validado; signal interrompe entre operações (o desfazer cobre o que já foi feito) */
export function applyOps(ops, { signal } = {}) {
  const plan = planOps(ops);
  if (plan.errors.length) return { ok: false, errors: plan.errors, warnings: plan.warnings };
  const s = app.state;
  const changes = [];
  const newNodes = [];
  const unplaced = [];
  const groupActions = [];
  for (const a of plan.actions) {
    if (signal?.aborted) { changes.push("(interrompido pelo usuário)"); break; }
    switch (a.kind) {
      case "add_node": {
        const node = app.addNode(a.type, a.x ?? 0, a.y ?? 0, a.params, a.id);
        s.nextId = Math.max(s.nextId, Number(a.id.slice(1)) + 1);
        newNodes.push(node.id);
        if (a.x == null) unplaced.push(node.id);
        changes.push(`+ ${a.id} ${a.type}`);
        break;
      }
      case "update_params": {
        const node = s.nodes.find(n => n.id === a.id);
        Object.assign(node.params, a.params);
        app.renderNode(node);
        changes.push(`~ ${a.id} ${Object.keys(a.params).join(", ")}`);
        break;
      }
      case "remove_node":
        app.removeNode(a.id);
        changes.push(`− ${a.id}`);
        break;
      case "connect": {
        const res = app.connectPorts(a.from, a.to);
        changes.push(`+ ${edgeText({ from: a.from, to: a.to })}` +
          (res.replaced?.length ? ` (substituiu ${res.replaced.map(edgeText).join(", ")})` : ""));
        break;
      }
      case "disconnect":
        for (const e of a.edges) {
          const real = s.edges.find(x => x.from.node === e.from.node && x.from.port === e.from.port &&
            x.to.node === e.to.node && x.to.port === e.to.port);
          if (real) app.removeEdge(real.id);
          changes.push(`− ${edgeText(e)}`);
        }
        break;
      case "move_node": {
        const node = s.nodes.find(n => n.id === a.id);
        setNodePos(node, a.x, a.y);
        changes.push(`↔ ${a.id}`);
        break;
      }
      default:
        groupActions.push(a); // grupos depois do posicionamento: a caixa envolve os nodes já no lugar
    }
  }
  if (unplaced.length) placeNodes(unplaced);
  for (const a of groupActions) {
    if (signal?.aborted) break;
    if (a.kind === "add_group") {
      const box = a.nodes.length ? groupBoxFor(a.nodes) : { x: a.x, y: a.y, w: a.w || 560, h: a.h || 340 };
      app.addGroup(box.x, box.y, a.w || box.w, a.h || box.h, { id: a.id, title: a.title, desc: a.desc, color: a.color });
      s.nextId = Math.max(s.nextId, Number(a.id.slice(1)) + 1);
      changes.push(`+ ${a.id} grupo “${a.title || "Grupo"}”`);
    } else if (a.kind === "update_group") {
      const g = s.groups.find(x => x.id === a.id);
      if (a.title !== undefined) g.title = a.title;
      if (a.desc !== undefined) g.desc = a.desc;
      if (a.color) g.color = a.color;
      if (a.nodes?.length) Object.assign(g, groupBoxFor(a.nodes));
      app.renderGroup(g);
      changes.push(`~ ${a.id} grupo`);
    } else if (a.kind === "remove_group") {
      app.removeGroup(a.id);
      changes.push(`− ${a.id} grupo`);
    }
  }
  app.drawEdges();
  app.autosave();
  if (newNodes.length) focusNodes(newNodes);
  return { ok: true, refMap: plan.refMap, changes, warnings: plan.warnings, problems: validateGraph() };
}

/* ---------- layout ---------- */

const overlaps = (a, b, pad = 20) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

function boxOf(node) { return { x: node.x, y: node.y, ...nodeSize(node.id) }; }

/* ordena ids para que origens venham antes (arestas entre os próprios ids) */
function orderBySources(ids) {
  const set = new Set(ids);
  const incoming = new Map(ids.map(id => [id, app.state.edges.filter(e => e.to.node === id && set.has(e.from.node)).map(e => e.from.node)]));
  const out = [];
  const visit = (id, stack = new Set()) => {
    if (out.includes(id) || stack.has(id)) return;
    stack.add(id);
    for (const src of incoming.get(id) || []) visit(src, stack);
    out.push(id);
  };
  ids.forEach(id => visit(id));
  return out;
}

/* posiciona nodes novos perto dos vizinhos, sem sobrepor os que já estão no canvas */
export function placeNodes(ids) {
  const s = app.state;
  const pending = new Set(ids);
  const placed = s.nodes.filter(n => !pending.has(n.id));
  for (const id of orderBySources(ids)) {
    const node = s.nodes.find(n => n.id === id);
    if (!node) continue;
    const size = nodeSize(id);
    const placedIds = new Set(placed.map(n => n.id));
    const sources = s.edges.filter(e => e.to.node === id && placedIds.has(e.from.node)).map(e => s.nodes.find(n => n.id === e.from.node));
    const targets = s.edges.filter(e => e.from.node === id && placedIds.has(e.to.node)).map(e => s.nodes.find(n => n.id === e.to.node));
    let x, y;
    if (sources.length) {
      x = Math.max(...sources.map(n => n.x + nodeSize(n.id).w)) + GAP_X;
      y = Math.min(...sources.map(n => n.y));
    } else if (targets.length) {
      x = Math.min(...targets.map(n => n.x)) - size.w - GAP_X;
      y = Math.min(...targets.map(n => n.y));
    } else {
      x = placed.length ? Math.min(...placed.map(n => n.x)) : 40;
      y = placed.length ? Math.max(...placed.map(n => n.y + nodeSize(n.id).h)) + GAP_Y : 40;
    }
    const box = { x, y, ...size };
    for (let guard = 0; guard < 200 && placed.some(n => overlaps(box, boxOf(n))); guard++) box.y += GAP_Y;
    setNodePos(node, box.x, box.y);
    placed.push(node);
  }
  app.drawEdges();
}

/* organiza em colunas por profundidade (origens à esquerda), ordenando cada coluna pela
   posição média das origens. Grupos não são movidos. */
export function layeredLayout(ids) {
  const s = app.state;
  const set = new Set(ids);
  const nodes = s.nodes.filter(n => set.has(n.id));
  if (!nodes.length) return;
  const order = orderBySources(ids);
  const depth = new Map();
  for (const id of order) {
    const srcs = s.edges.filter(e => e.to.node === id && set.has(e.from.node)).map(e => depth.get(e.from.node) ?? 0);
    depth.set(id, srcs.length ? Math.max(...srcs) + 1 : 0);
  }
  const columns = [];
  for (const id of order) (columns[depth.get(id)] ||= []).push(id);
  const startX = Math.min(...nodes.map(n => n.x));
  const startY = Math.min(...nodes.map(n => n.y));
  const rank = new Map();
  let x = startX;
  columns.forEach((col, ci) => {
    if (ci > 0) {
      const bary = (id) => {
        const srcs = s.edges.filter(e => e.to.node === id && rank.has(e.from.node)).map(e => rank.get(e.from.node));
        return srcs.length ? srcs.reduce((a, b) => a + b, 0) / srcs.length : Infinity;
      };
      col.sort((a, b) => bary(a) - bary(b));
    } else {
      col.sort((a, b) => s.nodes.find(n => n.id === a).y - s.nodes.find(n => n.id === b).y);
    }
    let y = startY;
    let width = 0;
    col.forEach((id, i) => {
      const node = s.nodes.find(n => n.id === id);
      const size = nodeSize(id);
      setNodePos(node, x, y);
      rank.set(id, i);
      y += size.h + GAP_Y;
      width = Math.max(width, size.w);
    });
    x += width + GAP_X;
  });
  app.drawEdges();
  app.autosave();
}

/* centraliza a vista nos nodes se algum estiver fora da tela */
export function focusNodes(ids) {
  const s = app.state;
  const nodes = s.nodes.filter(n => ids.includes(n.id));
  if (!nodes.length) return;
  const canvas = document.getElementById("canvas");
  const rect = canvas.getBoundingClientRect();
  const boxes = nodes.map(boxOf);
  const minX = Math.min(...boxes.map(b => b.x));
  const minY = Math.min(...boxes.map(b => b.y));
  const maxX = Math.max(...boxes.map(b => b.x + b.w));
  const maxY = Math.max(...boxes.map(b => b.y + b.h));
  const toScreen = (x, y) => ({ x: x * s.zoom + s.pan.x, y: y * s.zoom + s.pan.y });
  const a = toScreen(minX, minY);
  const b = toScreen(maxX, maxY);
  const margin = 60;
  if (a.x >= margin && a.y >= margin && b.x <= rect.width - margin && b.y <= rect.height - margin) return;
  const fit = Math.min(1, (rect.width - margin * 2) / (maxX - minX || 1), (rect.height - margin * 2) / (maxY - minY || 1));
  s.zoom = Math.max(0.35, Math.min(s.zoom, fit));
  s.pan = {
    x: rect.width / 2 - ((minX + maxX) / 2) * s.zoom,
    y: rect.height / 2 - ((minY + maxY) / 2) * s.zoom,
  };
  app.applyTransform();
  app.drawEdges();
}

/* ---------- leitura ---------- */

function isDataUrl(v) { return typeof v === "string" && v.startsWith("data:"); }

function shortValue(v, max) {
  if (isDataUrl(v)) return "(arquivo carregado)";
  if (Array.isArray(v)) return JSON.stringify(v);
  if (v && typeof v === "object") return "(arquivo carregado)";
  if (typeof v !== "string") return JSON.stringify(v);
  return v.length > max ? JSON.stringify(v.slice(0, max)) + `(+${v.length - max})` : JSON.stringify(v);
}

/* valor de param para leitura completa (get_node) */
export function paramText(v, max = 4000) {
  return shortValue(v, max);
}

/* params diferentes do padrão, como texto "chave=valor" */
export function changedParams(type, params, max = 300) {
  const def = app.NODE_DEFS[type];
  if (!def) return "";
  return def.params
    .filter(p => JSON.stringify(params?.[p.key] ?? p.default ?? "") !== JSON.stringify(p.default ?? ""))
    .map(p => `${p.key}=${USER_ONLY_WIDGETS.has(p.widget) ? "(arquivo carregado)" : shortValue(params[p.key], max)}`)
    .join(" ");
}

/* grafo serializado → texto para o modelo. live=true inclui status/erros do grafo aberto */
export function describeGraph(graph, { detail = "resumo", live = false } = {}) {
  const max = detail === "completo" ? 4000 : 300;
  const lines = [];
  const nodes = graph.nodes || [];
  lines.push(`Nodes (${nodes.length}):`);
  for (const n of nodes) {
    const def = app.NODE_DEFS[n.type];
    let line = `- ${n.id} ${n.type} “${def?.title || "?"}”`;
    const changed = changedParams(n.type, n.params, max);
    if (changed) line += ` ${changed}`;
    if (live) {
      const real = app.state.nodes.find(x => x.id === n.id);
      if (real?.status === "error") line += ` [ERRO: ${String(real.error || "").slice(0, 160)}]`;
      else if (real?.status === "done") line += " [com resultado]";
      else if (real?.status === "running") line += " [executando]";
    }
    lines.push(line);
  }
  const edges = graph.edges || [];
  lines.push(`Conexões (${edges.length}):`, ...edges.map(e => `- ${edgeText(e)}`));
  const groups = graph.groups || [];
  if (groups.length) {
    lines.push(`Grupos (${groups.length}):`);
    for (const g of groups) {
      const inside = nodes.filter(n => n.x >= g.x && n.y >= g.y && n.x < g.x + g.w && n.y < g.y + g.h).map(n => n.id);
      lines.push(`- ${g.id} “${g.title}”${g.desc ? ` (${g.desc})` : ""} [${inside.join(", ")}]`);
    }
  }
  return lines.join("\n");
}

/* problemas do grafo aberto (ciclo, entrada sem conexão, select apontando para item apagado…) */
export function validateGraph() {
  const s = app.state;
  const problems = [];
  try { app.topologicalOrder(); } catch { problems.push("o grafo tem um ciclo — remova uma das conexões do laço."); }
  for (const n of s.nodes) {
    const def = app.NODE_DEFS[n.type];
    for (const input of def.inputs) {
      const connected = s.edges.some(e => e.to.node === n.id && e.to.port === input.key);
      if (!connected && !/opcional/i.test(input.label || "")) {
        problems.push(`${n.id} (${def.title}): entrada “${input.key}” sem conexão (se for opcional para este uso, ignore).`);
      }
    }
    for (const p of def.params) {
      if (p.widget !== "select" || !p.optionsFn || SOFT_OPTION_FNS.has(p.optionsFn.name)) continue;
      if (isFree(p, n.params)) continue;
      if (typeof p.showIf === "function" && !safeShowIf(p, n.params)) continue;
      const v = n.params[p.key];
      if (v && !optionList(p, n.params).some(o => o.value === v)) problems.push(`${n.id}.${p.key} = “${v}” não existe mais (item apagado?).`);
    }
  }
  if (s.nodes.length > 1) {
    for (const n of s.nodes) {
      if (!s.edges.some(e => e.from.node === n.id || e.to.node === n.id)) problems.push(`${n.id} (${NODE_TITLE(n)}) está isolado.`);
    }
  }
  return problems.slice(0, 25);
}

const NODE_TITLE = (n) => app.NODE_DEFS[n.type]?.title || n.type;
