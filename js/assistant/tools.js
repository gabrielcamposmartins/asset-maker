/* ============================================================
   tools.js — ferramentas do agente (LangChain tool() + zod)
   ============================================================
   Toda ferramenta passa por define(): mostra um card no chat, recusa
   alterações durante uma execução (▶), guarda o estado para o ↺ antes da
   primeira mudança e devolve erros como texto para o modelo se corrigir.
   Schemas planos (sem union/record): objetos livres vão como string JSON.
   ============================================================ */

import { tool, z } from "./lc.js";
import { app } from "./bridge.js";
import { applyOps, planOps, layeredLayout, focusNodes, describeGraph, validateGraph, paramText } from "./graph-ops.js";
import { readLibrary, saveLibraryItem, findLibraryItem, referencesTo, manageFolder, KINDS, KIND_NOUN } from "./library-ops.js";
import { describeNodeType, nodeTypes } from "./catalog.js";

const MAX_RESULT = 6000;
const KIND = z.enum(KINDS).describe("prompt | agent (prompt de agente) | template (template de saída) | schema (schema de saída JSON)");
const CANCELLED = "O usuário cancelou. Não tente de novo nem contorne a exclusão; pergunte o que ele prefere.";

const OP = z.object({
  op: z.enum(["add_node", "update_params", "remove_node", "connect", "disconnect", "move_node", "add_group", "update_group", "remove_group"]),
  ref: z.string().optional().describe("apelido do node/grupo novo, usável nas ops seguintes (ex.: \"llm\")"),
  node: z.string().optional().describe("id (ex.: n3) ou ref do node — update_params, remove_node, move_node"),
  group: z.string().optional().describe("id ou ref do grupo — update_group, remove_group"),
  type: z.string().optional().describe("tipo do node (add_node) — ver catálogo"),
  params: z.string().optional().describe("JSON com os params (add_node, update_params), ex.: {\"model\":\"gpt-5.4-mini\"}"),
  from: z.string().optional().describe("\"node.saída\" (connect, disconnect), ex.: \"n3.text\" ou \"llm.text\""),
  to: z.string().optional().describe("\"node.entrada\" (connect, disconnect), ex.: \"n4.prompt\""),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  title: z.string().optional().describe("título do grupo"),
  desc: z.string().optional().describe("descrição do grupo"),
  color: z.string().optional().describe("cor do grupo #rrggbb"),
  nodes: z.array(z.string()).optional().describe("nodes envolvidos pelo grupo (add_group, update_group)"),
});

function clip(text) {
  return text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + `\n… (+${text.length - MAX_RESULT} caracteres)` : text;
}

async function workflowInfo(id) {
  if (app.BUILTIN_WORKFLOWS[id]) return { id, name: app.BUILTIN_WORKFLOWS[id].name, kind: "exemplo embutido", graph: app.EXAMPLES[id] };
  if (id === app.DRAFT_ID) return { id, name: "Rascunho", kind: "rascunho", graph: null };
  const tpl = await app.idbGet("workflows", id);
  return tpl ? { id, name: tpl.name, kind: "workflow do usuário", graph: tpl.graph } : null;
}

