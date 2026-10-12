/* ============================================================
   debug.js — autoteste do assistente, sem LLM e sem custo
   ============================================================
   window.assistantDebug.selfTest() (com localStorage
   "assets-pipeline-assistant-debug" = "1"). Roda num workflow temporário,
   que é apagado no fim, e volta ao workflow que estava aberto.
   ============================================================ */

import { app } from "./bridge.js";
import { applyOps, planOps } from "./graph-ops.js";
import { TurnCheckpoint, restoreCheckpoint } from "./undo.js";
import { saveLibraryItem } from "./library-ops.js";

function overlapping() {
  const boxes = app.state.nodes.map(n => {
    const el = document.getElementById("node-" + n.id);
    return { id: n.id, x: n.x, y: n.y, w: el?.offsetWidth || 0, h: el?.offsetHeight || 0 };
  });
  return boxes.flatMap((a, i) => boxes.slice(i + 1)
    .filter(b => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
    .map(b => `${a.id}×${b.id}`));
}

const hash = () => app.graphHash(JSON.stringify(app.serializeGraph()));

export async function selfTest() {
  const out = [];
  const check = (name, ok, detail = "") => out.push(`${ok ? "✔" : "✖"} ${name}${detail ? " — " + detail : ""}`);
  const original = app.state.workflowId;
  const tempId = app.newWorkflowId();
  const now = Date.now();
  await app.idbPut("workflows", { id: tempId, name: "Autoteste do assistente " + now, graph: { version: 1, nextId: 1, nodes: [], edges: [], groups: [] }, ts: now, created: now });
  await app.loadWorkflow(tempId, { quiet: true });
  try {
    // 1) monta o Exemplo 1 do zero
    const r = applyOps([
      { op: "add_node", ref: "txt", type: "text-input", params: '{"text":"Raposa cyberpunk"}' },
      { op: "add_node", ref: "llm", type: "openai-text", params: '{"system":"gere 3 prompts, um por linha"}' },
      { op: "add_node", ref: "split", type: "split-text" },
      { op: "add_node", ref: "img", type: "openai-image" },
      { op: "add_node", ref: "view", type: "viewer" },
      { op: "connect", from: "txt.text", to: "llm.prompt" },
      { op: "connect", from: "llm.text", to: "split.text" },
      { op: "connect", from: "split.items", to: "img.prompt" },
      { op: "connect", from: "img.image", to: "view.input" },
    ]);
    const m = r.refMap || {};
    check("monta o Exemplo 1 com refs", r.ok && app.state.edges.length === 4, r.ok ? "" : r.errors.join("; "));
    check("nodes novos não se sobrepõem", !overlapping().length, overlapping().join(", "));

    // 2) rejeições deixam o grafo idêntico
    const before = hash();
    const rejects = {
      "image → text rejeitado": [{ op: "connect", from: `${m.img}.image`, to: `${m.llm}.prompt` }],
      "ciclo rejeitado": [{ op: "connect", from: `${m.split}.items`, to: `${m.llm}.prompt` }],
      "select inválido rejeitado": [{ op: "update_params", node: m.llm, params: '{"model":"gpt-9"}' }],
      "número fora da faixa rejeitado": [{ op: "update_params", node: m.llm, params: '{"temperature":5}' }],
      "param de arquivo recusado": [{ op: "add_node", type: "image-input", params: '{"imageData":"x"}' }],
      "lote com um erro não aplica nada": [{ op: "add_node", type: "viewer" }, { op: "connect", from: "zz.text", to: `${m.llm}.prompt` }],
    };
    for (const [name, ops] of Object.entries(rejects)) check(name, !applyOps(ops).ok);
    check("grafo idêntico depois das rejeições", hash() === before);

    // 3) multi acumula, entrada comum substitui
    const r3 = applyOps([
      { op: "add_node", ref: "a", type: "image-input" }, { op: "add_node", ref: "b", type: "image-input" },
      { op: "connect", from: "a.image", to: `${m.img}.images` }, { op: "connect", from: "b.image", to: `${m.img}.images` },
      { op: "add_node", ref: "t2", type: "text-input" }, { op: "connect", from: "t2.text", to: `${m.llm}.prompt` },
    ]);
    const intoImages = app.state.edges.filter(e => e.to.node === m.img && e.to.port === "images").length;
    const intoPrompt = app.state.edges.filter(e => e.to.node === m.llm && e.to.port === "prompt").length;
    check("entrada multi acumula (2 conexões)", r3.ok && intoImages === 2);
    check("entrada comum substitui (1 conexão)", r3.ok && intoPrompt === 1);

    // 4) aviso de {{prompt}} inexistente
    const warn = planOps([{ op: "update_params", node: m.llm, params: '{"system":"use {{nao_existe_selftest}}"}' }]);
    check("{{inexistente}} gera aviso", warn.warnings.some(w => w.includes("nao_existe_selftest")));

    // 5) desfazer volta grafo e Biblioteca
    const graphBefore = hash();
    const libBefore = app.LIBRARY_STORAGE_KEYS.map(k => localStorage.getItem(k)).join("|");
    const cp = new TurnCheckpoint("selftest");
    await cp.beforeGraphChange();
    const created = saveLibraryItem({ kind: "prompt", name: "selftest_tmp", content: "texto de teste" });
    applyOps([{ op: "add_node", type: "viewer" }, { op: "update_params", node: m.llm, params: '{"system":"{{selftest_tmp}}"}' }]);
    const renamed = saveLibraryItem({ kind: "prompt", id: created.item?.id, name: "selftest_tmp2", content: "texto de teste" });
    check("renomear prompt usado avisa as referências", renamed.ok && renamed.warnings.some(w => w.includes(m.llm)));
    await restoreCheckpoint(cp.data, cp.results);
    check("desfazer volta o grafo", hash() === graphBefore);
    check("desfazer volta a Biblioteca", app.LIBRARY_STORAGE_KEYS.map(k => localStorage.getItem(k)).join("|") === libBefore);
  } catch (err) {
    check("autoteste terminou sem exceção", false, err?.stack || String(err));
  } finally {
    await app.loadWorkflow(original, { quiet: true });
    await app.deleteWorkflow(tempId);
  }
  const failed = out.filter(l => l.startsWith("✖")).length;
  out.push(failed ? `${failed} falha(s).` : "Tudo certo.");
  return out;
}
