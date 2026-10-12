/* ============================================================
   panel.js — painel do Assistente de IA (entrada, <script type="module">)
   ============================================================
   Só este módulo e os que não dependem do LangChain carregam com a página.
   O LangChain (CDN) é importado na primeira vez que o painel abre.
   ============================================================ */

import { app, missingGlobals } from "./bridge.js";
import {
  PROVIDERS, providerModels, isDebug, loadSettings, saveSettings, defaultProvider,
  newConversation, saveConversation, latestConversation, listConversations, deleteConversation,
} from "./store.js";
import { TurnCheckpoint, restoreCheckpoint } from "./undo.js";
import { focusNodes } from "./graph-ops.js";

const $ = (id) => document.getElementById(id);
const panel = $("assistant-panel");
const log = $("as-log");
const input = $("as-input");
const sendBtn = $("as-send");
const statusEl = $("as-status");

const TOOL_LABELS = {
  list_workflows: "Listando workflows", get_workflow: "Lendo workflow", get_node: "Lendo node",
  describe_node_type: "Consultando tipo de node", read_library: "Lendo a Biblioteca", edit_graph: "Editando o grafo",
  auto_layout: "Organizando o layout", open_workflow: "Abrindo workflow", create_workflow: "Criando workflow",
  save_workflow: "Salvando workflow", rename_workflow: "Renomeando workflow", delete_workflow: "Excluindo workflow",
  save_library_item: "Salvando na Biblioteca", delete_library_item: "Excluindo da Biblioteca", manage_folder: "Pastas da Biblioteca",
};

const EXAMPLES = [
  "Crie um workflow que gera 3 prompts de imagem a partir de um conceito e depois as imagens",
  "Crie um schema “Ficha de NPC” com nome, classe e uma lista de falas",
  "Explique o workflow aberto e aponte problemas",
];

let runtime = null;     // módulos que dependem do LangChain
let runtimeLoading = null;
let settings = loadSettings();
let conv = null;
let busy = false;
let controller = null;
const turnResults = {}; // turnId → resultados em memória para o ↺ (não vão para o IndexedDB)

/* ---------- carregamento ---------- */

function loadRuntime() {
  runtimeLoading ??= Promise.all([
    import("./lc.js"), import("./agent.js"), import("./models.js"), import("./tools.js"), import("./context.js"),
  ]).then(([lc, agent, models, tools, context]) => (runtime = { lc, agent, models, tools, context }))
    .catch((err) => { runtimeLoading = null; throw err; });
  return runtimeLoading;
}

async function ensureRuntime() {
  if (runtime) return runtime;
  const note = addEphemeral("as-note", "Carregando o assistente (LangChain)… na primeira vez pode levar até um minuto.");
  try {
    return await loadRuntime();
  } catch (err) {
    // Um build ruim de alguma dependência no CDN dá erro de MÓDULO, não de rede — e aí
    // "confira a internet" manda para o lado errado (aconteceu com o langsmith em 11/10/2026).
    const msg = err.message || String(err);
    const rede = !navigator.onLine || /Failed to fetch|NetworkError|ERR_|timed? ?out/i.test(msg);
    addEphemeral("as-error", rede
      ? `Não foi possível carregar o LangChain: ${msg}. Confira a internet e tente de novo.`
      : `Não foi possível carregar o LangChain: ${msg} — é erro de módulo, não de rede: alguma `
        + `versão publicada no CDN (esm.sh) está quebrada. As versões ficam fixadas em `
        + `js/assistant/lc.js, e o Console (F12) mostra qual arquivo falhou.`);
    return null;
  } finally {
    note.remove();
  }
}

/* ---------- abrir/fechar ---------- */

function setOpen(open) {
  panel.hidden = !open;
  // em telas estreitas, assistente e Biblioteca não cabem lado a lado
  if (open && !bothFit()) $("prompts-panel").hidden = true;
  app.drawEdges();
  if (open) onOpen();
}

