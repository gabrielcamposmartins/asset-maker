/* ============================================================
   app.js — editor de nodes, motor de execução e UI
   ============================================================ */

/* ---------- estado ---------- */

const state = {
  nodes: [],          // {id, type, x, y, params, result, status, error, progress}
  edges: [],          // {id, from:{node,port}, to:{node,port}}
  nextId: 1,
  pan: { x: 0, y: 0 },
  zoom: 1,
  selectedNode: null,
  groups: [],         // {id, x, y, w, h, color, title, desc} — containers visuais, não executam nada
  selectedGroup: null,
  selection: { nodes: [], groups: [] },  // seleção por área (botão direito ou Ctrl/Shift + arrastar)
  running: false,
  stopRequested: false,
};

const canvas = document.getElementById("canvas");
const world = document.getElementById("world");
const edgesSvg = document.getElementById("edges");
const statusText = document.getElementById("status-text");

const DTYPE_COLORS = {
  text: getCss("--type-text"),
  image: getCss("--type-image"),
  model3d: getCss("--type-model3d"),
  audio: getCss("--type-audio"),
  voice: getCss("--type-voice"),
  any: "#b48ce8",
};

function getCss(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function setStatus(html) { statusText.innerHTML = html; }

function uid() { return "n" + state.nextId++; }

/* ---------- transformação de coordenadas ---------- */

function applyTransform() {
  world.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  canvas.style.backgroundPosition = `${state.pan.x}px ${state.pan.y}px`;
  canvas.style.backgroundSize = `${26 * state.zoom}px ${26 * state.zoom}px`;
  document.getElementById("zoom-indicator").textContent = Math.round(state.zoom * 100) + "%";
  drawEdges();
}

function screenToWorld(sx, sy) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (sx - rect.left - state.pan.x) / state.zoom,
    y: (sy - rect.top - state.pan.y) / state.zoom,
  };
}

/* o canvas ocupa a tela inteira atrás dos painéis de vidro: a vista inicial começa
   deslocada para os nodes não nascerem embaixo da paleta e da topbar */
function defaultPan() {
  const sidebar = document.getElementById("sidebar");
  return { x: (sidebar?.offsetWidth || 250) + 44, y: 86 };
}

/* ---------- paleta ---------- */

function buildPalette() {
  const palette = document.getElementById("palette");
  palette.innerHTML = "";

  // organização: grupo/container (não é um node — só agrupa visualmente)
  const orgCat = document.createElement("div");
  orgCat.className = "palette-category";
  orgCat.textContent = "Organização";
  palette.appendChild(orgCat);
  const groupItem = document.createElement("div");
  groupItem.className = "palette-item";
  groupItem.draggable = true;
  groupItem.dataset.search = "grupo container organização área título descrição";
  groupItem.innerHTML = `<span class="p-icon">▢</span>
    <span><div class="p-label">Grupo</div><div class="p-desc">Área colorida com título e descrição</div></span>`;
  groupItem.title = "Clique para criar (envolve o node selecionado, se houver) ou arraste para o canvas";
  groupItem.addEventListener("click", addGroupFromPalette);
  groupItem.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("application/x-node-type", "__group");
    e.dataTransfer.effectAllowed = "copy";
  });
  palette.appendChild(groupItem);

  for (const cat of NODE_CATEGORIES) {
    const catEl = document.createElement("div");
    catEl.className = "palette-category";
    catEl.textContent = cat;
    palette.appendChild(catEl);
    for (const [type, def] of Object.entries(NODE_DEFS)) {
      if (def.category !== cat) continue;
      const item = document.createElement("div");
      item.className = "palette-item";
      item.draggable = true;
      item.dataset.search = `${def.title} ${def.desc} ${cat}`.toLowerCase();
      item.innerHTML = `<span class="p-icon">${def.icon}</span>
        <span><div class="p-label">${def.title}${def.local ? `<span class="p-local" title="Roda no servidor local (sua GPU)">LOCAL</span>` : ""}</div><div class="p-desc">${def.desc}</div></span>`;
      item.addEventListener("click", () => {
        const rect = canvas.getBoundingClientRect();
        const pos = screenToWorld(rect.left + rect.width / 2 - 125, rect.top + rect.height / 3);
        addNode(type, pos.x + (state.nodes.length % 5) * 24, pos.y + (state.nodes.length % 5) * 24);
      });
      item.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("application/x-node-type", type);
        e.dataTransfer.effectAllowed = "copy";
      });
      palette.appendChild(item);
    }
  }
}

/* busca da paleta: esconde itens que não casam e categorias que ficaram vazias */
function filterPalette(query) {
  const q = query.trim().toLowerCase();
  let category = null;
  let categoryHasItems = false;
  const closeCategory = () => { if (category) category.hidden = !categoryHasItems; };
  for (const el of document.getElementById("palette").children) {
    if (el.classList.contains("palette-category")) {
      closeCategory();
      category = el;
      categoryHasItems = false;
      continue;
    }
    el.hidden = Boolean(q) && !el.dataset.search.includes(q);
    if (!el.hidden) categoryHasItems = true;
  }
  closeCategory();
}

document.getElementById("palette-search").addEventListener("input", (e) => filterPalette(e.target.value));

canvas.addEventListener("dragover", (e) => {
  if (e.dataTransfer.types.includes("application/x-node-type")) e.preventDefault();
});
canvas.addEventListener("drop", (e) => {
  const type = e.dataTransfer.getData("application/x-node-type");
  if (!type) return;
  e.preventDefault();
  const pos = screenToWorld(e.clientX, e.clientY);
  if (type === "__group") selectGroup(addGroup(pos.x - 40, pos.y - 24).id);
  else addNode(type, pos.x - 125, pos.y - 20);
});

/* ---------- nodes ---------- */

function addNode(type, x, y, params = null, id = null) {
  const def = NODE_DEFS[type];
  if (!def) return null;
  const node = {
    id: id || uid(),
    type,
    x: Math.round(x),
    y: Math.round(y),
    params: {},
    result: null,
    status: "idle",
    error: null,
    progress: null,
  };
  for (const p of def.params) node.params[p.key] = params?.[p.key] ?? p.default ?? "";
  if (params) Object.assign(node.params, params);
  state.nodes.push(node);
  renderNode(node);
  drawEdges();
  autosave();
  return node;
}

function removeNode(nodeId) {
  state.edges = state.edges.filter(e => e.from.node !== nodeId && e.to.node !== nodeId);
  state.nodes = state.nodes.filter(n => n.id !== nodeId);
  document.getElementById("node-" + nodeId)?.remove();
  if (state.selectedNode === nodeId) state.selectedNode = null;
  drawEdges();
  autosave();
}

function selectNode(nodeId) {
  state.selectedNode = nodeId;
  state.selectedGroup = null;
  state.selection = { nodes: [], groups: [] };
  document.querySelectorAll(".node.selected, .group.selected").forEach(el => el.classList.remove("selected"));
  if (nodeId) document.getElementById("node-" + nodeId)?.classList.add("selected");
}

function renderNode(node) {
  const def = NODE_DEFS[node.type];
  let el = document.getElementById("node-" + node.id);
  if (!el) {
    el = document.createElement("div");
    el.id = "node-" + node.id;
    el.className = "node";
    el.addEventListener("mousedown", (e) => { if (e.button === 0) selectNode(node.id); });
    world.appendChild(el);
  }
  el.style.left = node.x + "px";
  el.style.top = node.y + "px";
  // tamanho escolhido na alça; só com altura fixa o corpo do node vira área rolável
  el.style.width = node.w ? node.w + "px" : "";
  el.style.height = node.h ? node.h + "px" : "";
  el.className = "node status-" + node.status + (isNodeSelected(node.id) ? " selected" : "")
    + (node.h ? " sized" : "");

  el.innerHTML = "";

  /* header */
  const header = document.createElement("div");
  header.className = "node-header";
  header.innerHTML = `<span class="node-status"></span><span class="n-icon">${def.icon}</span><span class="n-title">${def.title}</span>` +
    (def.local ? `<span class="n-local" title="Roda no servidor local (sua GPU)">🖥</span>` : "");
  const runBtn = document.createElement("button");
  runBtn.className = "node-run";
  runBtn.title = "Executar este node (e dependências)";
  runBtn.textContent = "▶";
  runBtn.addEventListener("click", (e) => { e.stopPropagation(); runSingleNode(node.id); });
  const closeBtn = document.createElement("button");
  closeBtn.className = "node-close";
  closeBtn.title = "Remover node";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (await confirmRemoveTargets({ nodes: [node.id], groups: [] })) removeNode(node.id);
  });
  header.appendChild(runBtn);
  header.appendChild(closeBtn);
  el.appendChild(header);
  makeNodeDraggable(node, header);

  /* portas: fora do corpo rolável, senão as arestas apontariam para portas fora da vista */
  const ports = document.createElement("div");
  ports.className = "node-ports";
  const maxRows = Math.max(def.inputs.length, def.outputs.length);
  for (let i = 0; i < maxRows; i++) {
    const inp = def.inputs[i];
    const out = def.outputs[i];
    if (inp) {
      const row = document.createElement("div");
      row.className = "port-row in";
      row.innerHTML = `<span>${inp.label}</span>`;
      row.appendChild(makePort(node, inp, "in"));
      ports.appendChild(row);
    }
    if (out) {
      const row = document.createElement("div");
      row.className = "port-row out";
      row.innerHTML = `<span>${out.label}</span>`;
      row.appendChild(makePort(node, out, "out"));
      ports.appendChild(row);
    }
  }
  el.appendChild(ports);

  /* body */
  const body = document.createElement("div");
  body.className = "node-body";

  /* params */
  if (def.params.length) {
    const paramsEl = document.createElement("div");
    paramsEl.className = "node-params";
    for (const p of def.params) {
      if (p.showIf && !p.showIf(node.params)) continue;
      paramsEl.appendChild(makeParamWidget(node, p));
    }
    body.appendChild(paramsEl);
  }

  /* progresso / erro / prévia */
  if (node.progress && node.status === "running") {
    const prog = document.createElement("div");
    prog.className = "node-progress";
    prog.textContent = "⏳ " + node.progress;
    body.appendChild(prog);
  }
  if (node.status === "queued") {
    const fila = document.createElement("div");
    fila.className = "node-progress node-queued";
    fila.textContent = `⏸ Na fila — esperando vaga (${runLane(node) === "local" ? "servidor local: 1 por vez" : "limite de execuções simultâneas"})`;
    body.appendChild(fila);
  }
  if (node.error) {
    const err = document.createElement("div");
    err.className = "node-error";
    err.textContent = node.error;
    body.appendChild(err);
  }
  if (node.warning) {
    const warn = document.createElement("div");
    warn.className = "node-warning";
    warn.textContent = node.warning;
    body.appendChild(warn);
  }
  const preview = document.createElement("div");
  preview.className = "node-preview";
  renderPreview(node, preview);
  body.appendChild(preview);

  body.appendChild(makeDebugSection(node, def));

  el.appendChild(body);
  el.appendChild(makeNodeResizer(node, el));
}

/* Alça no canto inferior direito. A largura vale sempre; a altura transforma o corpo do node
   numa área rolável (a prévia de áudio passa a usar o espaço todo). Duplo clique volta ao automático. */
function makeNodeResizer(node, el) {
  const grip = document.createElement("div");
  grip.className = "node-resize";
  grip.title = "Arraste para redimensionar · duplo clique volta ao tamanho automático";
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const zoom = state.zoom || 1;
    const start = { x: e.clientX, y: e.clientY, w: r.width / zoom, h: r.height / zoom };
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => {
      node.w = Math.max(200, Math.round(start.w + (ev.clientX - start.x) / zoom));
      node.h = Math.max(120, Math.round(start.h + (ev.clientY - start.y) / zoom));
      el.style.width = node.w + "px";
      el.style.height = node.h + "px";
      el.classList.add("sized");
      drawEdges();
    };
    const up = () => {
      grip.releasePointerCapture(e.pointerId);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      renderNode(node);
      drawEdges();
      autosave();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
  grip.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    delete node.w;
    delete node.h;
    renderNode(node);
    drawEdges();
    autosave();
  });
  return grip;
}

/* ---------- seção de debug do node ---------- */

function debugBlock(label, text) {
  const section = document.createElement("div");
  section.className = "debug-section";
  const lbl = document.createElement("div");
  lbl.className = "debug-label";
  lbl.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = text;
  section.appendChild(lbl);
  section.appendChild(pre);
  return section;
}

function summarizeValue(val) {
  if (!val) return "—";
  const items = Array.isArray(val.values) ? val.values : [val.value];
  const one = (v) => {
    if (val.type === "image") {
      const kb = typeof v === "string" ? Math.round((v.length * 0.75) / 1024) : 0;
      return typeof v === "string" && v.startsWith("data:") ? `imagem (~${kb} KB)` : `imagem (${String(v).slice(0, 60)}…)`;
    }
    if (val.type === "audio") {
      const kb = typeof v === "string" ? Math.round((v.length * 0.75) / 1024) : 0;
      return `áudio (~${kb} KB)`;
    }
    if (val.type === "model3d") return String(v).slice(0, 90);
    const s = String(v);
    return `"${s.slice(0, 90)}${s.length > 90 ? "…" : ""}"`;
  };
  if (items.length === 1) return `${val.type} → ${one(items[0])}`;
  return `${val.type} × ${items.length} itens:\n` +
    items.slice(0, 5).map((v, i) => `    ${i + 1}. ${one(v)}`).join("\n") +
    (items.length > 5 ? `\n    … +${items.length - 5}` : "");
}

function makeDebugSection(node, def) {
  const wrap = document.createElement("div");
  wrap.className = "node-debug" + (node.debugOpen ? " open" : "");
  const toggle = document.createElement("button");
  toggle.className = "debug-toggle";
  toggle.innerHTML = `<span>🐞 Debug</span><span>${node.debugOpen ? "▴" : "▾"}</span>`;
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    node.debugOpen = !node.debugOpen;
    renderNode(node);
    drawEdges();
  });
  stopNodeDragOn(toggle);
  wrap.appendChild(toggle);
  if (!node.debugOpen) return wrap;

  const body = document.createElement("div");
  body.className = "debug-body";
  body.appendChild(debugBlock("O que este node faz", def.help || def.desc));
  if (def.endpoint) body.appendChild(debugBlock("Endpoint", def.endpoint));
  body.appendChild(debugBlock("Portas", [
    def.inputs.length ? "Entradas: " + def.inputs.map(i => `${i.label} (${i.dtype})`).join(", ") : "Entradas: nenhuma",
    def.outputs.length ? "Saídas: " + def.outputs.map(o => `${o.label} (${o.dtype})`).join(", ") : "Saídas: nenhuma",
  ].join("\n")));

  const d = node.debug;
  if (d) {
    const lines = [`Status: ${node.status}${d.duration != null ? ` — ${(d.duration / 1000).toFixed(1)}s` : ""}`];
    if (d.inputs) lines.push("Entradas recebidas:\n" + d.inputs);
    if (d.outputs) lines.push("Saídas produzidas:\n" + d.outputs);
    if (node.error) lines.push("Erro: " + node.error);
    if (node.warning) lines.push("Aviso: " + node.warning);
    body.appendChild(debugBlock("Última execução", lines.join("\n")));
    if (d.log?.length) body.appendChild(debugBlock("Log", d.log.join("\n")));
  } else {
    body.appendChild(debugBlock("Última execução", "Ainda não executado."));
  }
  wrap.appendChild(body);
  return wrap;
}

function makePort(node, portDef, direction) {
  const port = document.createElement("div");
  port.className = "port " + direction;
  port.dataset.node = node.id;
  port.dataset.port = portDef.key;
  port.dataset.dtype = portDef.dtype;
  port.dataset.direction = direction;
  port.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    startEdgeDrag(node.id, portDef.key, direction, portDef.dtype, e);
  });
  return port;
}

const CUSTOM_VALUE = "__custom__";  // opção “digitar outro valor” dos selects com freeFn

function makeParamWidget(node, p) {
  const wrap = document.createElement("div");
  wrap.className = "param" + (p.widget === "checkbox" ? " param-check" : "");
  const commit = (value) => {
    node.params[p.key] = value;
    autosave();
  };
  const labelText = typeof p.labelFn === "function" ? p.labelFn(node.params) : p.label;
  // params com showIf/labelFn/optionsFn dependem de outros: selects e checkboxes re-renderizam o node
  const dependentUi = NODE_DEFS[node.type].params.some(x => x.showIf || x.labelFn || x.optionsFn);
  const commitAndRefresh = (value) => {
    commit(value);
    if (dependentUi) { renderNode(node); drawEdges(); }
  };

  // hint/hintFn: linha de ajuda abaixo do campo, conforme os outros params
  const hint = typeof p.hintFn === "function" ? p.hintFn(node.params) : (p.hint || "");
  const widget = p.widget;

  if (widget === "textarea") {
    wrap.innerHTML = `<label>${labelText}</label>`;
    const ta = document.createElement("textarea");
    ta.value = node.params[p.key] ?? "";
    ta.title = "Clique para abrir ampliado (Esc volta)";
    ta.addEventListener("input", () => commit(ta.value));
    // ao receber o foco, o campo abre ampliado sobre o canvas — texto longo fica legível
    ta.addEventListener("focus", () => openExpandedField(node, p, ta, labelText));
    stopNodeDragOn(ta);
    wrap.appendChild(ta);
  } else if (widget === "select") {
    wrap.innerHTML = `<label>${labelText}</label>`;
    const sel = document.createElement("select");
    const opts = (typeof p.optionsFn === "function" ? p.optionsFn(node.params) : p.options)
      .map(o => (typeof o === "string" ? { value: o, label: o } : o));
    const current = node.params[p.key] ?? p.default;
    // freeFn: o param aceita valores fora da lista (ex.: tamanho de imagem em modelos novos)
    const free = typeof p.freeFn === "function" ? p.freeFn(node.params) : false;
    if (current !== undefined && !opts.some(o => o.value === current)) {
      opts.push({ value: current, label: free ? current : `${current} (indisponível)` });
    }
    if (free) opts.push({ value: CUSTOM_VALUE, label: "✏️ Outro tamanho…" });
    let optgroup = null;
    for (const opt of opts) {
      const o = document.createElement("option");
      o.value = opt.value; o.textContent = opt.label;
      if (opt.group) {
        // opções com group (ex.: pastas da Biblioteca) viram um <optgroup>
        if (optgroup?.label !== opt.group) {
          optgroup = document.createElement("optgroup");
          optgroup.label = opt.group;
          sel.appendChild(optgroup);
        }
        optgroup.appendChild(o);
      } else {
        optgroup = null;
        sel.appendChild(o);
      }
    }
    sel.value = current;
    sel.addEventListener("change", async () => {
      if (sel.value !== CUSTOM_VALUE) { commitAndRefresh(sel.value); return; }
      sel.value = current;
      const typed = await askText({
        title: `${p.label} personalizado`,
        note: p.customExample ? `Formato: ${p.customExample}.` : "",
        label: p.label,
        value: current === CUSTOM_VALUE ? "" : String(current || ""),
        ok: "Usar",
        validate: v => (typeof p.checkFn === "function" ? p.checkFn(v, node.params) : ""),
      });
      if (typed) commitAndRefresh(typed);
    });
    stopNodeDragOn(sel);
    wrap.appendChild(sel);
    if (p.manage === "local-voices") {
      const manage = document.createElement("button");
      manage.className = "manage-link";
      manage.textContent = "⟳ Atualizar vozes do servidor local";
      manage.addEventListener("click", async (e) => {
        e.stopPropagation();
        setStatus("Buscando vozes no servidor local…");
        const ok = await refreshLocalVoices();
        setStatus(ok
          ? `<span class="ok">${localVoices.list.length} voz(es) salvas no servidor local.</span>`
          : `<span class="err">Servidor local offline em ${escapeHtml(localServerUrl())} — veja o README.</span>`);
      });
      stopNodeDragOn(manage);
      wrap.appendChild(manage);
    }
    if (p.manage === "output-templates" || p.manage === "output-schemas") {
      const manage = document.createElement("button");
      manage.className = "manage-link";
      manage.textContent = p.manage === "output-schemas" ? "⚙ Gerenciar schemas de saída…" : "⚙ Gerenciar templates de saída…";
      manage.addEventListener("click", (e) => { e.stopPropagation(); openTemplatesModal(); });
      stopNodeDragOn(manage);
      wrap.appendChild(manage);
    }
  } else if (widget === "number") {
    wrap.innerHTML = `<label>${labelText}</label>`;
    const inp = document.createElement("input");
    inp.type = "number";
    if (p.min !== undefined) inp.min = p.min;
    if (p.max !== undefined) inp.max = p.max;
    if (p.step !== undefined) inp.step = p.step;
    inp.value = node.params[p.key] ?? p.default ?? 0;
    inp.addEventListener("input", () => commit(inp.value));
    stopNodeDragOn(inp);
    wrap.appendChild(inp);
  } else if (widget === "checkbox") {
    const inp = document.createElement("input");
    inp.type = "checkbox";
    inp.id = `chk-${node.id}-${p.key}`;
    inp.checked = Boolean(node.params[p.key]);
    inp.addEventListener("change", () => commitAndRefresh(inp.checked));
    const label = document.createElement("label");
    label.htmlFor = inp.id;
    label.textContent = labelText;
    stopNodeDragOn(inp);
    wrap.appendChild(inp);
    wrap.appendChild(label);
  } else if (widget === "multicheck") {
    // várias escolhas (ex.: vozes do node Fala): guarda um array com os valores marcados
    const opts = (typeof p.optionsFn === "function" ? p.optionsFn(node.params) : p.options)
      .map(o => (typeof o === "string" ? { value: o, label: o } : o));
    const selected = Array.isArray(node.params[p.key]) ? node.params[p.key] : [];
    for (const v of selected) {
      if (!opts.some(o => o.value === v)) opts.push({ value: v, label: `${v.replace(/^\w+:/, "")} (indisponível)`, group: "Indisponíveis" });
    }
    const head = document.createElement("div");
    head.className = "multicheck-head";
    head.innerHTML = `<label>${labelText}</label>`;
    const count = document.createElement("span");
    count.className = "multicheck-count";
    head.appendChild(count);
    wrap.appendChild(head);
    const box = document.createElement("div");
    box.className = "multicheck";
    let group = null;
    for (const o of opts) {
      if (o.group && o.group !== group) {
        group = o.group;
        const g = document.createElement("div");
        g.className = "multicheck-group";
        g.textContent = group;
        box.appendChild(g);
      }
      if (!o.value) {
        const note = document.createElement("div");
        note.className = "multicheck-note";
        note.textContent = o.label;
        box.appendChild(note);
        continue;
      }
      const item = document.createElement("label");
      item.className = "multicheck-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = o.value;
      cb.checked = selected.includes(o.value);
      item.append(cb, document.createTextNode(o.label));
      box.appendChild(item);
    }
    const values = () => [...box.querySelectorAll("input:checked")].map(c => c.value);
    const updateCount = () => { count.textContent = `${values().length} marcada(s)`; };
    box.addEventListener("change", () => { commit(values()); updateCount(); });
    updateCount();
    const actions = document.createElement("div");
    actions.className = "multicheck-actions";
    for (const [text, checked] of [["Marcar todas", true], ["Limpar", false]]) {
      const b = document.createElement("button");
      b.className = "manage-link";
      b.textContent = text;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        box.querySelectorAll("input[type=checkbox]").forEach(c => { c.checked = checked; });
        commit(values());
        updateCount();
      });
      stopNodeDragOn(b);
      actions.appendChild(b);
    }
    stopNodeDragOn(box);
    wrap.appendChild(box);
    wrap.appendChild(actions);
  } else if (p.widget === "collector") {
    // ações do Coletar resultados: .zip, pasta de destino (Chrome) e “salvar agora”
    wrap.innerHTML = `<label>${labelText}</label>`;
    const items = collectedItems(node.result?.list);
    const row = document.createElement("div");
    row.className = "collector-row";
    const zip = document.createElement("button");
    zip.className = "file-btn";
    zip.textContent = "⇩ Baixar .zip";
    zip.disabled = !items.length;
    zip.title = items.length ? `${items.length} arquivo(s) + manifest.json` : "Execute o workflow para coletar os itens";
    zip.addEventListener("click", async () => {
      zip.disabled = true;
      zip.textContent = "Compactando…";
      try {
        const files = await buildCollectedFiles(items, node.params.pattern, msg => setStatus(escapeHtml(msg)));
        downloadBlob(await makeZip(files), `${slugForFile(state.workflowName, 60) || "resultados"}.zip`);
        setStatus(`<span class="ok">.zip com ${files.length - 1} arquivo(s) + manifest.json baixado.</span>`);
      } catch (err) {
        setStatus(`<span class="err">Não foi possível gerar o .zip: ${escapeHtml(err.message || String(err))}</span>`);
      } finally {
        renderNode(node);
        drawEdges();
      }
    });
    const saveNow = async () => {
      try {
        const files = await buildCollectedFiles(items, node.params.pattern, msg => setStatus(escapeHtml(msg)));
        await writeFilesToFolder(node._dirHandle, files);
        setStatus(`<span class="ok">${files.length - 1} arquivo(s) + manifest.json salvos na pasta “${escapeHtml(node._dirHandle.name)}”.</span>`);
      } catch (err) {
        setStatus(`<span class="err">Não foi possível salvar na pasta: ${escapeHtml(err.message || String(err))}</span>`);
      }
    };
    const folder = document.createElement("button");
    folder.className = "file-btn";
    folder.textContent = node._dirHandle ? `📁 ${node._dirHandle.name}` : "📁 Pasta…";
    folder.title = node._dirHandle ? "Trocar a pasta de destino" : "Escolher uma pasta do computador para salvar os arquivos";
    folder.addEventListener("click", async () => {
      if (!window.showDirectoryPicker) {
        setStatus(`<span class="err">Este navegador não permite escolher pastas — use o “⇩ Baixar .zip”.</span>`);
        return;
      }
      try {
        node._dirHandle = await window.showDirectoryPicker({ id: "assets-pipeline-coletor", mode: "readwrite" });
        if (items.length) await saveNow();
        renderNode(node);
        drawEdges();
      } catch (err) {
        if (err.name !== "AbortError") setStatus(`<span class="err">${escapeHtml(err.message || String(err))}</span>`);
      }
    });
    row.append(zip, folder);
    if (node._dirHandle) {
      const save = document.createElement("button");
      save.className = "file-btn";
      save.textContent = "Salvar agora";
      save.disabled = !items.length;
      save.addEventListener("click", saveNow);
      row.appendChild(save);
    }
    for (const b of row.children) stopNodeDragOn(b);
    wrap.appendChild(row);
    const info = document.createElement("div");
    info.className = "file-info";
    if (items.length) {
      const counts = {};
      for (const it of items) counts[it.type] = (counts[it.type] || 0) + 1;
      info.textContent = `${items.length} item(ns): ${Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(" · ")}`;
    } else {
      info.textContent = "Nada coletado ainda — execute o workflow.";
    }
    wrap.appendChild(info);
  } else if (p.widget === "textfile") {
    // arquivo de texto: guarda nome + conteúdo nos params; no Chrome guarda também o handle
    // (em memória, no próprio node) para reler o arquivo do disco a cada execução
    wrap.innerHTML = `<label>${labelText}</label>`;
    const file = node.params[p.key] && typeof node.params[p.key] === "object" ? node.params[p.key] : null;
    const row = document.createElement("div");
    row.className = "textfile-row";
    const btn = document.createElement("button");
    btn.className = "file-btn";
    btn.textContent = file ? "Trocar arquivo…" : "Escolher arquivo…";
    row.appendChild(btn);
    const load = async (f, handle) => {
      const text = await f.text();
      node._fileHandle = handle || null;
      commit({ name: f.name, text, size: f.size, loadedAt: Date.now() });
      renderNode(node);
      drawEdges();
      executeNode(node); // processa na hora: prévia e saídas prontas para os próximos nodes
    };
    if (node._fileHandle) {
      const reload = document.createElement("button");
      reload.className = "file-btn file-reload";
      reload.textContent = "↻";
      reload.title = "Reler o arquivo do disco agora";
      reload.addEventListener("click", async () => {
        try { await load(await node._fileHandle.getFile(), node._fileHandle); }
        catch (err) { setStatus(`<span class="err">Não foi possível reler o arquivo: ${escapeHtml(err.message || String(err))}</span>`); }
      });
      stopNodeDragOn(reload);
      row.appendChild(reload);
    }
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".txt,.md,.csv,.tsv,.json,.jsonl,.prompt,text/*";
    fileInput.hidden = true;
    fileInput.addEventListener("change", () => { if (fileInput.files[0]) load(fileInput.files[0], null); });
    btn.addEventListener("click", async () => {
      if (!window.showOpenFilePicker) return fileInput.click();
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: "Arquivos de texto", accept: { "text/plain": [".txt", ".md", ".csv", ".tsv", ".json", ".jsonl", ".prompt"] } }],
        });
        await load(await handle.getFile(), handle);
      } catch (err) {
        if (err.name !== "AbortError") setStatus(`<span class="err">Não foi possível abrir o arquivo: ${escapeHtml(err.message || String(err))}</span>`);
      }
    });
    stopNodeDragOn(btn);
    wrap.appendChild(row);
    wrap.appendChild(fileInput);
    if (file) {
      const info = document.createElement("div");
      info.className = "file-info";
      const lines = file.text ? file.text.split(/\r?\n/).length : 0;
      const kb = Math.max(1, Math.round((file.size || file.text.length) / 1024));
      info.textContent = `📄 ${file.name} · ${lines} linha(s) · ${kb} KB${node._fileHandle ? " · relê do disco" : ""}`;
      info.title = file.name;
      wrap.appendChild(info);
    }
  } else if (p.widget === "file") {
    wrap.innerHTML = `<label>${labelText}</label>`;
    const btn = document.createElement("button");
    btn.className = "file-btn";
    const noun = p.noun || "imagem";
    btn.textContent = node.params[p.key] ? `Trocar ${noun}…` : `Escolher ${noun}…`;
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = p.accept || "image/*";
    fileInput.hidden = true;
    btn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try {
        // p.transform permite converter o arquivo (ex.: áudio → WAV 24 kHz) antes de guardar
        const value = p.transform ? await p.transform(file) : await blobToDataUrl(file);
        const out = p.output || { key: "image", dtype: "image" };
        commit(value);
        node.result = { [out.key]: { type: out.dtype, value } };
        node.status = "done";
        node.error = null;
      } catch (err) {
        node.status = "error";
        node.error = err.message || String(err);
      }
      renderNode(node);
      drawEdges();
    });
    stopNodeDragOn(btn);
    wrap.appendChild(btn);
    wrap.appendChild(fileInput);
  } else { /* text */
    wrap.innerHTML = `<label>${labelText}</label>`;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = node.params[p.key] ?? "";
    inp.addEventListener("input", () => commit(inp.value));
    stopNodeDragOn(inp);
    wrap.appendChild(inp);
  }
  if (hint) {
    const el = document.createElement("div");
    el.className = "param-hint";
    el.textContent = hint;
    wrap.appendChild(el);
  }
  return wrap;
}

