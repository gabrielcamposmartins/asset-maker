/* ============================================================
   models.js — chat models do assistente
   ============================================================
   Anthropic, OpenAI e Gemini pelos pacotes do LangChain (chaves do 🔑);
   Claude Code local por um adaptador que emula tool calling com
   --json-schema do `claude -p` (rota /claude/run do servidor local);
   "Roteiro" (debug): respostas pré-definidas, sem custo.
   ============================================================ */

import { loadProviderClass, BaseChatModel, AIMessage, convertToOpenAITool, contentText } from "./lc.js";
import { app } from "./bridge.js";
import { providerModels, PROVIDERS } from "./store.js";

export function modelFor(settings) {
  const p = settings.provider;
  return settings.models?.[p] ?? providerModels(p)[0]?.value ?? "";
}

/* instância do chat model do provedor escolhido; lança erro legível se faltar configuração */
export async function createChatModel(settings) {
  const provider = settings.provider;
  const model = modelFor(settings);
  const keys = app.getApiKeys();
  const needKey = PROVIDERS[provider]?.key;
  if (needKey && !keys[needKey]) throw new Error(`Falta a chave ${PROVIDERS[provider].label} em 🔑 Chaves.`);
  switch (provider) {
    case "anthropic": {
      const ChatAnthropic = await loadProviderClass("anthropic");
      return new ChatAnthropic({ model, apiKey: keys.anthropic, maxTokens: 8192, streaming: true, maxRetries: 2 });
    }
    case "openai": {
      const ChatOpenAI = await loadProviderClass("openai");
      // sem temperature: os gpt-5.x só aceitam o padrão
      return new ChatOpenAI({ model, apiKey: keys.openai, streaming: true, maxRetries: 2, configuration: { dangerouslyAllowBrowser: true } });
    }
    case "gemini": {
      const ChatGoogleGenerativeAI = await loadProviderClass("gemini");
      return new ChatGoogleGenerativeAI({ model, apiKey: keys.gemini, maxRetries: 2 });
    }
    case "claude-local":
      return new ClaudeLocalChatModel({ model, effort: settings.effort || "" });
    case "scripted":
      return new ScriptedChatModel({ steps: scriptedSteps });
    default:
      throw new Error(`Provedor desconhecido: ${provider}`);
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/* ---------- Claude Code local ---------- */

const LOCAL_PROTOCOL = `PROTOCOLO DE RESPOSTA (obrigatório)
Responda SEMPRE com o JSON do schema:
- para usar ferramentas: "tool_calls" com uma ou mais chamadas {"name", "args"} (pode chamar várias de uma vez) e "message" vazio ou uma frase curta;
- para terminar: "tool_calls" vazio e a resposta final ao usuário em "message".
Os resultados das ferramentas chegam na próxima mensagem, em "### Resultado de <ferramenta>".`;

export class ClaudeLocalChatModel extends BaseChatModel {
  constructor({ model = "", effort = "", tools = [] } = {}) {
    super({});
    this.model = model;
    this.effort = effort;
    this.boundTools = tools; // formato OpenAI: { type: "function", function: { name, description, parameters } }
  }

  _llmType() { return "claude-local"; }

  bindTools(tools) {
    return new ClaudeLocalChatModel({ model: this.model, effort: this.effort, tools: tools.map(t => convertToOpenAITool(t)) });
  }

  async _generate(messages, options) {
    const system = [
      ...messages.filter(m => m.getType() === "system").map(m => contentText(m.content)),
      "FERRAMENTAS DISPONÍVEIS",
      ...this.boundTools.map(t => `## ${t.function.name}\n${t.function.description}\nargs (JSON Schema): ${JSON.stringify(t.function.parameters)}`),
      LOCAL_PROTOCOL,
    ].join("\n\n");
    const names = this.boundTools.map(t => t.function.name);
    const jsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["message", "tool_calls"],
      properties: {
        message: { type: "string" },
        tool_calls: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "args"],
            properties: { name: names.length ? { type: "string", enum: names } : { type: "string" }, args: { type: "object" } },
          },
        },
      },
    };
    const r = await app.callLocal("/claude/run", {
      method: "POST",
      body: { prompt: transcript(messages), system, model: this.model, effort: this.effort, json_schema: jsonSchema, timeout_s: 600 },
      signal: options?.signal,
    });
    const out = r.structured || safeJson(r.text) || { message: r.text || "", tool_calls: [] };
    const stamp = Date.now().toString(36);
    const calls = (Array.isArray(out.tool_calls) ? out.tool_calls : [])
      .filter(c => c && names.includes(c.name))
      .map((c, i) => ({ id: `cl_${stamp}_${i}`, name: c.name, args: typeof c.args === "string" ? safeJson(c.args) || {} : c.args || {}, type: "tool_call" }));
    const text = String(out.message || "");
    const message = new AIMessage({
      content: text,
      tool_calls: calls,
      response_metadata: { model: r.model, cost_usd: r.cost_usd, duration_ms: r.duration_ms },
    });
    return { generations: [{ text, message }] };
  }
}

/* conversa inteira em texto — o `claude -p` não guarda estado entre chamadas */
function transcript(messages) {
  const parts = [];
  for (const m of messages) {
    const type = m.getType();
    const text = contentText(m.content);
    if (type === "human") parts.push(`### Usuário\n${text}`);
    else if (type === "ai") {
      const calls = m.tool_calls?.length ? `\n[ferramentas chamadas: ${m.tool_calls.map(c => `${c.name}(${JSON.stringify(c.args)})`).join("; ")}]` : "";
      parts.push(`### Assistente\n${text}${calls}`);
    } else if (type === "tool") parts.push(`### Resultado de ${m.name || "ferramenta"}\n${text}`);
  }
  parts.push("### Sua vez\nResponda no formato do schema.");
  return parts.join("\n\n");
}

/* ---------- Roteiro (debug) ---------- */

let scriptedSteps = [
  { content: "", tool_calls: [{ name: "list_workflows", args: {} }] },
  { content: "Roteiro de teste concluído: listei os workflows." },
];

export function setScriptedSteps(steps) {
  scriptedSteps = steps;
}

/* cada chamada devolve o próximo passo do roteiro; no fim, uma resposta final fixa */
export class ScriptedChatModel extends BaseChatModel {
  constructor({ steps = [] } = {}) {
    super({});
    this.steps = steps;
    this.state = { i: 0 };
  }

  _llmType() { return "scripted"; }

  bindTools() {
    const bound = new ScriptedChatModel({ steps: this.steps });
    bound.state = this.state; // o agente chama bindTools a cada passo: o contador é compartilhado
    return bound;
  }

  async _generate() {
    const step = this.steps[this.state.i++] || { content: "(fim do roteiro)" };
    const stamp = Date.now().toString(36);
    const message = new AIMessage({
      content: step.content || "",
      tool_calls: (step.tool_calls || []).map((c, i) => ({ id: c.id || `sc_${stamp}_${i}`, name: c.name, args: c.args || {}, type: "tool_call" })),
    });
    return { generations: [{ text: step.content || "", message }] };
  }
}