async function onOpen() {
  const missing = missingGlobals();
  if (missing.length) {
    showBanner(`O assistente não encontrou no app: ${missing.join(", ")}. Recarregue a página (F5).`);
    return;
  }
  if (!settings.provider || !(settings.provider in providersShown())) {
    settings.provider = defaultProvider();
    saveSettings(settings);
  }
  if (!busy && (!conv || conv.workflowId !== app.state.workflowId)) await switchConversation(app.state.workflowId);
  else renderSessionBar();
  renderSettings();
  updateBanner();
  updateContextLine();
  input.focus();
  ensureRuntime(); // já começa a baixar o LangChain enquanto o usuário digita
}

$("btn-assistant").addEventListener("click", () => setOpen(panel.hidden));
$("as-close").addEventListener("click", () => setOpen(false));
$("btn-prompts").addEventListener("click", () => {
  // o handler do app.js já alternou a Biblioteca
  if (!$("prompts-panel").hidden && !panel.hidden && !bothFit()) {
    panel.hidden = true;
    app.drawEdges();
  }
});

/* ---------- conversa ---------- */

/* abre a sessão mais recente do workflow (cada pedido já é salvo ao terminar) */
async function switchConversation(workflowId) {
  conv = (await latestConversation(workflowId)) || newConversation(workflowId);
  renderLog();
  renderSessionBar();
}

window.addEventListener("workflow-changed", (e) => {
  updateContextLine();
  // durante um pedido quem troca de workflow é o assistente: a conversa continua a mesma
  if (busy || panel.hidden || conv?.workflowId === e.detail.id) return;
  switchConversation(e.detail.id);
});

$("as-new").addEventListener("click", () => newSession());

/* ---------- sessões (conversas salvas por workflow) ---------- */

function sessionTitle(c) {
  return c?.title || "Nova sessão";
}

function sessionMeta(c) {
  const asks = c.ui.filter(i => i.role === "user").length;
  return asks ? `${app.fmtDate(c.ts)} · ${asks} pedido(s)` : "vazia";
}

/* sessões do workflow aberto — a atual entra mesmo antes do primeiro pedido */
async function sessionsOfWorkflow() {
  const list = await listConversations(app.state.workflowId);
  if (conv && conv.workflowId === app.state.workflowId && !list.some(x => x.id === conv.id)) list.unshift(conv);
  return list;
}

async function renderSessionBar() {
  if (!conv) return;
  $("as-session-title").textContent = sessionTitle(conv);
  const list = await sessionsOfWorkflow();
  const count = $("as-session-count");
  count.textContent = String(list.length);
  count.hidden = list.length < 2;
  if (!$("as-sessions").hidden) renderSessionList(list);
}

function renderSessionList(list) {
  const box = $("as-sessions");
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "as-sessions-head";
  const label = document.createElement("span");
  label.textContent = `Sessões de “${app.state.workflowName}”`;
  const add = document.createElement("button");
  add.textContent = "＋ Nova sessão";
  add.disabled = busy;
  add.addEventListener("click", () => newSession());
  head.append(label, add);
  box.appendChild(head);
  for (const c of list) {
    const row = document.createElement("div");
    row.className = "as-session-row" + (c.id === conv?.id ? " current" : "");
    const open = document.createElement("button");
    open.className = "as-session-open";
    open.title = sessionTitle(c);
    open.innerHTML = `<span class="as-session-name"></span><span class="as-session-meta"></span>`;
    open.querySelector(".as-session-name").textContent = sessionTitle(c);
    open.querySelector(".as-session-meta").textContent = sessionMeta(c);
    open.addEventListener("click", () => openSession(c.id));
    const rename = document.createElement("button");
    rename.className = "as-session-act";
    rename.textContent = "✏️";
    rename.title = "Renomear sessão";
    rename.addEventListener("click", () => renameSession(c.id));
    const del = document.createElement("button");
    del.className = "as-session-act";
    del.textContent = "🗑";
    del.title = "Excluir sessão";
    del.addEventListener("click", async () => {
      const ok = await app.confirmDelete({
        title: `Excluir a sessão “${sessionTitle(c)}”?`,
        text: "A conversa e os pontos de ↺ desfazer dela são apagados.",
        items: [sessionMeta(c)],
        note: "As alterações que o assistente já aplicou no workflow continuam como estão.",
        okLabel: "Excluir sessão",
      });
      if (ok) deleteSession(c.id);
    });
    row.append(open, rename, del);
    box.appendChild(row);
  }
}