function stopNodeDragOn(el) {
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.addEventListener("mousedown", (e) => e.stopPropagation());
}

/* ---------- prévia de resultados ---------- */

function renderPreview(node, container) {
  container.innerHTML = "";
  const display = node.result?.__display || null;
  const outputs = node.result ? Object.entries(node.result).filter(([k]) => k !== "__display") : [];
  // prefere mostrar mídia (ex.: o áudio de referência do node Voz em vez do nome da voz)
  const media = outputs.find(([, v]) => v && ["image", "audio", "model3d"].includes(v.type));
  const entry = media || outputs[0] || [];
  const value = display || entry[1] || null;
  if (!value) return;
  // porta real do item mostrado — só com ela dá para refazer um item no lugar
  const port = display ? null : (entry[0] || null);

  const items = Array.isArray(value.values) ? value.values : [value.value];
  const metas = Array.isArray(value.values) ? (value.meta || []) : [value.meta];
  const types = Array.isArray(value.values) ? (value.types || []) : [];
  const asItems = () => items.map((v, i) => ({ type: types[i] || value.type, value: v, meta: metas[i] || null, prompt: metas[i]?.text || null }));

  if (types.some(t => t && t !== value.type)) {
    // lista com tipos misturados (Coletar resultados): resumo por tipo; o visualizador mostra cada item
    const icons = { image: "🖼", audio: "🔊", model3d: "🧊", text: "📝", voice: "🎙" };
    const counts = {};
    for (const t of types) counts[t] = (counts[t] || 0) + 1;
    const div = document.createElement("div");
    div.className = "preview-text";
    div.textContent = Object.entries(counts).map(([t, n]) => `${icons[t] || "•"} ${n} ${t}`).join("  ·  ");
    div.title = "Clique para ver os itens";
    div.addEventListener("click", () => openViewer(asItems(), 0, nodeTitle(node)));
    container.appendChild(div);
  } else if (value.type === "image") {
    if (items.length === 1) {
      const img = document.createElement("img");
      img.src = items[0];
      img.title = "Clique para ampliar";
      img.addEventListener("click", () => openViewer(asItems(), 0, nodeTitle(node)));
      container.appendChild(img);
    } else {
      const grid = document.createElement("div");
      grid.className = "preview-grid";
      items.forEach((v, i) => {
        const img = document.createElement("img");
        img.src = v;
        img.title = `Imagem ${i + 1}/${items.length} — clique para ampliar`;
        img.addEventListener("click", () => openViewer(asItems(), i, nodeTitle(node)));
        grid.appendChild(img);
      });
      container.appendChild(grid);
    }
  } else if (value.type === "text") {
    const wrap = document.createElement("div");
    if (items.length > 1) wrap.className = "preview-multi-text";
    items.forEach((v, i) => {
      const div = document.createElement("div");
      div.className = "preview-text";
      div.textContent = v;
      div.title = "Clique para ampliar";
      div.addEventListener("click", () => openViewer(asItems(), i, nodeTitle(node)));
      wrap.appendChild(div);
    });
    container.appendChild(wrap);
  } else if (value.type === "model3d") {
    items.forEach((v, i) => {
      const mv = document.createElement("model-viewer");
      mv.src = v;
      mv.setAttribute("camera-controls", "");
      mv.setAttribute("auto-rotate", "");
      mv.setAttribute("shadow-intensity", "0.8");
      container.appendChild(mv);
      const bar = document.createElement("div");
      bar.className = "preview-3d-bar";
      bar.innerHTML = `<span>Modelo GLB${items.length > 1 ? ` ${i + 1}/${items.length}` : ""}</span>`;
      const open = document.createElement("a");
      open.href = "#";
      open.textContent = "Ampliar ⤢";
      open.addEventListener("click", (e) => { e.preventDefault(); openViewer(asItems(), i, nodeTitle(node)); });
      bar.appendChild(open);
      container.appendChild(bar);
    });
  } else if (value.type === "audio") {
    const regenOk = Boolean(port) && canRegenerate(node);
    const falhas = (port && value.failed) || [];
    if (regenOk && falhas.length) {
      const bar = document.createElement("div");
      bar.className = "preview-3d-bar preview-failed";
      bar.innerHTML = `<span>✖ ${falhas.length} item(ns) falharam</span>`;
      const retry = document.createElement("a");
      retry.href = "#";
      retry.textContent = "↻ Refazer os que falharam";
      retry.title = falhas.map(f => `${f.voice || f.speaker || "voz"}: ${f.error}`).join("\n");
      retry.addEventListener("click", (e) => { e.preventDefault(); retryFailedItems(node, port); });
      stopNodeDragOn(retry);
      bar.appendChild(retry);
      container.appendChild(bar);
    }
    // todos os áudios ficam no node, numa área rolável; com muitos itens o preload fica
    // desligado para o node não decodificar dezenas de WAVs a cada render
    const lista = document.createElement("div");
    lista.className = "preview-scroll";   // a barra só aparece quando passa da altura máxima
    // o node é redesenhado inteiro a cada render (e a cada ↻): guarda e devolve a posição da lista
    lista.addEventListener("scroll", () => { node._previewScroll = lista.scrollTop; });
    // devolve a posição depois que o node entra no DOM. setTimeout e não requestAnimationFrame:
    // numa aba em segundo plano o rAF não roda, e a lista voltaria ao topo sozinha.
    if (node._previewScroll) setTimeout(() => {
      // busca pelo DOM: dois renders seguidos (progresso + fim) deixam a referência velha solta
      const atual = document.querySelector(`#node-${node.id} .preview-scroll`);
      if (atual) atual.scrollTop = node._previewScroll;
    }, 0);
    const leve = items.length > 12;
    items.forEach((v, i) => {
      const audio = document.createElement("audio");
      audio.src = v;
      audio.controls = true;
      audio.preload = leve ? "none" : "metadata";
      stopNodeDragOn(audio);
      lista.appendChild(audio);
      const bar = document.createElement("div");
      bar.className = "preview-3d-bar";
      const voiceName = metas[i]?.voice || metas[i]?.speaker;
      const rotulo = `Áudio${items.length > 1 ? ` ${i + 1}/${items.length}` : ""}${voiceName ? ` · ${escapeHtml(voiceName)}` : ""}`;
      // title porque o rótulo é cortado com reticências em nodes estreitos
      bar.innerHTML = `<span title="${rotulo}">${rotulo}</span>`;
      const links = document.createElement("span");
      links.className = "bar-links";
      const save = document.createElement("a");
      save.href = "#";
      save.textContent = "Salvar voz";
      save.title = "Criar um perfil de voz a partir deste áudio";
      save.addEventListener("click", (e) => { e.preventDefault(); openSaveVoiceModal(asItems()[i]); });
      const download = document.createElement("a");
      download.href = v;
      download.download = `audio-${i + 1}.wav`;
      download.textContent = "⇩";
      download.title = "Baixar WAV";
      const open = document.createElement("a");
      open.href = "#";
      open.textContent = "⤢";
      open.title = "Ampliar";
      open.addEventListener("click", (e) => {
        e.preventDefault();
        openViewer(asItems(), i, nodeTitle(node), port ? { nodeId: node.id, port } : null);
      });
      if (regenOk) {
        const regen = document.createElement("a");
        regen.href = "#";
        regen.textContent = "↻";
        regen.title = "Refazer só este áudio, com uma seed nova (Shift+clique para escolher a seed)";
        regen.addEventListener("click", async (e) => {
          e.preventDefault();
          if (state.running) return busyStatus();   // antes de abrir o campo de seed
          if (!e.shiftKey) return void regenerateResultItem(node, port, i);
          const seed = await askSeed(metas[i]);
          if (seed != null) regenerateResultItem(node, port, i, { seed });
        });
        stopNodeDragOn(regen);
        links.appendChild(regen);
      }
      links.append(save, download, open);
      bar.appendChild(links);
      lista.appendChild(bar);
    });
    container.appendChild(lista);
  } else if (value.type === "voice") {
    items.forEach(v => {
      const div = document.createElement("div");
      div.className = "preview-text";
      div.textContent = `🎙 Voz: ${v}`;
      container.appendChild(div);
    });
  }
  if (items.length > 1) {
    const count = document.createElement("div");
    count.className = "preview-count";
    count.textContent = `${items.length} itens`;
    container.appendChild(count);
  }
}

function nodeTitle(node) {
  return NODE_DEFS[node.type].icon + " " + NODE_DEFS[node.type].title;
}

/* ---------- espelho do estado fora do navegador (SQLite no serve.py) ----------

   O navegador continua sendo onde o editor lê e escreve — assim ele funciona em qualquer
   servidor estático. Mas o Chrome apaga o IndexedDB sozinho quando o disco enche, e aí os
   workflows somem. Com o serve.py no ar, toda mudança é espelhada num banco SQLite em disco e,
   na abertura, o que estiver faltando no navegador é trazido de volta automaticamente.        */

let mirrorOn = false;          // ligado só depois da conferência inicial
let mirrorBusy = false;
let mirrorErro = "";
let mirrorTimer = null;
const mirrorDirty = { workflows: new Set(), sessoes: new Set(), biblioteca: false };

function scheduleMirror() {
  if (!mirrorOn) return;
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(pushMirror, 1500);
}
function markMirror(storeName, id) {
  if (!mirrorOn || !id) return;
  if (storeName === "workflows") mirrorDirty.workflows.add(String(id));
  else if (storeName === "session") mirrorDirty.sessoes.add(String(id));
  else return;
  scheduleMirror();
}
function markMirrorLibrary() {
  if (!mirrorOn) return;
  mirrorDirty.biblioteca = true;
  scheduleMirror();
}

/* manda o que mudou + a lista completa de ids (é ela que apaga no banco o que foi excluído aqui) */
async function pushMirror() {
  if (!mirrorOn || mirrorBusy) return;
  const wfIds = [...mirrorDirty.workflows];
  const sesIds = [...mirrorDirty.sessoes];
  const bib = mirrorDirty.biblioteca;
  mirrorDirty.workflows.clear();
  mirrorDirty.sessoes.clear();
  mirrorDirty.biblioteca = false;
  mirrorBusy = true;
  try {
    const [chavesWf, chavesSes] = await Promise.all([idbKeys("workflows"), idbKeys("session")]);
    const [workflows, sessoes] = await Promise.all([
      Promise.all(wfIds.map(id => idbGet("workflows", id))),
      Promise.all(sesIds.map(id => idbGet("session", id))),
    ]);
    await editorApi("/__local/estado", "POST", {
      workflows: workflows.filter(Boolean),
      sessoes: sessoes.filter(Boolean),
      biblioteca: bib ? exportLibrary() : {},
      ids: { workflows: chavesWf, sessoes: chavesSes },
    });
    mirrorErro = "";
  } catch (err) {
    if (!err.status || err.status === 404) {
      mirrorOn = false;                    // servidor estático comum ou serve.py antigo
    } else {
      mirrorErro = err.message || String(err);
      for (const id of wfIds) mirrorDirty.workflows.add(id);   // tenta de novo na próxima
      for (const id of sesIds) mirrorDirty.sessoes.add(id);
      if (bib) mirrorDirty.biblioteca = true;
      setTimeout(scheduleMirror, 15000);
    }
  } finally {
    mirrorBusy = false;
    updateStorageWarning();
  }
}

/* na abertura: traz do banco o que o navegador não tem mais */
async function syncFromServer() {
  let resumo;
  try {
    resumo = await editorApi("/__local/estado/resumo");
  } catch {
    return false;                          // sem serve.py: só o navegador (e os backups)
  }
  try {
    const [chavesWf, chavesSes] = await Promise.all([idbKeys("workflows"), idbKeys("session")]);
    const temWf = new Set(chavesWf);
    const temSes = new Set(chavesSes);
    const faltamWf = resumo.workflows.filter(w => !temWf.has(String(w.id))).map(w => w.id);
    const faltamSes = resumo.sessoes.filter(s => !temSes.has(String(s.id))).map(s => s.id);
    // a Biblioteca só volta se tiver sumido inteira — senão ressuscitaria prompt excluído
    const atual = exportLibrary();
    const vazia = !["prompts", "agentPrompts", "outputTemplates", "outputSchemas"]
      .some(k => (atual[k] || []).length);
    const faltamBib = vazia ? resumo.biblioteca.map(b => b.chave) : [];

    if (faltamWf.length || faltamSes.length || faltamBib.length) {
      const dados = await editorApi("/__local/estado/ler", "POST",
        { workflows: faltamWf, sessoes: faltamSes, biblioteca: faltamBib });
      for (const w of dados.workflows || []) await idbWrite("workflows", s => s.put(w));
      for (const s of dados.sessoes || []) await idbWrite("session", st => st.put(s));
      const bib = dados.biblioteca || {};
      const nBib = Object.keys(bib).length ? importLibrary(bib) : 0;
      const partes = [];
      if (dados.workflows?.length) partes.push(`${dados.workflows.length} workflow(s)`);
      if (dados.sessoes?.length) partes.push(`${dados.sessoes.length} sessão(ões)`);
      if (nBib) partes.push(`${nBib} item(ns) da Biblioteca`);
      if (partes.length) {
        // com atraso: o resto do boot ainda vai escrever na barra de status
        setTimeout(() => setStatus(
          `<span class="ok">💾 Restaurado do banco local (o navegador havia perdido): ${partes.join(", ")}.</span>`), 1500);
      }
    }
  } catch (err) {
    mirrorErro = err.message || String(err);
  }
  mirrorOn = true;
  // a primeira gravação sincroniza tudo o que existir só no navegador
  mirrorDirty.biblioteca = true;
  for (const id of await idbKeys("workflows")) mirrorDirty.workflows.add(id);
  for (const id of await idbKeys("session")) mirrorDirty.sessoes.add(id);
  scheduleMirror();
  updateStorageWarning();
  return true;
}

/* ---------- tamanho dos modais (alça no canto inferior direito, valendo para todos) ---------- */

const MODAL_SIZE_STORAGE = "assets-pipeline-modal-size";
let modalSize = null;
try { modalSize = JSON.parse(localStorage.getItem(MODAL_SIZE_STORAGE) || "null"); } catch { modalSize = null; }

function applyModalSize(modal) {
  if (!modal || !modalSize?.w || !modalSize?.h) return;
  modal.style.width = Math.min(modalSize.w, window.innerWidth - 24) + "px";
  modal.style.height = Math.min(modalSize.h, window.innerHeight - 24) + "px";
}

let modalSizeTimer = null;
function rememberModalSize(modal) {
  const r = modal.getBoundingClientRect();
  if (r.width < 80 || r.height < 60) return;   // modal escondido
  modalSize = { w: Math.round(r.width), h: Math.round(r.height) };
  clearTimeout(modalSizeTimer);
  modalSizeTimer = setTimeout(() => {
    try { localStorage.setItem(MODAL_SIZE_STORAGE, JSON.stringify(modalSize)); } catch { /* cota cheia */ }
  }, 250);
}

/* aplica o tamanho guardado sempre que um modal abre */
function watchModals() {
  for (const backdrop of document.querySelectorAll(".modal-backdrop")) {
    const modal = backdrop.querySelector(".modal");
    if (!modal) continue;
    if (!backdrop.hidden) applyModalSize(modal);
    new MutationObserver(() => { if (!backdrop.hidden) applyModalSize(modal); })
      .observe(backdrop, { attributes: true, attributeFilter: ["hidden"] });
  }
}
watchModals();

/* guarda o tamanho ao soltar o mouse: a alça nativa não emite evento próprio, e o ResizeObserver
   não roda em aba de segundo plano. No documento porque o ponteiro pode ser solto fora do modal. */
document.addEventListener("pointerup", () => {
  for (const backdrop of document.querySelectorAll(".modal-backdrop:not([hidden])")) {
    const modal = backdrop.querySelector(".modal");
    if (modal) rememberModalSize(modal);
  }
});

/* ---------- edição pontual de um resultado já gerado ---------- */

/* Itens de uma porta como arrays paralelos, nas duas formas ({value} e {values}). */
function portItems(value) {
  const list = Array.isArray(value?.values);
  return {
    list,
    values: list ? value.values : [value?.value],
    meta: list ? (Array.isArray(value.meta) ? value.meta : []) : [value?.meta],
  };
}

/* Troca um item no lugar, preservando a ordem (texto × voz) e o resto do resultado.
   Primeira mutação in-place de node.result do projeto — por isso concentrada aqui. */
function replaceResultItem(node, port, index, value, meta) {
  const v = node.result?.[port];
  if (!v) return false;
  if (Array.isArray(v.values)) {
    if (index < 0 || index >= v.values.length) return false;
    v.values[index] = value;
    if (Array.isArray(v.meta)) v.meta[index] = meta;
  } else {
    if (index !== 0) return false;
    v.value = value;
    v.meta = meta;
  }
  // nodes de Saída guardam uma cópia do valor na porta virtual __display
  const disp = node.result.__display;
  if (disp && disp !== v) {
    const a = portItems(disp);
    if (a.values.length === (Array.isArray(v.values) ? v.values.length : 1)) {
      if (Array.isArray(disp.values)) {
        disp.values[index] = value;
        if (Array.isArray(disp.meta)) disp.meta[index] = meta;
      } else {
        disp.value = value;
        disp.meta = meta;
      }
    }
  }
  return true;
}

/* Onde um item recuperado entraria na ordem natural da lista (texto → voz → take). A ordem dos
   textos e das vozes é lida da própria lista, pela ordem em que aparecem — é a mesma que o motor
   produziu. Sem correspondência, vai para o fim. */
function naturalInsertIndex(metaList, item) {
  const textos = [];
  const vozes = [];
  for (const m of metaList) {
    const t = m?.text ?? "";
    const v = m?.voice || m?.speaker || "";
    if (!textos.includes(t)) textos.push(t);
    if (!vozes.includes(v)) vozes.push(v);
  }
  const pos = (arr, v) => { const i = arr.indexOf(v); return i < 0 ? arr.length : i; };
  const key = (m) => [pos(textos, m?.text ?? ""), pos(vozes, m?.voice || m?.speaker || ""), Number(m?.take) || 0];
  const alvo = key(item);
  const vemAntes = (a, b) => (a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] <= b[2]);
  for (let i = 0; i < metaList.length; i++) if (!vemAntes(key(metaList[i]), alvo)) return i;
  return metaList.length;
}

/* Devolve à lista itens que tinham falhado — cada um no lugar que ocuparia se tivesse dado certo,
   para o Coletar continuar numerando na ordem texto × voz. */
function appendResultItems(node, port, items) {
  const v = node.result?.[port];
  if (!v || !items.length) return false;
  if (!Array.isArray(v.values)) {
    // estava na forma singular: vira lista
    const first = v.value;
    const firstMeta = v.meta ?? null;
    delete v.value;
    v.values = [first];
    v.meta = [firstMeta];
  }
  if (!Array.isArray(v.meta)) v.meta = v.values.map(() => null);
  for (const it of items) {
    const at = naturalInsertIndex(v.meta, it.meta);
    v.values.splice(at, 0, it.value);
    v.meta.splice(at, 0, it.meta ?? null);
    if (Array.isArray(v.types)) v.types.splice(at, 0, v.type);
  }
  return true;
}

/* Reescreve a lista de falhas de uma porta (e o aviso do node) depois de um lote de recuperação. */
function setFailedEntries(node, port, entries) {
  const v = node.result?.[port];
  if (!v) return;
  if (entries.length) v.failed = entries;
  else delete v.failed;
  node.warning = entries.length
    ? `${entries.length} item(ns) continuam falhando:\n${entries.map(f => f.error).filter(Boolean).join("\n")}`
    : null;
}

/* ---------- regerar um item já gerado (↻) ---------- */

function canRegenerate(node) {
  return typeof NODE_DEFS[node.type]?.regenerateItem === "function";
}

/* Entra no “modo execução” para uma operação pontual fora do motor: o ▶ fica bloqueado
   (o servidor local gera um áudio por vez) e o node mostra a barra de progresso. */
function beginSideRun(node, msg) {
  state.running = true;
  state.stopRequested = false;
  document.getElementById("btn-run").disabled = true;
  node.status = "running";
  node.progress = msg;
  node.error = null;
  renderNode(node);
  drawEdges();
}

function endSideRun(node) {
  node.status = "done";
  node.progress = null;
  renderNode(node);
  drawEdges();
  finishRun();
}

function busyStatus() {
  setStatus(`<span class="err">Há uma execução em andamento — espere terminar.</span>`);
}

async function askSeed(meta) {
  const atual = Number.isFinite(Number(meta?.seed)) ? Number(meta.seed) : 0;
  const v = await askText({
    title: "Refazer com qual seed?",
    note: `A seed deste áudio é ${atual}. A mesma seed, com os mesmos parâmetros, devolve o mesmo áudio.`,
    label: "Seed",
    value: String(atual + 1),
    placeholder: "número inteiro",
    ok: "Refazer",
    validate: v => (/^\d+$/.test(v) ? null : "Digite um número inteiro maior ou igual a 0."),
  });
  return v == null ? null : Number(v.trim());
}

/* Refaz UM áudio e o substitui no lugar. Devolve o item novo, ou null se falhou. */
async function regenerateResultItem(node, port, index, { seed } = {}) {
  if (state.running) { busyStatus(); return null; }
  const def = NODE_DEFS[node.type];
  const { values, meta } = portItems(node.result?.[port]);
  const itemMeta = meta[index];
  if (!def?.regenerateItem || !itemMeta) {
    setStatus(`<span class="err">Este áudio não pode ser refeito isoladamente — execute o node.</span>`);
    return null;
  }
  const nextSeed = seed ?? (Number.isFinite(Number(itemMeta.seed)) ? Number(itemMeta.seed) + 1 : undefined);
  beginSideRun(node, `Regerando áudio ${index + 1}/${values.length}…`);
  try {
    const out = await def.regenerateItem({ meta: itemMeta, params: node.params, seed: nextSeed });
    const newMeta = out.meta || itemMeta;
    replaceResultItem(node, port, index, out.value, newMeta);
    for (const line of out.log || []) node.debug?.log?.push(line);
    setStatus(`<span class="ok">✔ Áudio ${index + 1} refeito com a seed ${newMeta.seed}.</span>`);
    endSideRun(node);
    saveSessionSoon();
    await refreshDownstreamOutputs([node.id]);
    return { type: "audio", value: out.value, meta: newMeta, prompt: newMeta.text || null };
  } catch (err) {
    setStatus(`<span class="err">✖ Falha ao refazer o áudio ${index + 1}: ${escapeHtml(err.message || String(err))}</span>`);
    endSideRun(node);
    return null;
  }
}

/* Refaz, em série, só as combinações que falharam no lote (o servidor local é serial mesmo). */
async function retryFailedItems(node, port) {
  if (state.running) { busyStatus(); return; }
  const def = NODE_DEFS[node.type];
  const pending = (node.result?.[port]?.failed || []).slice();
  if (!def?.regenerateItem || !pending.length) return;
  beginSideRun(node, `Refazendo 1/${pending.length}…`);
  const recuperados = [];
  const restantes = [];
  for (let i = 0; i < pending.length; i++) {
    node.progress = `Refazendo ${i + 1}/${pending.length}…`;
    renderNode(node);
    const { error, ...limpo } = pending[i];
    try {
      const out = await def.regenerateItem({ meta: limpo, params: node.params });
      recuperados.push({ value: out.value, meta: out.meta || limpo });
      for (const line of out.log || []) node.debug?.log?.push(line);
    } catch (err) {
      restantes.push({ ...limpo, error: err.message || String(err) });
    }
  }
  if (recuperados.length) appendResultItems(node, port, recuperados);
  setFailedEntries(node, port, restantes);
  setStatus(restantes.length
    ? `<span class="err">${recuperados.length} de ${pending.length} recuperado(s); ${restantes.length} continuam falhando.</span>`
    : `<span class="ok">✔ ${recuperados.length} item(ns) recuperado(s).</span>`);
  endSideRun(node);
  saveSessionSoon();
  await refreshDownstreamOutputs([node.id]);
}

/* ---------- visualizador ampliado (galeria + chat de edição) ---------- */

let viewerState = { items: [], index: 0, title: "", chatLog: [], origin: null };

/* `origin` ({nodeId, port}) liga os itens de volta ao resultado do node — é o que permite
   refazer um áudio de dentro do visualizador, inclusive os que não cabem na prévia. */
function openViewer(items, index, title, origin = null) {
  viewerState = {
    items: [...items],
    index: Math.max(0, Math.min(index || 0, items.length - 1)),
    title: title || "Visualizador",
    chatLog: [],
    origin,
  };
  document.getElementById("viewer-modal").hidden = false;
  renderViewerContent();
}

function viewerNav(delta) {
  const n = viewerState.items.length;
  if (!n) return;
  viewerState.index = Math.max(0, Math.min(n - 1, viewerState.index + delta));
  renderViewerContent();
}

function renderViewerContent() {
  const { items, index, title } = viewerState;
  const item = items[index];
  if (!item) return;
  document.getElementById("viewer-title").textContent =
    items.length > 1 ? `${title} — ${index + 1}/${items.length}` : title;
  const body = document.getElementById("viewer-body");
  const download = document.getElementById("viewer-download");
  body.innerHTML = "";
  download.style.display = "none";

  if (item.type === "image") {
    const img = document.createElement("img");
    img.src = item.value;
    body.appendChild(img);
    download.href = item.value;
    download.download = "imagem.png";
    download.style.display = "";
  } else if (item.type === "model3d") {
    const mv = document.createElement("model-viewer");
    mv.src = item.value;
    mv.setAttribute("camera-controls", "");
    mv.setAttribute("auto-rotate", "");
    mv.setAttribute("shadow-intensity", "1");
    body.appendChild(mv);
    download.href = item.value;
    download.download = "modelo.glb";
    download.style.display = "";
  } else if (item.type === "audio") {
    const audio = document.createElement("audio");
    audio.src = item.value;
    audio.controls = true;
    body.appendChild(audio);
    download.href = item.value;
    download.download = "audio.wav";
    download.style.display = "";
  } else {
    const pre = document.createElement("pre");
    pre.textContent = item.value;
    body.appendChild(pre);
  }

  const prev = document.getElementById("viewer-prev");
  const next = document.getElementById("viewer-next");
  const multi = items.length > 1;
  prev.style.display = next.style.display = multi ? "" : "none";
  prev.disabled = index === 0;
  next.disabled = index === items.length - 1;

  const caption = document.getElementById("viewer-caption");
  if (item.prompt) {
    document.getElementById("viewer-caption-text").textContent = item.prompt;
    caption.hidden = false;
  } else {
    caption.hidden = true;
  }

  document.getElementById("viewer-chat").hidden = item.type !== "image";
  document.getElementById("viewer-save-voice").hidden = item.type !== "audio";
  const origem = viewerState.origin && state.nodes.find(n => n.id === viewerState.origin.nodeId);
  document.getElementById("viewer-regen").hidden = !(item.type === "audio" && origem && canRegenerate(origem));
  renderChatLog();
}