/* ctx: { checkpoint (TurnCheckpoint), signal, ui: { toolStart, toolEnd, confirm } } */
export function buildTools(ctx) {
  const { checkpoint } = ctx;

  const define = (name, description, schema, fn, { mutates = false } = {}) => tool(async (args) => {
    const card = ctx.ui.toolStart(name, args);
    let text;
    try {
      if (ctx.signal?.aborted) throw new Error("cancelado pelo usuário.");
      if (mutates && app.state.running) throw new Error("há uma execução (▶) em andamento — espere terminar ou clique em Parar antes de editar.");
      const out = await fn(args || {});
      text = clip(typeof out === "string" ? out : JSON.stringify(out));
    } catch (err) {
      text = "ERRO: " + (err?.message || String(err));
    }
    ctx.ui.toolEnd(card, !text.startsWith("ERRO"), text);
    return text;
  }, { name, description, schema });

  const confirm = (opts) => ctx.ui.confirm(opts);

  return [
    define("list_workflows",
      "Lista os workflows: exemplos embutidos, o Rascunho e os do usuário (id, nome, nº de nodes, alterações não salvas, qual está aberto).",
      z.object({}),
      async () => {
        const [wfs, sessions] = await Promise.all([app.idbAll("workflows"), app.idbAll("session")]);
        const drafts = new Map(sessions.filter(x => x.kind === "draft").map(x => [x.workflowId, x]));
        const cur = app.state.workflowId;
        const row = (id, name, kind, graph) => {
          const draft = drafts.get(id);
          const g = id === cur ? app.serializeGraph() : (draft?.graph || graph);
          const dirty = id === cur ? app.state.dirty : draft?.dirty;
          return `- ${id} “${name}” (${kind}) · ${g?.nodes?.length ?? 0} nodes${dirty ? " · alterações não salvas" : ""}${id === cur ? " · ABERTO" : ""}`;
        };
        const lines = ["Exemplos embutidos (não são sobrescritos — salvar cria um workflow novo):"];
        for (const [id, meta] of Object.entries(app.BUILTIN_WORKFLOWS)) lines.push(row(id, meta.name, "exemplo", app.EXAMPLES[id]));
        if (cur === app.DRAFT_ID || drafts.get(app.DRAFT_ID)?.graph?.nodes?.length) lines.push(row(app.DRAFT_ID, "Rascunho", "rascunho", null));
        lines.push("Workflows do usuário:");
        const mine = wfs.sort((a, b) => app.compareByName(a.name, b.name));
        if (!mine.length) lines.push("- nenhum");
        for (const w of mine) lines.push(row(w.id, w.name, "seu", w.graph));
        return lines.join("\n");
      }),

    define("get_workflow",
      "Mostra um workflow: nodes (só params diferentes do padrão), conexões, grupos e problemas. Sem id = o aberto, com status e erros dos nodes.",
      z.object({
        id: z.string().optional().describe("id do workflow; vazio = o aberto"),
        detail: z.enum(["resumo", "completo"]).optional().describe("completo = textos longos sem cortes"),
      }),
      async ({ id, detail = "resumo" }) => {
        const cur = app.state.workflowId;
        if (!id || id === cur) {
          const problems = validateGraph();
          return `Workflow aberto “${app.state.workflowName}” (id ${cur})${app.state.dirty ? " — alterações não salvas" : ""}\n` +
            describeGraph(app.serializeGraph(), { detail, live: true }) +
            (problems.length ? "\nProblemas:\n" + problems.map(p => "- " + p).join("\n") : "");
        }
        const info = await workflowInfo(id);
        if (!info) return `ERRO: workflow “${id}” não existe. Use list_workflows.`;
        const draft = await app.idbGet("session", app.DRAFT_PREFIX + id);
        const graph = draft?.graph || info.graph || { nodes: [], edges: [] };
        return `Workflow “${info.name}” (id ${id}, ${info.kind}) — não está aberto; para editar, use open_workflow.\n` + describeGraph(graph, { detail });
      }),

    define("get_node",
      "Detalhes de um node do workflow aberto: todos os params, conexões, status, erro e o resultado resumido. Use para depurar.",
      z.object({ id: z.string(), include_result: z.boolean().optional() }),
      async ({ id, include_result = true }) => {
        const n = app.state.nodes.find(x => x.id === id);
        if (!n) return `ERRO: node “${id}” não existe no workflow aberto. Nodes: ${app.state.nodes.map(x => x.id).join(", ") || "nenhum"}.`;
        const def = app.NODE_DEFS[n.type];
        const lines = [`${n.id} ${n.type} “${def.title}” — status: ${n.status || "idle"}`];
        if (n.error) lines.push(`erro: ${n.error}`);
        if (n.warning) lines.push(`aviso: ${n.warning}`);
        lines.push("params:", ...def.params.map(p => `- ${p.key} = ${paramText(n.params[p.key])}`));
        const ins = app.state.edges.filter(e => e.to.node === id).map(e => `${e.from.node}.${e.from.port} → ${e.to.port}`);
        const outs = app.state.edges.filter(e => e.from.node === id).map(e => `${e.from.port} → ${e.to.node}.${e.to.port}`);
        lines.push(`entradas conectadas: ${ins.join(", ") || "nenhuma"}`, `saídas conectadas: ${outs.join(", ") || "nenhuma"}`);
        if (include_result && n.result) {
          lines.push("resultado:");
          for (const [port, val] of Object.entries(n.result)) {
            if (port === "meta") continue;
            let summary;
            try { summary = app.summarizeValue(val); } catch { summary = "(não resumível)"; }
            lines.push(`- ${port === "__display" ? "(exibindo)" : port}: ${summary}`);
          }
        }
        return lines.join("\n");
      }),

    define("describe_node_type",
      "Detalhes de um tipo de node: ajuda, portas (dtype, multi, lista) e todos os params com opções, faixas, padrões e quando aparecem.",
      z.object({ type: z.string() }),
      async ({ type }) => describeNodeType(type) || `ERRO: tipo “${type}” não existe. Tipos: ${nodeTypes().join(", ")}.`),

    define("read_library",
      "Lê a Biblioteca. Sem id: lista os itens (id, nome, pasta, valor de uso), filtrando por kind/query. Com id: o item completo. Lista também os schemas embutidos (builtin:…).",
      z.object({ kind: KIND.optional(), query: z.string().optional(), id: z.string().optional() }),
      async (args) => readLibrary(args)),

    define("edit_graph",
      `Edita o grafo do workflow ABERTO com um lote de operações aplicado de uma vez: se alguma falhar, nada muda e todos os erros voltam. Operações:
- add_node {ref?, type, params?}: node novo (posição automática); ref = apelido para usar nas ops seguintes
- update_params {node, params}: muda só os params informados
- remove_node {node}
- connect {from: "node.saída", to: "node.entrada"} — node é id (n3) ou ref
- disconnect {from?, to?}
- move_node {node, x, y}
- add_group {ref?, title, desc?, color?, nodes: [...]}: grupo envolvendo os nodes
- update_group {group, title?, desc?, color?, nodes?} / remove_group {group}
params é JSON em string, ex.: "{\\"model\\":\\"gpt-5.4-mini\\",\\"system\\":\\"...\\"}".`,
      z.object({ ops: z.array(OP).min(1).max(60) }),
      async ({ ops }) => {
        const plan = planOps(ops);
        if (plan.errors.length) {
          return "ERRO: nada foi aplicado.\n" + plan.errors.join("\n") + (plan.warnings.length ? "\nAvisos:\n" + plan.warnings.join("\n") : "");
        }
        await checkpoint.beforeGraphChange();
        const r = applyOps(ops, { signal: ctx.signal });
        if (!r.ok) return "ERRO: nada foi aplicado.\n" + r.errors.join("\n");
        checkpoint.count(r.changes.length);
        const refs = Object.entries(r.refMap);
        return [
          `Aplicado (${r.changes.length}):`, ...r.changes,
          refs.length ? "refs: " + refs.map(([k, v]) => `${k}=${v}`).join(", ") : "",
          r.warnings.length ? "Avisos:\n" + r.warnings.join("\n") : "",
          r.problems.length ? "Problemas do grafo:\n" + r.problems.map(p => "- " + p).join("\n") : "Sem problemas no grafo.",
        ].filter(Boolean).join("\n");
      }, { mutates: true }),

    define("auto_layout",
      "Reorganiza o layout do workflow aberto em colunas (origens à esquerda). Sem nodes = todos. Grupos não se movem.",
      z.object({ nodes: z.array(z.string()).optional() }),
      async ({ nodes }) => {
        const ids = nodes?.length ? nodes : app.state.nodes.map(n => n.id);
        const missing = ids.filter(id => !app.state.nodes.some(n => n.id === id));
        if (missing.length) return `ERRO: nodes inexistentes: ${missing.join(", ")}.`;
        if (!ids.length) return "O workflow está vazio.";
        await checkpoint.beforeGraphChange();
        layeredLayout(ids);
        focusNodes(ids);
        checkpoint.count();
        return `Layout reorganizado (${ids.length} nodes).` +
          (app.state.groups.length ? " Os grupos não foram movidos — ajuste com update_group {group, nodes} se precisar." : "");
      }, { mutates: true }),

    define("open_workflow",
      "Abre outro workflow na tela (as edições do atual ficam no rascunho dele). Necessário antes de editar outro workflow.",
      z.object({ id: z.string() }),
      async ({ id }) => {
        if (id === app.state.workflowId) return "Esse workflow já está aberto.";
        if (!await workflowInfo(id)) return `ERRO: workflow “${id}” não existe. Use list_workflows.`;
        await checkpoint.begin();
        const r = await app.loadWorkflow(id, { quiet: true });
        if (!r) return `ERRO: não consegui abrir “${id}”.`;
        checkpoint.count();
        return `Aberto “${app.state.workflowName}” (id ${id}).\n` + describeGraph(app.serializeGraph(), { live: true });
      }, { mutates: true }),

    define("create_workflow",
      "Cria um workflow do usuário (já salvo) e o abre. from=vazio (padrão) começa em branco; from=atual copia o grafo aberto.",
      z.object({ name: z.string(), from: z.enum(["vazio", "atual"]).optional() }),
      async ({ name, from = "vazio" }) => {
        const clean = String(name || "").trim();
        if (!clean) return "ERRO: informe o nome.";
        await checkpoint.begin();
        await app.flushPendingSaves();
        const finalName = app.uniqueName(clean, await app.workflowNames());
        const id = app.newWorkflowId();
        await checkpoint.markCreated(id);
        const graph = from === "atual" ? app.serializeGraph() : { version: 1, nextId: 1, nodes: [], edges: [], groups: [] };
        const now = Date.now();
        if (!await app.idbPut("workflows", { id, name: finalName, graph, ts: now, created: now })) return "ERRO: o navegador não deixou gravar.";
        await app.loadWorkflow(id, { quiet: true });
        checkpoint.count();
        return `Workflow “${finalName}” criado (id ${id}) e aberto${from === "atual" ? " com uma cópia do grafo anterior" : ", vazio"}. As próximas edições ficam no rascunho dele.`;
      }, { mutates: true }),

    define("save_workflow",
      "Salva o workflow aberto (só quando o usuário pedir). Em exemplos e no Rascunho, que não são sobrescritos, informe name: o grafo vira um workflow novo.",
      z.object({ name: z.string().optional().describe("nome do workflow novo (obrigatório em exemplos e no Rascunho)") }),
      async ({ name }) => {
        const id = app.state.workflowId;
        if (app.isUserWorkflow(id)) {
          await checkpoint.rememberWorkflow(id);
          await app.saveWorkflow();
          checkpoint.count();
          return `Workflow “${app.state.workflowName}” salvo.`;
        }
        if (!String(name || "").trim()) return "ERRO: exemplos e o Rascunho não são sobrescritos — informe name para salvar como workflow novo.";
        await checkpoint.beforeGraphChange(); // o rascunho de origem é limpo ao salvar como novo: guarda para o ↺
        const r = await app.saveWorkflowAsNamed(String(name).trim());
        if (!r) return "ERRO: o navegador não deixou gravar.";
        await checkpoint.markCreated(r.id);
        checkpoint.count();
        return `Salvo como workflow novo “${r.name}” (id ${r.id}), que agora está aberto.`;
      }, { mutates: true }),

    define("rename_workflow",
      "Renomeia um workflow do usuário.",
      z.object({ id: z.string(), name: z.string() }),
      async ({ id, name }) => {
        const clean = String(name || "").trim();
        if (!app.isUserWorkflow(id)) return "ERRO: exemplos e o Rascunho não podem ser renomeados.";
        if (!await app.idbGet("workflows", id)) return `ERRO: workflow “${id}” não existe.`;
        if (!clean) return "ERRO: informe o nome.";
        if ((await app.workflowNames(id)).has(clean.toLowerCase())) return `ERRO: já existe um workflow chamado “${clean}”.`;
        await checkpoint.rememberWorkflow(id);
        await app.renameWorkflowTo(id, clean);
        checkpoint.count();
        return `Workflow renomeado para “${clean}”.`;
      }, { mutates: true }),

    define("delete_workflow",
      "Exclui um workflow do usuário (com rascunho e saves). Pede confirmação ao usuário.",
      z.object({ id: z.string() }),
      async ({ id }) => {
        if (!app.isUserWorkflow(id)) return "ERRO: exemplos e o Rascunho não podem ser excluídos.";
        const tpl = await app.idbGet("workflows", id);
        if (!tpl) return `ERRO: workflow “${id}” não existe.`;
        const ok = await confirm({
          title: `Excluir o workflow “${tpl.name}”?`,
          detail: "Apaga também o rascunho e os saves dele. Dá para desfazer pelo ↺ desta resposta.",
          okLabel: "Excluir",
        });
        if (!ok) return CANCELLED;
        if (app.state.workflowId === id) await checkpoint.beforeGraphChange();
        await checkpoint.rememberWorkflow(id, { sessions: true });
        await app.deleteWorkflow(id);
        checkpoint.count();
        return `Workflow “${tpl.name}” excluído.${app.state.workflowId !== id ? ` Aberto agora: “${app.state.workflowName}”.` : ""}`;
      }, { mutates: true }),

    define("save_library_item",
      "Cria (sem id) ou edita (com id) um item da Biblioteca: prompt, prompt de agente, template de saída ou schema de saída (content = JSON Schema). folder = caminho da pasta (vazio = sem pasta; nome novo cria a pasta; / cria subpastas, ex.: pokeru/characters).",
      z.object({
        kind: KIND,
        name: z.string().describe("nome; em prompts só letras, números, _ e -"),
        content: z.string().describe("texto do prompt, instrução do template ou JSON Schema do schema"),
        folder: z.string().optional(),
        id: z.string().optional().describe("id do item a editar (vazio = criar)"),
      }),
      async (args) => {
        await checkpoint.begin();
        const r = saveLibraryItem(args);
        if (!r.ok) return "ERRO: " + r.error;
        checkpoint.count();
        return [r.message, ...r.warnings.map(w => "Aviso: " + w)].join("\n");
      }, { mutates: true }),

    define("delete_library_item",
      "Exclui um item da Biblioteca. Pede confirmação ao usuário.",
      z.object({ kind: KIND, id: z.string() }),
      async ({ kind, id }) => {
        const item = findLibraryItem(kind, id);
        if (!item) return `ERRO: nenhum ${KIND_NOUN[kind]} com id “${id}”.`;
        const refs = referencesTo(kind, item);
        const ok = await confirm({
          title: `Excluir o ${KIND_NOUN[kind]} “${item.name}”?`,
          detail: (refs.length ? `Ele é usado em ${refs.join(", ")}. ` : "") + "Dá para desfazer pelo ↺ desta resposta.",
          okLabel: "Excluir",
        });
        if (!ok) return CANCELLED;
        await checkpoint.begin();
        app.deleteLibraryItem(kind, id);
        checkpoint.count();
        return `${KIND_NOUN[kind]} “${item.name}” excluído.${refs.length ? ` Atenção: ${refs.join(", ")} ainda o referenciam.` : ""}`;
      }, { mutates: true }),

    define("manage_folder",
      "Pastas da Biblioteca por seção (kind): create, rename (com new_name) ou delete (os itens vão para “Sem pasta”; pede confirmação). O nome é um caminho: pokeru/characters é subpasta de pokeru. No rename, um nome simples mantém a pasta onde está e um caminho a move; subpastas e itens vão junto.",
      z.object({ kind: KIND, action: z.enum(["create", "rename", "delete"]), name: z.string(), new_name: z.string().optional() }),
      async (args) => {
        if (args.action === "delete") {
          const ok = await confirm({
            title: `Excluir a pasta “${args.name}” de ${KIND_NOUN[args.kind]}s?`,
            detail: "A pasta, as subpastas dela e os itens: os itens vão para “Sem pasta” — nada é apagado.",
            okLabel: "Excluir pasta",
          });
          if (!ok) return CANCELLED;
        }
        await checkpoint.begin();
        const r = manageFolder(args);
        if (!r.ok) return "ERRO: " + r.error;
        checkpoint.count();
        return r.message;
      }, { mutates: true }),
  ];
}