async function toggleSessions(show = $("as-sessions").hidden) {
  $("as-sessions").hidden = !show;
  $("as-session-btn").classList.toggle("open", show);
  if (show) {
    $("as-settings").hidden = true;
    renderSessionList(await sessionsOfWorkflow());
  }
}

$("as-session-btn").addEventListener("click", () => toggleSessions());

function newSession() {
  if (busy) return;
  conv = newConversation(app.state.workflowId);
  renderLog();
  toggleSessions(false);
  renderSessionBar();
  input.focus();
}

async function openSession(id) {
  if (busy || id === conv?.id) { toggleSessions(false); return; }
  const c = await app.idbGet("session", id);
  if (c) {
    conv = c;
    renderLog();
  }
  toggleSessions(false);
  renderSessionBar();
}

async function renameSession(id) {
  const c = id === conv?.id ? conv : await app.idbGet("session", id);
  if (!c) return;
  const name = await app.askText({ title: "Renomear sessão", label: "Nome da sessão", value: c.title || "", ok: "Renomear" });
  if (name == null) return;
  c.title = name;
  await saveConversation(c);
  renderSessionBar();
}

async function deleteSession(id) {
  if (busy) return;
  await deleteConversation(id);
  if (id === conv?.id) {
    conv = (await latestConversation(app.state.workflowId)) || newConversation(app.state.workflowId);
    renderLog();
  }
  renderSessionBar();
}

/* ---------- configurações ---------- */

function providersShown() {
  return isDebug() ? { ...PROVIDERS, scripted: { label: "🧪 Roteiro (debug, sem custo)", key: null } } : PROVIDERS;
}

function currentModel() {
  const models = providerModels(settings.provider);
  return settings.models?.[settings.provider] ?? models[0]?.value ?? "";
}

function renderSettings() {
  const providers = providersShown();
  const provSel = $("as-provider");
  provSel.innerHTML = "";
  for (const [id, p] of Object.entries(providers)) provSel.add(new Option(p.label, id));
  provSel.value = settings.provider;
  const models = providerModels(settings.provider);
  const modelSel = $("as-model-select");
  modelSel.innerHTML = "";
  for (const m of models) modelSel.add(new Option(m.label, m.value));
  modelSel.value = currentModel();
  $("as-model-wrap").hidden = !models.length;
  $("as-effort-wrap").hidden = settings.provider !== "claude-local";
  $("as-effort").value = settings.effort || "";
  $("as-max-calls").value = settings.maxModelCalls;
  const label = models.find(m => m.value === currentModel())?.label || "";
  $("as-model").textContent = `${providers[settings.provider]?.label || settings.provider}${label ? " · " + label : ""}`;
}

$("as-model").addEventListener("click", () => {
  $("as-settings").hidden = !$("as-settings").hidden;
  if (!$("as-settings").hidden) toggleSessions(false);
});
$("as-provider").addEventListener("change", (e) => {
  settings.provider = e.target.value;
  saveSettings(settings);
  renderSettings();
  updateBanner();
});
$("as-model-select").addEventListener("change", (e) => {
  settings.models = { ...settings.models, [settings.provider]: e.target.value };
  saveSettings(settings);
  renderSettings();
});
$("as-effort").addEventListener("change", (e) => { settings.effort = e.target.value; saveSettings(settings); });
$("as-max-calls").addEventListener("change", (e) => {
  settings.maxModelCalls = Math.max(3, Math.min(60, Number(e.target.value) || 25));
  saveSettings(settings);
  renderSettings();
});

