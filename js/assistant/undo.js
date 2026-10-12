/* ============================================================
   undo.js — desfazer por turno do assistente
   ============================================================
   Antes da primeira alteração de um turno, guarda o estado: a Biblioteca
   (strings cruas do localStorage), o grafo de cada workflow que o turno
   mexer (e um save "Antes do assistente" no menu 📋) e os registros de
   workflow criados/renomeados/excluídos. Desfazer volta tudo isso.
   ============================================================ */

import { app } from "./bridge.js";

export class TurnCheckpoint {
  constructor(turnId) {
    this.turnId = turnId;
    this.data = null;     // o que vai para a conversa (persistido, sem resultados)
    this.results = {};    // resultados por workflow — só em memória (podem ser grandes)
    this.changes = 0;
  }

  get active() { return Boolean(this.data); }

  /* primeira alteração do turno: Biblioteca + workflow aberto */
  async begin() {
    if (this.data) return;
    await app.flushPendingSaves();
    const s = app.state;
    this.data = {
      turnId: this.turnId,
      ts: Date.now(),
      workflowId: s.workflowId,
      workflowName: s.workflowName,
      library: Object.fromEntries(app.LIBRARY_STORAGE_KEYS.map(k => [k, localStorage.getItem(k)])),
      graphs: {},            // workflowId → { graph, savedHash }
      workflowsBefore: {},   // workflowId → registro de "workflows" antes (null = criado no turno)
      sessionsBefore: {},    // workflowId → sessões (rascunho, resultados, saves) antes de excluir
    };
  }

  /* antes de mexer no grafo do workflow aberto: guarda o grafo (uma vez por workflow) e cria o
     save "Antes do assistente" — restaurável pelo menu 📋 mesmo sem o ↺ */
  async beforeGraphChange() {
    await this.begin();
    const s = app.state;
    const id = s.workflowId;
    if (this.data.graphs[id]) return;
    this.data.graphs[id] = { graph: structuredClone(app.serializeGraph()), savedHash: s.savedHash };
    this.results[id] = app.serializeSession();
    if (s.nodes.length) {
      await app.putSnapshot(id, `Antes do assistente — ${app.fmtDate(Date.now())}`, app.serializeGraph(), this.results[id]);
    }
  }

  /* antes de criar/renomear/salvar/excluir um workflow */
  async rememberWorkflow(id, { sessions = false } = {}) {
    await this.begin();
    if (!(id in this.data.workflowsBefore)) this.data.workflowsBefore[id] = (await app.idbGet("workflows", id)) || null;
    if (sessions && !(id in this.data.sessionsBefore)) {
      this.data.sessionsBefore[id] = (await app.idbAll("session")).filter(x => x.workflowId === id && x.kind !== "chat");
    }
  }

  /* workflow criado agora (id só conhecido depois de criar) */
  async markCreated(id) {
    await this.begin();
    if (!(id in this.data.workflowsBefore)) this.data.workflowsBefore[id] = null;
  }

  count(n = 1) { this.changes += n; }
}

/* volta ao estado guardado no checkpoint. results: resultados em memória (se a página não recarregou) */
export async function restoreCheckpoint(cp, results = {}) {
  const s = app.state;
  if (s.running) throw new Error("Há uma execução em andamento — pare ou espere terminar antes de desfazer.");
  await app.flushPendingSaves();
  if (s.nodes.length) {
    await app.putSnapshot(s.workflowId, `Antes de desfazer o assistente — ${app.fmtDate(Date.now())}`,
      app.serializeGraph(), app.serializeSession());
  }

  // 1) Biblioteca
  for (const [key, value] of Object.entries(cp.library || {})) {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }

  // 2) registros de workflow (criados no turno somem; alterados/excluídos voltam)
  for (const [id, before] of Object.entries(cp.workflowsBefore || {})) {
    if (before) await app.idbPut("workflows", before);
    else {
      await app.idbDel("workflows", id);
      for (const x of await app.idbAll("session")) if (x.workflowId === id && x.kind !== "chat") await app.idbDel("session", x.id);
    }
  }
  for (const list of Object.values(cp.sessionsBefore || {})) {
    for (const x of list) await app.idbPut("session", x);
  }

  // 3) reabre o workflow que estava aberto (grava antes o que estiver na tela, e só depois
  //    reescreve os rascunhos — senão a gravação da troca sobrescreveria o restaurado)
  const exists = app.BUILTIN_WORKFLOWS[cp.workflowId] || cp.workflowId === app.DRAFT_ID || await app.idbGet("workflows", cp.workflowId);
  const target = exists ? cp.workflowId : "ex1";
  if (s.workflowId !== target) await app.loadWorkflow(target, { quiet: true });

  // 4) grafos: os outros workflows voltam pelo rascunho; o aberto, direto na tela
  for (const [id, g] of Object.entries(cp.graphs || {})) {
    if (id === target) continue;
    if (id !== app.DRAFT_ID && !app.BUILTIN_WORKFLOWS[id] && !await app.idbGet("workflows", id)) continue;
    const dirty = app.graphHash(JSON.stringify(g.graph)) !== g.savedHash;
    await app.idbPut("session", { id: app.DRAFT_PREFIX + id, workflowId: id, kind: "draft", graph: g.graph, savedHash: g.savedHash, dirty, ts: Date.now() });
    if (results[id]) await app.idbPut("session", { id: "auto:" + id, workflowId: id, kind: "auto", results: results[id], ts: Date.now() });
  }
  const own = cp.graphs?.[target];
  if (own) {
    const currentResults = app.serializeSession();
    app.loadGraph(structuredClone(own.graph));
    app.restoreSession({ results: results[target] || currentResults });
    s.savedHash = own.savedHash;
    await app.persistDraft();
  }

  app.refreshAllNodes();
  app.renderPromptsPanel();
  if (!exists) app.setStatus(`<span class="err">O workflow “${app.escapeHtml(cp.workflowName)}” não existe mais — abri o Exemplo 1.</span>`);
}