document.getElementById("viewer-regen").addEventListener("click", async (e) => {
  const origin = viewerState.origin;
  const node = origin && state.nodes.find(n => n.id === origin.nodeId);
  if (!node) return;
  if (state.running) return busyStatus();
  const index = viewerState.index;
  let seed;
  if (e.shiftKey) {
    seed = await askSeed(viewerState.items[index]?.meta);
    if (seed == null) return;
  }
  const novo = await regenerateResultItem(node, origin.port, index, { seed });
  if (!novo) return;
  viewerState.items[index] = novo;   // a cópia do visualizador também precisa do áudio novo
  renderViewerContent();
});

document.getElementById("viewer-caption-copy").addEventListener("click", () => {
  const prompt = viewerState.items[viewerState.index]?.prompt;
  if (!prompt) return;
  navigator.clipboard?.writeText(prompt);
  setStatus(`<span class="ok">Prompt copiado para a área de transferência.</span>`);
});

function renderChatLog() {
  const log = document.getElementById("viewer-chat-log");
  log.innerHTML = "";
  for (const m of viewerState.chatLog) {
    const div = document.createElement("div");
    div.className = "chat-msg " + m.kind;
    div.textContent = m.text;
    log.appendChild(div);
  }
  log.scrollTop = log.scrollHeight;
}

let chatBusy = false;
async function sendChatEdit() {
  if (chatBusy) return;
  const input = document.getElementById("chat-input");
  const prompt = input.value.trim();
  const item = viewerState.items[viewerState.index];
  if (!prompt || !item || item.type !== "image") return;
  const expandedPrompt = expandPromptRefs(prompt);
  const model = document.getElementById("chat-model").value;
  chatBusy = true;
  document.getElementById("chat-send").disabled = true;
  input.value = "";
  viewerState.chatLog.push({ kind: "user", text: prompt });
  viewerState.chatLog.push({ kind: "status", text: `⏳ Editando com ${model}…` });
  renderChatLog();
  try {
    const result = await callOpenAIImageEdit({ image: item.value, prompt: expandedPrompt, model, size: imageDefaultSize(model) });
    viewerState.chatLog.pop();
    viewerState.chatLog.push({ kind: "status", text: "✔ Edição concluída — use as setas para comparar com a anterior." });
    viewerState.items.push({ type: "image", value: result, prompt });
    viewerState.index = viewerState.items.length - 1;
    historyAdd({ type: "image", value: result, source: "Chat de edição", prompt });
    renderViewerContent();
  } catch (err) {
    viewerState.chatLog.pop();
    viewerState.chatLog.push({ kind: "error", text: "✖ " + (err.message || err) });
    renderChatLog();
  } finally {
    chatBusy = false;
    document.getElementById("chat-send").disabled = false;
  }
}

document.getElementById("chat-send").addEventListener("click", sendChatEdit);
document.getElementById("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChatEdit();
});
document.getElementById("viewer-prev").addEventListener("click", () => viewerNav(-1));
document.getElementById("viewer-next").addEventListener("click", () => viewerNav(1));
document.getElementById("viewer-save-voice").addEventListener("click", () => {
  openSaveVoiceModal(viewerState.items[viewerState.index]);
});

/* ---------- histórico de gerações (IndexedDB) ---------- */

let historyDbPromise = null;
function historyDb() {
  if (!historyDbPromise) {
    historyDbPromise = new Promise((resolve) => {
      const req = indexedDB.open("assets-pipeline-history", 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("items")) db.createObjectStore("items", { keyPath: "id", autoIncrement: true });
        if (!db.objectStoreNames.contains("session")) db.createObjectStore("session", { keyPath: "id" });
        if (!db.objectStoreNames.contains("workflows")) db.createObjectStore("workflows", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }
  return historyDbPromise;
}

async function historyAdd(entry) {
  const db = await historyDb();
  if (!db) return;
  const store = db.transaction("items", "readwrite").objectStore("items");
  store.add({ ...entry, ts: Date.now() });
  const countReq = store.count();
  countReq.onsuccess = () => {
    // mantém no máximo 200 entradas — remove a mais antiga ao exceder
    if (countReq.result > 200) {
      store.openCursor().onsuccess = (e) => { const c = e.target.result; if (c) c.delete(); };
    }
  };
}

async function historyAll() {
  const db = await historyDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const req = db.transaction("items", "readonly").objectStore("items").getAll();
    req.onsuccess = () => resolve((req.result || []).reverse());
    req.onerror = () => resolve([]);
  });
}

async function historyDelete(id) {
  const db = await historyDb();
  if (db) db.transaction("items", "readwrite").objectStore("items").delete(id);
}

async function historyClear() {
  const db = await historyDb();
  if (db) db.transaction("items", "readwrite").objectStore("items").clear();
}

/* ---------- sessão do workflow (resultados persistidos) ---------- */

function serializeSession() {
  const results = {};
  for (const n of state.nodes) {
    if (n.result && n.status === "done") {
      results[n.id] = { type: n.type, result: n.result, warning: n.warning || null };
    }
  }
  return results;
}

/* helpers genéricos de IndexedDB */
async function idbGet(storeName, key) {
  const db = await historyDb();
  if (!db) return null;
  return new Promise((res) => {
    const r = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => res(null);
  });
}
/* put/delete resolvem só quando a transação termina (true = gravado) */
function idbWrite(storeName, op) {
  return historyDb().then(db => new Promise((res) => {
    if (!db) return res(false);
    try {
      const tx = db.transaction(storeName, "readwrite");
      op(tx.objectStore(storeName));
      tx.oncomplete = () => res(true);
      tx.onerror = tx.onabort = () => res(false);
    } catch { res(false); }
  }));
}
function idbPut(storeName, value) {
  markBackupDirty();
  markMirror(storeName, value?.id);
  return idbWrite(storeName, s => s.put(value));
}
async function idbAll(storeName) {
  const db = await historyDb();
  if (!db) return [];
  return new Promise((res) => {
    const r = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => res([]);
  });
}
function idbDel(storeName, key) {
  if (storeName === "workflows" || storeName === "session") scheduleMirror();  // some lá também
  return idbWrite(storeName, s => s.delete(key));
}

/* só as chaves — para comparar com o servidor sem carregar centenas de MB de resultados */
async function idbKeys(storeName) {
  const db = await historyDb();
  if (!db) return [];
  return new Promise((res) => {
    const r = db.transaction(storeName, "readonly").objectStore(storeName).getAllKeys();
    r.onsuccess = () => res((r.result || []).map(String));
    r.onerror = () => res([]);
  });
}

/* auto-save dos resultados, por workflow (o grafo tem o próprio auto-save — ver persistDraft) */
let sessionSaveTimer = null;
function persistSession() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = null;
  return idbPut("session", {
    id: "auto:" + state.workflowId,
    workflowId: state.workflowId,
    kind: "auto",
    results: serializeSession(),
    ts: Date.now(),
  });
}
function saveSessionSoon() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(persistSession, 800);
}

function restoreSession(sess) {
  const results = sess?.results;
  if (!results) return 0;
  let count = 0;
  for (const n of state.nodes) {
    const saved = results[n.id];
    if (saved && saved.type === n.type && saved.result) {
      n.result = saved.result;
      n.status = "done";
      n.warning = saved.warning || null;
      renderNode(n);
      count++;
    }
  }
  drawEdges();
  return count;
}

async function openHistoryModal() {
  const grid = document.getElementById("history-grid");
  const items = await historyAll();
  grid.innerHTML = items.length
    ? ""
    : `<div class="hist-empty">Nada gerado ainda — imagens e modelos 3D produzidos pelos workflows aparecem aqui automaticamente.</div>`;
  items.forEach((it, idx) => {
    const tile = document.createElement("div");
    tile.className = "hist-tile";
    if (it.type === "image") {
      const img = document.createElement("img");
      img.src = it.value;
      tile.appendChild(img);
    } else {
      const d = document.createElement("div");
      d.className = "hist-3d";
      d.textContent = it.type === "audio" ? "🔊" : "🧊";
      tile.appendChild(d);
    }
    if (it.prompt) {
      const p = document.createElement("div");
      p.className = "hist-prompt";
      p.textContent = it.prompt;
      p.title = it.prompt;
      tile.appendChild(p);
    }
    const meta = document.createElement("div");
    meta.className = "hist-meta";
    meta.title = `${it.source || ""} — ${new Date(it.ts).toLocaleString("pt-BR")}${it.prompt ? "\nPrompt: " + it.prompt : ""}`;
    meta.textContent = `${it.source || it.type} · ${new Date(it.ts).toLocaleString("pt-BR")}`;
    tile.appendChild(meta);
    const del = document.createElement("button");
    del.className = "hist-del";
    del.title = "Remover do histórico";
    del.textContent = "✕";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await confirmDelete({
        title: "Remover do histórico?",
        text: `${it.source || it.type} · ${new Date(it.ts).toLocaleString("pt-BR")}`,
        note: "O arquivo sai do histórico do navegador. Se já estiver num node ou salvo em disco, isso não muda.",
        okLabel: "Remover",
      });
      if (!ok) return;
      await historyDelete(it.id);
      openHistoryModal();
    });
    tile.appendChild(del);
    tile.addEventListener("click", () => {
      openViewer(items.map(x => ({ type: x.type, value: x.value, prompt: x.prompt || null })), idx, "Histórico");
    });
    grid.appendChild(tile);
  });
  document.getElementById("history-modal").hidden = false;
}

document.getElementById("btn-history").addEventListener("click", openHistoryModal);
document.getElementById("btn-history-clear").addEventListener("click", async () => {
  const total = (await historyAll()).length;
  const ok = await confirmDelete({
    title: "Limpar o histórico inteiro?",
    text: `${total} item(ns) — imagens, áudios e modelos 3D guardados pelo navegador.`,
    note: "Irreversível. Os resultados que estão nos nodes continuam lá.",
    okLabel: "Limpar tudo",
  });
  if (!ok) return;
  await historyClear();
  openHistoryModal();
});

/* ---------- arrastar nodes ---------- */