function showBanner(text, action = null) {
  const b = $("as-banner");
  b.hidden = !text;
  b.innerHTML = "";
  if (!text) return;
  const span = document.createElement("span");
  span.textContent = text;
  b.appendChild(span);
  if (action) {
    const btn = document.createElement("button");
    btn.className = "btn btn-small btn-ghost";
    btn.textContent = action.label;
    btn.addEventListener("click", action.fn);
    b.appendChild(btn);
  }
}

const openKeys = { label: "Abrir 🔑", fn: () => $("btn-keys").click() };

async function updateBanner() {
  const p = providersShown()[settings.provider];
  if (p?.key && !app.getApiKeys()[p.key]) {
    showBanner(`Falta a chave ${p.label} em 🔑 Chaves.`, openKeys);
    return false;
  }
  if (settings.provider === "claude-local") {
    try {
      const info = await app.callLocal("/claude/info");
      if (info?.available === false) { showBanner("A CLI `claude` não foi encontrada pelo servidor local — veja o README."); return false; }
    } catch {
      showBanner("Servidor local desligado — ligue em 🔑 Chaves → Servidor local.", openKeys);
      return false;
    }
  }
  showBanner("");
  return true;
}

function updateContextLine() {
  const s = app.state;
  $("as-context").textContent = `Workflow: ${s.workflowName}${s.dirty ? " ●" : ""} · ${s.nodes.length} node(s)`;
}

/* ---------- renderização ---------- */

function renderMarkdown(text) {
  const blocks = [];
  let html = app.escapeHtml(text).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${code}</code></pre>`);
    return ` ${blocks.length - 1} `;
  });
  html = html
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w-])(n\d+)(?![\w-])/g, '$1<a class="as-node" data-node="$2">$2</a>');
  const out = [];
  let list = null;
  for (const line of html.split("\n")) {
    const m = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (m) {
      const tag = m[1] ? "ol" : "ul";
      if (list !== tag) { if (list) out.push(`</${list}>`); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${m[2]}</li>`);
      continue;
    }
    if (list) { out.push(`</${list}>`); list = null; }
    out.push(line.trim() ? `<p>${line}</p>` : "");
  }
  if (list) out.push(`</${list}>`);
  return out.join("").replace(/ (\d+) /g, (_, i) => blocks[i]);
}

function renderItem(item) {
  const el = document.createElement("div");
  switch (item.role) {
    case "user":
      el.className = "as-msg as-user";
      el.textContent = item.text;
      break;
    case "assistant":
      el.className = "as-msg as-assistant";
      el.innerHTML = renderMarkdown(item.text);
      break;
    case "tool": {
      el.className = "as-tool " + (item.ok === null ? "run" : item.ok ? "ok" : "err");
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.innerHTML = `<span class="as-tool-icon">${item.ok === null ? "⋯" : item.ok ? "✔" : "✖"}</span>`;
      summary.append(TOOL_LABELS[item.name] || item.name);
      const pre = document.createElement("pre");
      pre.textContent = `${item.name}(${item.args || ""})${item.summary ? "\n\n" + item.summary : ""}`;
      details.append(summary, pre);
      el.appendChild(details);
      break;
    }
    case "undo": {
      el.className = "as-undo";
      if (item.undone) {
        el.textContent = "↺ desfeito";
        el.classList.add("done");
      } else {
        const btn = document.createElement("button");
        btn.textContent = `↺ Desfazer · ${item.changes} alteração(ões)`;
        btn.title = "Volta o grafo, os workflows e a Biblioteca ao estado de antes desta resposta (e desfaz as respostas seguintes)";
        let armed = false;
        btn.addEventListener("click", () => {
          if (busy) return;
          if (!armed) {
            armed = true;
            btn.textContent = "Clique de novo para desfazer";
            btn.classList.add("armed");
            setTimeout(() => { armed = false; btn.classList.remove("armed"); btn.textContent = `↺ Desfazer · ${item.changes} alteração(ões)`; }, 3000);
            return;
          }
          undoTurn(item.turnId);
        });
        el.appendChild(btn);
      }
      break;
    }
    case "error":
      el.className = "as-error";
      el.textContent = item.text;
      break;
    default:
      el.className = "as-note";
      el.textContent = item.text;
  }
  return el;
}

