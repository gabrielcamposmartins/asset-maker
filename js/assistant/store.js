/* ============================================================
   store.js — configurações do assistente e conversas salvas
   ============================================================
   Configurações: localStorage. Conversas: IndexedDB, store "session", com
   id "chat:<id>" e kind "chat" — cada workflow tem várias sessões (conversas);
   excluir o workflow apaga as dele, e o backup completo as leva sem os pontos
   de desfazer.
   ============================================================ */

import { app } from "./bridge.js";

const SETTINGS_KEY = "assets-pipeline-assistant";
const DEBUG_KEY = "assets-pipeline-assistant-debug";
const MAX_MESSAGES = 80;   // mensagens do modelo guardadas por conversa
const MAX_UI = 160;        // itens exibidos no chat
const MAX_TURNS = 10;      // checkpoints de desfazer guardados

export const PROVIDERS = {
  anthropic: { label: "Anthropic (Claude)", modelsFrom: "claude-text", key: "anthropic" },
  openai: { label: "OpenAI (GPT)", modelsFrom: "openai-text", key: "openai" },
  gemini: { label: "Google Gemini", modelsFrom: "gemini-text", key: "gemini" },
  "claude-local": { label: "Claude Code local", modelsFrom: "claude-code", key: null },
};

/* modelos oferecidos: os mesmos dos nodes de texto (NODE_DEFS), sempre em sincronia */
export function providerModels(provider) {
  const def = app.NODE_DEFS[PROVIDERS[provider]?.modelsFrom];
  const p = def?.params.find(x => x.key === "model");
  return (p?.options || []).map(o => (typeof o === "string" ? { value: o, label: o } : o))
    .map(o => ({ value: o.value, label: o.value === "" ? "padrão da CLI" : o.label }));
}

export function isDebug() {
  try { return localStorage.getItem(DEBUG_KEY) === "1"; } catch { return false; }
}

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { /* padrão */ }
  return { provider: null, models: {}, effort: "", maxModelCalls: 25, panelWidth: 380, ...saved };
}

export function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignora */ }
}

/* provedor inicial: o primeiro com chave no 🔑; senão o Claude local */
export function defaultProvider() {
  const keys = app.getApiKeys();
  for (const [id, p] of Object.entries(PROVIDERS)) if (p.key && keys[p.key]) return id;
  return "claude-local";
}

export function newConversation(workflowId) {
  return {
    id: "chat:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: "chat",
    workflowId,
    ts: Date.now(),
    title: "",
    messages: [],  // mensagens do modelo (StoredMessage do LangChain)
    ui: [],        // o que o chat mostra: { role, text, turnId, ... }
    turns: [],     // checkpoints de desfazer { turnId, changes, checkpoint }
  };
}

/* corta o começo sem deixar resposta de ferramenta órfã: recomeça numa mensagem do usuário */
function trimMessages(messages) {
  if (messages.length <= MAX_MESSAGES) return messages;
  const from = messages.length - MAX_MESSAGES;
  const start = messages.findIndex((m, i) => i >= from && m.type === "human");
  return start === -1 ? [] : messages.slice(start);
}

export async function saveConversation(conv) {
  conv.ts = Date.now();
  conv.messages = trimMessages(conv.messages);
  conv.ui = conv.ui.slice(-MAX_UI);
  conv.turns = conv.turns.slice(-MAX_TURNS);
  return app.idbPut("session", conv);
}

/* sessões de um workflow, da mais recente para a mais antiga */
export async function listConversations(workflowId) {
  const all = (await app.idbAll("session")).filter(x => x.kind === "chat" && x.workflowId === workflowId);
  return all.sort((a, b) => b.ts - a.ts);
}

export async function latestConversation(workflowId) {
  return (await listConversations(workflowId))[0] || null;
}

export async function deleteConversation(id) {
  return app.idbDel("session", id);
}
