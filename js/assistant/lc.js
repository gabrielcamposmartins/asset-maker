/* ============================================================
   lc.js — único ponto de import do LangChain (CDN esm.sh)
   ============================================================
   Versões fixas e UMA só cópia de @langchain/core em todos os pacotes
   (?deps=): com duas cópias, isAIMessage/instanceof falham em silêncio.
   O pacote "langchain" é importado pelo entrypoint /browser, que não
   depende de node:async_hooks. Os provedores só carregam quando usados.
   O langsmith também é fixado: o @langchain/core o pede por FAIXA
   (">=0.5.0 <1.0.0"), então o CDN resolvia sozinho para a mais nova — e um
   build ruim lá derruba o assistente inteiro (ver a nota em VERSIONS).
   ============================================================ */

export const VERSIONS = {
  langchain: "1.5.11",
  langgraph: "1.4.13",
  core: "1.2.11",
  anthropic: "1.5.10",
  openai: "1.5.13",
  google: "2.3.2",
  zod: "3.25.76",
  // 0.10.10 e 0.10.11 têm o build do esm.sh quebrado: langsmith.mjs importa
  // { Langsmith } de ./client.mjs, que só exporta { Client }. Dava
  // "does not provide an export named 'Langsmith'" ao abrir o assistente.
  // Ao subir, conferir antes:
  //   curl -s "https://esm.sh/langsmith@<v>/es2022/langsmith.mjs" | head -c 200
  langsmith: "0.10.9",
};

/* os dois pins têm de citar o langsmith: é ele que define o hash do build do core,
   e com hashes diferentes voltariam as duas cópias que este arquivo existe para evitar */
const LS = `langsmith@${VERSIONS.langsmith},zod@${VERSIONS.zod}`;
const PIN = `@langchain/core@${VERSIONS.core},@langchain/langgraph@${VERSIONS.langgraph},${LS}`;
const esm = (spec, pin = PIN) => `https://esm.sh/${spec}?deps=${pin}`;
const core = (sub) => esm(`@langchain/core@${VERSIONS.core}/${sub}`, LS);

const [lc, messages, chatModels, fnCalling, zodMod] = await Promise.all([
  import(esm(`langchain@${VERSIONS.langchain}/browser`)),
  import(core("messages")),
  import(core("language_models/chat_models")),
  import(core("utils/function_calling")),
  import(`https://esm.sh/zod@${VERSIONS.zod}`),
]);

export const { createAgent, tool, fakeModel, modelCallLimitMiddleware, toolCallLimitMiddleware } = lc;
export const {
  AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage,
  isAIMessage, isAIMessageChunk, mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages,
} = messages;
export const { BaseChatModel } = chatModels;
export const { convertToOpenAITool } = fnCalling;
export const z = zodMod.z;

/* texto de uma mensagem: content pode ser string ou lista de blocos (só os blocos "text" contam) */
export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(b => (typeof b === "string" ? b : b?.type === "text" ? b.text || "" : "")).join("");
}

const PROVIDERS = {
  anthropic: () => import(esm(`@langchain/anthropic@${VERSIONS.anthropic}`)).then(m => m.ChatAnthropic),
  openai: () => import(esm(`@langchain/openai@${VERSIONS.openai}`)).then(m => m.ChatOpenAI),
  gemini: () => import(esm(`@langchain/google-genai@${VERSIONS.google}`)).then(m => m.ChatGoogleGenerativeAI),
};

/* classe do chat model do provedor, importada na primeira vez que é pedida */
const providerCache = {};
export function loadProviderClass(name) {
  if (!PROVIDERS[name]) throw new Error(`Provedor desconhecido: ${name}`);
  providerCache[name] ??= PROVIDERS[name]();
  return providerCache[name];
}