function welcome() {
  const el = document.createElement("div");
  el.className = "as-welcome";
  el.innerHTML = `<p><strong>Assistente de IA</strong> — cria e edita workflows, prompts, schemas e pastas. Ele não executa nada: quem aperta ▶ é você.</p><p>Cada resposta com alterações ganha um ↺ Desfazer.</p>`;
  for (const ex of EXAMPLES) {
    const b = document.createElement("button");
    b.className = "as-example";
    b.textContent = ex;
    b.addEventListener("click", () => { input.value = ex; input.focus(); });
    el.appendChild(b);
  }
  return el;
}

function nearBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}

function scrollDown(force = false) {
  if (force || nearBottom()) log.scrollTop = log.scrollHeight;
}

function renderLog() {
  log.innerHTML = "";
  if (!conv.ui.length) log.appendChild(welcome());
  for (const item of conv.ui) log.appendChild(renderItem(item));
  scrollDown(true);
}

function pushItem(item) {
  conv.ui.push(item);
  log.querySelector(".as-welcome")?.remove();
  const stick = nearBottom();
  const entry = { item, el: renderItem(item) };
  log.appendChild(entry.el);
  scrollDown(stick);
  return entry;
}

function rerender(entry) {
  const el = renderItem(entry.item);
  entry.el.replaceWith(el);
  entry.el = el;
}

function addEphemeral(cls, text) {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  log.appendChild(el);
  scrollDown(true);
  return el;
}

log.addEventListener("click", (e) => {
  const a = e.target.closest("a.as-node");
  if (!a) return;
  const id = a.dataset.node;
  if (!app.state.nodes.some(n => n.id === id)) return;
  app.selectNode(id);
  focusNodes([id]);
});

/* confirmação dentro do chat (exclusões): a ferramenta espera a resposta */
function confirmCard({ title, detail, okLabel = "Confirmar" }, signal) {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "as-confirm";
    el.innerHTML = `<div class="as-confirm-title"></div><div class="as-confirm-detail"></div>
      <div class="as-confirm-actions"><button class="btn btn-small btn-ghost" data-v="0">Cancelar</button><button class="btn btn-small as-danger" data-v="1"></button></div>`;
    el.querySelector(".as-confirm-title").textContent = title;
    el.querySelector(".as-confirm-detail").textContent = detail || "";
    el.querySelector("[data-v='1']").textContent = okLabel;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      el.querySelectorAll("button").forEach(b => { b.disabled = true; });
      el.classList.add(ok ? "yes" : "no");
      conv.ui.push({ role: "note", text: `${ok ? "✔ Confirmado" : "✖ Cancelado"}: ${title}` });
      resolve(ok);
    };
    el.querySelectorAll("button").forEach(b => b.addEventListener("click", () => finish(b.dataset.v === "1")));
    signal?.addEventListener("abort", () => finish(false), { once: true });
    log.appendChild(el);
    scrollDown(true);
  });
}

/* ---------- pedido ---------- */

function setBusy(on) {
  busy = on;
  sendBtn.textContent = on ? "Parar" : "Enviar";
  sendBtn.classList.toggle("as-stop", on);
  $("as-new").disabled = on;
  statusEl.hidden = !on;
}

