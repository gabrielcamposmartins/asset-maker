/* ============================================================
   agent.js — um pedido ao agente (createAgent do LangChain)
   ============================================================ */

import {
  createAgent, modelCallLimitMiddleware, toolCallLimitMiddleware,
  HumanMessage, AIMessage, ToolMessage, contentText,
  mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages,
} from "./lc.js";

const TOOL_RESULT_KEEP = 300; // resultado de ferramenta guardado no histórico (o completo só vale no pedido)

function limits(maxModelCalls) {
  const middleware = [];
  // exitBehavior "end": ao bater o limite, o agente para com uma mensagem em vez de lançar erro
  try { middleware.push(modelCallLimitMiddleware({ runLimit: maxModelCalls, exitBehavior: "end" })); } catch { /* versão sem o middleware */ }
  try { middleware.push(toolCallLimitMiddleware({ runLimit: maxModelCalls * 4, exitBehavior: "end" })); } catch { /* idem */ }
  return middleware;
}

/* chamadas de ferramenta sem resposta (pedido interrompido) quebram o próximo pedido nos
   provedores: responde cada uma como cancelada */
function closeDanglingToolCalls(messages) {
  const answered = new Set(messages.filter(m => m.getType() === "tool").map(m => m.tool_call_id));
  const out = [];
  for (const m of messages) {
    out.push(m);
    if (m.getType() !== "ai") continue;
    for (const c of m.tool_calls || []) {
      if (!answered.has(c.id)) out.push(new ToolMessage({ content: "cancelado pelo usuário", tool_call_id: c.id, name: c.name }));
    }
  }
  return out;
}

/* roda um pedido. Não lança: devolve { messages (novas), aborted, error } */
export async function runTurn({ model, tools, systemPrompt, history, userText, context, signal, maxModelCalls = 25, onText }) {
  const agent = createAgent({ model, tools, systemPrompt, middleware: limits(maxModelCalls) });
  const human = new HumanMessage(`${userText}\n\n${context}`);
  const input = [...history, human];
  let state = null; // último estado completo do agente (modo "values")
  let aborted = false;
  let error = null;
  try {
    const stream = await agent.stream({ messages: input },
      { streamMode: ["messages", "values"], signal, recursionLimit: maxModelCalls * 2 + 10 });
    for await (const [mode, payload] of stream) {
      if (mode === "messages") {
        const [chunk] = payload;
        if (chunk?.getType?.() === "ai") {
          const text = contentText(chunk.content);
          if (text) onText?.(text);
        }
      } else if (mode === "values") {
        state = payload;
      }
    }
  } catch (err) {
    if (signal?.aborted || err?.name === "AbortError") aborted = true;
    else error = err;
  }
  // as mensagens novas são as que vêm depois da entrada (o estado guarda a conversa inteira)
  const produced = (state?.messages || []).slice(input.length);
  return { messages: closeDanglingToolCalls(produced), aborted, error };
}

export function lastAiText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].getType() === "ai") {
      const t = contentText(messages[i].content).trim();
      if (t) return t;
    }
  }
  return "";
}

function compactMessage(m) {
  if (m.getType() !== "tool") return m;
  const text = contentText(m.content);
  if (text.length <= TOOL_RESULT_KEEP) return m;
  return new ToolMessage({ content: text.slice(0, TOOL_RESULT_KEEP) + " …(resumido)", tool_call_id: m.tool_call_id, name: m.name });
}

/* histórico a guardar: o pedido entra só com o texto do usuário (sem o <contexto>); sem nenhuma
   resposta do modelo (erro logo de cara), o pedido não entra — evita duas mensagens seguidas do usuário */
export function nextHistory(history, userText, produced) {
  const answered = produced.some(m => m.getType() === "ai");
  const all = answered ? [...history, new HumanMessage(userText), ...produced] : history;
  return mapChatMessagesToStoredMessages(all.map(compactMessage));
}

export function historyFromStored(stored) {
  try { return mapStoredMessagesToChatMessages(stored || []); } catch { return []; }
}

/* ao trocar de provedor, o histórico vira texto simples (blocos de ferramenta de um provedor
   não servem para outro) */
export function flattenHistory(history) {
  const out = [];
  for (const m of history) {
    const type = m.getType();
    const text = contentText(m.content).trim();
    if (type === "human") out.push(new HumanMessage(text));
    else if (type === "ai" && text) out.push(new AIMessage(text));
    else if (type === "tool" && out.length && out[out.length - 1].getType() === "ai") {
      const prev = out.pop();
      out.push(new AIMessage(`${contentText(prev.content)}\n[resultado de ${m.name}: ${text.slice(0, 200)}]`));
    }
  }
  return out;
}
