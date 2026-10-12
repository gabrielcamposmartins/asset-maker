/* ============================================================
   bridge.js — acesso aos globais dos scripts clássicos (nodes.js, app.js)
   ============================================================
   const/let do topo daqueles scripts não ficam em window, mas são visíveis
   pelo nome a partir deste módulo; as funções declaradas ficam em window.
   Todo o acoplamento do assistente com o app passa por aqui.
   ============================================================ */

export const app = {
  get state() { return state; },
  get NODE_DEFS() { return NODE_DEFS; },
  get LIBRARY() { return LIBRARY; },
  get BUILTIN_SCHEMAS() { return BUILTIN_SCHEMAS; },
  get OUTPUT_FORMATS() { return OUTPUT_FORMATS; },
  get BUILTIN_WORKFLOWS() { return BUILTIN_WORKFLOWS; },
  get EXAMPLES() { return EXAMPLES; },
  get DRAFT_ID() { return DRAFT_ID; },
  get DRAFT_PREFIX() { return DRAFT_PREFIX; },
  // chaves do localStorage da Biblioteca — o desfazer guarda e restaura as strings cruas
  get LIBRARY_STORAGE_KEYS() {
    return [PROMPTS_STORAGE, AGENT_PROMPTS_STORAGE, OUTPUT_TEMPLATES_STORAGE, OUTPUT_SCHEMAS_STORAGE, LIBRARY_FOLDERS_STORAGE];
  },
};

const CONSTANTS = ["state", "NODE_DEFS", "LIBRARY", "BUILTIN_SCHEMAS", "OUTPUT_FORMATS", "BUILTIN_WORKFLOWS", "EXAMPLES",
  "DRAFT_ID", "DRAFT_PREFIX", "LIBRARY_STORAGE_KEYS"];

const FUNCTIONS = [
  // grafo
  "addNode", "removeNode", "renderNode", "selectNode", "drawEdges", "connectPorts", "removeEdge",
  "addGroup", "removeGroup", "renderGroup", "serializeGraph", "loadGraph", "topologicalOrder",
  "applyTransform", "defaultPan", "autosave", "persistDraft", "flushPendingSaves", "refreshAllNodes",
  "graphHash", "nodeTitle", "summarizeValue", "serializeSession", "restoreSession",
  // workflows e saves
  "loadWorkflow", "saveWorkflow", "saveWorkflowAsNamed", "renameWorkflowTo", "deleteWorkflow",
  "workflowNames", "uniqueName", "newWorkflowId", "putSnapshot", "isUserWorkflow", "setCurrentWorkflow",
  "idbGet", "idbPut", "idbAll", "idbDel", "fmtDate", "buildWorkflowsMenu",
  // biblioteca
  "getSavedPrompts", "saveSavedPrompts", "getAgentPrompts", "saveAgentPrompts",
  "getOutputTemplates", "saveOutputTemplates", "getOutputSchemas", "saveOutputSchemas",
  "libraryFolder", "libraryFolders", "normalizeFolderName", "setItemFolder", "registerFolder",
  "folderParts", "folderParent", "folderLeaf", "folderJoin", "inFolderTree", "folderTargetPath",
  "afterLibraryChange", "renderPromptsPanel", "validateSchemaText", "validatePromptName",
  "deleteLibraryItem", "createLibraryFolderNamed", "renameLibraryFolderTo", "deleteLibraryFolder",
  "outputFormatOptions", "outputSchemaOptions", "compareByName",
  // utilidades
  "setStatus", "escapeHtml", "getApiKeys", "callLocal", "localServerUrl", "askText", "confirmDelete",
];

for (const name of FUNCTIONS) app[name] = (...args) => globalThis[name](...args);

/* nomes que o app não expõe (renomeados/removidos) — o painel mostra o erro em vez de quebrar no meio */
export function missingGlobals() {
  const missing = FUNCTIONS.filter(name => typeof globalThis[name] !== "function");
  for (const name of CONSTANTS) {
    try { if (app[name] === undefined) missing.push(name); } catch { missing.push(name); }
  }
  return missing;
}