function startTimer() {
  const t0 = Date.now();
  statusEl.textContent = "pensando…";
  const id = setInterval(() => { statusEl.textContent = `pensando… ${Math.round((Date.now() - t0) / 1000)}s`; }, 1000);
  return () => clearInterval(id);
}

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (/401|invalid.*(api.?key|x-api-key)|incorrect api key|authentication/i.test(msg)) return `Chave recusada pelo provedor — confira em 🔑 Chaves. (${msg.slice(0, 200)})`;
  if (/429|rate.?limit|quota/i.test(msg)) return `O provedor recusou por limite de uso/cota. Tente de novo em instantes. (${msg.slice(0, 200)})`;
  if (/failed to fetch|networkerror/i.test(msg)) return `Sem conexão com o provedor. (${msg.slice(0, 200)})`;
  return "Erro: " + msg.slice(0, 600);
}

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  const rt = await ensureRuntime();
  if (!rt) return;
  if (!await updateBanner()) return;
  if (!conv) conv = newConversation(app.state.workflowId);
  input.value = "";
  setBusy(true);
  controller = new AbortController();
  const signal = controller.signal;
  const stopTimer = startTimer();
  const turnId = "t" + Date.now().toString(36);
  const checkpoint = new TurnCheckpoint(turnId);
  pushItem({ role: "user", text });
  if (!conv.title) conv.title = text.slice(0, 60);

  let bubble = null;
  let raf = 0;
  const ui = {
    text(t) {
      if (!bubble) bubble = pushItem({ role: "assistant", text: "" });
      bubble.item.text += t;
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        const stick = nearBottom();
        bubble && (bubble.el.innerHTML = renderMarkdown(bubble.item.text));
        scrollDown(stick);
      });
    },
    toolStart(name, args) {
      bubble = null;
      let preview = "";
      try { preview = JSON.stringify(args); } catch { /* ignora */ }
      return pushItem({ role: "tool", name, args: preview.length > 400 ? preview.slice(0, 400) + "…" : preview, ok: null, summary: "" });
    },
    toolEnd(entry, ok, summary) {
      entry.item.ok = ok;
      entry.item.summary = summary.length > 2000 ? summary.slice(0, 2000) + "…" : summary;
      rerender(entry);
    },
    confirm: (opts) => confirmCard(opts, signal),
  };

  let history = rt.agent.historyFromStored(conv.messages);
  if (conv.provider && conv.provider !== settings.provider && history.length) history = rt.agent.flattenHistory(history);
  const userText = (conv.pendingNote ? conv.pendingNote + "\n\n" : "") + text;
  let result = { messages: [], aborted: false, error: null };
  try {
    const model = await rt.models.createChatModel(settings);
    result = await rt.agent.runTurn({
      model,
      tools: rt.tools.buildTools({ checkpoint, signal, ui }),
      systemPrompt: rt.context.systemPrompt(),
      history,
      userText,
      context: rt.context.turnContext(),
      signal,
      maxModelCalls: settings.provider === "claude-local" ? Math.min(settings.maxModelCalls, 12) : settings.maxModelCalls,
      onText: (t) => ui.text(t),
    });
  } catch (err) {
    result.error = err;
  }
  stopTimer();

  // resposta que não veio pelo stream (ex.: aviso de limite de chamadas)
  const finalText = rt.agent.lastAiText(result.messages);
  if (!bubble && finalText && !conv.ui.slice(-3).some(x => x.role === "assistant" && x.text === finalText)) {
    pushItem({ role: "assistant", text: finalText });
  }
  if (result.error) pushItem({ role: "error", text: friendlyError(result.error) });
  if (result.aborted) pushItem({ role: "note", text: "⏹ Interrompido." });

  conv.messages = rt.agent.nextHistory(history, userText, result.messages);
  if (result.messages.some(m => m.getType() === "ai")) conv.pendingNote = "";
  conv.provider = settings.provider;
  if (checkpoint.changes > 0) {
    conv.turns.push({ turnId, changes: checkpoint.changes, checkpoint: checkpoint.data });
    turnResults[turnId] = checkpoint.results;
    pushItem({ role: "undo", turnId, changes: checkpoint.changes });
  }
  conv.workflowId = app.state.workflowId;
  await saveConversation(conv);
  renderSessionBar();
  controller = null;
  setBusy(false);
  updateContextLine();
  input.focus();
}

