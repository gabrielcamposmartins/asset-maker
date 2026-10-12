/* ============================================================
   context.js — system prompt e contexto de cada pedido
   ============================================================
   O system prompt é fixo (bom para cache de prompt). O estado atual do app
   (workflow aberto, Biblioteca) vai num bloco <contexto> só na mensagem do
   pedido atual — as anteriores ficam só com o texto do usuário.
   ============================================================ */

import { app } from "./bridge.js";
import { compactCatalog } from "./catalog.js";
import { describeGraph, validateGraph } from "./graph-ops.js";

const MAX_CONTEXT_NODES = 40;
const MAX_LIBRARY_NAMES = 30;

let cachedSystem = null;

export function systemPrompt() {
  cachedSystem ??= `Você é o assistente do Asset Maker, um editor visual de workflows de IA (nodes ligados por portas). Responda sempre em português do Brasil, de forma curta e direta.

O QUE VOCÊ FAZ
- Cria e edita workflows (o grafo aberto), prompts, prompts de agentes, templates de saída, schemas de saída (JSON Schema) e pastas da Biblioteca, usando as ferramentas.
- Você NÃO executa workflows nem nodes. Se pedirem para rodar, diga para clicar em ▶ Executar (ou no ▶ do node). Você pode ler resultados e erros de nodes já executados com get_node para ajudar a depurar.

COMO O APP FUNCIONA
- Nomes que o usuário costuma usar: “Texto” = text-input (texto manual); “LLM”/“GPT”/“Claude”/“Gemini” = openai-text/claude-text/gemini-text; “Claude Code” = claude-code; “Dividir” = split-text; “Visualizador” = viewer; “Coletar” = collector; “imagem” = openai-image (gerar) ou image-input (upload).
- Cada porta tem um tipo (dtype): text, image, model3d, audio, voice ou any. Só conecte saída → entrada do mesmo tipo, ou quando um dos lados é any.
- Entrada comum aceita uma conexão (conectar outra substitui); entradas (multi) aceitam várias.
- Listas: um node que recebe uma lista (saída items do Dividir Texto, do Arquivo de texto ou do Claude Code com schema) roda uma vez por item (fan-out). Entradas (lista) recebem a lista inteira de uma vez.
- Visualizador e Coletar resultados aceitam qualquer tipo.
- Em qualquer campo de texto, {{nome}} vira o texto do prompt (ou prompt de agente) com esse nome na hora da execução. {{input}} é reservado ao node Texto.
- outputFormat dos nodes de texto aceita os formatos fixos ou "tpl:<id>" de um template de saída. O schema do claude-code aceita "sch:<id>", "builtin:<chave>" ou "custom" (com schemaCustom).
- Nome de prompt: só letras, números, _ e -, único entre prompts e prompts de agentes.

REGRAS DE EDIÇÃO
- Edite o grafo com UM edit_graph por lote, usando refs para os nodes novos (ex.: {"op":"add_node","ref":"llm",...} e depois "llm.prompt").
- Não informe x/y: o layout é automático (auto_layout reorganiza tudo).
- params é um JSON (em string) só com o que muda; valores de select precisam ser uma das opções do catálogo (describe_node_type mostra os detalhes).
- Não preencha params de arquivo (image-input, audio-input, text-file): o usuário carrega o arquivo.
- Não troque modelos, temperaturas ou outros params que o usuário não pediu.
- Se uma ferramenta devolver ERRO ou "Problemas", corrija e tente de novo.
- Você só edita o workflow aberto; para mexer em outro, use open_workflow antes e avise o usuário.
- Só salve (save_workflow) quando o usuário pedir: as edições já ficam no rascunho do workflow e podem ser desfeitas com ↺.
- Exclusões pedem confirmação ao usuário; se ele cancelar, não insista.
- Na resposta final, resuma o que mudou em 1 a 3 frases, citando os ids dos nodes (ex.: n4).
- Se o pedido for ambíguo, faça a escolha mais simples e diga qual foi.

CATÁLOGO DE NODES — tipo “título” [categoria] in: entradas | out: saídas | params (* = padrão; (se …) = só aparece nessa condição)
${compactCatalog()}

EXEMPLO — “Texto → Prompts → Imagens”
text-input(text="Raposa cyberpunk…").text → openai-text(system="Gere 3 prompts de imagem distintos, um por linha").prompt; openai-text.text → split-text.text; split-text.items → openai-image.prompt; openai-image.image → viewer.input`;
  return cachedSystem;
}

function libraryIndex() {
  const lines = ["Biblioteca:"];
  const names = (items, fmt) => {
    const shown = items.slice(0, MAX_LIBRARY_NAMES).map(fmt).join(", ");
    return items.length > MAX_LIBRARY_NAMES ? `${shown} (+${items.length - MAX_LIBRARY_NAMES}; use read_library)` : shown || "nenhum";
  };
  lines.push(`- prompts: ${names(app.getSavedPrompts(), p => `{{${p.name}}}`)}`);
  lines.push(`- prompts de agentes: ${names(app.getAgentPrompts(), p => `{{${p.name}}}`)}`);
  lines.push(`- templates de saída: ${names(app.getOutputTemplates(), t => `“${t.name}” (tpl:${t.id})`)}`);
  lines.push(`- schemas de saída: ${names(app.getOutputSchemas(), s => `“${s.name}” (sch:${s.id})`)}`);
  return lines.join("\n");
}

/* bloco <contexto> do pedido atual */
export function turnContext() {
  const s = app.state;
  const kind = app.BUILTIN_WORKFLOWS[s.workflowId] ? "exemplo embutido"
    : s.workflowId === app.DRAFT_ID ? "Rascunho (ainda sem nome)" : "workflow do usuário";
  const lines = [`Workflow aberto: “${s.workflowName}” (id ${s.workflowId}, ${kind})` +
    `${s.dirty ? " — tem alterações não salvas" : ""}${s.running ? " — EXECUTANDO agora: não edite" : ""}`];
  if (s.selectedNode) lines.push(`Node selecionado pelo usuário: ${s.selectedNode}`);
  if (s.nodes.length <= MAX_CONTEXT_NODES) {
    lines.push(describeGraph(app.serializeGraph(), { detail: "curto", live: true }));
  } else {
    lines.push(`O grafo tem ${s.nodes.length} nodes e ${s.edges.length} conexões — use get_workflow para ver.`);
    if (s.selectedNode) {
      const near = new Set([s.selectedNode]);
      for (const e of s.edges) {
        if (e.from.node === s.selectedNode) near.add(e.to.node);
        if (e.to.node === s.selectedNode) near.add(e.from.node);
      }
      const g = app.serializeGraph();
      lines.push(describeGraph({ nodes: g.nodes.filter(n => near.has(n.id)), edges: g.edges.filter(e => near.has(e.from.node) && near.has(e.to.node)) }, { detail: "curto", live: true }));
    }
  }
  const problems = validateGraph();
  if (problems.length) lines.push("Problemas:", ...problems.slice(0, 10).map(p => "- " + p));
  lines.push(libraryIndex());
  return `<contexto>\n${lines.join("\n")}\n</contexto>`;
}