function makeNodeDraggable(node, handle) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    selectNode(node.id);
    const start = { x: e.clientX, y: e.clientY, nx: node.x, ny: node.y };
    const el = document.getElementById("node-" + node.id);
    const onMove = (ev) => {
      node.x = start.nx + (ev.clientX - start.x) / state.zoom;
      node.y = start.ny + (ev.clientY - start.y) / state.zoom;
      el.style.left = node.x + "px";
      el.style.top = node.y + "px";
      drawEdges();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      autosave();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

/* ---------- pan e zoom ---------- */

canvas.addEventListener("pointerdown", (e) => {
  if (e.target !== canvas && e.target !== edgesSvg) return;
  closeContextMenu();
  if (isMarqueeGesture(e)) { e.preventDefault(); startMarquee(e); return; }
  if (e.button !== 0) return;
  startPan(e);
});

/* arrastar o fundo (ou a área vazia de um grupo) move o canvas */
function startPan(e) {
  selectNode(null);
  canvas.classList.add("panning");
  const start = { x: e.clientX, y: e.clientY, px: state.pan.x, py: state.pan.y };
  const onMove = (ev) => {
    state.pan.x = start.px + (ev.clientX - start.x);
    state.pan.y = start.py + (ev.clientY - start.y);
    applyTransform();
  };
  const onUp = () => {
    canvas.classList.remove("panning");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

canvas.addEventListener("wheel", (e) => {
  // dentro de áreas roláveis do node (textos, prévias), deixa o scroll normal
  if (e.target.closest?.(".preview-text, .preview-scroll, .node.sized .node-body, .param textarea, .debug-body, .multicheck")) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newZoom = Math.min(2.5, Math.max(0.25, state.zoom * factor));
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  state.pan.x = mx - ((mx - state.pan.x) / state.zoom) * newZoom;
  state.pan.y = my - ((my - state.pan.y) / state.zoom) * newZoom;
  state.zoom = newZoom;
  applyTransform();
}, { passive: false });

/* ---------- grupos (containers coloridos para separar partes do workflow) ---------- */

const GROUP_COLORS = ["#6ea8fe", "#ff9e57", "#5fd4a0", "#ff6fae", "#b794f6", "#f6d65c", "#94a3b8"];

function addGroup(x, y, w = 560, h = 340, opts = {}) {
  const g = {
    id: opts.id || "g" + state.nextId++,
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
    color: opts.color || GROUP_COLORS[state.groups.length % GROUP_COLORS.length],
    title: opts.title ?? "Grupo",
    desc: opts.desc ?? "",
  };
  state.groups.push(g);
  renderGroup(g);
  autosave();
  return g;
}

/* item da paleta: envolve o node selecionado ou cria no centro da tela */
function addGroupFromPalette() {
  const sel = state.nodes.find(n => n.id === state.selectedNode);
  if (sel) {
    const el = document.getElementById("node-" + sel.id);
    selectGroup(addGroup(sel.x - 24, sel.y - 72, (el?.offsetWidth || 250) + 48, (el?.offsetHeight || 200) + 100).id);
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const c = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  selectGroup(addGroup(c.x - 280, c.y - 170).id);
}

function removeGroup(id) {
  state.groups = state.groups.filter(g => g.id !== id);
  document.getElementById("group-" + id)?.remove();
  if (state.selectedGroup === id) state.selectedGroup = null;
  autosave();
}

function selectGroup(id) {
  selectNode(null);
  state.selectedGroup = id;
  if (id) document.getElementById("group-" + id)?.classList.add("selected");
}

/* um node pertence ao grupo quando o centro do seu cabeçalho está dentro dele */
function nodesInsideGroup(g) {
  return state.nodes.filter(n => {
    const w = document.getElementById("node-" + n.id)?.offsetWidth || 250;
    const cx = n.x + w / 2;
    const cy = n.y + 18;
    return cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h;
  });
}

function renderGroup(g) {
  let el = document.getElementById("group-" + g.id);
  if (!el) {
    el = document.createElement("div");
    el.id = "group-" + g.id;
    el.className = "group";
    world.appendChild(el);
    buildGroupDom(g, el);
  }
  el.style.left = g.x + "px";
  el.style.top = g.y + "px";
  el.style.width = g.w + "px";
  el.style.height = g.h + "px";
  el.style.setProperty("--g-color", g.color);
  el.classList.toggle("selected", isGroupSelected(g.id));
}

function buildGroupDom(g, el) {
  el.innerHTML = `
    <div class="group-header">
      <button class="group-color" title="Cor do grupo"></button>
      <input class="group-title" readonly spellcheck="false" title="Duplo clique para renomear" />
      <button class="group-close" title="Remover grupo (os nodes continuam no canvas)">✕</button>
    </div>
    <div class="group-swatches" hidden>${GROUP_COLORS.map(c => `<button data-color="${c}" style="background:${c}" title="${c}"></button>`).join("")}</div>
    <textarea class="group-desc" rows="1" placeholder="Adicionar descrição…" spellcheck="false"></textarea>
    <div class="group-resize" title="Redimensionar"></div>`;
  const header = el.querySelector(".group-header");
  const title = el.querySelector(".group-title");
  const desc = el.querySelector(".group-desc");
  const swatches = el.querySelector(".group-swatches");
  title.value = g.title;
  desc.value = g.desc;
  const fitDesc = () => { desc.style.height = "auto"; desc.style.height = desc.scrollHeight + "px"; };
  requestAnimationFrame(fitDesc);

  // título: duplo clique edita; Enter, Esc ou sair do campo confirma
  title.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    title.readOnly = false;
    title.focus();
    title.select();
  });
  title.addEventListener("blur", () => {
    title.readOnly = true;
    g.title = title.value.trim() || "Grupo";
    title.value = g.title;
    autosave();
  });
  title.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "Escape") title.blur();
  });

  desc.addEventListener("input", () => { g.desc = desc.value; fitDesc(); autosave(); });
  desc.addEventListener("keydown", (e) => e.stopPropagation());
  stopNodeDragOn(desc);

  const colorBtn = el.querySelector(".group-color");
  colorBtn.addEventListener("click", (e) => { e.stopPropagation(); swatches.hidden = !swatches.hidden; });
  swatches.addEventListener("click", (e) => {
    const color = e.target.dataset?.color;
    if (!color) return;
    g.color = color;
    swatches.hidden = true;
    renderGroup(g);
    autosave();
  });
  const closeBtn = el.querySelector(".group-close");
  closeBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (await confirmRemoveTargets({ nodes: [], groups: [g.id] })) removeGroup(g.id);
  });
  for (const b of [colorBtn, closeBtn, swatches]) stopNodeDragOn(b);

  // arrastar pelo cabeçalho move o grupo e os nodes que estão dentro dele
  header.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !title.readOnly) return;
    e.stopPropagation();
    e.preventDefault();
    selectGroup(g.id);
    const start = {
      x: e.clientX, y: e.clientY, gx: g.x, gy: g.y,
      nodes: nodesInsideGroup(g).map(n => ({ n, x: n.x, y: n.y, el: document.getElementById("node-" + n.id) })),
    };
    const onMove = (ev) => {
      const dx = (ev.clientX - start.x) / state.zoom;
      const dy = (ev.clientY - start.y) / state.zoom;
      g.x = Math.round(start.gx + dx);
      g.y = Math.round(start.gy + dy);
      renderGroup(g);
      for (const s of start.nodes) {
        s.n.x = Math.round(s.x + dx);
        s.n.y = Math.round(s.y + dy);
        s.el.style.left = s.n.x + "px";
        s.el.style.top = s.n.y + "px";
      }
      drawEdges();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      autosave();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  el.querySelector(".group-resize").addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    selectGroup(g.id);
    const start = { x: e.clientX, y: e.clientY, w: g.w, h: g.h };
    const onMove = (ev) => {
      g.w = Math.max(220, Math.round(start.w + (ev.clientX - start.x) / state.zoom));
      g.h = Math.max(120, Math.round(start.h + (ev.clientY - start.y) / state.zoom));
      renderGroup(g);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      autosave();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  // área vazia do grupo funciona como o fundo: arrasta o canvas
  el.addEventListener("pointerdown", (e) => {
    if (e.target !== el) return;
    if (isMarqueeGesture(e)) { e.preventDefault(); startMarquee(e); return; }
    if (e.button === 0) startPan(e);
  });
}

/* ---------- editor ampliado dos campos de texto ---------- */
// Clicar num campo de texto de um node abre uma folha grande sobre o canvas com o mesmo
// conteúdo: dá para ler e escrever sem depender da rolagem miúda do node. O texto é o
// mesmo objeto de params, salvo a cada tecla; Esc, ✕ ou um clique fora voltam ao node.

let expandedField = null;
let expandLockUntil = 0;  // impede reabrir logo depois de fechar (o navegador devolve o foco ao campo)

function openExpandedField(node, p, source, labelText) {
  if (expandedField || Date.now() < expandLockUntil || state.running) return;
  const def = NODE_DEFS[node.type];
  const overlay = document.createElement("div");
  overlay.className = "exp-overlay";
  overlay.innerHTML = `
    <div class="exp-sheet">
      <div class="exp-head">
        <span class="exp-icon">${def.icon}</span>
        <span class="exp-title">${escapeHtml(def.title)}</span>
        <span class="exp-dot">·</span>
        <span class="exp-label">${escapeHtml(labelText || p.key)}</span>
        <button class="exp-close" type="button" title="Fechar (Esc)">✕</button>
      </div>
      <textarea class="exp-text" spellcheck="false"></textarea>
      <div class="exp-foot">
        <span class="exp-count"></span>
        <span class="exp-hint">Esc ou clique fora para voltar — o texto é salvo enquanto você digita</span>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const sheet = overlay.querySelector(".exp-sheet");
  const text = overlay.querySelector(".exp-text");
  const count = overlay.querySelector(".exp-count");
  text.value = node.params[p.key] ?? "";

  const refreshCount = () => {
    const words = text.value.trim() ? text.value.trim().split(/\s+/).length : 0;
    count.textContent = `${text.value.length} caractere(s) · ${words} palavra(s)`;
  };
  refreshCount();

  text.addEventListener("input", () => {
    node.params[p.key] = text.value;
    if (source.isConnected) source.value = text.value;
    refreshCount();
    autosave();
  });
  text.addEventListener("keydown", (e) => {
    e.stopPropagation();   // Delete, Ctrl+C e companhia continuam sendo do texto
    if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); closeExpandedField(); }
  });
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) closeExpandedField(); });
  overlay.querySelector(".exp-close").addEventListener("click", () => closeExpandedField());

  expandedField = { node, p, source, overlay, sheet };
  growFrom(sheet, source.getBoundingClientRect());
  text.focus();
  // mantém o cursor onde o usuário clicou no campo pequeno
  text.setSelectionRange(source.selectionStart ?? text.value.length, source.selectionEnd ?? text.value.length);
}

function closeExpandedField() {
  if (!expandedField) return;
  const { node, overlay, sheet, source } = expandedField;
  expandedField = null;
  expandLockUntil = Date.now() + 300;
  const back = source.isConnected ? source.getBoundingClientRect() : null;
  overlay.classList.add("closing");
  let fechado = false;
  const done = () => {
    if (fechado) return;
    fechado = true;
    overlay.remove();
    renderNode(node);
    drawEdges();
  };
  const anim = back ? growFrom(sheet, back, true) : null;
  if (anim) {
    anim.addEventListener("finish", done);
    anim.addEventListener("cancel", done);
  }
  // rede de segurança: numa aba em segundo plano a animação não roda e nunca termina
  setTimeout(done, anim ? 220 : 0);
}

/* anima a folha entre o retângulo do campo pequeno e o tamanho final (ida ou volta) */
function growFrom(sheet, rect, reverse = false) {
  const to = sheet.getBoundingClientRect();
  if (!to.width || !rect.width) return null;
  const frames = [
    {
      transform: `translate(${rect.left + rect.width / 2 - (to.left + to.width / 2)}px, ` +
        `${rect.top + rect.height / 2 - (to.top + to.height / 2)}px) ` +
        `scale(${Math.max(0.2, rect.width / to.width)}, ${Math.max(0.1, rect.height / to.height)})`,
      opacity: 0,
    },
    { transform: "none", opacity: 1 },
  ];
  return sheet.animate(reverse ? [...frames].reverse() : frames,
    { duration: reverse ? 130 : 180, easing: "cubic-bezier(.2,.8,.2,1)" });
}

/* ---------- seleção por área, copiar e colar ---------- */
// Botão direito: menu de contexto (copiar, colar, duplicar, remover). Arrastando com ele
// — ou com Ctrl/Shift + botão esquerdo — seleciona por área. Copiar um grupo leva junto
// os nodes que estão dentro dele e as conexões entre os copiados.

const CLIP_KIND = "assets-pipeline/clip";
const CLIP_MAX_SYSTEM = 900000;   // acima disso (imagens em dataURL) fica só no recorte desta aba

let clipboard = null;             // último recorte copiado aqui
let lastPointer = { x: 0, y: 0 }; // ponteiro na tela: é onde o Ctrl+V cola
let marqueeMoved = false;         // houve arrasto com o botão direito (o menu vira o da seleção)
let clipboardPerm = null;         // PermissionStatus de clipboard-read, consultado uma vez só

canvas.addEventListener("pointermove", (e) => { lastPointer = { x: e.clientX, y: e.clientY }; });

function isNodeSelected(id) { return state.selectedNode === id || state.selection.nodes.includes(id); }
function isGroupSelected(id) { return state.selectedGroup === id || state.selection.groups.includes(id); }
function selectionSize() { return state.selection.nodes.length + state.selection.groups.length; }

function applySelectionClasses() {
  for (const n of state.nodes) document.getElementById("node-" + n.id)?.classList.toggle("selected", isNodeSelected(n.id));
  for (const g of state.groups) document.getElementById("group-" + g.id)?.classList.toggle("selected", isGroupSelected(g.id));
}

function setSelection(nodes = [], groups = []) {
  state.selectedNode = null;
  state.selectedGroup = null;
  state.selection = { nodes: [...new Set(nodes)], groups: [...new Set(groups)] };
  applySelectionClasses();
}

function clearSelection() {
  setSelection();
  applySelectionClasses();
}

function selectAll() {
  setSelection(state.nodes.map(n => n.id), state.groups.map(g => g.id));
  setStatus(`Selecionados: ${targetsLabel(currentTargets())} — botão direito ou Ctrl+C para copiar.`);
}

/* alvo das ações: a seleção por área ou, se não houver, o node/grupo selecionado */
function currentTargets() {
  if (selectionSize()) return { nodes: [...state.selection.nodes], groups: [...state.selection.groups] };
  if (state.selectedNode) return { nodes: [state.selectedNode], groups: [] };
  if (state.selectedGroup) return { nodes: [], groups: [state.selectedGroup] };
  return { nodes: [], groups: [] };
}

function hasTargets(t) { return t.nodes.length > 0 || t.groups.length > 0; }

function targetsLabel(t) {
  const parts = [];
  if (t.nodes.length) parts.push(`${t.nodes.length} node${t.nodes.length > 1 ? "s" : ""}`);
  if (t.groups.length) parts.push(`${t.groups.length} grupo${t.groups.length > 1 ? "s" : ""}`);
  return parts.join(" e ") || "nada";
}

/* ----- seleção por área ----- */

function isMarqueeGesture(e) {
  return e.button === 2 || (e.button === 0 && (e.ctrlKey || e.metaKey || e.shiftKey));
}

function boxOf(a, b) {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}
function touches(rect, box) {
  return Boolean(rect) && rect.right > box.left && rect.left < box.right && rect.bottom > box.top && rect.top < box.bottom;
}
function inside(rect, box) {
  return Boolean(rect) && rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom;
}

function startMarquee(e) {
  const el = document.getElementById("marquee");
  const start = { x: e.clientX, y: e.clientY };
  let box = boxOf(start, start);
  marqueeMoved = false;
  const onMove = (ev) => {
    box = boxOf(start, { x: ev.clientX, y: ev.clientY });
    if (box.right - box.left > 4 || box.bottom - box.top > 4) { marqueeMoved = true; el.hidden = false; }
    el.style.left = box.left + "px";
    el.style.top = box.top + "px";
    el.style.width = (box.right - box.left) + "px";
    el.style.height = (box.bottom - box.top) + "px";
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    el.hidden = true;
    if (!marqueeMoved) { clearSelection(); return; }
    // node entra se a área encostar nele; grupo, só se couber inteiro dentro
    const nodes = state.nodes.filter(n => touches(document.getElementById("node-" + n.id)?.getBoundingClientRect(), box));
    const groups = state.groups.filter(g => inside(document.getElementById("group-" + g.id)?.getBoundingClientRect(), box));
    setSelection(nodes.map(n => n.id), groups.map(g => g.id));
    setStatus(selectionSize()
      ? `Selecionados: ${targetsLabel(currentTargets())} — botão direito ou Ctrl+C para copiar.`
      : "Nada dentro da área selecionada.");
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/* ----- recorte ----- */

/* monta o recorte: nodes pedidos + os de dentro dos grupos + as conexões entre eles */
function clipFrom(t) {
  const groups = state.groups.filter(g => t.groups.includes(g.id));
  const ids = new Set(t.nodes);
  for (const g of groups) for (const n of nodesInsideGroup(g)) ids.add(n.id);
  const nodes = state.nodes.filter(n => ids.has(n.id));
  if (!nodes.length && !groups.length) return null;
  const ox = Math.min(...nodes.map(n => n.x), ...groups.map(g => g.x));
  const oy = Math.min(...nodes.map(n => n.y), ...groups.map(g => g.y));
  return {
    kind: CLIP_KIND,
    origin: { x: ox, y: oy },
    nodes: nodes.map(n => ({ id: n.id, type: n.type, x: n.x - ox, y: n.y - oy, params: { ...n.params } })),
    edges: state.edges.filter(e => ids.has(e.from.node) && ids.has(e.to.node))
      .map(e => ({ from: { ...e.from }, to: { ...e.to } })),
    groups: groups.map(g => ({ x: g.x - ox, y: g.y - oy, w: g.w, h: g.h, color: g.color, title: g.title, desc: g.desc })),
  };
}

function clipLabel(clip, t) {
  const extra = clip.nodes.length - t.nodes.length;
  return targetsLabel(t) + (extra > 0 ? ` (com ${extra} node${extra > 1 ? "s" : ""} de dentro)` : "");
}

/* a área de transferência do sistema pode pedir permissão e nunca responder: nunca esperamos por ela */
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("tempo esgotado")), ms))]);
}

function copyTargets(t) {
  const clip = clipFrom(t);
  if (!clip) { setStatus("Nada selecionado para copiar."); return null; }
  clipboard = clip;
  setStatus(`<span class="ok">Copiado: ${clipLabel(clip, t)}. Cole com Ctrl+V ou com o botão direito.</span>`);
  shareClip(clip);
  return clip;
}

/* leva o recorte para as outras abas, se o navegador deixar (imagens grandes ficam só aqui) */
function shareClip(clip) {
  const text = JSON.stringify(clip);
  if (text.length > CLIP_MAX_SYSTEM || !navigator.clipboard?.writeText) return;
  withTimeout(navigator.clipboard.writeText(text), 1500).catch(() => { /* fica só nesta aba */ });
}

/* o recorte pode vir de outra aba/workflow pela área de transferência do sistema.
   Só lemos quando a permissão já está concedida: pedir na hora trava a colagem. */
async function readClip() {
  if (!navigator.clipboard?.readText) return clipboard;
  try {
    if (!clipboardPerm) clipboardPerm = await withTimeout(navigator.permissions.query({ name: "clipboard-read" }), 400);
    if (clipboardPerm.state !== "granted") return clipboard;   // o objeto se atualiza sozinho depois
    const data = JSON.parse(await withTimeout(navigator.clipboard.readText(), 800));
    if (data?.kind === CLIP_KIND && Array.isArray(data.nodes)) return data;
  } catch { /* sem permissão, tempo esgotado ou não é um recorte: usa o daqui */ }
  return clipboard;
}

function pasteClip(clip, pos) {
  const map = {};
  const nodes = [];
  let ignorados = 0;
  for (const n of clip.nodes) {
    const node = addNode(n.type, pos.x + n.x, pos.y + n.y, n.params);
    if (!node) { ignorados++; continue; }  // tipo que não existe mais nesta versão
    map[n.id] = node.id;
    nodes.push(node.id);
  }
  for (const e of clip.edges || []) {
    if (!map[e.from.node] || !map[e.to.node]) continue;
    state.edges.push({
      id: "e" + state.nextId++,
      from: { node: map[e.from.node], port: e.from.port },
      to: { node: map[e.to.node], port: e.to.port },
    });
  }
  const groups = (clip.groups || [])
    .map(g => addGroup(pos.x + g.x, pos.y + g.y, g.w, g.h, { color: g.color, title: g.title, desc: g.desc }).id);
  drawEdges();
  autosave();
  setSelection(nodes, groups);
  setStatus(`<span class="ok">Colado: ${targetsLabel({ nodes, groups })}${ignorados ? ` — ${ignorados} node(s) de tipo desconhecido ignorados` : ""}.</span>`);
}

async function pasteAt(screenX, screenY) {
  const clip = await readClip();
  if (!clip) { setStatus("Nada copiado ainda — clique com o botão direito num node, grupo ou seleção."); return; }
  pasteClip(clip, screenToWorld(screenX, screenY));
}

function duplicateTargets(t) {
  const clip = clipFrom(t);
  if (!clip) { setStatus("Nada selecionado para duplicar."); return; }
  clipboard = clip;
  pasteClip(clip, { x: clip.origin.x + 40, y: clip.origin.y + 40 });
}

async function removeTargets(t) {
  if (!(await confirmRemoveTargets(t))) return;
  for (const id of t.nodes) removeNode(id);
  for (const id of t.groups) removeGroup(id);
  clearSelection();
}

/* confirmação de exclusão no canvas: descreve o que sai e o que fica */
function confirmRemoveTargets(t) {
  const nodes = t.nodes.map(id => state.nodes.find(n => n.id === id)).filter(Boolean);
  const groups = t.groups.map(id => state.groups.find(g => g.id === id)).filter(Boolean);
  if (!nodes.length && !groups.length) return Promise.resolve(false);
  const conexoes = state.edges.filter(e => t.nodes.includes(e.from.node) || t.nodes.includes(e.to.node)).length;
  const items = [];
  if (nodes.length === 1) items.push(`Node: ${NODE_DEFS[nodes[0].type].title} (${nodes[0].id})`);
  else if (nodes.length) items.push(`${nodes.length} nodes: ${nodes.map(n => n.id).join(", ")}`);
  if (groups.length === 1) items.push(`Grupo: “${groups[0].title}” — os nodes de dentro continuam no canvas`);
  else if (groups.length) items.push(`${groups.length} grupos — os nodes de dentro continuam no canvas`);
  if (conexoes) items.push(`${conexoes} conexão(ões) ligada(s) a esses nodes`);
  return confirmDelete({
    title: nodes.length + groups.length > 1 ? "Remover a seleção?" : "Remover?",
    text: "Isto não pode ser desfeito pelo editor.",
    items,
    note: "Dica: Ctrl+C copia antes de remover, e o menu 📋 → Saves guarda o estado atual.",
    okLabel: "Remover",
  });
}

/* ----- menu de contexto ----- */

const ctxMenu = document.getElementById("ctx-menu");

function closeContextMenu() {
  if (ctxMenu) { ctxMenu.hidden = true; ctxMenu.innerHTML = ""; }
}

function openContextMenu(x, y, items) {
  ctxMenu.innerHTML = "";
  for (const item of items) {
    if (item === "-") {
      const div = document.createElement("div");
      div.className = "menu-divider";
      ctxMenu.appendChild(div);
      continue;
    }
    const btn = document.createElement("button");
    btn.innerHTML = escapeHtml(item.label) + (item.kbd ? `<kbd>${escapeHtml(item.kbd)}</kbd>` : "");
    if (item.danger) btn.className = "ctx-danger";
    btn.addEventListener("click", () => { closeContextMenu(); item.act(); });
    ctxMenu.appendChild(btn);
  }
  ctxMenu.hidden = false;
  ctxMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - ctxMenu.offsetWidth - 8)) + "px";
  ctxMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - ctxMenu.offsetHeight - 8)) + "px";
}

canvas.addEventListener("contextmenu", (e) => {
  // em campos de texto vale o menu do navegador (copiar/colar texto)
  if (e.target.closest("input, textarea, select, [contenteditable='true']")) return;
  e.preventDefault();
  const areaSelecionada = marqueeMoved;
  marqueeMoved = false;
  if (areaSelecionada && !selectionSize()) return;

  if (!areaSelecionada) {
    const nodeEl = e.target.closest(".node");
    const groupEl = e.target.closest(".group");
    if (nodeEl) {
      const id = nodeEl.id.replace("node-", "");
      if (!isNodeSelected(id)) selectNode(id);
    } else if (groupEl) {
      const id = groupEl.id.replace("group-", "");
      if (!isGroupSelected(id)) selectGroup(id);
    }
  }

  const t = currentTargets();
  const items = [];
  if (hasTargets(t)) {
    const clip = clipFrom(t);
    const label = clip ? clipLabel(clip, t) : targetsLabel(t);
    items.push({ label: `📋 Copiar ${label}`, kbd: "Ctrl+C", act: () => copyTargets(t) });
    items.push({ label: `⧉ Duplicar ${label}`, kbd: "Ctrl+D", act: () => duplicateTargets(t) });
  }
  items.push({ label: "📥 Colar aqui", kbd: "Ctrl+V", act: () => pasteAt(e.clientX, e.clientY) });
  if (hasTargets(t)) {
    items.push("-");
    items.push({ label: `🗑 Remover ${targetsLabel(t)}`, kbd: "Delete", danger: true, act: () => removeTargets(t) });
  }
  items.push("-");
  items.push({ label: "⬚ Selecionar tudo", kbd: "Ctrl+A", act: selectAll });
  if (selectionSize()) items.push({ label: "✖ Limpar seleção", kbd: "Esc", act: clearSelection });
  openContextMenu(e.clientX, e.clientY, items);
});

/* ---------- conexões (edges) ---------- */

let tempEdge = null; // {fromNode, fromPort, direction, dtype, mouse:{x,y}}

function portScreenPos(nodeId, portKey, direction) {
  const el = document.querySelector(
    `.port[data-node="${nodeId}"][data-port="${portKey}"][data-direction="${direction}"]`
  );
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const cRect = canvas.getBoundingClientRect();
  return { x: rect.left + rect.width / 2 - cRect.left, y: rect.top + rect.height / 2 - cRect.top };
}

function edgePath(x1, y1, x2, y2) {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function drawEdges() {
  edgesSvg.innerHTML = "";
  for (const edge of state.edges) {
    const p1 = portScreenPos(edge.from.node, edge.from.port, "out");
    const p2 = portScreenPos(edge.to.node, edge.to.port, "in");
    if (!p1 || !p2) continue;
    const fromNode = state.nodes.find(n => n.id === edge.from.node);
    const dtype = fromNode
      ? (NODE_DEFS[fromNode.type].outputs.find(o => o.key === edge.from.port)?.dtype || "any")
      : "any";
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", edgePath(p1.x, p1.y, p2.x, p2.y));
    path.setAttribute("class", "edge");
    path.setAttribute("stroke", DTYPE_COLORS[dtype] || DTYPE_COLORS.any);
    path.addEventListener("dblclick", () => removeEdge(edge.id));
    edgesSvg.appendChild(path);
  }
  if (tempEdge) {
    const anchor = portScreenPos(tempEdge.fromNode, tempEdge.fromPort, tempEdge.direction);
    if (anchor) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const m = tempEdge.mouse;
      const d = tempEdge.direction === "out"
        ? edgePath(anchor.x, anchor.y, m.x, m.y)
        : edgePath(m.x, m.y, anchor.x, anchor.y);
      path.setAttribute("d", d);
      path.setAttribute("class", "edge-temp");
      edgesSvg.appendChild(path);
    }
  }
}

/* conecta uma saída a uma entrada com as regras da UI: tipos iguais ou "any"; entrada multi
   acumula conexões, entrada comum substitui a existente. { ok, error?, edge?, replaced? } */
function connectPorts(from, to) {
  const fromNode = state.nodes.find(n => n.id === from.node);
  const toNode = state.nodes.find(n => n.id === to.node);
  if (!fromNode || !toNode) return { ok: false, error: `Node não encontrado: ${!fromNode ? from.node : to.node}` };
  if (from.node === to.node) return { ok: false, error: "Um node não pode se conectar a ele mesmo." };
  const outDef = NODE_DEFS[fromNode.type].outputs.find(o => o.key === from.port);
  const inDef = NODE_DEFS[toNode.type].inputs.find(i => i.key === to.port);
  if (!outDef) return { ok: false, error: `Saída “${from.port}” não existe em ${from.node}.` };
  if (!inDef) return { ok: false, error: `Entrada “${to.port}” não existe em ${to.node}.` };
  // saída “any” (ex.: lista do Coletar) conecta em qualquer entrada; o tipo real vai junto no valor
  if (!(inDef.dtype === "any" || outDef.dtype === "any" || outDef.dtype === inDef.dtype)) {
    return { ok: false, error: `Tipos incompatíveis: ${outDef.dtype} → ${inDef.dtype}` };
  }
  const intoPort = (ed) => ed.to.node === to.node && ed.to.port === to.port;
  const sameSource = (ed) => ed.from.node === from.node && ed.from.port === from.port;
  // entrada multi: aceita várias conexões — só evita duplicar a mesma; comum: substitui a existente
  const replaced = state.edges.filter(ed => intoPort(ed) && (!inDef.multi || sameSource(ed)));
  state.edges = state.edges.filter(ed => !replaced.includes(ed));
  const edge = { id: "e" + state.nextId++, from: { ...from }, to: { ...to } };
  state.edges.push(edge);
  autosave();
  return { ok: true, edge, replaced };
}

function removeEdge(edgeId) {
  const before = state.edges.length;
  state.edges = state.edges.filter(e => e.id !== edgeId);
  if (state.edges.length === before) return false;
  drawEdges();
  autosave();
  return true;
}

function startEdgeDrag(nodeId, portKey, direction, dtype, e) {
  const cRect = canvas.getBoundingClientRect();
  tempEdge = {
    fromNode: nodeId, fromPort: portKey, direction, dtype,
    mouse: { x: e.clientX - cRect.left, y: e.clientY - cRect.top },
  };
  const onMove = (ev) => {
    tempEdge.mouse = { x: ev.clientX - cRect.left, y: ev.clientY - cRect.top };
    drawEdges();
  };
  const onUp = (ev) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    if (target?.classList?.contains("port")) {
      const tNode = target.dataset.node;
      const tPort = target.dataset.port;
      const tDir = target.dataset.direction;
      const tDtype = target.dataset.dtype;
      if (tDir !== direction && tNode !== nodeId) {
        const from = direction === "out"
          ? { node: nodeId, port: portKey }
          : { node: tNode, port: tPort };
        const to = direction === "out"
          ? { node: tNode, port: tPort }
          : { node: nodeId, port: portKey };
        const res = connectPorts(from, to);
        if (!res.ok) setStatus(`<span class="err">${escapeHtml(res.error)}</span>`);
      }
    }
    tempEdge = null;
    drawEdges();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/* ---------- motor de execução ---------- */

function topologicalOrder(nodeIds) {
  const ids = nodeIds || state.nodes.map(n => n.id);
  const idSet = new Set(ids);
  const indegree = new Map(ids.map(id => [id, 0]));
  for (const e of state.edges) {
    if (idSet.has(e.from.node) && idSet.has(e.to.node)) {
      indegree.set(e.to.node, (indegree.get(e.to.node) || 0) + 1);
    }
  }
  const queue = ids.filter(id => indegree.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const e of state.edges) {
      if (e.from.node === id && idSet.has(e.to.node)) {
        indegree.set(e.to.node, indegree.get(e.to.node) - 1);
        if (indegree.get(e.to.node) === 0) queue.push(e.to.node);
      }
    }
  }
  if (order.length !== ids.length) throw new Error("O workflow contém um ciclo — remova conexões circulares.");
  return order;
}

function upstreamOf(nodeId) {
  const visited = new Set();
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const e of state.edges) {
      if (e.to.node === id) stack.push(e.from.node);
    }
  }
  return [...visited];
}

function gatherInputs(node) {
  const def = NODE_DEFS[node.type];
  const inputs = {};
  for (const inp of def.inputs) {
    const edges = state.edges.filter(e => e.to.node === node.id && e.to.port === inp.key);
    if (!edges.length) continue;
    if (!inp.multi) {
      const src = state.nodes.find(n => n.id === edges[0].from.node);
      if (src?.result && src.result[edges[0].from.port]) inputs[inp.key] = src.result[edges[0].from.port];
      continue;
    }
    // entrada multi: agrega os valores (com meta e tipo de cada item) de todas as conexões
    const agg = { values: [], meta: [], types: [] };
    for (const edge of edges) {
      const src = state.nodes.find(n => n.id === edge.from.node);
      const v = src?.result?.[edge.from.port];
      if (v) pushPortValues(agg, v);
    }
    if (agg.values.length) inputs[inp.key] = packPortValues(agg.types[0], agg.values, agg.meta, agg.types);
  }
  return inputs;
}

/* Valores de porta: { type, value } (único) ou { type, values: [...] } (lista).
   Quando uma entrada é lista, o node executa uma vez por item (produto
   cartesiano se houver mais de uma entrada em lista) e as saídas são agregadas. */

function expandInputCombos(raw, noExpand = new Set()) {
  let combos = [{}];
  for (const [key, val] of Object.entries(raw)) {
    if (Array.isArray(val?.values) && !noExpand.has(key)) {
      const next = [];
      for (const combo of combos) {
        val.values.forEach((item, i) => {
          // meta (ex.: texto e seed de um áudio gerado) acompanha cada item
          const meta = Array.isArray(val.meta) ? val.meta[i] : null;
          const type = val.types?.[i] || val.type;
          next.push({ ...combo, [key]: meta ? { type, value: item, meta } : { type, value: item } });
        });
      }
      combos = next;
    } else {
      combos = combos.map(c => ({ ...c, [key]: val }));
    }
  }
  return combos;
}

/* meta (opcional) e o tipo de cada item ficam alinhados item a item com os valores de uma porta;
   “types” só aparece quando a lista mistura tipos (ex.: Coletar resultados com áudios e imagens) */
function pushPortValues(target, res) {
  const list = Array.isArray(res.values);
  const vals = list ? res.values : [res.value];
  const metas = list ? (Array.isArray(res.meta) ? res.meta : []) : [res.meta];
  const types = list && Array.isArray(res.types) ? res.types : [];
  vals.forEach((v, i) => {
    target.values.push(v);
    target.meta.push(metas[i] ?? null);
    if (target.types) target.types.push(types[i] || res.type);
  });
  // combinações que o node tentou e não conseguiu gerar — viajam junto para o “↻ Refazer os que falharam”
  if (Array.isArray(res.failed) && res.failed.length && target.failed) target.failed.push(...res.failed);
}

function packPortValues(type, values, meta, types = [], failed = []) {
  const hasMeta = meta.some(Boolean);
  let packed;
  if (values.length === 1) {
    const itemType = types[0] || type;
    packed = hasMeta ? { type: itemType, value: values[0], meta: meta[0] } : { type: itemType, value: values[0] };
  } else {
    packed = hasMeta ? { type, values, meta } : { type, values };
    if (types.some(t => t && t !== type)) packed.types = types;
  }
  if (failed.length) packed.failed = failed;
  return packed;
}

async function executeNode(node) {
  const def = NODE_DEFS[node.type];
  node.status = "running";
  node.error = null;
  node.warning = null;
  node.progress = "Executando…";
  node.debug = { startedAt: Date.now(), duration: null, inputs: null, outputs: null, log: [] };
  const dbg = (msg) => node.debug.log.push(`[${new Date().toLocaleTimeString("pt-BR")}] ${msg}`);
  renderNode(node);
  drawEdges();
  const ctx = {
    progress: (msg) => {
      node.progress = msg;
      dbg(msg);
      renderNode(node);
      drawEdges();
      // com vários nodes rodando, a barra de status mostra o resumo em vez de um node só
      if (runInfo) updateRunStatus();
      else setStatus(`<span class="run">⏳ ${nodeTitle(node)}: ${escapeHtml(msg)}</span>`);
    },
    log: dbg,
    node, // objeto do node em execução (ex.: o Arquivo de texto guarda nele o handle do arquivo)
    // avisos viram o balão amarelo do node (sem falhar a execução)
    warn: (msg) => {
      if (!runWarnings.includes(msg)) runWarnings.push(msg);
      dbg("⚠ " + msg);
    },
    setParam: (key, value) => { node.params[key] = value; autosave(); },
  };
  const runWarnings = [];
  try {
    // interpola prompts salvos ({{nome}}) nos parâmetros de texto do node
    const runParams = {};
    for (const [k, v] of Object.entries(node.params)) {
      runParams[k] = (typeof v === "string" && !v.startsWith("data:")) ? expandPromptRefs(v, ctx) : v;
    }
    const raw = gatherInputs(node);
    node.debug.inputs = Object.keys(raw).length
      ? Object.entries(raw).map(([k, v]) => `  ${k} = ${summarizeValue(v)}`).join("\n")
      : "  (nenhuma)";
    // entradas marcadas com list:true recebem a lista inteira (sem fan-out)
    const noExpand = new Set((def.inputs || []).filter(i => i.list).map(i => i.key));
    const combos = expandInputCombos(raw, noExpand);
    dbg(`Início — ${combos.length} execução(ões).`);
    const acc = {};
    const display = { values: [], meta: [], types: [] };
    const itemErrors = [];
    let displayType = null;
    let stoppedEarly = false;
    for (let i = 0; i < combos.length; i++) {
      if (state.stopRequested) {
        stoppedEarly = true;
        dbg("Interrompido pelo usuário — mantendo os resultados já gerados.");
        break;
      }
      const itemStart = performance.now();
      if (combos.length > 1) ctx.progress(`Item ${i + 1}/${combos.length}…`);
      let out;
      try {
        out = await def.run(combos[i], runParams, ctx);
      } catch (err) {
        const msg = err.message || String(err);
        itemErrors.push(combos.length > 1 ? `Item ${i + 1}: ${msg}` : msg);
        dbg(`✖ ${combos.length > 1 ? `Item ${i + 1}/${combos.length}` : "Execução"} falhou: ${msg}`);
        continue;
      }
      dbg(`${combos.length > 1 ? `Item ${i + 1}/${combos.length} concluído` : "Execução concluída"} em ${((performance.now() - itemStart) / 1000).toFixed(1)}s.`);
      // registra imagens/modelos no histórico com o prompt (entrada de texto) desta execução
      if (["Imagem", "3D", "Áudio"].includes(def.category)) {
        const promptVal = Object.values(combos[i]).find(v => v?.type === "text")?.value || null;
        for (const [port, res] of Object.entries(out)) {
          if (port === "__display" || !res) continue;
          // mídia gerada guarda o texto que a originou (legenda, nome de arquivo no Coletar, Salvar voz…)
          if (promptVal && !res.meta && ["image", "model3d", "audio"].includes(res.type)) {
            res.meta = Array.isArray(res.values) ? res.values.map(() => ({ text: promptVal })) : { text: promptVal };
          }
          if (res.noHistory) continue;
          if (["image", "model3d", "audio"].includes(res.type)) {
            const vals = Array.isArray(res.values) ? res.values : [res.value];
            for (const v of vals) historyAdd({ type: res.type, value: v, source: nodeTitle(node), prompt: promptVal });
          }
        }
      }
      for (const [port, res] of Object.entries(out)) {
        if (port === "__display") {
          displayType = displayType || res.type;
          pushPortValues(display, res);
          continue;
        }
        if (!acc[port]) acc[port] = { type: res.type, values: [], meta: [], types: [], failed: [] };
        pushPortValues(acc[port], res);
      }
    }
    const producedNothing = Object.keys(acc).length === 0 && display.values.length === 0;
    if (producedNothing && itemErrors.length) {
      // todas as execuções falharam — aí sim o node inteiro falha
      throw new Error(itemErrors.join("\n"));
    }
    if (producedNothing && stoppedEarly) {
      node.status = "idle";
      node.progress = null;
      node.debug.duration = Date.now() - node.debug.startedAt;
      renderNode(node);
      drawEdges();
      return false;
    }
    const result = {};
    for (const [port, r] of Object.entries(acc)) result[port] = packPortValues(r.type, r.values, r.meta, r.types, r.failed);
    if (display.values.length) result.__display = packPortValues(displayType, display.values, display.meta, display.types);
    node.result = result;
    node.status = "done";
    node.progress = null;
    if (itemErrors.length) {
      node.warning = `${itemErrors.length} de ${combos.length} item(ns) falharam — os demais foram mantidos:\n${itemErrors.join("\n")}`;
      dbg(`⚠ Concluído parcialmente: ${itemErrors.length} falha(s) de ${combos.length}.`);
    } else if (stoppedEarly) {
      node.warning = "Execução interrompida — resultados parciais mantidos.";
    }
    if (runWarnings.length) node.warning = [node.warning, ...runWarnings].filter(Boolean).join("\n");
    node.debug.duration = Date.now() - node.debug.startedAt;
    node.debug.outputs = Object.keys(result).length
      ? Object.entries(result).filter(([k]) => k !== "__display")
          .map(([k, v]) => `  ${k} = ${summarizeValue(v)}`).join("\n") || "  (apenas exibição)"
      : "  (nenhuma)";
    dbg(`✔ Node concluído em ${(node.debug.duration / 1000).toFixed(1)}s.`);
    saveSessionSoon();
    renderNode(node);
    drawEdges();
    return true;
  } catch (err) {
    node.status = "error";
    node.progress = null;
    node.error = err.message || String(err);
    node.debug.duration = Date.now() - node.debug.startedAt;
    dbg(`✖ ERRO: ${node.error}`);
    renderNode(node);
    drawEdges();
    return false;
  }
}

/* Quantos nodes podem rodar AO MESMO TEMPO em cada fila. O servidor local atende um pedido por
   vez (é uma GPU só), as APIs na nuvem aguentam algumas chamadas simultâneas, e os nodes que só
   mexem em texto/arquivo são instantâneos. Quem não encontra vaga espera na fila. */
const RUN_LIMITS = { local: 1, rede: 4, cpu: 8 };

function runLane(node) {
  const def = NODE_DEFS[node.type];
  if (def?.local) return "local";          // Qwen3-TTS, Claude Code: servidor local
  return def?.endpoint ? "rede" : "cpu";   // APIs vs. nodes locais de CPU
}

/* estado da execução em curso — alimenta a barra de status e o selo “na fila” dos nodes */
let runInfo = null;

function updateRunStatus() {
  if (!runInfo) return;
  const rodando = [...runInfo.rodando.values()];
  const fila = runInfo.fila.size;
  if (!rodando.length && !fila) return;
  const sufixo = fila ? ` · ${fila} na fila` : "";
  if (rodando.length === 1) {
    const n = rodando[0];
    setStatus(`<span class="run">⏳ ${nodeTitle(n)}${n.progress ? ": " + escapeHtml(n.progress) : ""}${sufixo}</span>`);
  } else {
    setStatus(`<span class="run">⏳ ${rodando.length} nodes rodando${sufixo}</span>`);
  }
}

async function runNodes(nodeIds, opts = {}) {
  if (state.running) return;
  state.running = true;
  state.stopRequested = false;
  document.getElementById("btn-run").disabled = true;
  document.getElementById("btn-stop").disabled = false;

  let order;
  try {
    order = topologicalOrder(nodeIds);
  } catch (err) {
    setStatus(`<span class="err">✖ ${err.message}</span>`);
    finishRun();
    return;
  }

  const pendentes = new Set(order);
  const falhos = new Set();
  const executadosOk = new Set();
  const emVoo = new Map();                       // id → promessa em andamento
  const emUso = { local: 0, rede: 0, cpu: 0 };
  runInfo = { rodando: new Map(), fila: new Set(), ok: 0, pulados: 0 };

  const depsDe = (id) => state.edges.filter(e => e.to.node === id).map(e => e.from.node);

  const disparar = (node) => {
    const lane = runLane(node);
    emUso[lane]++;
    runInfo.rodando.set(node.id, node);
    runInfo.fila.delete(node.id);
    const p = executeNode(node)
      .then(ok => { if (ok) { runInfo.ok++; executadosOk.add(node.id); } else falhos.add(node.id); })
      .catch(() => { falhos.add(node.id); })
      .finally(() => { emUso[lane]--; runInfo.rodando.delete(node.id); emVoo.delete(node.id); });
    emVoo.set(node.id, p);
  };

  while ((pendentes.size || emVoo.size) && !state.stopRequested) {
    let disparouAlgum = false;
    for (const id of [...pendentes]) {
      if (state.stopRequested) break;
      const node = state.nodes.find(n => n.id === id);
      if (!node) { pendentes.delete(id); continue; }
      const deps = depsDe(id);
      if (deps.some(dep => pendentes.has(dep) || emVoo.has(dep))) continue;   // ainda depende de alguém
      if (deps.some(dep => falhos.has(dep))) {
        pendentes.delete(id);
        runInfo.fila.delete(id);
        falhos.add(id);
        node.status = "idle";
        node.error = "Não executado: um node anterior falhou.";
        renderNode(node);
        continue;
      }
      // execução de um node específico: reaproveita outputs já existentes dos anteriores
      if (opts.skipDone && id !== opts.targetId && node.status === "done" && node.result) {
        pendentes.delete(id);
        runInfo.pulados++;
        continue;
      }
      if (emUso[runLane(node)] >= RUN_LIMITS[runLane(node)]) {
        if (!runInfo.fila.has(id)) {          // sem vaga na fila do recurso: espera a vez
          runInfo.fila.add(id);
          node.status = "queued";
          node.progress = null;
          renderNode(node);
        }
        continue;
      }
      pendentes.delete(id);
      disparar(node);
      disparouAlgum = true;
    }
    updateRunStatus();
    if (!emVoo.size) {
      if (!disparouAlgum) break;    // nada rodando e nada pôde começar: não há o que esperar
      continue;
    }
    await Promise.race([...emVoo.values()]);
  }
  await Promise.allSettled([...emVoo.values()]);

  // nodes que ficaram na fila quando a execução parou voltam ao estado neutro
  for (const id of [...runInfo.fila, ...pendentes]) {
    const n = state.nodes.find(x => x.id === id);
    if (n && n.status === "queued") { n.status = "idle"; n.progress = null; renderNode(n); }
  }

  const { ok, pulados } = runInfo;
  if (state.stopRequested) setStatus(`<span class="err">Execução interrompida.</span>`);
  else {
    // visualizadores conectados a nodes que acabaram de rodar atualizam sozinhos
    await refreshDownstreamOutputs(executadosOk);
    const skipMsg = pulados ? ` (${pulados} reaproveitado(s))` : "";
    if (falhos.size === 0) setStatus(`<span class="ok">✔ Concluído — ${ok} node(s) executado(s)${skipMsg}.</span>`);
    else setStatus(`<span class="err">Execução terminou com ${falhos.size} falha(s)${skipMsg}.</span>`);
  }
  finishRun();
}

/* Visualizador e Coletar alimentados pelos nodes de `sourceIds` são reexecutados: sem isto o
   zip/áudio único ficaria com o resultado velho depois de uma regeneração ou de um run. */
async function refreshDownstreamOutputs(sourceIds) {
  const sources = sourceIds instanceof Set ? sourceIds : new Set(sourceIds);
  for (const out of state.nodes) {
    if (!["viewer", "collector"].includes(out.type) || sources.has(out.id)) continue;
    if (state.edges.some(e => e.to.node === out.id && sources.has(e.from.node))) await executeNode(out);
  }
}

function finishRun() {
  runInfo = null;
  state.running = false;
  document.getElementById("btn-run").disabled = false;
  document.getElementById("btn-stop").disabled = true;
  saveSessionSoon();
}

function runWorkflow() { return runNodes(null); }
function runSingleNode(nodeId) { return runNodes(upstreamOf(nodeId), { targetId: nodeId, skipDone: true }); }

/* ---------- persistência ---------- */

const GRAPH_STORAGE = "assets-pipeline-graph";

function serializeGraph() {
  return {
    version: 1,
    nextId: state.nextId,
    nodes: state.nodes.map(n => {
      const out = { id: n.id, type: n.type, x: n.x, y: n.y, params: n.params };
      if (n.w) out.w = n.w;        // tamanho definido na alça do node
      if (n.h) out.h = n.h;
      return out;
    }),
    edges: state.edges,
    groups: state.groups.map(g => ({ ...g })),
  };
}

function loadGraph(data) {
  world.innerHTML = "";
  state.nodes = [];
  state.edges = [];
  state.groups = [];
  closeExpandedField();
  state.selectedNode = null;
  state.selectedGroup = null;
  state.selection = { nodes: [], groups: [] };
  state.nextId = data.nextId || 1;
  for (const g of data.groups || []) addGroup(g.x, g.y, g.w, g.h, g);
  for (const n of data.nodes || []) {
    if (!NODE_DEFS[n.type]) continue;
    const novo = addNode(n.type, n.x, n.y, n.params, n.id);
    if (novo && (n.w || n.h)) {
      if (n.w) novo.w = n.w;
      if (n.h) novo.h = n.h;
      renderNode(novo);
    }
  }
  state.edges = (data.edges || []).filter(e =>
    state.nodes.some(n => n.id === e.from.node) && state.nodes.some(n => n.id === e.to.node)
  );
  drawEdges();
  autosave();
}

/* hash rápido (cyrb53) — detecta alterações no grafo sem guardar uma segunda cópia */
function graphHash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
function currentGraphHash() { return graphHash(JSON.stringify(serializeGraph())); }

/* auto-save do grafo: cada alteração vai para um rascunho por workflow no IndexedDB
   ("draft:<id>") e, como cópia síncrona, para o localStorage. Trocar de workflow ou fechar a
   aba não perde edições; o template em si só muda no 💾 Salvar. state.savedHash é o hash da
   última versão salva — diferente do atual = alterações não salvas. */
const GRAPH_META_STORAGE = "assets-pipeline-graph-meta"; // { workflowId, ts } da cópia no localStorage
const DRAFT_PREFIX = "draft:";
let autosaveTimer = null;
let lastDraftKey = null;

function autosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(persistDraft, 400);
}

function persistDraft() {
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  const graph = serializeGraph();
  const json = JSON.stringify(graph);
  const hash = graphHash(json);
  const dirty = hash !== state.savedHash;
  setDirty(dirty);
  const ts = Date.now();
  try {
    localStorage.setItem(GRAPH_STORAGE, json);
    localStorage.setItem(GRAPH_META_STORAGE, JSON.stringify({ workflowId: state.workflowId, ts }));
  } catch {
    // quota excedida (imagens grandes): o rascunho no IndexedDB continua valendo; a cópia velha
    // sai do localStorage para não passar na frente dele na próxima abertura
    try { localStorage.removeItem(GRAPH_STORAGE); localStorage.removeItem(GRAPH_META_STORAGE); } catch { /* ignora */ }
  }
  const key = `${state.workflowId}|${hash}|${state.savedHash}`;
  if (key === lastDraftKey) return Promise.resolve(true);
  lastDraftKey = key;
  return idbPut("session", {
    id: DRAFT_PREFIX + state.workflowId, workflowId: state.workflowId, kind: "draft",
    graph, savedHash: state.savedHash, dirty, ts,
  }).then(ok => { if (!ok) lastDraftKey = null; return ok; });
}

/* grava na hora o que estiver agendado — antes de trocar de workflow, exportar, fechar a aba… */
function flushPendingSaves() {
  const jobs = [];
  if (autosaveTimer) jobs.push(persistDraft());
  if (sessionSaveTimer) jobs.push(persistSession());
  return Promise.all(jobs);
}

/* ---------- workflows de exemplo ---------- */

const EXAMPLES = {
  ex1: {
    nextId: 100,
    nodes: [
      { id: "n1", type: "text-input", x: 40, y: 150, params: { text: "Raposa cyberpunk em cenários urbanos noturnos" } },
      { id: "n2", type: "openai-text", x: 340, y: 90, params: {
        model: "gpt-5.6-luna",
        system: "Você é um especialista em prompts para geração de imagens. Recebendo um conceito, gere 3 prompts detalhados e DISTINTOS em inglês para um gerador de imagens (variando composição, iluminação e estilo). Responda APENAS com os prompts, um por linha, sem numeração e sem explicações.",
        temperature: 0.9,
      } },
      { id: "n5", type: "split-text", x: 650, y: 140, params: { mode: "linhas", maxItems: 0 } },
      { id: "n3", type: "openai-image", x: 950, y: 110, params: { model: "gpt-image-2", size: "1024x1024", quality: "medium", n: 1 } },
      { id: "n4", type: "viewer", x: 1270, y: 170, params: {} },
    ],
    edges: [
      { id: "e1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } },
      { id: "e2", from: { node: "n2", port: "text" }, to: { node: "n5", port: "text" } },
      { id: "e4", from: { node: "n5", port: "items" }, to: { node: "n3", port: "prompt" } },
      { id: "e3", from: { node: "n3", port: "image" }, to: { node: "n4", port: "input" } },
    ],
  },
  ex2: {
    nextId: 200,
    nodes: [
      { id: "n1", type: "text-input", x: 60, y: 160, params: { text: "A cute isometric wooden treasure chest, game asset, white background, studio lighting, 3D render style" } },
      { id: "n2", type: "openai-image", x: 380, y: 120, params: { model: "gpt-image-2", size: "1024x1024", quality: "medium", n: 1 } },
      { id: "n3", type: "trellis-3d", x: 700, y: 100, params: { space: "microsoft/TRELLIS", randomizeSeed: true, seed: 0, textureSize: "1024" } },
      { id: "n4", type: "viewer", x: 1030, y: 160, params: {} },
    ],
    edges: [
      { id: "e1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } },
      { id: "e2", from: { node: "n2", port: "image" }, to: { node: "n3", port: "image" } },
      { id: "e3", from: { node: "n3", port: "model" }, to: { node: "n4", port: "input" } },
    ],
  },
  ex3: {
    nextId: 300,
    nodes: [
      { id: "n1", type: "text-input", x: 40, y: 96, params: { text: "Bem-vindo a Eldoria, viajante. Faz tempo que ninguém atravessa o portão norte.\nAs estradas estão tomadas por lobos; siga pela trilha do rio e não pare depois do anoitecer.\nSe precisar de suprimentos, procure o ferreiro perto da praça. Diga que fui eu quem mandou." } },
      { id: "n2", type: "split-text", x: 330, y: 96, params: { mode: "linhas", maxItems: 0 } },
      { id: "n3", type: "qwen3-tts-voice", x: 40, y: 676, params: {
        name: "guarda_eldoria",
        source: "design",
        instruct: "Homem de uns 50 anos, voz grave e levemente rouca, fala pausada e protetora, tom de guarda veterano de um reino medieval.",
        refText: "Alto lá, viajante! Antes de cruzar o portão, diga seu nome e o que procura em nossas terras.",
        language: "Portuguese",
        seed: 42,
      } },
      { id: "n4", type: "qwen3-tts", x: 690, y: 96, params: { language: "Portuguese", sampling: "equilibrado", seedMode: "profile" } },
      { id: "n5", type: "viewer", x: 1000, y: 150, params: {} },
      { id: "n6", type: "collector", x: 1000, y: 460, params: { pattern: "{n}_{voz}_{texto}" } },
    ],
    groups: [
      { id: "g1", x: 20, y: 20, w: 580, h: 560, color: "#6ea8fe", title: "Roteiro", desc: "Uma fala por linha — o Dividir transforma em lista" },
      { id: "g2", x: 20, y: 600, w: 290, h: 720, color: "#f6d65c", title: "Voz do personagem", desc: "Perfil persistente: rode quantas vezes quiser, a voz não muda" },
      { id: "g3", x: 670, y: 20, w: 610, h: 900, color: "#5fd4a0", title: "Geração", desc: "Todas as falas com a mesma voz e a mesma seed" },
    ],
    edges: [
      { id: "e1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "text" } },
      { id: "e2", from: { node: "n2", port: "items" }, to: { node: "n4", port: "text" } },
      { id: "e3", from: { node: "n3", port: "voice" }, to: { node: "n4", port: "voice" } },
      { id: "e4", from: { node: "n4", port: "audio" }, to: { node: "n5", port: "input" } },
      { id: "e5", from: { node: "n4", port: "audio" }, to: { node: "n6", port: "input" } },
    ],
  },
  blank: { nextId: 1, nodes: [], edges: [] },
};

/* ---------- UI: topbar, modais, atalhos ---------- */

document.getElementById("btn-run").addEventListener("click", runWorkflow);
document.getElementById("btn-stop").addEventListener("click", () => { state.stopRequested = true; });

/* ---------- workflows, rascunhos e saves ---------- */
/* Onde cada coisa fica (IndexedDB "assets-pipeline-history"):
   - workflows                 { id, name, graph, ts, created } — versão salva de cada workflow seu
   - session draft:<id>        { graph, savedHash, dirty, ts }  — grafo em edição (auto-save contínuo)
   - session auto:<id>         { results, ts }                  — resultados dos nodes (auto-save)
   - session manual:<id>:<ts>  { name, graph, results, ts }     — saves nomeados (snapshots)
   Exemplos embutidos e o "rascunho" não têm registro em workflows: só rascunho em edição e saves. */

const CURRENT_WF_STORAGE = "assets-pipeline-current-workflow";
const BACKUP_FORMAT = "assets-pipeline-backup";
const DRAFT_ID = "rascunho";
const EMPTY_GRAPH = { nextId: 1, nodes: [], edges: [] };
const BUILTIN_WORKFLOWS = {
  ex1: { name: "Exemplo 1 — Texto → Prompts → Imagens" },
  ex2: { name: "Exemplo 2 — Prompt → Imagem → 3D" },
  ex3: { name: "Exemplo 3 — Falas com voz consistente (Qwen3-TTS local)" },
};
state.workflowId = "ex1";
state.workflowName = BUILTIN_WORKFLOWS.ex1.name;
state.savedHash = null;
state.dirty = false;

function isUserWorkflow(id = state.workflowId) {
  return !BUILTIN_WORKFLOWS[id] && id !== DRAFT_ID;
}

function fmtDate(ts) { return new Date(ts).toLocaleString("pt-BR"); }

function newWorkflowId() { return "wf" + Date.now() + Math.random().toString(36).slice(2, 6); }

function dirtyLabel() {
  if (BUILTIN_WORKFLOWS[state.workflowId]) return "editado — difere do exemplo original";
  if (state.workflowId === DRAFT_ID) return "rascunho — ainda não salvo como workflow";
  return "alterações não salvas";
}

function updateWorkflowButton() {
  const name = state.workflowName || "Workflows";
  document.getElementById("wf-name").textContent = name.length > 34 ? name.slice(0, 34) + "…" : name;
  document.getElementById("wf-dirty").hidden = !state.dirty;
  document.getElementById("btn-examples").title = state.dirty
    ? `${name} — ${dirtyLabel()} (Ctrl+S salva)`
    : "Workflows, templates e saves";
}

function setDirty(dirty) {
  if (state.dirty === dirty) return;
  state.dirty = dirty;
  updateWorkflowButton();
}

function setCurrentWorkflow(id, name) {
  state.workflowId = id;
  state.workflowName = name;
  try { localStorage.setItem(CURRENT_WF_STORAGE, JSON.stringify({ id, name })); } catch { /* ignora */ }
  updateWorkflowButton();
  window.dispatchEvent(new CustomEvent("workflow-changed", { detail: { id, name } }));
}

/* nomes já usados (minúsculos) — workflows seus + embutidos */
async function workflowNames(exceptId = null) {
  const names = new Set([...Object.values(BUILTIN_WORKFLOWS).map(w => w.name.toLowerCase()), "rascunho"]);
  for (const w of await idbAll("workflows")) if (w.id !== exceptId) names.add(String(w.name).toLowerCase());
  return names;
}

function uniqueName(base, taken) {
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const name = `${base} (${i})`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/* Abre um workflow. Usa o rascunho em edição quando houver (nada se perde ao trocar de
   workflow); senão, a versão salva. opts.local = cópia do localStorage (usada na inicialização
   quando é mais nova que o rascunho do IndexedDB); opts.discardDraft volta à versão salva.
   Devolve { restored } (nodes com resultados restaurados) ou null se não achar o workflow. */
async function loadWorkflow(id, opts = {}) {
  await flushPendingSaves();
  let name, base, tpl = null;
  if (BUILTIN_WORKFLOWS[id] && EXAMPLES[id]) {
    name = BUILTIN_WORKFLOWS[id].name;
    base = EXAMPLES[id];
  } else if (id === DRAFT_ID) {
    name = "Rascunho";
    base = EMPTY_GRAPH;
  } else {
    tpl = await idbGet("workflows", id);
    if (tpl) {
      name = tpl.name;
      base = tpl.graph;
    } else if (opts.local) {
      // o workflow aberto foi excluído, mas o grafo continuava na tela: vira rascunho em vez de sumir
      await snapshotDraft(DRAFT_ID, "Rascunho anterior");
      id = DRAFT_ID;
      name = "Rascunho";
      base = EMPTY_GRAPH;
      opts = { ...opts, local: { ...opts.local, ts: Infinity } };
    } else {
      setStatus(`<span class="err">Workflow não encontrado — foi excluído?</span>`);
      return null;
    }
  }

  const draft = opts.discardDraft ? null : await idbGet("session", DRAFT_PREFIX + id);
  // rascunho sem alterações e mais velho que a versão salva (ex.: salva em outra aba) perde a vez
  const draftUsable = Boolean(draft?.graph) && (draft.dirty || !(tpl && tpl.ts > draft.ts));
  const useLocal = Boolean(opts.local?.graph) && opts.local.ts > (draftUsable ? draft.ts : tpl?.ts || 0);
  let graph = base;
  let savedHash = null;
  if (draftUsable) { graph = draft.graph; savedHash = draft.savedHash ?? null; }
  if (useLocal) graph = opts.local.graph;

  setCurrentWorkflow(id, name);
  lastDraftKey = null;
  if (savedHash == null || graph === base) {
    // hash da versão salva, calculado depois de normalizada pelo loadGraph (params padrão etc.)
    loadGraph(structuredClone(base));
    savedHash = currentGraphHash();
  }
  if (graph !== base) loadGraph(structuredClone(graph));
  state.savedHash = savedHash;
  await persistDraft();
  state.pan = defaultPan();
  state.zoom = 1;
  applyTransform();

  const sess = await idbGet("session", "auto:" + id);
  const restored = sess ? restoreSession(sess) : 0;
  if (!opts.quiet) {
    setStatus(`Workflow “${escapeHtml(name)}” aberto${state.dirty ? ` (${dirtyLabel()})` : ""}` +
      `${restored ? ` — ${restored} node(s) com resultados restaurados` : ""}.`);
  }
  return { restored };
}

/* 💾 Salvar (Ctrl+S): grava o grafo atual no workflow. Exemplos e rascunho não são
   sobrescritos — viram um workflow seu (Salvar como). */
async function saveWorkflow() {
  if (!isUserWorkflow()) return saveWorkflowAs();
  await flushPendingSaves();
  const tpl = await idbGet("workflows", state.workflowId);
  if (!tpl) return saveWorkflowAs();
  const graph = serializeGraph();
  if (!await idbPut("workflows", { ...tpl, graph, ts: Date.now() })) return storageError();
  state.savedHash = graphHash(JSON.stringify(graph));
  await persistDraft();
  setStatus(`<span class="ok">💾 Workflow “${escapeHtml(tpl.name)}” salvo.</span>`);
}

async function saveWorkflowAs() {
  const fromUser = isUserWorkflow();
  const from = state.workflowId;
  const taken = await workflowNames();
  const suggestion = state.workflowId === DRAFT_ID ? "" : uniqueName(`${state.workflowName} (cópia)`, taken);
  const name = await askText({
    title: fromUser ? "Salvar como novo workflow" : "Salvar workflow",
    note: fromUser
      ? "Cria uma cópia do workflow atual (grafo, grupos e resultados) com outro nome. O original fica como está."
      : "Exemplos e o rascunho não são sobrescritos: o grafo atual (com grupos e resultados) vira um workflow seu, com saves próprios.",
    label: "Nome do workflow",
    value: suggestion,
    placeholder: "ex.: Cartinhas v2 — geração em lote",
    ok: "Salvar",
    validate: v => (taken.has(v.toLowerCase()) ? "Já existe um workflow com esse nome." : null),
  });
  if (name == null) return;
  await saveWorkflowAsNamed(name);
}

/* grava o grafo aberto (com resultados) como um workflow novo, sem modal.
   Devolve { id, name } ou null se o navegador não deixar gravar. */
async function saveWorkflowAsNamed(requestedName) {
  const fromUser = isUserWorkflow();
  const from = state.workflowId;
  await flushPendingSaves();
  const name = uniqueName(requestedName, await workflowNames());
  const id = newWorkflowId();
  const graph = serializeGraph();
  const now = Date.now();
  if (!await idbPut("workflows", { id, name, graph, ts: now, created: now })) { storageError(); return null; }
  setCurrentWorkflow(id, name);
  state.savedHash = graphHash(JSON.stringify(graph));
  lastDraftKey = null;
  await Promise.all([persistDraft(), persistSession()]); // a sessão atual vai junto
  // o exemplo/rascunho de origem volta ao original: as edições agora vivem no workflow novo
  if (!fromUser) await idbDel("session", DRAFT_PREFIX + from);
  setStatus(`<span class="ok">💾 Workflow “${escapeHtml(name)}” salvo — ele tem rascunho e saves próprios.</span>`);
  return { id, name };
}

async function renameWorkflow(id) {
  const tpl = await idbGet("workflows", id);
  if (!tpl) return;
  const taken = await workflowNames(id);
  const name = await askText({
    title: "Renomear workflow",
    label: "Novo nome",
    value: tpl.name,
    ok: "Renomear",
    validate: v => (taken.has(v.toLowerCase()) ? "Já existe um workflow com esse nome." : null),
  });
  if (name == null || name === tpl.name) return;
  await renameWorkflowTo(id, name);
}

/* renomeia sem modal (quem chama garante que o nome é único); true = renomeado */
async function renameWorkflowTo(id, name) {
  const tpl = await idbGet("workflows", id);
  if (!tpl) return false;
  if (!await idbPut("workflows", { ...tpl, name })) { storageError(); return false; } // mantém o ts da versão salva
  if (state.workflowId === id) setCurrentWorkflow(id, name);
  setStatus(`<span class="ok">Workflow renomeado para “${escapeHtml(name)}”.</span>`);
  return true;
}

async function deleteWorkflow(id) {
  const tpl = await idbGet("workflows", id);
  if (state.workflowId === id) await loadWorkflow("ex1", { quiet: true });
  await idbDel("workflows", id);
  for (const s of await idbAll("session")) if (s.workflowId === id) await idbDel("session", s.id);
  setStatus(`Workflow “${escapeHtml(tpl?.name || id)}” excluído (com o rascunho e os saves dele).`);
}

async function discardChanges() {
  const builtin = Boolean(BUILTIN_WORKFLOWS[state.workflowId]);
  await loadWorkflow(state.workflowId, { discardDraft: true, quiet: true });
  setStatus(builtin ? "Exemplo restaurado ao original." : "Alterações descartadas — de volta à última versão salva.");
}

function storageError() {
  setStatus(`<span class="err">O navegador não deixou gravar (armazenamento cheio ou bloqueado). Exporte um backup pelo menu 📋 antes de continuar.</span>`);
}

/* ----- saves (snapshots nomeados de grafo + resultados) ----- */

function putSnapshot(workflowId, name, graph, results) {
  const ts = Date.now();
  return idbPut("session", { id: `manual:${workflowId}:${ts}`, workflowId, kind: "manual", name, graph, results, ts });
}

/* guarda como save o rascunho em edição de um workflow, antes de descartá-lo */
async function snapshotDraft(id, label) {
  const draft = await idbGet("session", DRAFT_PREFIX + id);
  if (!draft?.dirty || !draft.graph?.nodes?.length) return false;
  const auto = await idbGet("session", "auto:" + id);
  return putSnapshot(id, `${label} — ${fmtDate(draft.ts)}`, draft.graph, auto?.results || {});
}

async function createSnapshot() {
  const name = await askText({
    title: "Criar save",
    note: "Um save guarda uma cópia do grafo e dos resultados atuais deste workflow. Restaure quando quiser pelo menu 📋.",
    label: "Nome do save",
    value: "Save " + fmtDate(Date.now()),
    ok: "Criar save",
  });
  if (name == null) return;
  await flushPendingSaves();
  if (!await putSnapshot(state.workflowId, name, serializeGraph(), serializeSession())) return storageError();
  setStatus(`<span class="ok">📸 Save “${escapeHtml(name)}” criado em “${escapeHtml(state.workflowName)}” (grafo + resultados).</span>`);
}

async function renameSnapshot(save) {
  const name = await askText({ title: "Renomear save", label: "Novo nome", value: save.name, ok: "Renomear" });
  if (name == null || name === save.name) return;
  const current = await idbGet("session", save.id);
  if (current && await idbPut("session", { ...current, name })) setStatus(`<span class="ok">Save renomeado para “${escapeHtml(name)}”.</span>`);
}

async function restoreSnapshot(save) {
  await flushPendingSaves();
  // o estado atual vira um save antes de ser substituído — restaurar nunca apaga trabalho
  let kept = false;
  if (state.nodes.length && (state.dirty || Object.keys(serializeSession()).length)) {
    kept = await putSnapshot(state.workflowId, `Antes de restaurar “${save.name}” — ${fmtDate(Date.now())}`,
      serializeGraph(), serializeSession());
  }
  loadGraph(structuredClone(save.graph));
  const count = restoreSession({ results: save.results });
  await Promise.all([persistDraft(), persistSession()]);
  setStatus(`<span class="ok">“${escapeHtml(save.name)}” restaurado — ${count} node(s) com resultados.` +
    `${kept ? " O estado anterior ficou guardado nos saves." : ""}</span>`);
}

async function newBlankWorkflow() {
  await flushPendingSaves();
  const kept = await snapshotDraft(DRAFT_ID, "Rascunho anterior");
  await Promise.all([idbDel("session", "auto:" + DRAFT_ID), idbDel("session", DRAFT_PREFIX + DRAFT_ID)]);
  await loadWorkflow(DRAFT_ID, { quiet: true });
  setStatus(`Novo workflow em branco.${kept ? " O rascunho anterior ficou nos saves do Rascunho." : ""} Use 💾 Salvar (Ctrl+S) para dar um nome a ele.`);
}

/* ----- modal genérico que pede um texto (resolve null se cancelar) ----- */

let askState = null;
function askText({ title, note = "", label = "Nome", value = "", placeholder = "", ok = "OK", validate = null }) {
  closeMenus();
  askState?.resolve(null);
  const el = (id) => document.getElementById(id);
  el("ask-title").textContent = title;
  el("ask-note").textContent = note;
  el("ask-note").hidden = !note;
  el("ask-label").textContent = label;
  el("ask-ok").textContent = ok;
  el("ask-status").textContent = "";
  el("ask-status").className = "schema-status";
  const input = el("ask-input");
  input.value = value;
  input.placeholder = placeholder;
  el("ask-modal").hidden = false;
  input.focus();
  input.select();
  return new Promise((resolve) => { askState = { resolve, validate }; });
}

function finishAsk(submit) {
  if (!askState) return;
  const input = document.getElementById("ask-input");
  const value = input.value.trim();
  if (submit) {
    const error = value ? askState.validate?.(value) : "Preencha o campo.";
    if (error) {
      const status = document.getElementById("ask-status");
      status.className = "schema-status err";
      status.textContent = error;
      input.focus();
      return;
    }
  }
  const { resolve } = askState;
  askState = null;
  document.getElementById("ask-modal").hidden = true;
  resolve(submit ? value : null);
}

document.getElementById("ask-ok").addEventListener("click", () => finishAsk(true));
document.getElementById("ask-cancel").addEventListener("click", () => finishAsk(false));
document.getElementById("ask-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); finishAsk(true); }
});

/* ---------- confirmação de exclusão ---------- */
// Toda exclusão do editor (node, grupo, item da Biblioteca, pasta, workflow, save, voz,
// histórico) passa por aqui. Enter confirma, Esc ou o clique fora cancelam.

let confirmState = null;

function confirmDelete({ title = "Excluir?", text = "", items = [], note = "", okLabel = "Excluir" } = {}) {
  closeMenus();
  confirmState?.resolve(false);
  const el = (id) => document.getElementById(id);
  el("confirm-title").textContent = title;
  el("confirm-text").textContent = text;
  const list = el("confirm-list");
  list.innerHTML = "";
  list.hidden = !items.length;
  for (const line of items) {
    const li = document.createElement("li");
    li.textContent = line;
    list.appendChild(li);
  }
  el("confirm-note").textContent = note;
  el("confirm-note").hidden = !note;
  el("confirm-ok").textContent = okLabel;
  el("confirm-modal").hidden = false;
  el("confirm-ok").focus();
  return new Promise((resolve) => { confirmState = { resolve }; });
}

function finishConfirm(ok) {
  if (!confirmState) return;
  const { resolve } = confirmState;
  confirmState = null;
  document.getElementById("confirm-modal").hidden = true;
  resolve(ok);
}

document.getElementById("confirm-ok").addEventListener("click", () => finishConfirm(true));
document.getElementById("confirm-cancel").addEventListener("click", () => finishConfirm(false));
document.getElementById("confirm-modal").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); finishConfirm(true); }
});

/* ----- menu 📋 ----- */

async function buildWorkflowsMenu() {
  const menu = document.getElementById("examples-menu");
  const [templates, sessions] = await Promise.all([idbAll("workflows"), idbAll("session")]);
  menu.innerHTML = "";
  const rebuild = () => { if (menu.classList.contains("open")) buildWorkflowsMenu(); };
  // o modal de confirmação fecha o menu; depois da ação ele volta ao mesmo lugar
  const askThenRun = async (ask, fn) => {
    const estavaAberto = menu.classList.contains("open");
    const ok = await ask();
    if (estavaAberto) menu.classList.add("open");
    if (!ok) return;
    await fn();
    rebuild();
  };
  const title = (t) => {
    const d = document.createElement("div");
    d.className = "menu-title";
    d.textContent = t;
    menu.appendChild(d);
  };
  const note = (text, cls = "menu-note") => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    menu.appendChild(d);
  };
  const divider = () => {
    const d = document.createElement("div");
    d.className = "menu-divider";
    menu.appendChild(d);
  };
  // actions: [{ icon, title, fn, confirm }] — botões pequenos à direita da linha
  const row = (label, onClick, actions = [], opts = {}) => {
    const wrap = document.createElement("div");
    wrap.className = "menu-row";
    const b = document.createElement("button");
    b.textContent = label;
    b.title = opts.title || label;
    if (opts.kbd) {
      const k = document.createElement("kbd");
      k.textContent = opts.kbd;
      b.appendChild(k);
    }
    if (opts.ask) b.addEventListener("click", (e) => { e.stopPropagation(); askThenRun(opts.ask, onClick); });
    else b.addEventListener("click", onClick);
    wrap.appendChild(b);
    for (const a of actions) {
      const btn = document.createElement("button");
      btn.className = a.ask ? "menu-del" : "menu-act";
      btn.textContent = a.icon;
      btn.title = a.title;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (a.ask) askThenRun(a.ask, a.fn);
        else Promise.resolve(a.fn()).then(rebuild);
      });
      wrap.appendChild(btn);
    }
    menu.appendChild(wrap);
  };

  const cur = state.workflowId;
  const user = isUserWorkflow();
  const drafts = new Map(sessions.filter(s => s.kind === "draft").map(s => [s.workflowId, s]));
  const isDirty = (id) => (id === cur ? state.dirty : Boolean(drafts.get(id)?.dirty));
  const label = (id, text) => (id === cur ? "▸ " : "") + text + (isDirty(id) ? "  ●" : "");

  title("Workflow atual");
  if (state.dirty) note("● " + dirtyLabel(), "menu-dirty");
  row(user ? "💾 Salvar" : "💾 Salvar como workflow seu…", () => { closeMenus(); saveWorkflow(); }, [], { kbd: "Ctrl+S" });
  if (user) {
    row("📝 Salvar como novo workflow…", () => { closeMenus(); saveWorkflowAs(); });
    row("✏️ Renomear…", () => { closeMenus(); renameWorkflow(cur); });
  }
  if (state.dirty && cur !== DRAFT_ID) {
    row(BUILTIN_WORKFLOWS[cur] ? "↺ Restaurar o exemplo original" : "↺ Descartar alterações não salvas",
      () => discardChanges(), [], {
        ask: () => confirmDelete({
          title: BUILTIN_WORKFLOWS[cur] ? "Restaurar o exemplo original?" : "Descartar as alterações?",
          text: BUILTIN_WORKFLOWS[cur]
            ? "O exemplo volta como veio de fábrica e as suas alterações neste rascunho são perdidas."
            : "O workflow volta para a última versão salva e as alterações não salvas são perdidas.",
          okLabel: BUILTIN_WORKFLOWS[cur] ? "Restaurar" : "Descartar",
        }),
      });
  }

  divider();
  title("Workflows");
  for (const [id, meta] of Object.entries(BUILTIN_WORKFLOWS)) {
    row(label(id, meta.name), () => { closeMenus(); loadWorkflow(id); });
  }
  for (const t of templates.sort((a, b) => compareByName(a.name, b.name))) {
    row(label(t.id, "🧩 " + t.name), () => { closeMenus(); loadWorkflow(t.id); }, [
      { icon: "✏️", title: "Renomear", fn: () => renameWorkflow(t.id) },
      {
        icon: "🗑",
        title: "Excluir workflow (com o rascunho e os saves dele)",
        ask: () => confirmDelete({
          title: `Excluir o workflow “${t.name}”?`,
          text: "O workflow sai da lista junto com tudo o que é dele.",
          items: [
            "O rascunho (alterações não salvas)",
            `Os saves de “${t.name}”`,
            "As sessões do assistente deste workflow",
          ],
          note: "Não dá para desfazer. O backup completo (menu 📋 → Backup) guarda uma cópia de tudo.",
          okLabel: "Excluir workflow",
        }),
        fn: () => deleteWorkflow(t.id),
      },
    ], { title: `${t.name} — salvo em ${fmtDate(t.ts)}` });
  }
  if (cur === DRAFT_ID || drafts.get(DRAFT_ID)?.graph?.nodes?.length) {
    row(label(DRAFT_ID, "📝 Rascunho"), () => { closeMenus(); loadWorkflow(DRAFT_ID); });
  }
  row("➕ Novo workflow em branco", () => { closeMenus(); newBlankWorkflow(); });

  divider();
  title(`Saves de “${state.workflowName}”`);
  row("📸 Criar save agora (grafo + resultados)…", () => { closeMenus(); createSnapshot(); });
  const mine = sessions.filter(s => s.workflowId === cur);
  const auto = mine.find(s => s.kind === "auto");
  if (auto && Object.keys(auto.results || {}).length) {
    row(`⏱ Resultados automáticos — ${fmtDate(auto.ts)}`, () => {
      closeMenus();
      const count = restoreSession(auto);
      setStatus(`Resultados automáticos restaurados — ${count} node(s).`);
    });
  }
  const manuals = mine.filter(s => s.kind === "manual").sort((a, b) => b.ts - a.ts);
  for (const s of manuals) {
    row("💾 " + s.name, () => { closeMenus(); restoreSnapshot(s); }, [
      { icon: "✏️", title: "Renomear save", fn: () => renameSnapshot(s) },
      {
        icon: "🗑",
        title: "Excluir save",
        ask: () => confirmDelete({
          title: `Excluir o save “${s.name}”?`,
          text: `Save de ${fmtDate(s.ts)}, com o grafo e os resultados guardados nele.`,
          note: "O workflow em si não é afetado.",
          okLabel: "Excluir save",
        }),
        fn: async () => { await idbDel("session", s.id); setStatus("Save excluído."); },
      },
    ], { title: `${s.name} — ${fmtDate(s.ts)} · clique para restaurar (o estado atual vira um save antes)` });
  }
  if (!manuals.length) note("Nenhum save deste workflow ainda.", "menu-empty");

  divider();
  title("Backup");
  row("⇩ Exportar backup completo (.json)", () => { closeMenus(); exportBackup(); });
  row("⇧ Importar backup ou workflow…", () => { closeMenus(); document.getElementById("import-file").click(); });
  if (backupSupported) {
    const n = backupInfo?.files || 0;
    const tamanho = gbText(backupInfo?.bytes);
    row(`🗑 Limpar backups automáticos (${tamanho})`, async () => {
      const info = await clearAutoBackups();
      setStatus(`<span class="ok">${info.removed} backup(s) apagado(s) — ${gbText(info.freed)} liberados.</span>`);
    }, [], {
      title: `Apaga os arquivos de ${backupInfo?.dir || "backups/"}`,
      ask: () => confirmDelete({
        title: "Limpar os backups automáticos?",
        text: `${n} arquivo(s) ocupando ${tamanho} em ${backupInfo?.dir || "backups/"}.`,
        note: "O que está no editor não é afetado — só as cópias em disco. Uma nova cópia é gravada em seguida.",
        okLabel: "Limpar backups",
      }),
    });
    note(n
      ? `💾 Backup automático: ${n} arquivo(s) · ${tamanho} · último ${timeAgoText(backupInfo.last)} · ${backupInfo.dir}`
      : "💾 Backup automático ligado — a primeira cópia é gravada em instantes.");
  } else {
    note("Backup automático indisponível: abra o editor pelo serve.py (iniciar-editor.bat) para ele gravar cópias em backups/.", "menu-warn");
  }
  note(storagePersisted
    ? "🔒 Armazenamento persistente ativo: o navegador não apaga estes dados sozinho. O backup inclui workflows, rascunhos, saves, sessões do assistente e a Biblioteca."
    : "⚠ Sem garantia de armazenamento: com o disco cheio o navegador pode apagar tudo isto sozinho. O backup inclui workflows, rascunhos, saves, sessões do assistente e a Biblioteca.",
    storagePersisted ? undefined : "menu-warn");
}

function closeMenus() {
  closeContextMenu();
  document.getElementById("examples-menu").classList.remove("open");
  document.getElementById("appearance-menu")?.classList.remove("open");
}

const examplesMenu = document.getElementById("examples-menu");
document.getElementById("btn-examples").addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = !examplesMenu.classList.contains("open");
  closeMenus();
  if (willOpen) {
    buildWorkflowsMenu();
    examplesMenu.classList.add("open");
    // números do backup podem ter mudado desde a última abertura
    refreshBackupInfo().then(() => { if (examplesMenu.classList.contains("open")) buildWorkflowsMenu(); });
  }
});
examplesMenu.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", closeMenus);

document.getElementById("btn-save-workflow").addEventListener("click", saveWorkflow);
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
    e.preventDefault(); // não abre o "Salvar página" do navegador
    if (document.getElementById("ask-modal").hidden) saveWorkflow();
  }
});

/* ----- exportar / importar ----- */

function downloadJson(filename, data, pretty = true) {
  const blob = new Blob([JSON.stringify(data, null, pretty ? 2 : 0)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function fileSlug(name) {
  return String(name || "workflow").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "workflow";
}

document.getElementById("btn-export").addEventListener("click", () => {
  // inclui os resultados (sessão) no arquivo — quem importar recupera de onde parou
  downloadJson(fileSlug(state.workflowName) + ".json",
    { name: state.workflowName, ...serializeGraph(), results: serializeSession() });
});

document.getElementById("btn-import").addEventListener("click", () => {
  document.getElementById("import-file").click();
});
document.getElementById("import-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      if (data?.format === BACKUP_FORMAT) await importBackup(data);
      else await importWorkflowFile(data, file.name);
    } catch (err) {
      setStatus(`<span class="err">Falha ao importar ${escapeHtml(file.name)}: ${escapeHtml(err.message)}</span>`);
    }
  };
  reader.readAsText(file);
});

/* um workflow exportado (⇩) entra como workflow novo — nunca sobrescreve o que está aberto */
async function importWorkflowFile(data, fileName) {
  if (!data || !Array.isArray(data.nodes)) throw new Error("o arquivo não é um workflow do Asset Maker (não tem nodes).");
  const { results, name: savedName, ...graph } = data;
  const taken = await workflowNames();
  const name = uniqueName(String(savedName || fileName.replace(/\.json$/i, "")).trim() || "Workflow importado", taken);
  const id = newWorkflowId();
  const now = Date.now();
  if (!await idbPut("workflows", { id, name, graph, ts: now, created: now })) return storageError();
  if (results && Object.keys(results).length) {
    await idbPut("session", { id: "auto:" + id, workflowId: id, kind: "auto", results, ts: now });
  }
  const res = await loadWorkflow(id, { quiet: true });
  setStatus(`<span class="ok">Workflow importado como “${escapeHtml(name)}”` +
    `${res?.restored ? ` — ${res.restored} node(s) com resultados restaurados` : ""}. O que estava aberto continua salvo.</span>`);
}

/* conteúdo do backup: workflows, rascunhos, saves e Biblioteca (o 🕘 Histórico fica de fora).
   O mesmo objeto vai para o arquivo do ⇩ e para o backup automático em disco. */
async function buildBackupData() {
  await flushPendingSaves();
  const [workflows, allSessions] = await Promise.all([idbAll("workflows"), idbAll("session")]);
  // sessões do assistente vão sem os pontos de desfazer (guardam grafos inteiros e só valem neste navegador)
  const sessions = allSessions.map(s => (s.kind === "chat" ? { ...s, turns: [] } : s));
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    current: { id: state.workflowId, name: state.workflowName },
    workflows,
    sessions,
    library: exportLibrary(),
  };
}

function backupSummary(data) {
  return `${data.workflows.length} workflow(s), ${data.sessions.filter(s => s.kind === "manual").length} save(s)` +
    ` e ${data.sessions.filter(s => s.kind === "chat").length} sessão(ões) do assistente`;
}

async function exportBackup() {
  const data = await buildBackupData();
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  downloadJson(`asset-maker-backup-${stamp}.json`, data, false);
  setStatus(`<span class="ok">Backup exportado: ${backupSummary(data)} e a Biblioteca.</span>`);
}

/* ---------- backup automático em disco (pasta backups/, gravada pelo serve.py) ---------- */

const AUTO_BACKUP_INTERVAL = 10 * 60 * 1000;   // no máximo um backup a cada 10 minutos
let backupInfo = null;        // estatísticas vindas do servidor (arquivos, bytes, último)
let backupSupported = false;  // false enquanto não souber, e quando não for o serve.py
let backupDirty = false;      // mudou alguma coisa desde o último backup
let backupError = "";
let backupBusy = false;

/* chamado de idbPut e de afterLibraryChange: qualquer gravação marca o backup como pendente */
function markBackupDirty() { backupDirty = true; }

function gbText(bytes) {
  const b = bytes || 0;
  if (b >= 0.01 * 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2).replace(".", ",")} GB`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} MB`;
  return `${Math.round(b / 1024)} KB`;
}

async function refreshBackupInfo() {
  try {
    backupInfo = await editorApi("/__local/backups");
    backupSupported = true;
  } catch (err) {
    backupSupported = false;   // servidor estático comum ou serve.py antigo: só o ⇩ manual
    backupInfo = null;
    if (err.status && err.status !== 404 && err.status !== 403) backupError = err.message;
  }
  updateStorageWarning();
  return backupInfo;
}

async function runAutoBackup({ force = false } = {}) {
  if (backupBusy || !backupSupported) return null;
  if (state.running) return null;                       // durante o ▶ os resultados ainda estão mudando
  if (!force && !backupDirty) return null;
  if (!force && backupInfo?.last && Date.now() - backupInfo.last < AUTO_BACKUP_INTERVAL) return null;
  backupBusy = true;
  try {
    backupInfo = await editorApi("/__local/backup", "POST", await buildBackupData());
    backupDirty = false;
    backupError = "";
  } catch (err) {
    // sem status = o serve.py saiu do ar; com status = ele recusou (disco cheio, permissão…)
    if (!err.status || err.status === 404) backupSupported = false;
    else backupError = err.message || String(err);
  } finally {
    backupBusy = false;
    updateStorageWarning();
  }
  return backupInfo;
}

async function clearAutoBackups() {
  const info = await editorApi("/__local/backups/clear", "POST");
  backupInfo = info;
  backupDirty = true;   // sem cópia em disco: grava uma nova na próxima rodada
  updateStorageWarning();
  return info;
}

function initAutoBackup() {
  refreshBackupInfo().then(() => {
    if (!backupSupported) return;
    // logo depois de abrir, grava uma cópia se a última for antiga (ou se não houver nenhuma)
    const velha = !backupInfo?.last || Date.now() - backupInfo.last > AUTO_BACKUP_INTERVAL;
    setTimeout(() => runAutoBackup({ force: velha }), 8000);
    setInterval(() => runAutoBackup(), 60000);
  });
}

/* importa um backup somando ao que já existe: nada daqui é sobrescrito — conflitos entram como cópia */
async function importBackup(data) {
  await flushPendingSaves();
  const [currentWfs, currentSessions] = await Promise.all([idbAll("workflows"), idbAll("session")]);
  const wfById = new Map(currentWfs.map(w => [w.id, w]));
  const sessionIds = new Set(currentSessions.map(s => s.id));
  const known = new Set([...wfById.keys(), ...Object.keys(BUILTIN_WORKFLOWS), DRAFT_ID]);
  const taken = await workflowNames();
  const remap = {};
  let nWf = 0, nSaves = 0, nChats = 0;

  for (const w of Array.isArray(data.workflows) ? data.workflows : []) {
    if (!w?.id || !w.graph) continue;
    const existing = wfById.get(w.id);
    if (existing && existing.name === w.name && JSON.stringify(existing.graph) === JSON.stringify(w.graph)) continue;
    let id = w.id;
    if (existing) { id = newWorkflowId(); remap[w.id] = id; }
    const name = uniqueName(String(w.name || "Workflow importado"), taken);
    taken.add(name.toLowerCase());
    if (await idbPut("workflows", { ...w, id, name })) { known.add(id); nWf++; }
  }

  for (const s of Array.isArray(data.sessions) ? data.sessions : []) {
    if (!s?.workflowId || !["auto", "draft", "manual", "chat"].includes(s.kind)) continue;
    const wf = remap[s.workflowId] || s.workflowId;
    if (!known.has(wf)) continue; // save de um workflow que não veio no backup
    const id = s.kind === "chat" ? s.id
      : s.kind === "manual" ? `manual:${wf}:${s.ts}` : (s.kind === "draft" ? DRAFT_PREFIX : "auto:") + wf;
    if (sessionIds.has(id)) continue;
    sessionIds.add(id);
    if (await idbPut("session", { ...s, id, workflowId: wf })) {
      if (s.kind === "manual") nSaves++;
      if (s.kind === "chat") nChats++;
    }
  }

  const libAdded = importLibrary(data.library);
  if (!document.getElementById("prompts-panel").hidden) renderPromptsPanel();
  refreshAllNodes();
  setStatus(`<span class="ok">Backup importado: ${nWf} workflow(s), ${nSaves} save(s), ${nChats} sessão(ões) do assistente e ${libAdded} item(ns) da Biblioteca — nada que já existia foi sobrescrito.</span>`);
}

/* pede ao navegador para não apagar o IndexedDB/localStorage quando faltar espaço */
let storagePersisted = false;
async function requestPersistentStorage() {
  try {
    storagePersisted = Boolean(await navigator.storage?.persisted?.()) || Boolean(await navigator.storage?.persist?.());
  } catch { storagePersisted = false; }
  // o Chrome nega a persistência a páginas "sem engajamento": aí um disco cheio apaga tudo sem avisar
  updateStorageWarning();
}

/* faixa vermelha acima da barra de status: só quando nada protege os dados, ou quando o
   backup automático falha (disco cheio, por exemplo) */
async function updateStorageWarning() {
  const bar = document.getElementById("storage-warning");
  if (!bar) return;
  if (sessionStorage.getItem("assets-pipeline-storage-warning") === "off") { bar.hidden = true; return; }
  let texto = "";
  if (mirrorErro) {
    texto = "⚠ <b>O estado não está sendo salvo fora do navegador:</b> " + escapeHtml(mirrorErro) +
      " Enquanto isso, só valem o armazenamento do navegador e os backups em <code>backups/</code>.";
  } else if (backupError) {
    texto = "⚠ <b>O backup automático falhou:</b> " + escapeHtml(backupError) +
      " Os backups ficam na pasta <code>backups/</code>; libere espaço no disco ou limpe os antigos em 📋 → Backup.";
  } else if (!storagePersisted && !backupSupported && !mirrorOn) {
    let livre = "";
    try {
      const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) || {};
      if (quota) livre = ` Espaço disponível para esta página agora: ${Math.round((quota - usage) / 1e6)} MB.`;
    } catch { /* estimate é opcional */ }
    texto = "⚠ <b>O navegador não garantiu o armazenamento desta página e não há backup automático.</b> " +
      "Se o disco encher, ele pode apagar workflows, saves, rascunhos e a Biblioteca sem avisar." + escapeHtml(livre) +
      " Abra o editor pelo serve.py (iniciar-editor.bat) para ativar o backup em disco, e favorite a página (Ctrl+D).";
  }
  if (!texto) { bar.hidden = true; return; }
  document.getElementById("storage-warning-text").innerHTML = texto;
  bar.hidden = false;
}

document.getElementById("storage-warning-close").addEventListener("click", () => {
  sessionStorage.setItem("assets-pipeline-storage-warning", "off");
  document.getElementById("storage-warning").hidden = true;
});
document.getElementById("storage-warning-backup").addEventListener("click", () => { exportBackup(); });

/* chaves de API */
document.getElementById("btn-keys").addEventListener("click", () => {
  const keys = getApiKeys();
  document.getElementById("key-openai").value = keys.openai || "";
  document.getElementById("key-anthropic").value = keys.anthropic || "";
  document.getElementById("key-gemini").value = keys.gemini || "";
  document.getElementById("key-hf").value = keys.hf || "";
  document.getElementById("key-local-server").value = keys.localServer || "";
  document.getElementById("local-test-status").textContent = "";
  renderModelsStatus();
  document.getElementById("keys-modal").hidden = false;
  startServerPolling();
});
document.getElementById("btn-save-keys").addEventListener("click", () => {
  const previous = getApiKeys();
  const keys = {
    openai: document.getElementById("key-openai").value.trim(),
    anthropic: document.getElementById("key-anthropic").value.trim(),
    gemini: document.getElementById("key-gemini").value.trim(),
    hf: document.getElementById("key-hf").value.trim(),
    localServer: document.getElementById("key-local-server").value.trim(),
  };
  localStorage.setItem(API_KEYS_STORAGE, JSON.stringify(keys));
  document.getElementById("keys-modal").hidden = true;
  setStatus(`<span class="ok">Chaves de API salvas no navegador.</span>`);
  refreshLocalVoices();
  // chave nova ou trocada: busca a lista de modelos desse provedor
  const changed = Object.keys(MODEL_SOURCES).filter(id => keys[id] && keys[id] !== previous[id]);
  if (changed.length) updateModelLists({ force: changed });
});

/* ---------- listas de modelos (catálogo em nodes.js) ---------- */

function timeAgoText(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  if (min < 48 * 60) return `há ${Math.round(min / 60)} h`;
  return `há ${Math.round(min / 1440)} dias`;
}

function renderModelsStatus() {
  const el = document.getElementById("models-status");
  const cache = loadModelCache();
  const parts = Object.entries(MODEL_SOURCES).filter(([id]) => cache[id]).map(([id, src]) => {
    const c = cache[id];
    return c.error
      ? `<span class="err">${escapeHtml(src.label)}: ✖ ${escapeHtml(c.error.slice(0, 90))}</span>`
      : `${escapeHtml(src.label)}: ${c.models?.length || 0} modelos`;
  });
  const capsList = Object.values(cache.caps || {});
  const sized = capsList.filter(c => c.size?.length).length;
  const livres = capsList.filter(c => c.freeSize).length;
  if (sized || livres) {
    parts.push(`tamanhos de ${sized + livres} modelo(s) de imagem` + (livres ? ` (${livres} com tamanho livre)` : ""));
  }
  const semLista = capsList.filter(c => !c.size?.length && !c.freeSize);
  if (semLista.length) parts.push(`<span class="err">${semLista.length} modelo(s) sem lista de tamanhos: ${escapeHtml(semLista[0].note || "a API não explicou")}</span>`);
  if (localClaude.loaded) parts.push(`Claude local: ${localClaude.efforts.length} níveis de esforço`);
  const at = Math.max(0, ...Object.entries(cache).filter(([k]) => k !== "caps").map(([, c]) => c.at || 0));
  el.className = "";
  el.innerHTML = parts.length ? `${parts.join(" · ")}${at ? ` · ${timeAgoText(at)}` : ""}` : "Ainda não consultado.";
}

/* o select do chat de edição de imagem usa a mesma lista do node Editar Imagem */
function fillChatModelSelect() {
  const sel = document.getElementById("chat-model");
  const current = sel.value;
  sel.innerHTML = "";
  let group = null;
  for (const o of modelParamOf("openai-image-edit")?.options || []) {
    const opt = new Option(o.label, o.value);
    if (!o.group) { sel.add(opt); group = null; continue; }
    if (group?.label !== o.group) { group = document.createElement("optgroup"); group.label = o.group; sel.appendChild(group); }
    group.appendChild(opt);
  }
  if ([...sel.options].some(o => o.value === current)) sel.value = current;
}

let modelsRefreshing = null;
async function updateModelLists({ force = false, keys, manual = false } = {}) {
  if (modelsRefreshing) return modelsRefreshing;
  modelsRefreshing = (async () => {
    // o servidor local entra na mesma verificação: vozes salvas e níveis de esforço da sua CLI
    const [r] = await Promise.all([refreshModelCatalog({ force, keys }), refreshClaudeInfo(), refreshLocalVoices()]);
    if (r.added.length || r.probed.length || localClaude.loaded) refreshAllNodes();
    fillChatModelSelect();
    renderModelsStatus();
    const brandNew = [...new Set(r.brandNew.map(a => a.value))];
    const errors = r.results.filter(x => x.error);
    const failed = errors.length ? ` <span class="err">Falhou: ${escapeHtml(errors.map(e => `${e.label} — ${e.error}`).join(" · "))}</span>` : "";
    if (brandNew.length) {
      setStatus(`<span class="ok">🆕 Modelos novos disponíveis nos nodes: ${escapeHtml(brandNew.join(", "))}</span>${manual ? failed : ""}`);
    } else if (manual) {
      const n = new Set(r.added.map(a => a.value)).size;
      const ok = r.probed.filter(c => c.size?.length || c.freeSize);
      const semLista = r.probed.filter(c => !c.size?.length && !c.freeSize);
      const caps = (ok.length ? ` Tamanhos conferidos em ${ok.length} modelo(s) de imagem.` : "")
        + (semLista.length ? ` <span class="err">Sem lista de tamanhos em ${escapeHtml(semLista.map(c => c.model).join(", "))} — ${escapeHtml(semLista[0].note || "a API não explicou")}</span>` : "");
      if (r.results.every(x => x.skipped === "sem chave")) setStatus("Nenhuma chave de OpenAI, Anthropic ou Gemini para consultar os modelos.");
      else if (r.results.every(x => x.error || x.skipped)) setStatus(`<span class="err">Não foi possível listar os modelos.</span>${failed}`);
      else setStatus(`<span class="ok">Listas de modelos atualizadas${n ? ` — ${n} modelo(s) acrescentado(s) aos nodes` : " — nenhum modelo novo"}.${caps}</span>${failed}`);
    }
    return r;
  })();
  try { return await modelsRefreshing; }
  catch (err) { if (manual) setStatus(`<span class="err">Falha ao atualizar modelos: ${escapeHtml(err.message || String(err))}</span>`); }
  finally { modelsRefreshing = null; }
}

document.getElementById("btn-refresh-models").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  // usa o que está digitado no modal, mesmo antes de salvar
  const keys = {
    openai: document.getElementById("key-openai").value.trim(),
    anthropic: document.getElementById("key-anthropic").value.trim(),
    gemini: document.getElementById("key-gemini").value.trim(),
  };
  btn.disabled = true;
  document.getElementById("models-status").className = "";
  document.getElementById("models-status").textContent = "Consultando…";
  try { await updateModelLists({ force: true, keys, manual: true }); }
  finally { btn.disabled = false; renderModelsStatus(); }
});

document.getElementById("btn-test-local").addEventListener("click", async () => {
  const status = document.getElementById("local-test-status");
  const url = document.getElementById("key-local-server").value.trim().replace(/\/+$/, "") || LOCAL_SERVER_DEFAULT;
  status.className = "";
  status.textContent = "Testando…";
  try {
    const res = await fetch(url + "/health");
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const h = await res.json();
    const models = h.backends?.["qwen3-tts"]?.models || {};
    const found = Object.entries(models).filter(([, ok]) => ok).map(([k]) => k);
    status.className = "ok";
    status.textContent = `✔ ${h.gpu ? `${h.gpu.name} (${h.gpu.vram_total_gb} GB)` : "CPU"} · Qwen3-TTS: ${found.length ? found.join(", ") : "nenhum modelo encontrado"}`;
  } catch (err) {
    status.className = "err";
    status.textContent = `✖ Sem resposta em ${url} — o servidor está rodando? (${err.message})`;
  }
});

/* ---------- servidor local: ligar/desligar pelo editor ---------- */
// “Ligar” precisa do editor aberto pelo serve.py (é ele quem abre o processo);
// “Desligar” usa a rota /shutdown do próprio servidor e funciona sempre.

let srvPoll = null;
let srvAction = null;    // null | "starting" | "stopping"
let srvActionAt = 0;
let srvLogOpen = false;
let srvError = "";

async function editorApi(path, method = "GET", body = null) {
  const init = { method, headers: { "X-Assets-Pipeline": "1" } };
  if (body != null) {
    init.headers["Content-Type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    const err = new Error(data?.detail || `${res.status} ${res.statusText}`);
    err.status = res.status;   // 404 = serve.py antigo ou outro servidor estático
    throw err;
  }
  return data;
}

async function localHealth() {
  try {
    const res = await fetch(localServerUrl() + "/health", { signal: AbortSignal.timeout(2500) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

function setSrvIndicators(state) {
  const cls = "srv-dot" + (state === "running" ? " on" : state === "starting" || state === "stopping" ? " starting" : "");
  for (const id of ["srv-dot", "srv-state-dot"]) {
    const el = document.getElementById(id);
    if (el) el.className = cls;
  }
}

async function refreshServerStatus() {
  const [health, launcher] = await Promise.all([localHealth(), editorApi("/__local/status").catch(() => null)]);
  if (srvAction === "starting") {
    if (health) {
      srvAction = null;
      setStatus(`<span class="ok">Servidor local ligado.</span>`);
      refreshLocalVoices();
    } else if (launcher && launcher.state === "stopped" && launcher.exit_code != null) {
      srvAction = null;
      srvError = `O servidor fechou ao iniciar (código ${launcher.exit_code}) — veja o log.`;
      srvLogOpen = true;
    } else if (Date.now() - srvActionAt > 120000) {
      srvAction = null;
      srvError = "O servidor não respondeu em 2 minutos — veja o log.";
      srvLogOpen = true;
    }
  } else if (srvAction === "stopping" && !health && (!launcher || launcher.state === "stopped")) {
    srvAction = null;
    setStatus("Servidor local desligado.");
    refreshLocalVoices();
  }

  const state = srvAction || (health ? "running" : launcher?.state === "starting" ? "starting" : "stopped");
  setSrvIndicators(state);
  const text = document.getElementById("srv-state-text");
  if (state === "running") {
    const loaded = health.loaded?.length ? `na GPU: ${health.loaded.map(m => m.replace("Qwen3-TTS-12Hz-", "")).join(", ")}` : "nenhum modelo carregado";
    text.textContent = `Ligado · ${health.gpu?.name || health.device} · ${loaded}`;
  } else {
    text.textContent = { starting: "Iniciando… (~10–20 s)", stopping: "Desligando…", stopped: "Desligado" }[state];
  }
  document.getElementById("btn-srv-start").disabled = state !== "stopped" || !launcher || !launcher.installed;
  document.getElementById("btn-srv-stop").disabled = state !== "running";
  document.getElementById("btn-srv-log").disabled = !launcher;

  const hint = document.getElementById("srv-hint");
  hint.className = "srv-hint" + (srvError ? " err" : "");
  if (srvError) hint.textContent = srvError;
  else if (!launcher) hint.innerHTML = "Para ligar o servidor por aqui, abra o editor com <code>python serve.py</code> (ou <code>iniciar-editor.bat</code>) em vez do <code>python -m http.server</code>. Desligar funciona sempre.";
  else if (!launcher.installed) hint.innerHTML = "Ambiente do servidor não instalado — rode <code>local-server\\setup.ps1</code>.";
  else hint.innerHTML = "Roda em segundo plano, sem janela · log em <code>local-server\\logs\\server.log</code>";

  if (srvLogOpen) refreshServerLog();
}

async function refreshServerLog() {
  const pre = document.getElementById("srv-log");
  pre.hidden = !srvLogOpen;
  if (!srvLogOpen) return;
  try {
    const r = await editorApi("/__local/log");
    pre.textContent = r.lines.join("\n") || "(log vazio)";
    pre.scrollTop = pre.scrollHeight;
  } catch {
    pre.textContent = "O log só está disponível com o editor aberto pelo serve.py.";
  }
}

function startServerPolling() {
  clearInterval(srvPoll);
  refreshServerStatus();
  srvPoll = setInterval(() => {
    if (document.getElementById("keys-modal").hidden && !srvAction) {
      clearInterval(srvPoll);
      srvPoll = null;
      return;
    }
    refreshServerStatus();
  }, 2000);
}

document.getElementById("btn-srv-start").addEventListener("click", async () => {
  srvAction = "starting";
  srvActionAt = Date.now();
  srvError = "";
  setSrvIndicators("starting");
  try {
    await editorApi("/__local/start", "POST");
  } catch (err) {
    srvAction = null;
    srvError = err.message || String(err);
  }
  startServerPolling();
});

document.getElementById("btn-srv-stop").addEventListener("click", async () => {
  srvAction = "stopping";
  srvActionAt = Date.now();
  srvError = "";
  setSrvIndicators("stopping");
  try {
    const launcher = await editorApi("/__local/status").catch(() => null);
    if (launcher) await editorApi("/__local/stop", "POST");
    else await fetch(localServerUrl() + "/shutdown", { method: "POST" });
  } catch { /* o polling mostra o estado real */ }
  startServerPolling();
});

document.getElementById("btn-srv-log").addEventListener("click", () => {
  srvLogOpen = !srvLogOpen;
  refreshServerLog();
});

/* ---------- salvar áudio gerado como voz (perfil clonado) ---------- */

let saveVoiceItem = null;

function describeVoiceMeta(meta) {
  if (!meta) return "";
  if (meta.mode === "speaker") return `speaker ${meta.speaker}${meta.instruct ? " — " + meta.instruct : ""}`;
  if (meta.mode === "design") return meta.instruct || "voz por descrição";
  if (meta.mode === "voice" && meta.voice) return `derivada de “${meta.voice}”`;
  return "";
}

function setSaveVoiceStatus(msg, kind = "") {
  const el = document.getElementById("sv-status");
  el.className = "schema-status " + kind;
  el.textContent = msg;
}

function openSaveVoiceModal(item) {
  if (!item || item.type !== "audio") return;
  saveVoiceItem = item;
  const meta = item.meta || {};
  document.getElementById("sv-audio").src = item.value;
  document.getElementById("sv-name").value = "";
  document.getElementById("sv-text").value = meta.text || item.prompt || "";
  const lang = document.getElementById("sv-lang");
  if (!lang.options.length) for (const l of QWEN_TTS_LANGUAGES) lang.add(new Option(l.label, l.value));
  lang.value = meta.language || "Portuguese";
  document.getElementById("sv-seed").value = meta.seed ?? 42;
  document.getElementById("sv-overwrite").checked = false;
  const origin = describeVoiceMeta(meta);
  setSaveVoiceStatus(origin ? `Origem: ${origin}` : "Áudio sem texto associado — escreva a transcrição exata.");
  document.getElementById("savevoice-modal").hidden = false;
  document.getElementById("sv-name").focus();
}

document.getElementById("btn-sv-cancel").addEventListener("click", () => {
  document.getElementById("savevoice-modal").hidden = true;
});

document.getElementById("btn-sv-save").addEventListener("click", async () => {
  const name = document.getElementById("sv-name").value.trim();
  const text = document.getElementById("sv-text").value.trim();
  const overwrite = document.getElementById("sv-overwrite").checked;
  if (!/^[\p{L}\p{N}_\- ]{1,64}$/u.test(name)) {
    setSaveVoiceStatus("Nome inválido — use letras, números, espaço, _ ou - (até 64 caracteres).", "err");
    return;
  }
  if (!text) {
    setSaveVoiceStatus("Informe a transcrição exata do que é falado — o modelo usa ela para clonar a voz.", "err");
    return;
  }
  const btn = document.getElementById("btn-sv-save");
  btn.disabled = true;
  try {
    await refreshLocalVoices();
    if (!localVoices.loaded) throw new Error(`Servidor local offline em ${localServerUrl()} — ligue-o em Chaves.`);
    if (!overwrite && localVoices.list.some(v => v.name === name)) {
      throw new Error(`Já existe a voz “${name}”. Escolha outro nome ou marque “Substituir”.`);
    }
    setSaveVoiceStatus("Salvando… (calcula o prompt de clonagem na GPU)");
    const r = await callLocal("/qwen3-tts/voices", { method: "POST", body: {
      name,
      source: "audio",
      ref_audio: saveVoiceItem.value,
      ref_text: text,
      language: document.getElementById("sv-lang").value,
      seed: Math.max(0, Math.floor(Number(document.getElementById("sv-seed").value) || 0)),
      overwrite,
      instruct: describeVoiceMeta(saveVoiceItem.meta),
    } });
    if (r.reused) throw new Error(`Já existe a voz “${name}”.`);
    const warnings = (r.log || []).filter(line => line.startsWith("⚠"));
    document.getElementById("savevoice-modal").hidden = true;
    refreshLocalVoices();
    setStatus(`<span class="ok">Voz “${escapeHtml(name)}” salva — escolha-a em “Voz salva” no node Fala.${warnings.length ? " " + escapeHtml(warnings.join(" ")) : ""}</span>`);
  } catch (err) {
    setSaveVoiceStatus(err.message || String(err), "err");
  } finally {
    btn.disabled = false;
  }
});

/* ---------- templates de saída ---------- */

let editingTemplateId = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function refreshAllNodes() {
  for (const n of state.nodes) renderNode(n);
  drawEdges();
}

function openTemplateFormModal(tpl, folder = "") {
  editingTemplateId = tpl ? tpl.id : null;
  document.getElementById("tpl-folder").value = tpl ? libraryFolder(tpl) : folder;
  fillFolderOptions("template");
  document.getElementById("tpl-name").value = tpl ? tpl.name : "";
  document.getElementById("tpl-instruction").value = tpl ? tpl.instruction : "";
  document.getElementById("template-form-title").textContent = tpl ? "✏️ Editar template de saída" : "➕ Novo template de saída";
  document.getElementById("btn-tpl-save").textContent = tpl ? "Salvar alterações" : "Adicionar template";
  document.getElementById("template-form-modal").hidden = false;
  document.getElementById("tpl-name").focus();
}

function closeTemplateFormModal() {
  editingTemplateId = null;
  document.getElementById("template-form-modal").hidden = true;
}

/* o link “⚙ Gerenciar templates de saída…” dos nodes abre o painel lateral */
function openTemplatesModal() {
  document.getElementById("prompts-panel").hidden = false;
  renderPromptsPanel();
  drawEdges();
}

document.getElementById("btn-tpl-save").addEventListener("click", () => {
  const name = document.getElementById("tpl-name").value.trim();
  const instruction = document.getElementById("tpl-instruction").value.trim();
  if (!name || !instruction) {
    setStatus(`<span class="err">Preencha o nome e a instrução do template.</span>`);
    return;
  }
  const folder = normalizeFolderName(document.getElementById("tpl-folder").value);
  const templates = getOutputTemplates();
  if (editingTemplateId) {
    const t = templates.find(x => x.id === editingTemplateId);
    if (t) { t.name = name; t.instruction = instruction; setItemFolder(t, folder); }
  } else {
    templates.push(setItemFolder({ id: "t" + Date.now(), name, instruction }, folder));
  }
  saveOutputTemplates(templates);
  registerFolder("template", folder);
  setStatus(`<span class="ok">Template “${name}” salvo.</span>`);
  closeTemplateFormModal();
  renderPromptsPanel();
  refreshAllNodes();
});

document.getElementById("btn-tpl-cancel").addEventListener("click", closeTemplateFormModal);
document.getElementById("tpl-new").addEventListener("click", () => openTemplateFormModal(null));

/* ---------- aparência (cores + estilo) ---------- */

const APPEARANCE_STORAGE = "assets-pipeline-appearance";

/* cada preset define o fundo (cor base + duas manchas de luz atrás do vidro) e o destaque */
const COLOR_PRESETS = {
  "laranja-azul": {
    name: "Laranja & Azul",
    vars: {
      "--accent": "#ff7a1a", "--accent-soft": "#ff9e57", "--accent-glow": "rgba(255,122,26,.35)",
      "--bg-deep": "#0a0f1c", "--bg-blob-1": "rgba(255,122,26,.16)", "--bg-blob-2": "rgba(64,132,255,.20)",
    },
  },
  "roxo-grafite": {
    name: "Roxo & Grafite",
    vars: {
      "--accent": "#b07cff", "--accent-soft": "#c9a2ff", "--accent-glow": "rgba(176,124,255,.35)",
      "--bg-deep": "#0e0b18", "--bg-blob-1": "rgba(176,124,255,.18)", "--bg-blob-2": "rgba(90,70,200,.18)",
    },
  },
  "verde-petroleo": {
    name: "Verde & Petróleo",
    vars: {
      "--accent": "#2fd18c", "--accent-soft": "#6ee3b0", "--accent-glow": "rgba(47,209,140,.32)",
      "--bg-deep": "#06120f", "--bg-blob-1": "rgba(47,209,140,.14)", "--bg-blob-2": "rgba(20,120,150,.22)",
    },
  },
  "ciano-meianoite": {
    name: "Ciano & Meia-noite",
    vars: {
      "--accent": "#29c5ff", "--accent-soft": "#7fd9ff", "--accent-glow": "rgba(41,197,255,.32)",
      "--bg-deep": "#050b17", "--bg-blob-1": "rgba(41,197,255,.16)", "--bg-blob-2": "rgba(90,90,255,.18)",
    },
  },
  "vermelho-carvao": {
    name: "Vermelho & Carvão",
    vars: {
      "--accent": "#ff4d5e", "--accent-soft": "#ff8591", "--accent-glow": "rgba(255,77,94,.32)",
      "--bg-deep": "#100c0f", "--bg-blob-1": "rgba(255,77,94,.15)", "--bg-blob-2": "rgba(130,70,110,.20)",
    },
  },
};

let appearance = { preset: "laranja-azul", accent: null, style: "arredondado" };
try { Object.assign(appearance, JSON.parse(localStorage.getItem(APPEARANCE_STORAGE)) || {}); } catch { /* ignora */ }

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function lightenHex(hex, amount) {
  const c = hexToRgb(hex);
  if (!c) return hex;
  const mix = (v) => Math.round(v + (255 - v) * amount);
  return `rgb(${mix(c.r)}, ${mix(c.g)}, ${mix(c.b)})`;
}

function applyAppearance() {
  const preset = COLOR_PRESETS[appearance.preset] || COLOR_PRESETS["laranja-azul"];
  const root = document.documentElement;
  for (const [k, v] of Object.entries(preset.vars)) root.style.setProperty(k, v);
  if (appearance.accent) {
    const c = hexToRgb(appearance.accent);
    root.style.setProperty("--accent", appearance.accent);
    root.style.setProperty("--accent-soft", lightenHex(appearance.accent, 0.3));
    if (c) {
      root.style.setProperty("--accent-glow", `rgba(${c.r},${c.g},${c.b},.35)`);
      root.style.setProperty("--bg-blob-1", `rgba(${c.r},${c.g},${c.b},.16)`);
    }
  }
  document.body.dataset.style = appearance.style || "arredondado";
  updateAppearanceMenu();
}

function saveAppearance() {
  localStorage.setItem(APPEARANCE_STORAGE, JSON.stringify(appearance));
}

function buildAppearanceMenu() {
  const swatches = document.getElementById("ap-swatches");
  swatches.innerHTML = "";
  for (const [key, preset] of Object.entries(COLOR_PRESETS)) {
    const b = document.createElement("button");
    b.className = "ap-swatch";
    b.dataset.preset = key;
    b.title = preset.name;
    b.style.background = `linear-gradient(135deg, ${preset.vars["--bg-deep"]} 50%, ${preset.vars["--accent"]} 50%)`;
    b.addEventListener("click", () => {
      appearance.preset = key;
      appearance.accent = null; // preset limpa a cor livre
      saveAppearance();
      applyAppearance();
    });
    swatches.appendChild(b);
  }
  const custom = document.getElementById("ap-custom");
  const applyCustom = (save) => {
    appearance.accent = custom.value;
    if (save) saveAppearance();
    applyAppearance();
  };
  custom.addEventListener("input", () => applyCustom(false));
  custom.addEventListener("change", () => applyCustom(true));
  document.querySelectorAll("#ap-styles button").forEach(btn => {
    btn.addEventListener("click", () => {
      appearance.style = btn.dataset.style;
      saveAppearance();
      applyAppearance();
    });
  });
}

function updateAppearanceMenu() {
  document.querySelectorAll(".ap-swatch").forEach(b => {
    b.classList.toggle("active", b.dataset.preset === appearance.preset && !appearance.accent);
  });
  document.querySelectorAll("#ap-styles button").forEach(b => {
    b.classList.toggle("active", b.dataset.style === (appearance.style || "arredondado"));
  });
  const preset = COLOR_PRESETS[appearance.preset] || COLOR_PRESETS["laranja-azul"];
  document.getElementById("ap-custom").value = appearance.accent || preset.vars["--accent"];
}

const appearanceMenu = document.getElementById("appearance-menu");
document.getElementById("btn-appearance").addEventListener("click", (e) => {
  e.stopPropagation();
  appearanceMenu.classList.toggle("open");
});
appearanceMenu.addEventListener("click", (e) => e.stopPropagation());

buildAppearanceMenu();
applyAppearance();

/* ---------- painel de prompts salvos ---------- */

let editingPromptId = null;
let editingPromptKind = "prompt";

function openPromptFormModal(prompt, kind = "prompt", folder = "") {
  editingPromptId = prompt ? prompt.id : null;
  editingPromptKind = kind;
  document.getElementById("pp-folder").value = prompt ? libraryFolder(prompt) : folder;
  fillFolderOptions(kind);
  const label = kind === "agent" ? "prompt de agente" : "prompt";
  document.getElementById("pp-name").value = prompt ? prompt.name : "";
  document.getElementById("pp-text").value = prompt ? prompt.text : "";
  document.getElementById("prompt-form-title").textContent = prompt ? `✏️ Editar ${label}` : `➕ Novo ${label}`;
  document.getElementById("pp-save").textContent = prompt ? "Salvar alterações" : `Adicionar ${label}`;
  document.getElementById("prompt-form-modal").hidden = false;
  document.getElementById("pp-name").focus();
}

function closePromptFormModal() {
  editingPromptId = null;
  document.getElementById("prompt-form-modal").hidden = true;
}

function renderPromptsPanel() {
  for (const kind of Object.keys(LIBRARY)) renderLibrarySection(kind);
  renderVoicesSection();
}

/* ---------- schemas de saída (JSON Schema do node Claude Code) ---------- */

let editingSchemaId = null;

function schemaSummary(schema) {
  const props = Object.keys(schema?.properties || {});
  return props.length ? `propriedades: ${props.join(", ")}` : "sem propriedades declaradas";
}

function validateSchemaText(text) {
  let schema;
  try { schema = JSON.parse(text); }
  catch (err) { return { ok: false, msg: "JSON inválido: " + err.message }; }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { ok: false, msg: "O schema precisa ser um objeto JSON." };
  const arrays = Object.entries(schema.properties || {}).filter(([, p]) => p?.type === "array").map(([k]) => k);
  const notes = [schemaSummary(schema)];
  if (arrays.length === 1) notes.push(`“${arrays[0]}” sai na porta itens (lista)`);
  if (schema.type && schema.type !== "object") notes.push("⚠ prefira um objeto na raiz");
  return { ok: true, schema, msg: "✔ " + notes.join(" · ") };
}

function showSchemaStatus() {
  const v = validateSchemaText(document.getElementById("schema-json").value);
  const status = document.getElementById("schema-status");
  status.className = "schema-status " + (v.ok ? "ok" : "err");
  status.textContent = v.msg;
  return v;
}

function openSchemaFormModal(s, isEdit, folder = "") {
  editingSchemaId = isEdit ? s.id : null;
  document.getElementById("schema-folder").value = (s && libraryFolder(s)) || folder;
  fillFolderOptions("schema");
  document.getElementById("schema-name").value = s?.name || "";
  document.getElementById("schema-json").value = s?.schema ||
    '{\n  "type": "object",\n  "properties": {\n    "nome": { "type": "string" },\n    "itens": { "type": "array", "items": { "type": "string" } }\n  },\n  "required": ["nome", "itens"],\n  "additionalProperties": false\n}';
  document.getElementById("schema-form-title").textContent = isEdit ? "Editar schema de saída" : "Novo schema de saída";
  document.getElementById("btn-schema-save").textContent = isEdit ? "Salvar alterações" : "Adicionar schema";
  document.getElementById("schema-form-modal").hidden = false;
  showSchemaStatus();
  document.getElementById("schema-name").focus();
}

function closeSchemaFormModal() {
  editingSchemaId = null;
  document.getElementById("schema-form-modal").hidden = true;
}

document.getElementById("schema-new").addEventListener("click", () => openSchemaFormModal(null, false));
document.getElementById("schema-json").addEventListener("input", showSchemaStatus);
document.getElementById("btn-schema-format").addEventListener("click", () => {
  const v = showSchemaStatus();
  if (v.ok) document.getElementById("schema-json").value = JSON.stringify(v.schema, null, 2);
});
document.getElementById("btn-schema-cancel").addEventListener("click", closeSchemaFormModal);
document.getElementById("btn-schema-save").addEventListener("click", () => {
  const name = document.getElementById("schema-name").value.trim();
  const v = showSchemaStatus();
  if (!name) {
    setStatus(`<span class="err">Dê um nome ao schema.</span>`);
    return;
  }
  if (!v.ok) return;
  const folder = normalizeFolderName(document.getElementById("schema-folder").value);
  const schemas = getOutputSchemas();
  const pretty = JSON.stringify(v.schema, null, 2);
  const existing = editingSchemaId && schemas.find(x => x.id === editingSchemaId);
  if (existing) {
    existing.name = name;
    existing.schema = pretty;
    setItemFolder(existing, folder);
  } else {
    schemas.push(setItemFolder({ id: "s" + Date.now(), name, schema: pretty }, folder));
  }
  saveOutputSchemas(schemas);
  registerFolder("schema", folder);
  setStatus(`<span class="ok">Schema “${escapeHtml(name)}” salvo — escolha-o no campo “Schema de saída” do node Claude Code.</span>`);
  closeSchemaFormModal();
  renderPromptsPanel();
  refreshAllNodes();
});

/* vozes do servidor local (perfis do Qwen3-TTS) */
function renderVoicesSection() {
  const list = document.getElementById("voices-list-panel");
  if (!localVoices.loaded) {
    list.innerHTML = `<div class="pp-empty">Servidor local offline (${escapeHtml(localServerUrl())}). Inicie-o com <code>local-server\\start.ps1</code> e clique em ⟳.</div>`;
    return;
  }
  if (!localVoices.list.length) {
    list.innerHTML = `<div class="pp-empty">Nenhuma voz salva. Crie uma com o node <code>🎙️ Qwen3-TTS — Voz</code>.</div>`;
    return;
  }
  list.innerHTML = "";
  for (const v of localVoices.list) {
    const origin = { design: "descrição", speaker: `speaker ${v.speaker}`, audio: "áudio clonado" }[v.source] || v.source;
    const item = document.createElement("div");
    item.className = "pp-item";
    item.innerHTML = `<div class="pp-item-info">
        <div class="pp-item-name"><code>🎙 ${escapeHtml(v.name)}</code></div>
        <div class="pp-item-text">${escapeHtml(`${origin} · seed ${v.seed} · ${v.duration}s${v.instruct ? " · " + v.instruct : ""}`)}</div>
      </div>`;
    const audio = document.createElement("audio");
    audio.className = "pp-audio";
    audio.controls = true;
    audio.preload = "none";
    // ?v= evita o cache do navegador quando a voz é recriada com o mesmo nome
    audio.src = `${localServerUrl()}/qwen3-tts/voices/${encodeURIComponent(v.name)}/audio?v=${encodeURIComponent(v.created)}`;
    item.querySelector(".pp-item-info").appendChild(audio);
    const actions = document.createElement("div");
    actions.className = "pp-item-actions";
    const del = document.createElement("button");
    del.title = "Excluir voz do servidor";
    del.textContent = "🗑️";
    del.addEventListener("click", async () => {
      // excluir um perfil é irreversível: apaga o áudio de referência no servidor
      const ok = await confirmDelete({
        title: `Excluir a voz “${v.name}”?`,
        text: "O perfil é apagado do servidor local: áudio de referência, seed e prompt de clonagem.",
        items: ["Gerações futuras com essa voz deixam de ser possíveis", "Os áudios já gerados continuam no histórico"],
        note: "Irreversível — não há backup dos perfis de voz.",
        okLabel: "Excluir voz",
      });
      if (!ok) return;
      try {
        await callLocal(`/qwen3-tts/voices/${encodeURIComponent(v.name)}`, { method: "DELETE" });
        setStatus(`Voz “${escapeHtml(v.name)}” excluída do servidor local.`);
      } catch (err) {
        setStatus(`<span class="err">${escapeHtml(err.message || String(err))}</span>`);
      }
      refreshLocalVoices();
    });
    actions.appendChild(del);
    item.appendChild(actions);
    list.appendChild(item);
  }
}

document.getElementById("voices-refresh").addEventListener("click", () => refreshLocalVoices());

window.addEventListener("local-voices-changed", () => {
  if (!srvAction) setSrvIndicators(localVoices.loaded ? "running" : "stopped");
  for (const n of state.nodes) {
    if (NODE_DEFS[n.type]?.params.some(p => p.optionsFn === localVoiceOptions || p.optionsFn === voiceTargetOptions)) renderNode(n);
  }
  drawEdges();
  if (!document.getElementById("prompts-panel").hidden) renderVoicesSection();
});

/* ---------- Biblioteca: pastas, cards, arrastar e backup ---------- */
/* Prompts, prompts de agentes, templates e schemas guardam a pasta em item.folder (sem o campo =
   “Sem pasta”). As pastas criadas — inclusive vazias — ficam em LIBRARY_FOLDERS_STORAGE, por
   seção. Pastas são só organização: o {{nome}} de um prompt continua valendo em qualquer pasta. */

const LIBRARY_FOLDERS_STORAGE = "assets-pipeline-library-folders";
const LIBRARY_COLLAPSED_STORAGE = "assets-pipeline-library-collapsed";
const LIBRARY_BACKUP_KEYS = { prompt: "prompts", agent: "agentPrompts", template: "outputTemplates", schema: "outputSchemas" };

const LIBRARY = {
  prompt: {
    listId: "pp-list", get: getSavedPrompts, save: saveSavedPrompts,
    empty: `Nenhum prompt salvo ainda. Crie um no ＋ e use <code>{{nome}}</code> nos nodes.`,
    create: (folder) => openPromptFormModal(null, "prompt", folder),
    card: (p) => promptCard(p, "prompt"),
  },
  agent: {
    listId: "agent-list-panel", get: getAgentPrompts, save: saveAgentPrompts,
    empty: `Nenhum prompt de agente. Crie personas/instruções de sistema e use <code>{{nome}}</code> na “Instrução de sistema” dos nodes LLM.`,
    create: (folder) => openPromptFormModal(null, "agent", folder),
    card: (p) => promptCard(p, "agent"),
  },
  template: {
    listId: "tpl-list-panel", get: getOutputTemplates, save: saveOutputTemplates, affectsNodes: true,
    empty: `Nenhum template de saída. Eles aparecem no campo “Formato de saída” dos nodes de texto.`,
    create: (folder) => openTemplateFormModal(null, folder),
    card: (t) => templateCard(t),
  },
  schema: {
    listId: "schema-list-panel", get: getOutputSchemas, save: saveOutputSchemas, affectsNodes: true,
    empty: "", // a seção sempre tem os embutidos
    create: (folder) => openSchemaFormModal(null, false, folder),
    card: (s) => schemaCard(s),
    extra: renderBuiltinSchemas,
  },
};

function readJsonStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function getStoredFolders() {
  const all = readJsonStorage(LIBRARY_FOLDERS_STORAGE, {});
  return all && typeof all === "object" && !Array.isArray(all) ? all : {};
}

function saveStoredFolders(all) {
  localStorage.setItem(LIBRARY_FOLDERS_STORAGE, JSON.stringify(all));
}

/* pastas são um caminho: "pokeru/characters". Cada trecho é limpo e o caminho tem até 5 níveis. */
const FOLDER_MAX_DEPTH = 5;

function normalizeFolderName(value) {
  return String(value || "")
    .split("/")
    .map(part => part.trim().replace(/\s+/g, " ").slice(0, 60))
    .filter(Boolean)
    .slice(0, FOLDER_MAX_DEPTH)
    .join("/");
}

function folderParts(path) { return String(path || "").split("/").filter(Boolean); }
function folderParent(path) { return folderParts(path).slice(0, -1).join("/"); }
function folderLeaf(path) { return folderParts(path).at(-1) || ""; }
function folderJoin(parent, name) { return normalizeFolderName(parent ? `${parent}/${name}` : name); }
/* a pasta em si e tudo o que está dentro dela */
function inFolderTree(path, folder) { return folder === path || folder.startsWith(path + "/"); }

function setItemFolder(item, folder) {
  if (folder) item.folder = folder;
  else delete item.folder;
  return item;
}

/* pastas de uma seção: as criadas (mesmo vazias), as que algum item usa e as pastas-pai delas */
function libraryFolders(kind) {
  const names = new Set();
  const add = (path) => {
    const clean = normalizeFolderName(path);
    if (!clean) return;
    // "pokeru/characters" também garante a existência de "pokeru"
    const parts = folderParts(clean);
    for (let i = 1; i <= parts.length; i++) names.add(parts.slice(0, i).join("/"));
  };
  for (const f of getStoredFolders()[kind] || []) add(f);
  for (const it of LIBRARY[kind].get()) add(libraryFolder(it));
  return [...names].sort(compareByName);
}

/* árvore das pastas: Map aninhado { trecho -> { path, children } } */
function libraryFolderTree(kind) {
  const root = new Map();
  for (const path of libraryFolders(kind)) {
    let level = root;
    let acc = "";
    for (const part of folderParts(path)) {
      acc = acc ? `${acc}/${part}` : part;
      if (!level.has(part)) level.set(part, { path: acc, children: new Map() });
      level = level.get(part).children;
    }
  }
  return root;
}

function registerFolder(kind, folder) {
  if (!folder) return;
  const all = getStoredFolders();
  const list = Array.isArray(all[kind]) ? all[kind] : [];
  if (list.includes(folder)) return;
  all[kind] = [...list, folder];
  saveStoredFolders(all);
}

/* sugestões do campo “Pasta” dos formulários */
function fillFolderOptions(kind) {
  const datalist = document.getElementById("lib-folder-options");
  datalist.innerHTML = "";
  for (const f of libraryFolders(kind)) {
    const o = document.createElement("option");
    o.value = f;
    datalist.appendChild(o);
  }
}

const collapsedFolders = new Set((() => {
  const saved = readJsonStorage(LIBRARY_COLLAPSED_STORAGE, []);
  return Array.isArray(saved) ? saved : [];
})());

function folderKey(kind, folder) { return `${kind}::${folder}`; }

function saveCollapsed() {
  try { localStorage.setItem(LIBRARY_COLLAPSED_STORAGE, JSON.stringify([...collapsedFolders])); } catch { /* ignora */ }
}

function toggleFolder(kind, folder) {
  const key = folderKey(kind, folder);
  if (!collapsedFolders.delete(key)) collapsedFolders.add(key);
  saveCollapsed();
}

/* ----- renderização ----- */

function renderLibrarySection(kind) {
  const cfg = LIBRARY[kind];
  const list = document.getElementById(cfg.listId);
  const items = cfg.get();
  const folders = libraryFolders(kind);
  const byName = (a, b) => compareByName(a.name, b.name);
  list.innerHTML = "";
  if (!items.length && !folders.length && cfg.empty) {
    list.innerHTML = `<div class="pp-empty">${cfg.empty}</div>`;
  }
  for (const block of folderBlocks(kind, libraryFolderTree(kind), items, byName)) list.appendChild(block);
  const loose = items.filter(i => !libraryFolder(i)).sort(byName);
  if (folders.length || loose.length) {
    const box = document.createElement("div");
    box.className = "lib-loose";
    if (folders.length) {
      // com pastas na seção, “Sem pasta” vira alvo para tirar um item da pasta
      const head = document.createElement("div");
      head.className = "lib-loose-head";
      head.textContent = loose.length ? "Sem pasta" : "Sem pasta — arraste para cá para tirar um item da pasta";
      box.appendChild(head);
      makeDropTarget(box, head, kind, "");
    }
    for (const it of loose) box.appendChild(cfg.card(it));
    list.appendChild(box);
  }
  cfg.extra?.(list);
}

/* um bloco por pasta, com as subpastas dentro do corpo */
function folderBlocks(kind, level, items, byName) {
  const cfg = LIBRARY[kind];
  return [...level.values()]
    .sort((a, b) => compareByName(folderLeaf(a.path), folderLeaf(b.path)))
    .map(node => folderBlock(
      kind,
      node.path,
      items.filter(i => libraryFolder(i) === node.path).sort(byName).map(i => cfg.card(i)),
      {
        label: folderLeaf(node.path),
        sub: folderBlocks(kind, node.children, items, byName),
        total: items.filter(i => inFolderTree(node.path, libraryFolder(i))).length,
      },
    ));
}

function smallButton(icon, title, fn) {
  const b = document.createElement("button");
  b.textContent = icon;
  b.title = title;
  if (fn) b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
  return b;
}

function folderBlock(kind, name, cards, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = "lib-folder" + (collapsedFolders.has(folderKey(kind, name)) ? " collapsed" : "");
  const head = document.createElement("div");
  head.className = "lib-folder-head";
  const toggle = document.createElement("button");
  toggle.className = "lib-folder-toggle";
  toggle.title = "Abrir/fechar a pasta";
  const total = opts.total ?? cards.length;
  toggle.innerHTML = `<span class="lib-folder-chev">▾</span><span>${opts.icon || "📁"}</span>` +
    `<span class="lib-folder-name"></span><span class="lib-folder-count">${total}</span>`;
  toggle.title = `Abrir/fechar${opts.sub?.length ? " (inclui subpastas)" : ""}`;
  toggle.querySelector(".lib-folder-name").textContent = opts.label || name;
  toggle.addEventListener("click", () => { toggleFolder(kind, name); wrap.classList.toggle("collapsed"); });
  head.appendChild(toggle);
  const body = document.createElement("div");
  body.className = "lib-folder-body";
  if (opts.sub?.length) body.append(...opts.sub);
  if (cards.length) body.append(...cards);
  if (!cards.length && !opts.sub?.length) {
    body.innerHTML = `<div class="lib-folder-empty">Pasta vazia — arraste itens para cá ou use o ＋ da pasta.</div>`;
  }
  if (!opts.builtin) {
    const actions = document.createElement("div");
    actions.className = "lib-folder-actions";
    const del = smallButton("🗑️", "Excluir a pasta e as subpastas (os itens vão para “Sem pasta”, nada é apagado)",
      () => confirmDeleteLibraryFolder(kind, name));
    const podeSubpasta = folderParts(name).length < FOLDER_MAX_DEPTH;
    actions.append(
      smallButton("＋", `Novo item na pasta “${name}”`, () => LIBRARY[kind].create(name)),
      ...(podeSubpasta ? [smallButton("📁", `Nova subpasta dentro de “${name}”`, () => createLibraryFolder(kind, name))] : []),
      smallButton("✏️", "Renomear a pasta", () => renameLibraryFolder(kind, name)),
      del,
    );
    head.appendChild(actions);
    makeDropTarget(wrap, head, kind, name);
  }
  wrap.append(head, body);
  return wrap;
}

let libDrag = null; // { kind, id } do card sendo arrastado

function libCard({ name, text, actions, drag }) {
  const item = document.createElement("div");
  item.className = "pp-item";
  item.innerHTML = `<div class="pp-item-info"><div class="pp-item-name"><code></code></div><div class="pp-item-text"></div></div>`;
  item.querySelector("code").textContent = name;
  item.querySelector(".pp-item-text").textContent = text;
  const box = document.createElement("div");
  box.className = "pp-item-actions";
  for (const [icon, title, fn] of actions) box.appendChild(smallButton(icon, title, fn));
  item.appendChild(box);
  if (drag) {
    item.draggable = true;
    item.addEventListener("dragstart", (e) => {
      libDrag = { kind: drag.kind, id: drag.id };
      e.dataTransfer.effectAllowed = "copyMove";
      // prompts: soltar o card num campo de texto de um node insere o {{nome}}
      e.dataTransfer.setData(drag.text ? "text/plain" : "application/x-assets-library", drag.text || drag.id);
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
      libDrag = null;
      item.classList.remove("dragging");
      document.querySelectorAll(".lib-folder-head.drop, .lib-loose-head.drop").forEach(el => el.classList.remove("drop"));
    });
  }
  return item;
}

/* el recebe o card; highlight é o cabeçalho que acende enquanto o card está por cima */
function makeDropTarget(el, highlight, kind, folder) {
  el.addEventListener("dragover", (e) => {
    if (libDrag?.kind !== kind) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    highlight.classList.add("drop");
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget)) highlight.classList.remove("drop");
  });
  el.addEventListener("drop", (e) => {
    if (libDrag?.kind !== kind) return;
    e.preventDefault();
    highlight.classList.remove("drop");
    const { id } = libDrag;
    libDrag = null;
    moveLibraryItem(kind, id, folder);
  });
}

function promptCard(p, kind) {
  const ref = `{{${p.name}}}`;
  return libCard({
    name: (kind === "agent" ? "🤖 " : "") + ref,
    text: p.text,
    drag: { kind, id: p.id, text: ref },
    actions: [
      ["📋", `Copiar ${ref}`, () => {
        navigator.clipboard?.writeText(ref);
        setStatus(`<span class="ok">${escapeHtml(ref)} copiado — cole num campo de texto de um node.</span>`);
      }],
      ["✏️", "Editar", () => openPromptFormModal(p, kind)],
      ["🗑️", "Excluir", () => confirmDeleteLibraryItem(kind, p.id)],
    ],
  });
}

function templateCard(t) {
  return libCard({
    name: "📄 " + t.name,
    text: t.instruction,
    drag: { kind: "template", id: t.id },
    actions: [
      ["✏️", "Editar", () => openTemplateFormModal(t)],
      ["🗑️", "Excluir", () => confirmDeleteLibraryItem("template", t.id)],
    ],
  });
}

function schemaCard(s) {
  let summary;
  try { summary = schemaSummary(JSON.parse(s.schema)); } catch { summary = "JSON inválido"; }
  return libCard({
    name: "📐 " + s.name,
    text: summary,
    drag: { kind: "schema", id: s.id },
    actions: [
      ["✏️", "Editar", () => openSchemaFormModal(s, true)],
      ["🗑️", "Excluir", () => confirmDeleteLibraryItem("schema", s.id)],
    ],
  });
}

/* schemas embutidos: uma pasta fixa, só para consulta e duplicação */
function renderBuiltinSchemas(list) {
  const cards = Object.values(BUILTIN_SCHEMAS).map(b => libCard({
    name: "🧩 " + b.name,
    text: schemaSummary(b.schema),
    actions: [
      ["⧉", "Duplicar para editar", () => openSchemaFormModal({ name: `${b.name} (cópia)`, schema: JSON.stringify(b.schema, null, 2) }, false)],
    ],
  }));
  list.appendChild(folderBlock("schema", "__builtin", cards, { label: "Embutidos", icon: "🧩", builtin: true }));
}

/* nodes que usam um item da Biblioteca: {{nome}} nos textos, tpl:<id> e sch:<id> nos selects */
function libraryItemUsage(kind, item) {
  const needle = kind === "prompt" || kind === "agent" ? `{{${item.name}}}` : `${kind === "template" ? "tpl:" : "sch:"}${item.id}`;
  return state.nodes.filter(n => Object.values(n.params).some(v => typeof v === "string" && v.includes(needle)));
}

/* pergunta antes de excluir um item da Biblioteca (o assistente tem a confirmação dele) */
async function confirmDeleteLibraryItem(kind, id) {
  const item = LIBRARY[kind].get().find(x => x.id === id);
  if (!item) return;
  const noun = { prompt: "prompt", agent: "prompt de agente", template: "template de saída", schema: "schema de saída" }[kind];
  const usados = libraryItemUsage(kind, item);
  const items = [];
  if (libraryFolder(item)) items.push(`Pasta: ${libraryFolder(item)}`);
  if (usados.length) {
    items.push(`Usado por ${usados.length} node(s): ${usados.slice(0, 6).map(n => n.id).join(", ")}${usados.length > 6 ? "…" : ""}`);
  }
  const ok = await confirmDelete({
    title: `Excluir o ${noun} “${item.name}”?`,
    text: usados.length
      ? (kind === "prompt" || kind === "agent"
        ? `Os nodes que usam {{${item.name}}} passam a mostrar o texto cru.`
        : "Os nodes que apontam para ele ficam com o campo “(indisponível)”.")
      : "Só este item da Biblioteca é apagado.",
    items,
    note: "Não dá para desfazer pelo editor. O backup completo (menu 📋 → Backup) guarda uma cópia.",
    okLabel: "Excluir",
  });
  if (ok) deleteLibraryItem(kind, id);
}

/* exclui um item da Biblioteca (sem confirmação — quem chama decide); devolve o item ou null */
function deleteLibraryItem(kind, id) {
  const cfg = LIBRARY[kind];
  const items = cfg.get();
  const item = items.find(x => x.id === id);
  if (!item) return null;
  cfg.save(items.filter(x => x.id !== id));
  if ((kind === "prompt" || kind === "agent") && editingPromptId === id) closePromptFormModal();
  if (kind === "template" && editingTemplateId === id) closeTemplateFormModal();
  if (kind === "schema" && editingSchemaId === id) closeSchemaFormModal();
  afterLibraryChange(kind);
  const noun = { prompt: "Prompt", agent: "Prompt de agente", template: "Template", schema: "Schema" }[kind];
  setStatus(`${noun} “${escapeHtml(item.name)}” excluído.`);
  return item;
}

/* ----- operações com pastas ----- */

function afterLibraryChange(kind) {
  markBackupDirty();
  markMirrorLibrary();
  renderLibrarySection(kind);
  if (LIBRARY[kind].affectsNodes) refreshAllNodes(); // selects de template/schema mostram as pastas
}

function moveLibraryItem(kind, id, folder) {
  const cfg = LIBRARY[kind];
  const items = cfg.get();
  const it = items.find(x => x.id === id);
  if (!it || libraryFolder(it) === folder) return;
  setItemFolder(it, folder);
  cfg.save(items);
  registerFolder(kind, folder);
  afterLibraryChange(kind);
  setStatus(`“${escapeHtml(it.name)}” movido para ${folder ? `a pasta “${escapeHtml(folder)}”` : "“Sem pasta”"}.`);
}

async function createLibraryFolder(kind, parent = "") {
  const taken = new Set(libraryFolders(kind).map(f => f.toLowerCase()));
  const full = (v) => folderJoin(parent, normalizeFolderName(v));
  const value = await askText({
    title: parent ? `Nova subpasta em “${parent}”` : "Nova pasta",
    note: parent
      ? "O caminho fica “" + parent + "/nome”. Use / para criar mais níveis de uma vez."
      : "Pastas só organizam a Biblioteca: o {{nome}} de um prompt continua funcionando em qualquer pasta. Use / para subpastas, ex.: pokeru/characters.",
    label: parent ? "Nome da subpasta" : "Nome da pasta",
    placeholder: parent ? "ex.: characters" : "ex.: pokeru/characters",
    ok: "Criar pasta",
    validate: v => {
      const path = full(v);
      if (!path) return "Informe um nome.";
      if (folderParts(path).length > FOLDER_MAX_DEPTH) return `No máximo ${FOLDER_MAX_DEPTH} níveis de pasta.`;
      return taken.has(path.toLowerCase()) ? "Já existe uma pasta com esse caminho nesta seção." : null;
    },
  });
  if (value == null) return;
  createLibraryFolderNamed(kind, full(value));
}

/* cria a pasta sem modal; devolve o nome normalizado */
function createLibraryFolderNamed(kind, value) {
  const folder = normalizeFolderName(value);
  registerFolder(kind, folder);
  collapsedFolders.delete(folderKey(kind, folder));
  saveCollapsed();
  renderLibrarySection(kind);
  setStatus(`Pasta “${escapeHtml(folder)}” criada — arraste itens para ela ou use o ＋ da pasta.`);
  return folder;
}

async function renameLibraryFolder(kind, oldName) {
  const taken = new Set(libraryFolders(kind).filter(f => f !== oldName).map(f => f.toLowerCase()));
  const parent = folderParent(oldName);
  const value = await askText({
    title: "Renomear pasta",
    note: parent
      ? `Está em “${parent}”. Um nome simples mantém o lugar; com / você move a pasta (ex.: outra/${folderLeaf(oldName)}).`
      : "Com / você transforma em subpasta de outra, ex.: pokeru/characters.",
    label: "Novo nome",
    value: folderLeaf(oldName),
    ok: "Renomear",
    validate: v => {
      const target = folderTargetPath(oldName, v);
      if (!target) return "Informe um nome.";
      if (inFolderTree(oldName, target) && target !== oldName) return "Uma pasta não pode virar subpasta dela mesma.";
      if (folderParts(target).length > FOLDER_MAX_DEPTH) return `No máximo ${FOLDER_MAX_DEPTH} níveis de pasta.`;
      return taken.has(target.toLowerCase()) ? "Já existe uma pasta com esse caminho nesta seção." : null;
    },
  });
  if (value == null) return;
  renameLibraryFolderTo(kind, oldName, value);
}

/* nome simples mantém a pasta onde está; com / vale o caminho inteiro digitado */
function folderTargetPath(oldName, value) {
  const typed = String(value || "");
  return typed.includes("/") ? normalizeFolderName(typed) : folderJoin(folderParent(oldName), typed);
}

/* renomeia a pasta sem modal (quem chama garante que o nome é único); devolve o nome novo */
function renameLibraryFolderTo(kind, oldName, value) {
  const name = folderTargetPath(oldName, value);
  if (!name || name === oldName || inFolderTree(oldName, name)) return oldName;
  // a pasta e tudo o que está dentro dela mudam de caminho
  const rewrite = (path) => (inFolderTree(oldName, path) ? name + path.slice(oldName.length) : path);
  const cfg = LIBRARY[kind];
  const items = cfg.get();
  for (const it of items) {
    const folder = libraryFolder(it);
    if (inFolderTree(oldName, folder)) it.folder = rewrite(folder);
  }
  cfg.save(items);
  const all = getStoredFolders();
  all[kind] = [...new Set((all[kind] || []).map(rewrite))];
  saveStoredFolders(all);
  for (const key of [...collapsedFolders]) {
    const [k, path] = [key.slice(0, key.indexOf("::")), key.slice(key.indexOf("::") + 2)];
    if (k === kind && inFolderTree(oldName, path)) {
      collapsedFolders.delete(key);
      collapsedFolders.add(folderKey(kind, rewrite(path)));
    }
  }
  saveCollapsed();
  afterLibraryChange(kind);
  setStatus(`Pasta renomeada para “${escapeHtml(name)}”.`);
  return name;
}

async function confirmDeleteLibraryFolder(kind, name) {
  const subs = libraryFolders(kind).filter(f => f !== name && inFolderTree(name, f));
  const itens = LIBRARY[kind].get().filter(x => inFolderTree(name, libraryFolder(x)));
  const items = [];
  if (subs.length) items.push(`${subs.length} subpasta(s): ${subs.slice(0, 5).join(", ")}${subs.length > 5 ? "…" : ""}`);
  items.push(itens.length ? `${itens.length} item(ns) vão para “Sem pasta”` : "A pasta está vazia");
  const ok = await confirmDelete({
    title: `Excluir a pasta “${name}”?`,
    text: "A pasta some da Biblioteca, mas nenhum prompt, template ou schema é apagado.",
    items,
    okLabel: "Excluir pasta",
  });
  if (ok) deleteLibraryFolder(kind, name);
}

function deleteLibraryFolder(kind, name) {
  const cfg = LIBRARY[kind];
  const items = cfg.get();
  const subpastas = libraryFolders(kind).filter(f => f !== name && inFolderTree(name, f)).length;
  let moved = 0;
  for (const it of items) {
    if (inFolderTree(name, libraryFolder(it))) { delete it.folder; moved++; }
  }
  cfg.save(items);
  const all = getStoredFolders();
  all[kind] = (all[kind] || []).filter(f => !inFolderTree(name, f));
  saveStoredFolders(all);
  for (const key of [...collapsedFolders]) {
    const path = key.startsWith(kind + "::") ? key.slice(kind.length + 2) : null;
    if (path && inFolderTree(name, path)) collapsedFolders.delete(key);
  }
  saveCollapsed();
  afterLibraryChange(kind);
  const detalhes = [
    subpastas ? `${subpastas} subpasta(s)` : "",
    moved ? `${moved} item(ns) foram para “Sem pasta” (nada foi apagado)` : "",
  ].filter(Boolean).join(" · ");
  setStatus(`Pasta “${escapeHtml(name)}” excluída${detalhes ? ` — ${detalhes}` : ""}.`);
}

document.querySelectorAll("[data-lib-folder]").forEach(btn => {
  btn.addEventListener("click", () => createLibraryFolder(btn.dataset.libFolder));
});

/* ----- Biblioteca no backup ----- */

function exportLibrary() {
  const out = { folders: getStoredFolders() };
  for (const [kind, key] of Object.entries(LIBRARY_BACKUP_KEYS)) out[key] = LIBRARY[kind].get();
  return out;
}

/* soma os itens do backup aos atuais: iguais são ignorados; nome repetido ganha sufixo */
function importLibrary(lib) {
  if (!lib || typeof lib !== "object") return 0;
  let added = 0;
  const promptNames = new Set([...getSavedPrompts(), ...getAgentPrompts()].map(p => p.name));
  const signature = (i) => JSON.stringify([i.name, i.text ?? null, i.instruction ?? null, i.schema ?? null]);
  for (const [kind, key] of Object.entries(LIBRARY_BACKUP_KEYS)) {
    const incoming = Array.isArray(lib[key]) ? lib[key] : [];
    if (!incoming.length) continue;
    const cfg = LIBRARY[kind];
    const items = cfg.get();
    const isPrompt = kind === "prompt" || kind === "agent";
    const names = isPrompt ? promptNames : new Set(items.map(i => i.name));
    const ids = new Set(items.map(i => i.id));
    const signatures = new Set(items.map(signature));
    for (const raw of incoming) {
      if (!raw || typeof raw !== "object" || !raw.name || signatures.has(signature(raw))) continue;
      const it = { ...raw };
      if (!it.id || ids.has(it.id)) it.id = kind[0] + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      // {{nome}} de prompt não aceita espaço: sufixo _2, _3…; os demais ganham " (2)"
      for (let i = 2; names.has(it.name); i++) it.name = isPrompt ? `${raw.name}_${i}` : `${raw.name} (${i})`;
      names.add(it.name);
      ids.add(it.id);
      signatures.add(signature(it));
      items.push(it);
      registerFolder(kind, libraryFolder(it));
      added++;
    }
    cfg.save(items);
  }
  const folders = lib.folders && typeof lib.folders === "object" ? lib.folders : {};
  for (const kind of Object.keys(LIBRARY)) {
    for (const f of Array.isArray(folders[kind]) ? folders[kind] : []) registerFolder(kind, normalizeFolderName(f));
  }
  return added;
}

document.getElementById("btn-prompts").addEventListener("click", () => {
  const panel = document.getElementById("prompts-panel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    renderPromptsPanel();
    drawEdges();
  } else {
    drawEdges();
  }
});
document.getElementById("pp-close").addEventListener("click", () => {
  document.getElementById("prompts-panel").hidden = true;
  drawEdges();
});

/* regras de nome de prompt — prompts e prompts de agentes dividem o espaço de {{nome}}; null = ok */
function validatePromptName(name, exceptId = null) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return "Nome inválido — use apenas letras, números, _ e - (sem espaços).";
  if (name === "input") return "“input” é reservado para a interpolação do node Texto — escolha outro nome.";
  const duplicate = [...getSavedPrompts(), ...getAgentPrompts()].find(x => x.name === name && x.id !== exceptId);
  return duplicate ? `Já existe um prompt chamado “${name}”.` : null;
}

document.getElementById("pp-save").addEventListener("click", () => {
  const name = document.getElementById("pp-name").value.trim();
  const text = document.getElementById("pp-text").value.trim();
  if (!name || !text) {
    setStatus(`<span class="err">Preencha o nome e o texto do prompt.</span>`);
    return;
  }
  const nameError = validatePromptName(name, editingPromptId);
  if (nameError) {
    setStatus(`<span class="err">${escapeHtml(nameError)}</span>`);
    return;
  }
  const isAgent = editingPromptKind === "agent";
  const folder = normalizeFolderName(document.getElementById("pp-folder").value);
  const prompts = isAgent ? getAgentPrompts() : getSavedPrompts();
  if (editingPromptId) {
    const p = prompts.find(x => x.id === editingPromptId);
    if (p) { p.name = name; p.text = text; setItemFolder(p, folder); }
  } else {
    prompts.push(setItemFolder({ id: (isAgent ? "a" : "p") + Date.now(), name, text }, folder));
  }
  (isAgent ? saveAgentPrompts : saveSavedPrompts)(prompts);
  registerFolder(isAgent ? "agent" : "prompt", folder);
  setStatus(`<span class="ok">Prompt “${name}” salvo — use {{${name}}} em qualquer campo de texto.</span>`);
  closePromptFormModal();
  renderPromptsPanel();
});

document.getElementById("pp-cancel").addEventListener("click", closePromptFormModal);
document.getElementById("pp-new").addEventListener("click", () => openPromptFormModal(null, "prompt"));
document.getElementById("agent-new").addEventListener("click", () => openPromptFormModal(null, "agent"));

document.querySelectorAll(".modal-close").forEach(btn => {
  btn.addEventListener("click", () => {
    document.getElementById(btn.dataset.close).hidden = true;
    if (btn.dataset.close === "confirm-modal") finishConfirm(false);
  });
});
document.querySelectorAll(".modal-backdrop").forEach(backdrop => {
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target !== backdrop) return;
    backdrop.hidden = true;
    if (backdrop.id === "confirm-modal") finishConfirm(false);
  });
});

window.addEventListener("keydown", (e) => {
  const inField = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (e.key === "Delete" && !inField) {
    const t = currentTargets();
    if (hasTargets(t)) removeTargets(t);
  }
  // copiar / colar / duplicar / selecionar tudo (com texto selecionado, Ctrl+C copia o texto)
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !inField) {
    const key = e.key.toLowerCase();
    const textoSelecionado = Boolean(window.getSelection?.()?.toString());
    if (key === "c" && !textoSelecionado && hasTargets(currentTargets())) { e.preventDefault(); copyTargets(currentTargets()); }
    if (key === "v") { e.preventDefault(); pasteAt(lastPointer.x, lastPointer.y); }
    if (key === "d") { e.preventDefault(); duplicateTargets(currentTargets()); }
    if (key === "a") { e.preventDefault(); selectAll(); }
  }
  if (e.key === "Escape") {
    finishConfirm(false);
    closeContextMenu();
    clearSelection();
    document.querySelectorAll(".modal-backdrop").forEach(m => { m.hidden = true; });
  }
  if (!document.getElementById("viewer-modal").hidden && !inField) {
    if (e.key === "ArrowLeft") viewerNav(-1);
    if (e.key === "ArrowRight") viewerNav(1);
  }
});

window.addEventListener("resize", drawEdges);

/* ---------- inicialização ---------- */

buildPalette();
state.pan = defaultPan();
applyTransform();
refreshLocalVoices(); // silencioso se o servidor local estiver desligado
applyModelCatalog();  // modelos, tamanhos e qualidades já conhecidos entram nos selects antes do primeiro render
refreshClaudeInfo().then(ok => { if (ok) for (const n of state.nodes) if (n.type === "claude-code") renderNode(n); });
fillChatModelSelect();
updateModelLists();   // consulta as APIs se a lista tiver mais de 1 dia (silencioso)
initWorkflows();

// grava o que estiver pendente ao fechar/trocar de aba (o localStorage garante a cópia síncrona)
window.addEventListener("pagehide", () => { flushPendingSaves(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) flushPendingSaves(); });

async function initWorkflows() {
  requestPersistentStorage();
  initAutoBackup();
  await syncFromServer();   // antes de abrir qualquer workflow: o que sumiu do navegador volta aqui
  let current = null, localGraph = null, localMeta = null;
  try { current = JSON.parse(localStorage.getItem(CURRENT_WF_STORAGE)); } catch { /* ignora */ }
  try { localGraph = JSON.parse(localStorage.getItem(GRAPH_STORAGE)); } catch { /* ignora */ }
  try { localMeta = JSON.parse(localStorage.getItem(GRAPH_META_STORAGE)); } catch { /* ignora */ }
  const id = current?.id || null;

  // migra a sessão do formato antigo (única, sem workflow) para o workflow aberto — só se ele
  // ainda não tiver resultados próprios; senão ela fica onde está, intocada
  const legacy = await idbGet("session", "current");
  const target = id || "ex1";
  if (legacy && !await idbGet("session", "auto:" + target)) {
    const moved = await idbPut("session", { id: "auto:" + target, workflowId: target, kind: "auto", results: legacy.results || {}, ts: legacy.ts || Date.now() });
    if (moved) await idbDel("session", "current");
  }

  if (id) {
    // cópia do localStorage: das versões antigas (sem meta, então vale sobre tudo) ou mais nova
    // que o rascunho do IndexedDB (aba fechada no meio de uma gravação)
    const local = localGraph?.nodes && (!localMeta || localMeta.workflowId === id)
      ? { graph: localGraph, ts: localMeta?.ts ?? Infinity } : null;
    const res = await loadWorkflow(id, { local, quiet: true });
    if (res) {
      setStatus(`<span class="ok">Workflow “${escapeHtml(state.workflowName)}” restaurado` +
        `${res.restored ? ` — ${res.restored} node(s) com os resultados de onde você parou` : ""}` +
        `${state.dirty ? ` (${dirtyLabel()})` : ""}.</span>`);
      return;
    }
  }
  await loadWorkflow("ex1", { quiet: true });
  setStatus("Exemplo 1 carregado. Configure suas 🔑 chaves de API e clique em ▶ Executar.");
}