/* volta ao estado de antes da resposta turnId (e das seguintes) */
async function undoTurn(turnId) {
  if (busy) return;
  const idx = conv.turns.findIndex(t => t.turnId === turnId);
  if (idx === -1) {
    pushItem({ role: "error", text: "Esse ponto não está mais disponível para desfazer (ficam guardados os últimos 10)." });
    return;
  }
  setBusy(true);
  statusEl.textContent = "desfazendo…";
  const later = conv.turns.length - idx - 1;
  try {
    await restoreCheckpoint(conv.turns[idx].checkpoint, turnResults[turnId] || {});
    const undone = new Set(conv.turns.slice(idx).map(t => t.turnId));
    conv.turns = conv.turns.slice(0, idx);
    for (const it of conv.ui) if (it.role === "undo" && undone.has(it.turnId)) it.undone = true;
    conv.ui.push({ role: "note", text: `↺ Desfeito${later ? ` (e as ${later} resposta(s) seguinte(s))` : ""} — grafo, workflows e Biblioteca voltaram ao estado anterior. O estado de antes do desfazer ficou num save no menu 📋.` });
    conv.pendingNote = "[Nota: o usuário desfez alterações que você fez antes; o estado atual está no <contexto> abaixo.]";
    conv.workflowId = app.state.workflowId;
    renderLog();
    await saveConversation(conv);
    renderSessionBar();
  } catch (err) {
    pushItem({ role: "error", text: "Não deu para desfazer: " + (err?.message || err) });
  }
  setBusy(false);
  updateContextLine();
}

sendBtn.addEventListener("click", () => {
  if (busy) controller?.abort();
  else send();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!busy) send();
  }
});

/* ---------- largura do painel (arrastar a borda esquerda) ---------- */

const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 300;

function sidebarWidth() {
  return $("sidebar")?.offsetWidth || 252;
}

function applyWidth(width) {
  const max = Math.max(MIN_WIDTH, Math.min(1100, window.innerWidth - sidebarWidth() - 160));
  const w = Math.round(Math.max(MIN_WIDTH, Math.min(max, Number(width) || DEFAULT_WIDTH)));
  document.documentElement.style.setProperty("--as-w", w + "px");
  return w;
}

let panelWidth = applyWidth(settings.panelWidth);

/* paleta + assistente + Biblioteca (330px) + um pedaço de canvas cabem lado a lado? */
function bothFit() {
  return window.innerWidth >= sidebarWidth() + panelWidth + 330 + 520;
}

const resizer = $("as-resize");
resizer.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const right = panel.getBoundingClientRect().right;
  document.body.classList.add("as-resizing");
  // os eventos seguintes vêm da janela: o arraste continua mesmo se o cursor sair da alça
  const move = (ev) => { panelWidth = applyWidth(right - ev.clientX); };
  const up = (ev) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    document.body.classList.remove("as-resizing");
    if (ev.type === "pointerup") panelWidth = applyWidth(right - ev.clientX);
    settings.panelWidth = panelWidth;
    saveSettings(settings);
    if (!$("prompts-panel").hidden && !bothFit()) $("prompts-panel").hidden = true;
    app.drawEdges();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
});
resizer.addEventListener("dblclick", () => {
  panelWidth = applyWidth(DEFAULT_WIDTH);
  settings.panelWidth = panelWidth;
  saveSettings(settings);
  app.drawEdges();
});
window.addEventListener("resize", () => { panelWidth = applyWidth(settings.panelWidth); });

/* ---------- debug ---------- */

if (isDebug()) {
  window.assistantDebug = {
    get conversation() { return conv; },
    loadRuntime,
    async setScript(steps) { (await loadRuntime()).models.setScriptedSteps(steps); },
    selfTest: async () => (await import("./debug.js")).selfTest(),
  };
}
