/* ============================================================
   nodes.js — definições de nodes e executores de API
   ============================================================
   Cada node tem: title, icon, category, inputs, outputs, params
   e uma função run(inputs, params, ctx) que devolve um objeto
   { <porta de saída>: { type, value } }.

   Tipos de dados: 'text' | 'image' (dataURL/objectURL) | 'model3d' (URL .glb)
                   | 'audio' (dataURL WAV) | 'voice' (nome de um perfil de voz local)

   Nodes com local: true chamam o servidor local (local-server/, ver README).
   ============================================================ */

const API_KEYS_STORAGE = "assets-pipeline-keys";

function getApiKeys() {
  try { return JSON.parse(localStorage.getItem(API_KEYS_STORAGE)) || {}; }
  catch { return {}; }
}

function requireKey(name, label) {
  const key = getApiKeys()[name];
  if (!key) throw new Error(`Chave de API "${label}" não configurada. Clique em 🔑 Chaves de API no topo.`);
  return key;
}

/* ---------- biblioteca de prompts salvos ---------- */

const PROMPTS_STORAGE = "assets-pipeline-prompts";

function getSavedPrompts() {
  try { return JSON.parse(localStorage.getItem(PROMPTS_STORAGE)) || []; }
  catch { return []; }
}

function saveSavedPrompts(list) {
  localStorage.setItem(PROMPTS_STORAGE, JSON.stringify(list));
}

const AGENT_PROMPTS_STORAGE = "assets-pipeline-agent-prompts";

function getAgentPrompts() {
  try { return JSON.parse(localStorage.getItem(AGENT_PROMPTS_STORAGE)) || []; }
  catch { return []; }
}

function saveAgentPrompts(list) {
  localStorage.setItem(AGENT_PROMPTS_STORAGE, JSON.stringify(list));
}

/* Substitui {{nome}} pelo texto do prompt salvo com aquele nome, em qualquer
   string de parâmetro de node, na hora da execução. Prompts podem referenciar
   outros prompts (profundidade máx. 5). {{input}} é reservado ao node Texto
   e nomes desconhecidos ficam intactos. */
function expandPromptRefs(text, ctx, depth = 0) {
  if (typeof text !== "string" || !text.includes("{{") || depth > 5) return text;
  const prompts = [...getSavedPrompts(), ...getAgentPrompts()];
  return text.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (match, name) => {
    if (name === "input") return match;
    const p = prompts.find(x => x.name === name);
    if (!p) return match;
    if (depth === 0) ctx?.log?.(`Prompt salvo “${name}” interpolado.`);
    return expandPromptRefs(p.text, ctx, depth + 1);
  });
}

/* ---------- formatos de saída (nodes de texto) ---------- */

const OUTPUT_TEMPLATES_STORAGE = "assets-pipeline-output-templates";

function getOutputTemplates() {
  try { return JSON.parse(localStorage.getItem(OUTPUT_TEMPLATES_STORAGE)) || []; }
  catch { return []; }
}

function saveOutputTemplates(list) {
  localStorage.setItem(OUTPUT_TEMPLATES_STORAGE, JSON.stringify(list));
}

const OUTPUT_FORMATS = {
  "livre": {
    label: "Livre (sem instrução)",
    instruction: null,
  },
  "json-objeto": {
    label: "JSON — objeto",
    strip: true,
    instruction: "Responda APENAS com um objeto JSON válido, sem cercas de código (```), sem comentários e sem nenhum texto antes ou depois do JSON.",
  },
  "json-array": {
    label: "JSON — array",
    strip: true,
    instruction: "Responda APENAS com um array JSON válido de strings, sem cercas de código (```) e sem nenhum texto antes ou depois do JSON. Exemplo: [\"item 1\", \"item 2\", \"item 3\"]",
  },
  "lista-linhas": {
    label: "Lista — um item por linha",
    instruction: "Responda APENAS com os itens, um por linha, sem numeração, sem marcadores e sem explicações.",
  },
  "csv": {
    label: "CSV",
    strip: true,
    instruction: "Responda APENAS com dados em CSV válido: vírgula como separador, primeira linha como cabeçalho e valores contendo vírgula entre aspas duplas. Nenhum texto fora do CSV.",
  },
  "markdown": {
    label: "Markdown",
    instruction: "Formate a resposta em Markdown bem estruturado, usando títulos, listas e ênfase quando fizer sentido.",
  },
  "xml": {
    label: "XML",
    strip: true,
    instruction: "Responda APENAS com XML válido e bem formado, sem nenhum texto fora do XML.",
  },
};

/* pastas da Biblioteca: cada item guarda a sua em item.folder ("" = sem pasta) */
function libraryFolder(item) {
  return typeof item?.folder === "string" ? item.folder.trim() : "";
}

function compareByName(a, b) {
  return a.localeCompare(b, "pt-BR", { numeric: true, sensitivity: "base" });
}

/* itens da Biblioteca como opções de select: os sem pasta primeiro, depois um optgroup por pasta */
function libraryOptions(items, toOption) {
  const loose = items.filter(i => !libraryFolder(i)).sort((a, b) => compareByName(a.name, b.name));
  const foldered = items.filter(i => libraryFolder(i))
    .sort((a, b) => compareByName(libraryFolder(a), libraryFolder(b)) || compareByName(a.name, b.name));
  return [
    ...loose.map(toOption),
    ...foldered.map(i => ({ ...toOption(i), group: "📁 " + libraryFolder(i) })),
  ];
}

function outputFormatOptions() {
  return [
    ...Object.entries(OUTPUT_FORMATS).map(([value, f]) => ({ value, label: f.label })),
    ...libraryOptions(getOutputTemplates(), t => ({ value: "tpl:" + t.id, label: "📄 " + t.name })),
  ];
}

function applyOutputFormat(prompt, formatKey, ctx) {
  if (!formatKey || formatKey === "livre") return prompt;
  let instruction = null;
  let label = formatKey;
  if (formatKey.startsWith("tpl:")) {
    const tpl = getOutputTemplates().find(t => t.id === formatKey.slice(4));
    if (!tpl) throw new Error("Template de saída não encontrado — foi removido? Escolha outro formato no node.");
    instruction = tpl.instruction;
    label = `template “${tpl.name}”`;
  } else {
    instruction = OUTPUT_FORMATS[formatKey]?.instruction;
  }
  if (!instruction) return prompt;
  ctx?.log?.(`Formato de saída aplicado ao prompt: ${label}.`);
  return `${prompt}\n\n### Formato de saída obrigatório\n${instruction}`;
}

function cleanFormattedOutput(text, formatKey) {
  if (!formatKey || !OUTPUT_FORMATS[formatKey]?.strip) return text;
  // modelos costumam devolver JSON/CSV/XML dentro de cercas de código — remove
  const m = text.trim().match(/^```[\w-]*\s*([\s\S]*?)\s*```$/);
  return m ? m[1].trim() : text.trim();
}

/* ---------- schemas de saída (JSON Schema → claude -p --json-schema) ---------- */

const OUTPUT_SCHEMAS_STORAGE = "assets-pipeline-output-schemas";

function getOutputSchemas() {
  try { return JSON.parse(localStorage.getItem(OUTPUT_SCHEMAS_STORAGE)) || []; }
  catch { return []; }
}

function saveOutputSchemas(list) {
  localStorage.setItem(OUTPUT_SCHEMAS_STORAGE, JSON.stringify(list));
}

const BUILTIN_SCHEMAS = {
  "lista": {
    name: "Lista de itens",
    schema: { type: "object", properties: { itens: { type: "array", items: { type: "string" } } },
      required: ["itens"], additionalProperties: false },
  },
  "prompts-imagem": {
    name: "Prompts de imagem",
    schema: { type: "object", properties: { prompts: { type: "array",
      items: { type: "string", description: "Prompt detalhado, em inglês, para um gerador de imagens" } } },
      required: ["prompts"], additionalProperties: false },
  },
  "falas": {
    name: "Falas de personagem",
    schema: { type: "object", properties: { personagem: { type: "string" },
      falas: { type: "array", items: { type: "string" } } },
      required: ["personagem", "falas"], additionalProperties: false },
  },
  "ficha-asset": {
    name: "Ficha de asset",
    schema: { type: "object", properties: { nome: { type: "string" }, descricao: { type: "string" },
      tags: { type: "array", items: { type: "string" } } },
      required: ["nome", "descricao", "tags"], additionalProperties: false },
  },
};

function outputSchemaOptions() {
  return [
    { value: "", label: "— nenhum (texto livre) —" },
    ...libraryOptions(getOutputSchemas(), s => ({ value: "sch:" + s.id, label: "📐 " + s.name })),
    ...Object.entries(BUILTIN_SCHEMAS).map(([key, s]) => ({ value: "builtin:" + key, label: "🧩 " + s.name, group: "🧩 Embutidos" })),
    { value: "custom", label: "✏️ Personalizado (campo abaixo)" },
  ];
}

function parseSchemaText(text, label) {
  let schema;
  try { schema = JSON.parse(text); }
  catch (err) { throw new Error(`${label}: JSON inválido — ${err.message}`); }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error(`${label}: o schema precisa ser um objeto JSON.`);
  return schema;
}

function resolveOutputSchema(key, customText) {
  if (!key) return null;
  if (key === "custom") return parseSchemaText(customText || "", "Schema personalizado");
  if (key.startsWith("builtin:")) {
    const b = BUILTIN_SCHEMAS[key.slice(8)];
    if (!b) throw new Error("Schema embutido não encontrado.");
    return b.schema;
  }
  const s = getOutputSchemas().find(x => "sch:" + x.id === key);
  if (!s) throw new Error("Schema de saída não encontrado — foi removido? Escolha outro no node.");
  return parseSchemaText(s.schema, `Schema “${s.name}”`);
}

/* lista contida na saída estruturada: array na raiz ou a única propriedade array do objeto */
function listFromStructured(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const arrays = Object.values(value).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0];
  }
  return null;
}

/* ---------- texto → lista (Dividir Texto e Arquivo de texto) ---------- */

const LIST_MODES = ["linhas", "parágrafos (linha em branco)", "vírgula", "ponto e vírgula", "JSON (array)", "CSV (coluna)"];

// remove numeração/marcadores no início ("1. ", "- ", "• "…)
function stripBullet(s) {
  return s.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, "").trim();
}

// JSON tolerante: aceita comentários (// e /* … */), vírgula sobrando antes de ] ou }, cercas de
// código ``` e JSON Lines (um JSON por linha). Quando não dá, o erro aponta linha e coluna.
function parseJsonLoose(text) {
  const src = text.replace(/^\uFEFF/, "").replace(/```(?:jsonc?|jsonl)?/gi, "").trim();
  try { return JSON.parse(src); } catch { /* tenta as variações abaixo */ }
  const cleaned = stripJsonExtras(src);
  let lastErr;
  try { return JSON.parse(cleaned); } catch (err) { lastErr = err; }
  const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every(l => l[0] === "{" || l[0] === "[")) {
    try { return lines.map(l => JSON.parse(l)); } catch { /* não é JSON Lines */ }
  }
  throw new Error(describeJsonError(cleaned, lastErr));
}

/* remove comentários e vírgulas sobrando fora de strings (mantém as quebras de linha para
   o número da linha no erro continuar batendo com o arquivo) */
function stripJsonExtras(src) {
  let noComments = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      noComments += c;
      if (c === "\\") noComments += src[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      noComments += c;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i + 1 < src.length && src[i + 1] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      noComments += src.slice(i, stop).replace(/[^\n]/g, "");
      i = stop - 1;
    } else {
      noComments += c;
    }
  }
  let out = "";
  inStr = false;
  for (let i = 0; i < noComments.length; i++) {
    const c = noComments[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += noComments[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    if (c === ",") {
      let k = i + 1;
      while (k < noComments.length && /\s/.test(noComments[k])) k++;
      if (noComments[k] === "]" || noComments[k] === "}") continue; // vírgula sobrando
    }
    out += c;
  }
  return out;
}

function describeJsonError(src, err) {
  const msg = String(err?.message || err || "erro desconhecido");
  let line = null;
  let col = null;
  const lc = msg.match(/line (\d+) column (\d+)/i);
  const pos = msg.match(/position (\d+)/i);
  if (lc) {
    line = Number(lc[1]);
    col = Number(lc[2]);
  } else if (pos) {
    const before = src.slice(0, Number(pos[1])).split("\n");
    line = before.length;
    col = before[before.length - 1].length + 1;
  }
  const where = line ? ` na linha ${line}, coluna ${col} (“${(src.split("\n")[line - 1] || "").trim().slice(0, 60)}”)` : "";
  const first = src.trimStart()[0];
  const hint = first && first !== "[" && first !== "{"
    ? ` O conteúdo começa com “${first}” em vez de [ ou { — é mesmo um JSON? Para uma lista simples (um item por linha), use o separador “linhas”.`
    : "";
  return `JSON inválido${where}: ${msg}.${hint}`;
}

/* caminho "a.b.0.c" dentro de um valor JSON; "$" (ou vazio) é a raiz */
function getJsonPath(value, path) {
  if (!path || path === "$") return value;
  return path.split(".").reduce((v, key) => (v == null ? undefined : v[key]), value);
}

/* a lista a iterar: a do caminho escolhido ou, no automático, a raiz / a única lista do objeto */
function resolveJsonList(data, listPath) {
  if (!listPath) return listFromStructured(data);
  const v = getJsonPath(data, listPath);
  return Array.isArray(v) ? v : null;
}

/* caminhos de todas as listas do JSON (até 3 níveis) — alimentam o select “Lista a iterar” */
function findJsonArrays(value, prefix = "", depth = 0, out = []) {
  if (Array.isArray(value)) out.push(prefix || "$");
  else if (value && typeof value === "object" && depth < 3) {
    for (const [k, v] of Object.entries(value)) findJsonArrays(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
  }
  return out;
}

/* campos dos objetos de uma lista (até 2 níveis; amostra dos 50 primeiros itens), com um valor de exemplo */
function findObjectFields(list) {
  const fields = new Map();
  const walk = (obj, prefix, depth) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (!fields.has(path) || fields.get(path) === "") fields.set(path, v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));
      if (v && typeof v === "object" && !Array.isArray(v) && depth < 1) walk(v, path, depth + 1);
    }
  };
  for (const item of list.slice(0, 50)) {
    if (item && typeof item === "object" && !Array.isArray(item)) walk(item, "", 0);
  }
  return [...fields.entries()].map(([path, sample]) => ({ path, sample }));
}

/* os selects são re-renderizados com frequência: parseia o arquivo uma vez por conteúdo */
const jsonParseCache = { text: null, value: undefined };
function parseJsonCached(text) {
  if (jsonParseCache.text !== text) {
    let value;
    try { value = parseJsonLoose(text); }
    catch { value = undefined; }
    jsonParseCache.text = text;
    jsonParseCache.value = value;
  }
  return jsonParseCache.value;
}

function jsonListOptions(params) {
  const opts = [{ value: "", label: "Automático (raiz ou lista única)" }];
  const data = typeof params?.file?.text === "string" ? parseJsonCached(params.file.text) : undefined;
  if (data !== undefined) {
    for (const path of findJsonArrays(data)) {
      const len = getJsonPath(data, path).length;
      opts.push({ value: path, label: `${path === "$" ? "(raiz)" : path} — ${len} item(ns)` });
    }
  }
  return opts;
}

function jsonFieldOptions(params) {
  const opts = [{ value: "", label: "Item inteiro (objeto como JSON)" }];
  const data = typeof params?.file?.text === "string" ? parseJsonCached(params.file.text) : undefined;
  const list = data === undefined ? null : resolveJsonList(data, params.jsonList);
  if (Array.isArray(list)) {
    for (const { path, sample } of findObjectFields(list)) {
      const short = sample.length > 28 ? sample.slice(0, 28) + "…" : sample;
      opts.push({ value: path, label: short ? `${path} — “${short}”` : path });
    }
  }
  return opts;
}

function splitTextToItems(text, mode, { csvColumn = "1", csvHeader = true, maxItems = 0, jsonList = "", jsonField = "", stats = null } = {}) {
  let items;
  if (mode === "JSON (array)") {
    const parsed = parseJsonLoose(text);
    const list = resolveJsonList(parsed, jsonList);
    if (!list) {
      throw new Error(jsonList
        ? `“${jsonList}” não é uma lista neste JSON.`
        : "O JSON não é um array nem tem uma única lista — escolha a lista em “Lista a iterar”.");
    }
    // com “Campo de cada item”, cada objeto vira o valor daquele campo (itens sem o campo são ignorados)
    items = list.map(v => {
      const picked = jsonField ? getJsonPath(v, jsonField) : v;
      return picked == null ? "" : typeof picked === "string" ? picked : JSON.stringify(picked);
    });
    if (stats) {
      stats.total = list.length;
      stats.missing = jsonField ? list.filter(v => getJsonPath(v, jsonField) == null).length : 0;
    }
  } else if (mode === "CSV (coluna)") {
    items = csvColumnValues(text, csvColumn, csvHeader);
  } else if (mode === "parágrafos (linha em branco)") {
    items = text.split(/\r?\n[ \t]*\r?\n/);
  } else {
    const sep = mode === "vírgula" ? "," : mode === "ponto e vírgula" ? ";" : /\r?\n/;
    items = text.split(sep).map(stripBullet);
  }
  items = items.map(s => String(s).trim()).filter(Boolean);
  return maxItems > 0 ? items.slice(0, maxItems) : items;
}

/* CSV simples (RFC 4180): aspas, aspas escapadas e quebras de linha dentro de campos;
   o separador (vírgula, ponto e vírgula ou tab) é detectado pela primeira linha */
function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const counts = { ",": 0, ";": 0, "\t": 0 };
  for (const c of firstLine) if (c in counts) counts[c]++;
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ",";
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim()));
}

function csvColumnValues(text, column, hasHeader) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const col = String(column || "1").trim();
  let idx;
  if (/^\d+$/.test(col)) {
    idx = Number(col) - 1;
  } else {
    if (!hasHeader) throw new Error("Para escolher a coluna pelo nome, marque “CSV tem cabeçalho” (ou use o número da coluna).");
    idx = rows[0].findIndex(h => h.trim().toLowerCase() === col.toLowerCase());
    if (idx < 0) throw new Error(`Coluna “${col}” não encontrada. Cabeçalho: ${rows[0].join(", ")}`);
  }
  return rows.slice(hasHeader ? 1 : 0).map(r => r[idx] ?? "");
}

/* ---------- utilidades ---------- */

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return await res.blob();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function readErrorBody(res) {
  let detail = "";
  try {
    const j = await res.json();
    detail = j?.error?.message || j?.error || j?.message || JSON.stringify(j);
  } catch {
    try { detail = await res.text(); } catch { /* ignore */ }
  }
  return `${res.status} ${res.statusText}${detail ? " — " + String(detail).slice(0, 400) : ""}`;
}

/* ---------- chamadas às APIs ---------- */

async function callOpenAIText({ prompt, system, model, temperature }) {
  const key = requireKey("openai", "OpenAI");
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const doCall = (body) => fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  let res = await doCall({ model, messages, temperature });
  if (!res.ok) {
    const errText = await readErrorBody(res);
    // modelos de raciocínio (gpt-5.x) podem rejeitar temperature — repete sem o parâmetro
    if (/temperature/i.test(errText)) {
      res = await doCall({ model, messages });
      if (!res.ok) throw new Error("OpenAI: " + (await readErrorBody(res)));
    } else {
      throw new Error("OpenAI: " + errText);
    }
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function callClaudeText({ prompt, system, model, temperature }) {
  const key = requireKey("anthropic", "Anthropic / Claude");
  const body = {
    model,
    max_tokens: 4096,
    temperature,
    messages: [{ role: "user", content: prompt }],
  };
  if (system) body.system = system;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Claude: " + (await readErrorBody(res)));
  const data = await res.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
}

async function callGeminiText({ prompt, system, model, temperature }) {
  const key = requireKey("gemini", "Google Gemini");
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!res.ok) throw new Error("Gemini: " + (await readErrorBody(res)));
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
}

async function callOpenAIImage({ prompt, model, size, quality, background }) {
  const key = requireKey("openai", "OpenAI");
  const body = { model, prompt, n: 1 };
  if (size && size !== "auto") body.size = size;
  if (quality && quality !== "auto") body.quality = quality;
  // o fundo transparente só existe no PNG (e no WebP); pedir no prompt não basta
  if (background && background !== "auto") {
    body.background = background;
    if (background === "transparent") body.output_format = "png";
  }
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("OpenAI Imagem: " + (await readErrorBody(res)));
  const data = await res.json();
  const item = data.data?.[0];
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item?.url) return item.url;
  throw new Error("OpenAI Imagem: resposta sem imagem.");
}

async function callOpenAIImageEdit({ image, images, prompt, model, size, background }) {
  const key = requireKey("openai", "OpenAI");
  const list = images && images.length ? images : [image];
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  if (size && size !== "auto") form.append("size", size);
  if (background && background !== "auto") {
    form.append("background", background);
    if (background === "transparent") form.append("output_format", "png");
  }
  const field = list.length > 1 ? "image[]" : "image";
  for (let i = 0; i < list.length; i++) {
    form.append(field, await dataUrlToBlob(list[i]), `input${i}.png`);
  }
  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error("OpenAI Edição: " + (await readErrorBody(res)));
  const data = await res.json();
  const item = data.data?.[0];
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item?.url) return item.url;
  throw new Error("OpenAI Edição: resposta sem imagem.");
}

async function callHFImage({ prompt, model }) {
  const key = requireKey("hf", "Hugging Face");
  const res = await fetch(
    `https://router.huggingface.co/hf-inference/models/${model}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ inputs: prompt }),
    }
  );
  if (!res.ok) throw new Error("Hugging Face: " + (await readErrorBody(res)));
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) {
    const text = await blob.text();
    throw new Error("Hugging Face: resposta inesperada — " + text.slice(0, 300));
  }
  return await blobToDataUrl(blob);
}

/* ---------- TRELLIS (Hugging Face Space, via cliente Gradio) ---------- */

async function callTrellis({ image, space, seed, randomizeSeed, textureSize }, ctx) {
  if (!window.GradioClient) {
    throw new Error("Cliente Gradio não carregou (verifique a conexão com a internet).");
  }
  const hfToken = getApiKeys().hf || undefined;
  const opts = hfToken && hfToken.startsWith("hf_") ? { hf_token: hfToken } : {};

  ctx.progress(`Conectando ao space ${space}…`);
  let client;
  try {
    client = await window.GradioClient.connect(space, opts);
  } catch (e) {
    throw new Error(`Não foi possível conectar ao space "${space}". Verifique o nome do space e se ele está no ar. Detalhe: ${e.message || e}`);
  }

  const imageBlob = await dataUrlToBlob(image);

  // Pipeline clássico do TRELLIS (preprocess → image_to_3d → extract_glb).
  // Se o space tiver outra assinatura (ex.: variantes do TRELLIS 2),
  // tentamos endpoints alternativos comuns antes de desistir.
  try {
    try { await client.predict("/start_session"); } catch { /* opcional em alguns spaces */ }

    ctx.progress("Pré-processando imagem…");
    const pre = await client.predict("/preprocess_image", [imageBlob]);
    const processed = pre.data[0];

    let usedSeed = Number(seed) || 0;
    try {
      const s = await client.predict("/get_seed", [Boolean(randomizeSeed), usedSeed]);
      usedSeed = Number(s.data[0]) || usedSeed;
    } catch { /* alguns spaces não têm /get_seed */ }

    ctx.progress("Gerando estrutura 3D (pode levar alguns minutos)…");
    await client.predict("/image_to_3d", [processed, [], usedSeed, 7.5, 12, 3.0, 12, "stochastic"]);

    ctx.progress("Extraindo malha GLB…");
    const glb = await client.predict("/extract_glb", [0.95, Number(textureSize) || 1024]);
    const file = (glb.data || []).find(d => d && typeof d === "object" && (d.url || d.path));
    if (!file) throw new Error("O space não retornou um arquivo GLB.");
    return file.url || file.path;
  } catch (pipelineError) {
    // Fallback: endpoints de chamada única usados por alguns forks/spaces.
    ctx.progress("Pipeline padrão falhou; tentando endpoints alternativos…");
    for (const endpoint of ["/generate_3d", "/run", "/predict"]) {
      try {
        const out = await client.predict(endpoint, [imageBlob]);
        const file = (out.data || []).flat().find(d => d && typeof d === "object" && (d.url || d.path));
        if (file) return file.url || file.path;
      } catch { /* tenta o próximo */ }
    }
    throw new Error(
      `Falha ao executar o space "${space}": ${pipelineError.message || pipelineError}\n` +
      `Dica: confirme o nome do space no parâmetro do node (ex.: microsoft/TRELLIS) e se você tem um token HF válido. ` +
      `Spaces com fila longa ou hibernando também podem falhar — abra o space no navegador para acordá-lo.`
    );
  }
}

/* ---------- catálogo de modelos (listas atualizadas pelas APIs) ---------- */
// Cada select “Modelo” tem uma lista curada no NODE_DEFS; os modelos que a API
// do provedor informa e não estão nela entram no grupo MODELS_GROUP. A consulta
// usa as chaves do 🔑, roda sozinha 1× por dia e pelo botão em Chaves de API.
// As opções são trocadas no próprio param (p.options), então nodes, assistente
// e o chat do visualizador enxergam a lista nova sem mais nada.

const MODELS_STORAGE = "assets-pipeline-models";
const MODELS_MAX_AGE = 24 * 3600 * 1000;
const MODELS_NEW_FOR = 14 * 24 * 3600 * 1000; // quanto tempo um modelo novo fica com 🆕
const MODELS_GROUP = "Mais modelos (da API)";

const MODEL_SOURCES = {
  openai: {
    label: "OpenAI",
    async list(key) {
      const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json();
      return (data.data || []).sort((a, b) => (b.created || 0) - (a.created || 0)).map(m => ({ id: m.id }));
    },
  },
  anthropic: {
    label: "Anthropic",
    async list(key) {
      const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
      });
      if (!res.ok) throw new Error(await readErrorBody(res));
      const data = await res.json(); // já vem do mais novo para o mais antigo
      return (data.data || []).map(m => ({ id: m.id, label: m.display_name || m.id }));
    },
  },
  gemini: {
    label: "Gemini",
    async list(key) {
      const models = [];
      let page = "";
      do {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${page ? "&pageToken=" + encodeURIComponent(page) : ""}&key=${encodeURIComponent(key)}`);
        if (!res.ok) throw new Error(await readErrorBody(res));
        const data = await res.json();
        for (const m of data.models || []) {
          if ((m.supportedGenerationMethods || []).includes("generateContent")) {
            models.push({ id: String(m.name).replace(/^models\//, ""), label: m.displayName });
          }
        }
        page = data.nextPageToken || "";
      } while (page);
      // sem data de criação: versões maiores primeiro (3.5 antes de 2.5)
      return models.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
    },
  },
};

const OPENAI_SNAPSHOT = /-\d{4}(-\d{2}-\d{2})?$/; // gpt-4o-2024-08-06, gpt-3.5-turbo-0125
const isGptImageModel = id => /^(gpt-image|chatgpt-image)/.test(id) && !OPENAI_SNAPSHOT.test(id);

/* quais modelos de cada provedor aparecem em cada node */
const MODEL_TARGETS = [
  { node: "openai-text", source: "openai", accept: id => /^(gpt-|chatgpt-|o\d)/.test(id)
      && !/image|audio|realtime|tts|transcri|search|embedding|moderation|instruct|codex|computer-use|deep-research|diarize|-pro$|^gpt-3|^gpt-4(-|$)/.test(id)
      && !OPENAI_SNAPSHOT.test(id) },
  { node: "openai-image", source: "openai", accept: isGptImageModel },
  { node: "openai-image-edit", source: "openai", accept: isGptImageModel },
  { node: "claude-text", source: "anthropic", accept: id => /^claude-/.test(id) },
  { node: "claude-code", source: "anthropic", accept: id => /^claude-/.test(id), labels: true },
  { node: "gemini-text", source: "gemini", accept: id => /^gemini-/.test(id)
      && !/image|tts|audio|live|embedding|robotics|computer-use|-\d{3}$/.test(id) },
];

/* ---------- capacidades por modelo (tamanhos, qualidades) ---------- */
// A lista /v1/models da OpenAI não diz que tamanhos cada modelo de imagem aceita.
// Descobrimos com um pedido inválido de propósito: a API responde 400 listando os
// valores aceitos, sem gerar imagem nem custo. O resultado fica no mesmo cache.

const CAPS_MAX_AGE = 30 * 24 * 3600 * 1000;
const PROBE_VALUE = "__probe__";
const modelCaps = {}; // modelo -> { size: [...], quality: [...], at }

// usado enquanto o modelo não foi sondado (ou se a sondagem falhar)
const IMAGE_CAPS_FALLBACK = [
  { match: /^dall-e-3/, size: ["1024x1024", "1792x1024", "1024x1792"], quality: ["standard", "hd"] },
  { match: /^dall-e-2/, size: ["256x256", "512x512", "1024x1024"], quality: ["standard"] },
  { match: /./, size: ["auto", "1024x1024", "1536x1024", "1024x1536"], quality: ["auto", "low", "medium", "high"] },
];

// Modelos sem lista fechada aceitam qualquer LARGURAxALTURA: aqui ficam os tamanhos
// oferecidos no select, do quadrado ao 4K. Os maiores que o limite do modelo (quando a
// API informa) são escondidos, e “✏️ Outro tamanho…” no node permite digitar qualquer um.
const IMAGE_SIZE_PRESETS = [
  { value: "auto", label: "auto — o modelo escolhe" },
  { value: "1024x1024", label: "1024×1024 — quadrado" },
  { value: "1536x1024", label: "1536×1024 — paisagem 3:2" },
  { value: "1024x1536", label: "1024×1536 — retrato 2:3" },
  { value: "1824x1024", label: "1824×1024 — paisagem 16:9" },
  { value: "2048x2048", label: "2048×2048 — quadrado 2K" },
  { value: "2048x1152", label: "2048×1152 — paisagem 2K 16:9" },
  { value: "1152x2048", label: "1152×2048 — retrato 2K 9:16" },
  { value: "2560x1440", label: "2560×1440 — paisagem QHD" },
  { value: "1440x2560", label: "1440×2560 — retrato QHD" },
  { value: "3072x3072", label: "3072×3072 — quadrado 3K" },
  { value: "3840x2160", label: "3840×2160 — paisagem 4K" },
  { value: "2160x3840", label: "2160×3840 — retrato 4K" },
  { value: "4096x4096", label: "4096×4096 — quadrado 4K" },
];

const sizeSides = value => String(value).split(/[x×]/i).map(Number);

function imageCaps(model) {
  const known = modelCaps[model] || {};
  const fb = IMAGE_CAPS_FALLBACK.find(f => f.match.test(model || ""));
  let size;
  if (known.size?.length) {
    size = known.size;
  } else if (known.freeSize) {
    const max = known.maxSide || 0;
    size = IMAGE_SIZE_PRESETS.filter(o => !max || o.value === "auto" || sizeSides(o.value).every(n => n <= max));
    if (known.sizeExample && !size.some(o => o.value === known.sizeExample)) size.push({ value: known.sizeExample, label: known.sizeExample });
  } else {
    size = fb.size;
  }
  return {
    // freeSize: o modelo aceita qualquer LARGURAxALTURA — a lista vira sugestão
    freeSize: Boolean(known.freeSize),
    sizeExample: known.sizeExample || "",
    maxSide: known.maxSide || 0,
    limitNote: known.limitNote || "",
    size,
    quality: known.quality?.length ? known.quality : fb.quality,
    probed: Boolean(known.size || known.quality || known.freeSize),
  };
}

function imageSizeOptions(params) { return imageCaps(params.model).size; }
function imageQualityOptions(params) { return imageCaps(params.model).quality; }

/* nos modelos de tamanho livre o select ganha “✏️ Outro tamanho…” e aceita valor digitado */
function imageSizeFree(params) { return imageCaps(params.model).freeSize; }

/* confere um tamanho digitado contra o que a API informou sobre o modelo */
function imageSizeCheck(value, params) {
  const v = String(value || "").trim();
  if (v === "auto") return "";
  const [w, h] = sizeSides(v);
  if (!w || !h) return "Use LARGURAxALTURA, por exemplo 2048x1152.";
  const caps = imageCaps(params.model);
  if (caps.maxSide && Math.max(w, h) > caps.maxSide) return `Este modelo aceita no máximo ${caps.maxSide} px por lado.`;
  if (Math.min(w, h) < 64) return "Cada lado precisa ter pelo menos 64 px.";
  return "";
}

function imageSizeHint(params) {
  const caps = imageCaps(params.model);
  if (!caps.freeSize) return "";
  const limite = caps.maxSide ? ` Limite da API: até ${caps.maxSide} px por lado.`
    : caps.limitNote ? ` A API respondeu: ${caps.limitNote}` : "";
  return `Este modelo aceita qualquer LARGURAxALTURA — use “✏️ Outro tamanho…” para digitar.${limite}`;
}

/* tamanho a usar quando o node não pergunta (chat de edição do visualizador) */
function imageDefaultSize(model) {
  const sizes = imageCaps(model).size;
  return sizes.includes("auto") ? "auto" : (sizes.find(v => v === "1024x1024") || sizes[0] || "auto");
}

/* valores aceitos citados na mensagem de erro da API.
   Formatos já vistos: "Supported values are: 'a', 'b' and 'c'", "must be one of 'a', 'b'",
   "Expected one of: a, b, c". Como varia, tentamos do mais específico ao mais solto. */
function supportedValuesFromError(message, kind) {
  const text = String(message || "");
  const looksLikeSize = v => /^(auto|\d{3,5}\s*[x×]\s*\d{3,5})$/i.test(v.trim());
  const looksLikeWord = v => /^[a-z][a-z0-9_-]{1,20}$/i.test(v.trim());
  const ok = v => (kind === "size" ? looksLikeSize(v) : looksLikeWord(v));
  const clean = list => {
    const values = [...new Set(list.map(v => v.trim().replace(/\s*[x×]\s*/i, "x")))]
      .filter(v => v && v !== PROBE_VALUE && ok(v));
    return values.length ? values : null;
  };

  // 1) trecho depois de "supported values are" / "must be one of" / "expected one of"
  const listPart = /(?:supported values are|must be one of|expected one of|valid values are)\s*:?\s*([^.]*)/i.exec(text);
  if (listPart) {
    const quoted = [...listPart[1].matchAll(/'([^']+)'|"([^"]+)"|`([^`]+)`/g)].map(m => m[1] || m[2] || m[3]);
    const found = clean(quoted.length ? quoted : listPart[1].split(/,| or | and |\|/));
    if (found) return found;
  }
  // 2) qualquer valor citado na mensagem inteira que tenha a cara certa
  const anyQuoted = [...text.matchAll(/'([^']+)'|"([^"]+)"|`([^`]+)`/g)].map(m => m[1] || m[2] || m[3]);
  const found = clean(anyQuoted);
  if (found && found.length > 1) return found;
  // 3) tamanhos soltos no texto (ex.: 1024x1024, 1536x1024)
  if (kind === "size") {
    const bare = clean(text.match(/\b\d{3,5}\s*[x×]\s*\d{3,5}\b/gi) || []);
    if (bare && bare.length > 1) return bare;
  }
  return null;
}

/* sonda um modelo de imagem: 2 pedidos inválidos de propósito, nenhuma imagem gerada.
   Guarda a resposta crua em `note` quando não dá para ler a lista — aparece em 🔑 Chaves. */
async function probeImageModel(model, key) {
  const ask = async (body) => {
    let res;
    try {
      res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, prompt: "probe", ...body }),
      });
    } catch (err) {
      return { status: 0, param: "", message: `sem resposta da API (${err.message || err})` };
    }
    if (res.ok) return { status: res.status, param: "", message: "", ok: true };
    const data = await res.json().catch(() => null);
    return {
      status: res.status,
      param: data?.error?.param || "",
      code: data?.error?.code || "",
      message: data?.error?.message || `HTTP ${res.status}`,
    };
  };

  const caps = { at: Date.now() };
  const notes = [];

  const sizeErr = await ask({ size: PROBE_VALUE });
  if (!/model/i.test(sizeErr.param || "")) {
    // modelos novos não têm lista: "Invalid size '…'. Expected WIDTHxHEIGHT, for example '1824x1024'."
    if (/width\s*x\s*height/i.test(sizeErr.message)) {
      caps.freeSize = true;
      caps.sizeExample = (/'(\d{3,5}x\d{3,5})'/.exec(sizeErr.message) || [])[1] || "";
    } else {
      caps.size = supportedValuesFromError(sizeErr.message, "size") || undefined;
    }
  }
  if (!caps.size && !caps.freeSize) {
    notes.push(`size → ${sizeErr.status}${sizeErr.param ? ` (${sizeErr.param})` : ""}: ${sizeErr.message || "sem mensagem"}`);
  }

  // prompt vazio como trava: se a API não validar “quality”, o pedido morre no prompt em vez de gerar imagem
  const size = (caps.size || []).find(v => v !== "auto") || caps.sizeExample || "1024x1024";
  const qualityErr = await ask({ size, quality: PROBE_VALUE, prompt: "" });
  if (/quality/i.test(qualityErr.param || qualityErr.message)) {
    caps.quality = supportedValuesFromError(qualityErr.message, "quality") || undefined;
  }
  // tamanho livre: descobre o teto pedindo um tamanho absurdo (prompt vazio impede gerar imagem)
  if (caps.freeSize) {
    const bigErr = await ask({ size: "16384x16384", prompt: "" });
    if (/size|width|height|dimension|pixel/i.test(bigErr.param || bigErr.message)) {
      caps.limitNote = String(bigErr.message || "").slice(0, 200);
      const numbers = (caps.limitNote.match(/\d{3,5}/g) || []).map(Number).filter(n => n >= 256 && n <= 8192);
      if (numbers.length) caps.maxSide = Math.max(...numbers);
    }
  }

  // a qualidade costuma não ser sondável (a API recusa o prompt vazio antes): fica a lista padrão,
  // sem alarde — o motivo vai em qualityNote, só para diagnóstico
  if (!caps.quality) caps.qualityNote = `${qualityErr.status}${qualityErr.param ? ` (${qualityErr.param})` : ""}: ${qualityErr.message || "sem mensagem"}`.slice(0, 200);

  if (notes.length) caps.note = notes.join(" · ").slice(0, 400);
  return caps;
}

function loadModelCache() {
  try { return JSON.parse(localStorage.getItem(MODELS_STORAGE)) || {}; }
  catch { return {}; }
}

/* claude-haiku-4-5-20251001 e claude-haiku-4-5 são o mesmo modelo */
const modelBaseId = id => String(id).replace(/-\d{8}$/, "");

function modelParamOf(type) {
  return NODE_DEFS[type]?.params.find(p => p.key === "model" && p.widget === "select") || null;
}

/* aplica a lista em cache aos selects de modelo (síncrono, sem rede) */
function applyModelCatalog() {
  const cache = loadModelCache();
  Object.assign(modelCaps, cache.caps || {});
  const now = Date.now();
  for (const t of MODEL_TARGETS) {
    const p = modelParamOf(t.node);
    if (!p) continue;
    p.baseOptions ??= p.options.map(o => (typeof o === "string" ? { value: o, label: o } : o));
    const known = new Set(p.baseOptions.map(o => modelBaseId(o.value)));
    const src = cache[t.source] || {};
    const extra = [];
    for (const m of src.models || []) {
      if (!t.accept(m.id) || known.has(modelBaseId(m.id))) continue;
      known.add(modelBaseId(m.id));
      const isNew = now - (src.firstSeen?.[m.id] || 0) < MODELS_NEW_FOR;
      const label = t.labels && m.label ? m.label : m.id;
      extra.push({ value: m.id, label: (isNew ? "🆕 " : "") + label, group: MODELS_GROUP });
    }
    p.options = [...p.baseOptions, ...extra];
  }
}

/* consulta as APIs com chave configurada e atualiza o cache e os selects.
   force: true (todas) ou lista de provedores; sem force, só as com mais de 1 dia.
   Devolve { results: [{source, label, count?, error?, skipped?}], added, brandNew } — added: opções
   que passaram a aparecer nos selects; brandNew: as que o provedor lançou desde a consulta anterior */
async function refreshModelCatalog({ force = false, keys = getApiKeys() } = {}) {
  const before = new Map(MODEL_TARGETS.map(t => [t.node, new Set((modelParamOf(t.node)?.options || []).map(o => o.value ?? o))]));
  const results = [];
  const fetched = {};
  const newIds = new Set();
  await Promise.all(Object.entries(MODEL_SOURCES).map(async ([id, src]) => {
    const prev = loadModelCache()[id];
    const forced = force === true || (Array.isArray(force) && force.includes(id));
    if (!keys[id]) { results.push({ source: id, label: src.label, skipped: "sem chave" }); return; }
    if (!forced && prev?.at && Date.now() - prev.at < MODELS_MAX_AGE) {
      results.push({ source: id, label: src.label, skipped: "atualizado recentemente", count: prev.models?.length });
      return;
    }
    try {
      const models = await src.list(keys[id]);
      const firstSeen = {};
      for (const m of models) {
        // na primeira consulta nada é “novo”; depois, o que ainda não tinha aparecido
        firstSeen[m.id] = prev?.firstSeen?.[m.id] ?? (prev?.models ? Date.now() : 0);
        if (prev?.models && prev.firstSeen?.[m.id] === undefined) newIds.add(m.id);
      }
      fetched[id] = { at: Date.now(), models, firstSeen };
      results.push({ source: id, label: src.label, count: models.length });
    } catch (err) {
      // guarda a tentativa (sem apagar a lista anterior) para não repetir o erro a cada carregamento
      fetched[id] = { ...(prev || {}), at: Date.now(), error: String(err.message || err).slice(0, 300) };
      results.push({ source: id, label: src.label, error: fetched[id].error });
    }
  }));
  if (Object.keys(fetched).length) {
    const cache = { ...loadModelCache(), ...fetched };
    try { localStorage.setItem(MODELS_STORAGE, JSON.stringify(cache)); } catch { /* sem espaço: fica só nesta sessão */ }
  }
  applyModelCatalog();

  // tamanhos e qualidades dos modelos de imagem que ainda não foram sondados
  const probed = [];
  if (keys.openai) {
    const wanted = new Set();
    for (const t of MODEL_TARGETS) {
      if (t.source !== "openai" || !/image/.test(t.node)) continue;
      for (const o of modelParamOf(t.node)?.options || []) {
        const caps = modelCaps[o.value];
        const forced = force === true || (Array.isArray(force) && force.includes("openai"));
        if (!caps || Date.now() - (caps.at || 0) > CAPS_MAX_AGE || (forced && !caps.size)) wanted.add(o.value);
      }
    }
    for (const model of [...wanted].slice(0, 8)) {
      const caps = await probeImageModel(model, keys.openai);
      modelCaps[model] = caps;
      probed.push({ model, ...caps });
    }
    if (wanted.size) {
      const cache = { ...loadModelCache(), caps: modelCaps };
      try { localStorage.setItem(MODELS_STORAGE, JSON.stringify(cache)); } catch { /* ignora */ }
    }
  }
  const added = [];
  for (const t of MODEL_TARGETS) {
    for (const o of modelParamOf(t.node)?.options || []) {
      if (!before.get(t.node).has(o.value)) added.push({ node: t.node, value: o.value });
    }
  }
  return { results, added, probed, brandNew: added.filter(a => newIds.has(a.value)) };
}

/* ---------- servidor local (modelos que rodam na sua máquina) ---------- */

const LOCAL_SERVER_DEFAULT = "http://127.0.0.1:8765";

function localServerUrl() {
  return (getApiKeys().localServer || LOCAL_SERVER_DEFAULT).trim().replace(/\/+$/, "");
}

async function callLocal(path, { method = "GET", body, signal } = {}) {
  const base = localServerUrl();
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err; // cancelado (ex.: Parar do assistente)
    throw new Error(`Servidor local não respondeu em ${base}. Inicie-o com local-server\\start.ps1 (veja o README) e confira a URL em 🔑 Chaves de API.`);
  }
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = j.detail ?? j; }
    catch { try { detail = await res.text(); } catch { /* ignore */ } }
    // erros de validação do FastAPI chegam como lista de objetos
    if (typeof detail !== "string") detail = JSON.stringify(detail);
    throw new Error(`Servidor local (${res.status}): ${detail.slice(0, 600)}`);
  }
  return res.json();
}

/* vozes salvas no servidor — cache síncrono usado pelos selects dos nodes */
const localVoices = { list: [], loaded: false };

async function refreshLocalVoices() {
  try {
    const r = await callLocal("/qwen3-tts/voices");
    localVoices.list = r.voices || [];
    localVoices.loaded = true;
  } catch {
    localVoices.loaded = false;
  }
  window.dispatchEvent(new CustomEvent("local-voices-changed"));
  return localVoices.loaded;
}

/* ---------- Claude Code local: esforços aceitos pela CLI instalada ---------- */
// O /claude/info do servidor local lê os níveis do `claude --help`, então a lista
// acompanha a sua CLI (um nível novo aparece sem mexer no editor).

const DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_LABELS = { low: "Baixo — mais rápido", medium: "Médio", high: "Alto", xhigh: "Muito alto", max: "Máximo" };
const localClaude = { efforts: DEFAULT_EFFORTS, available: false, version: "", loaded: false };

async function refreshClaudeInfo() {
  try {
    const r = await callLocal("/claude/info");
    localClaude.efforts = r.efforts?.length ? r.efforts : DEFAULT_EFFORTS;
    localClaude.available = Boolean(r.available);
    localClaude.version = r.version || "";
    localClaude.loaded = true;
  } catch {
    localClaude.loaded = false;
  }
  return localClaude.loaded;
}

function claudeEffortOptions() {
  return [
    { value: "", label: "Padrão" },
    ...localClaude.efforts.map(e => ({ value: e, label: EFFORT_LABELS[e] || e })),
  ];
}

function localVoiceOptions() {
  const placeholder = !localVoices.loaded ? "(servidor local offline)"
    : localVoices.list.length ? "— escolha uma voz —" : "(nenhuma voz salva — crie com o node Voz)";
  return [
    { value: "", label: placeholder },
    ...localVoices.list.map(v => ({ value: v.name, label: `🎙 ${v.name}` })),
  ];
}

/* opções do modo “Várias vozes”: vozes salvas + speakers pré-definidos (valores “voice:…”/“speaker:…”) */
function voiceTargetOptions() {
  const opts = localVoices.list.map(v => ({ value: "voice:" + v.name, label: `🎙 ${v.name}`, group: "Vozes salvas" }));
  if (!opts.length) {
    opts.push({ value: "", label: localVoices.loaded ? "Nenhuma voz salva ainda" : "Servidor local offline — vozes salvas indisponíveis", group: "Vozes salvas" });
  }
  for (const s of QWEN_TTS_SPEAKERS) opts.push({ value: "speaker:" + s.value, label: s.label, group: "Speakers pré-definidos" });
  return opts;
}

/* Converte qualquer áudio que o navegador decodifica (mp3, m4a, ogg, wav…) em WAV
   mono 16-bit 24 kHz — a taxa nativa do Qwen3-TTS — e bem menor para salvar no workflow. */
async function audioFileToWav(file, { sampleRate = 24000, maxSeconds = 60 } = {}) {
  const ctx = new AudioContext();
  let decoded;
  try { decoded = await ctx.decodeAudioData(await file.arrayBuffer()); }
  catch { throw new Error("Não foi possível decodificar esse arquivo de áudio."); }
  finally { ctx.close(); }
  const seconds = Math.min(decoded.duration, maxSeconds);
  const offline = new OfflineAudioContext(1, Math.ceil(seconds * sampleRate), sampleRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination); // destino mono: mixa os canais e reamostra
  src.start();
  const rendered = await offline.startRendering();
  return pcmToWavDataUrl(rendered.getChannelData(0), sampleRate);
}

function pcmToWavDataUrl(samples, sampleRate) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return blobToDataUrl(new Blob([view], { type: "audio/wav" }));
}

/* ---------- Qwen3-TTS ---------- */

const QWEN_TTS_SPEAKERS = [
  { value: "Aiden", label: "Aiden — masc., americano, claro" },
  { value: "Ryan", label: "Ryan — masc., enérgico, ritmado" },
  { value: "Vivian", label: "Vivian — fem., jovem, vibrante" },
  { value: "Serena", label: "Serena — fem., jovem, suave" },
  { value: "Uncle_Fu", label: "Uncle_Fu — masc., maduro, grave" },
  { value: "Dylan", label: "Dylan — masc., jovem (Pequim)" },
  { value: "Eric", label: "Eric — masc., rouco (Chengdu)" },
  { value: "Ono_Anna", label: "Ono_Anna — fem., japonesa, leve" },
  { value: "Sohee", label: "Sohee — fem., coreana, calorosa" },
];

const QWEN_TTS_LANGUAGES = [
  { value: "Portuguese", label: "Português" },
  { value: "Auto", label: "Automático" },
  { value: "English", label: "Inglês" },
  { value: "Spanish", label: "Espanhol" },
  { value: "French", label: "Francês" },
  { value: "Italian", label: "Italiano" },
  { value: "German", label: "Alemão" },
  { value: "Russian", label: "Russo" },
  { value: "Chinese", label: "Chinês" },
  { value: "Japanese", label: "Japonês" },
  { value: "Korean", label: "Coreano" },
];

/* Corpo da chamada /qwen3-tts/tts. Usado pela execução do node e por “regerar este áudio”,
   para os dois caminhos nunca divergirem. `target` traz a voz do item; `seedMode`/`seed`/`take`
   permitem forçar uma seed exata (o servidor resolve seed_mode "fixed" como seed + take). */
/* duração estimada da frase de referência, com os mesmos pesos do servidor
   (um caractere CJK vale quase 3× um latino) */
function refSeconds(text) {
  const s = String(text || "");
  const cjk = (s.match(/[぀-ヿ㐀-䶿一-鿿가-힯]/g) || []).length;
  return (80 + 1.8 * (s.length - cjk) + 5 * cjk) / 2 / 12.5;
}

function ttsBody({ text, target, params, seedMode, seed, take = 0, language }) {
  return {
    text,
    mode: target.mode,
    voice: target.voice || "",
    speaker: target.speaker || params.speaker,
    instruct: target.mode === "voice" ? "" : (target.instruct ?? params.instruct ?? ""),
    language: language || params.language,
    model_size: params.modelSize,
    sampling: params.sampling,
    seed_mode: seedMode || params.seedMode,
    seed: Math.max(0, Math.floor(Number(seed ?? params.seed) || 0)),
    take: Math.max(0, Math.min(64, Math.floor(Number(take) || 0))),
    split: Boolean(params.split),
    max_chars: Math.max(40, Number(params.maxChars) || 220),
    pause_ms: Math.max(0, Number(params.pauseMs) || 0),
    normalize: params.normalize,
    trim_silence: Boolean(params.trimSilence),
  };
}

/* meta de um áudio gerado: identifica a combinação (texto × voz × take) e a seed usada */
function ttsItemMeta(text, target, params, take, seed) {
  return {
    text: String(text),
    seed,
    take,
    language: params.language,
    mode: target.mode,
    voice: target.voice || null,
    speaker: target.mode === "speaker" ? target.speaker : null,
    instruct: target.mode === "voice" ? "" : (target.instruct ?? params.instruct ?? ""),
  };
}

/* caminho inverso: do meta de um áudio de volta para o alvo de voz que o gerou */
function ttsTargetFromMeta(meta, params) {
  if (meta?.mode === "speaker") return { mode: "speaker", speaker: meta.speaker || params.speaker };
  if (meta?.mode === "design") return { mode: "design", instruct: meta.instruct || params.instruct || "" };
  if (!meta?.voice) {
    throw new Error("Este áudio não guarda a voz que o gerou (resultado de uma versão anterior) — execute o node de novo.");
  }
  return { mode: "voice", voice: meta.voice };
}

/* ---------- coletar resultados: arquivos, .zip, pasta e áudio único ---------- */

/* itens (tipo, valor, meta) de um valor de porta — único ou lista, com tipos misturados */
function collectedItems(value) {
  if (!value) return [];
  const list = Array.isArray(value.values);
  const vals = list ? value.values : [value.value];
  const metas = list ? (value.meta || []) : [value.meta];
  const types = list ? (value.types || []) : [];
  return vals.map((v, i) => ({ type: types[i] || value.type, value: v, meta: metas[i] || null }));
}

function packItems(items) {
  if (items.length === 1) {
    const it = items[0];
    return it.meta ? { type: it.type, value: it.value, meta: it.meta } : { type: it.type, value: it.value };
  }
  const out = { type: items[0].type, values: items.map(i => i.value) };
  if (items.some(i => i.meta)) out.meta = items.map(i => i.meta || null);
  if (items.some(i => i.type !== out.type)) out.types = items.map(i => i.type);
  return out;
}

/* emenda áudios (qualquer formato que o navegador decodifica) num WAV mono, na ordem, com pausa */
async function concatAudioDataUrls(urls, pauseMs = 400, sampleRate = 24000) {
  const ctx = new AudioContext({ sampleRate });
  try {
    const buffers = [];
    for (const url of urls) buffers.push(await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer()));
    const gap = Math.round(sampleRate * Math.max(0, pauseMs) / 1000);
    const out = new Float32Array(buffers.reduce((s, b) => s + b.length, 0) + gap * Math.max(0, buffers.length - 1));
    let pos = 0;
    buffers.forEach((b, i) => {
      if (i) pos += gap;
      const channels = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
      for (let j = 0; j < b.length; j++) {
        let sum = 0;
        for (const ch of channels) sum += ch[j];
        out[pos + j] = sum / channels.length;
      }
      pos += b.length;
    });
    return await pcmToWavDataUrl(out, sampleRate);
  } finally {
    ctx.close();
  }
}

const MIME_EXT = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg",
  "model/gltf-binary": "glb",
};

/* trecho de texto seguro para nome de arquivo (Windows incluso) */
function slugForFile(text, max = 40) {
  return String(text || "")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim()
    .replace(/[. ]+$/, "")
    .replace(/ /g, "_");
}

async function itemToBlob(item) {
  if (item.type === "text" || item.type === "voice") {
    return new Blob([String(item.value)], { type: "text/plain;charset=utf-8" });
  }
  const res = await fetch(item.value); // dataURL ou URL (ex.: GLB de um Space)
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.blob();
}

function fileExtFor(item, blob) {
  if (item.type === "text" || item.type === "voice") return "txt";
  if (item.type === "model3d") return "glb";
  return MIME_EXT[(blob.type || "").split(";")[0]] || (item.type === "audio" ? "wav" : item.type === "image" ? "png" : "bin");
}

/* um arquivo por item + manifest.json (arquivo → texto/seed/voz de origem) */
async function buildCollectedFiles(items, pattern, log) {
  const files = [];
  const manifest = [];
  const used = new Set();
  const pad = Math.max(3, String(items.length).length);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let blob;
    try { blob = await itemToBlob(it); }
    catch (err) { log?.(`⚠ Item ${i + 1} (${it.type}) não pôde ser lido: ${err.message || err}`); continue; }
    const text = it.meta?.text || (it.type === "text" ? it.value : "");
    const number = String(i + 1).padStart(pad, "0");
    const base = slugForFile((pattern || "{n}_{texto}")
      .replaceAll("{n}", number).replaceAll("{texto}", slugForFile(text)).replaceAll("{tipo}", it.type)
      .replaceAll("{voz}", slugForFile(it.meta?.voice || it.meta?.speaker || "", 30)), 120)
      .replace(/_+/g, "_").replace(/^_|_$/g, "") || number;
    const ext = fileExtFor(it, blob);
    let name = `${base}.${ext}`;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base}-${k}.${ext}`;
    used.add(name.toLowerCase());
    files.push({ name, blob });
    const entry = { arquivo: name, tipo: it.type };
    if (text) entry.texto = text;
    for (const key of ["seed", "voice", "speaker", "language"]) if (it.meta?.[key] != null) entry[key] = it.meta[key];
    manifest.push(entry);
  }
  if (files.length) files.push({ name: "manifest.json", blob: new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }) });
  return files;
}

/* .zip sem compressão (formato “store”), montado no navegador sem bibliotecas */
let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function makeZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // nomes em UTF-8
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(local, name, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(entry, name);
    offset += 30 + name.length + data.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, central.reduce((s, p) => s + p.byteLength, 0), true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* grava os arquivos numa pasta escolhida com showDirectoryPicker (Chrome/Edge) */
async function writeFilesToFolder(dir, files) {
  if (dir.queryPermission && (await dir.queryPermission({ mode: "readwrite" })) !== "granted") {
    if ((await dir.requestPermission({ mode: "readwrite" })) !== "granted") throw new Error("sem permissão para gravar na pasta");
  }
  for (const f of files) {
    const handle = await dir.getFileHandle(f.name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(f.blob);
    await writable.close();
  }
}

/* ============================================================
   Registro de tipos de node
   ============================================================ */

const NODE_DEFS = {
  /* ----- Entrada ----- */
  "text-input": {
    title: "Texto",
    icon: "📝",
    category: "Entrada",
    desc: "Texto manual + interpolação",
    help: "Fornece o texto do campo “Conteúdo” na saída “texto”. A entrada “input” é opcional: quando conectada, o texto recebido é interpolado no conteúdo — se o conteúdo contiver o placeholder {{input}}, cada ocorrência é substituída pelo texto de entrada; sem placeholder, o seletor “Posição do input” decide se ele entra antes ou depois do conteúdo. Se a entrada for uma lista, o node executa uma vez por item, produzindo uma lista de textos interpolados. Não chama nenhuma API.",
    inputs: [{ key: "input", label: "input (opcional)", dtype: "text" }],
    outputs: [{ key: "text", label: "texto", dtype: "text" }],
    params: [
      { key: "text", label: "Conteúdo — use {{input}} para interpolar", widget: "textarea", default: "" },
      { key: "inputPosition", label: "Posição do input (sem {{input}})", widget: "select", options: ["depois do conteúdo", "antes do conteúdo"], default: "depois do conteúdo" },
    ],
    async run(inputs, params, ctx) {
      const content = params.text || "";
      const inp = inputs.input?.value;
      if (inp === undefined || inp === null) {
        return { text: { type: "text", value: content } };
      }
      let out;
      if (content.includes("{{input}}")) {
        out = content.split("{{input}}").join(inp);
        ctx?.log?.("Input interpolado no placeholder {{input}}.");
      } else if (!content.trim()) {
        out = inp;
        ctx?.log?.("Conteúdo vazio — repassando o input.");
      } else if (params.inputPosition === "antes do conteúdo") {
        out = `${inp}\n${content}`;
        ctx?.log?.("Input concatenado antes do conteúdo.");
      } else {
        out = `${content}\n${inp}`;
        ctx?.log?.("Input concatenado depois do conteúdo.");
      }
      return { text: { type: "text", value: out } };
    },
  },

  "image-input": {
    title: "Imagem (upload)",
    icon: "🖼️",
    category: "Entrada",
    desc: "Carregar imagem local",
    help: "Lê o arquivo de imagem escolhido e o disponibiliza como dataURL na saída “imagem”. Tudo acontece localmente no navegador, sem upload para nenhum serviço.",
    inputs: [],
    outputs: [{ key: "image", label: "imagem", dtype: "image" }],
    params: [
      { key: "imageData", label: "Arquivo de imagem", widget: "file" },
    ],
    async run(inputs, params) {
      if (!params.imageData) throw new Error("Nenhuma imagem carregada. Clique em “Escolher imagem”.");
      return { image: { type: "image", value: params.imageData } };
    },
  },

  "audio-input": {
    title: "Áudio (upload)",
    icon: "🎵",
    category: "Entrada",
    desc: "Carregar áudio local",
    help: "Lê o arquivo de áudio escolhido (wav, mp3, m4a, ogg, flac…), converte no próprio navegador para WAV mono 24 kHz (a taxa nativa do Qwen3-TTS; até 60 s) e o disponibiliza na saída “áudio”. Uso típico: referência para clonar uma voz no node “Qwen3-TTS — Voz” (5–15 s de fala limpa é o ideal). Nada é enviado a nenhum serviço.",
    inputs: [],
    outputs: [{ key: "audio", label: "áudio", dtype: "audio" }],
    params: [
      { key: "audioData", label: "Arquivo de áudio", widget: "file", accept: "audio/*", noun: "áudio",
        transform: (file) => audioFileToWav(file), output: { key: "audio", dtype: "audio" } },
    ],
    async run(inputs, params) {
      if (!params.audioData) throw new Error("Nenhum áudio carregado. Clique em “Escolher áudio”.");
      return { audio: { type: "audio", value: params.audioData } };
    },
  },

  "text-file": {
    title: "Arquivo de texto",
    icon: "📄",
    category: "Entrada",
    desc: "Texto ou lista de um arquivo",
    help: "Lê um arquivo de texto do seu computador (.txt, .md, .csv, .json…) e entrega o conteúdo em duas saídas: “texto” (o arquivo inteiro, como um único texto) e “itens (lista)” (o arquivo dividido conforme o Separador — linhas, parágrafos, vírgula, ponto e vírgula, JSON ou uma coluna de CSV). No modo JSON, “Lista a iterar” escolhe qual lista do arquivo percorrer (automático = a raiz ou a única lista) e “Campo de cada item” escolhe qual propriedade de cada objeto vira o item (ex.: prompt, fala.texto) — os dois selects mostram o que existe no arquivo carregado; sem campo, cada objeto sai inteiro como JSON. Comentários (// e /* … */) e vírgulas sobrando do arquivo são ignorados: no modo JSON, “texto (inteiro)” traz o JSON limpo e formatado. Conecte “itens” direto em qualquer node para ele rodar uma vez por item (fan-out), ou “texto” no Dividir Texto → Lista / num LLM. No Chrome, o arquivo escolhido é relido do disco a cada execução enquanto a página estiver aberta — edite o arquivo e rode de novo; depois de recarregar a página, vale a cópia salva no workflow até você escolher o arquivo outra vez. Nada é enviado a nenhum serviço.",
    inputs: [],
    outputs: [
      { key: "text", label: "texto (inteiro)", dtype: "text" },
      { key: "items", label: "itens (lista)", dtype: "text" },
    ],
    params: [
      { key: "file", label: "Arquivo", widget: "textfile", default: null },
      { key: "listMode", label: "Separador da lista", widget: "select", options: LIST_MODES, default: "linhas" },
      { key: "csvColumn", label: "Coluna do CSV (número ou nome)", widget: "text", default: "1", showIf: p => p.listMode === "CSV (coluna)" },
      { key: "csvHeader", label: "CSV tem cabeçalho", widget: "checkbox", default: true, showIf: p => p.listMode === "CSV (coluna)" },
      { key: "jsonList", label: "Lista a iterar", widget: "select", optionsFn: jsonListOptions, default: "", showIf: p => p.listMode === "JSON (array)" },
      { key: "jsonField", label: "Campo de cada item", widget: "select", optionsFn: jsonFieldOptions, default: "", showIf: p => p.listMode === "JSON (array)" },
      { key: "maxItems", label: "Máx. de itens (0 = todos)", widget: "number", default: 0, min: 0, step: 1 },
      { key: "reread", label: "Reler o arquivo do disco a cada execução", widget: "checkbox", default: true },
    ],
    async run(inputs, params, ctx) {
      let file = params.file && typeof params.file === "object" ? params.file : null;
      const handle = ctx.node?._fileHandle;
      if (handle && params.reread !== false) {
        try {
          const f = await handle.getFile();
          const text = await f.text();
          if (file && text !== file.text) ctx.log?.("O arquivo mudou no disco desde a última leitura.");
          file = { name: f.name, text, size: f.size, loadedAt: Date.now() };
          ctx.setParam?.("file", file);
          ctx.log?.(`“${f.name}” relido do disco.`);
        } catch (err) {
          ctx.warn?.(`Não foi possível reler “${file?.name || "o arquivo"}” do disco (${err.message || err}) — usando a cópia salva no workflow.`);
        }
      }
      if (!file) throw new Error("Nenhum arquivo carregado. Clique em “Escolher arquivo…”.");
      const text = file.text.replace(/^\uFEFF/, ""); // remove o BOM de arquivos salvos como “UTF-8 com BOM”
      const stats = {};
      const items = splitTextToItems(text, params.listMode, {
        csvColumn: params.csvColumn, csvHeader: params.csvHeader !== false, maxItems: Number(params.maxItems) || 0,
        jsonList: params.jsonList || "", jsonField: params.jsonField || "", stats,
      });
      ctx.log?.(`${file.name}: ${text.length} caracteres · ${items.length} item(ns) no modo “${params.listMode}”` +
        (params.listMode === "JSON (array)" ? ` (lista: ${params.jsonList || "automática"}, campo: ${params.jsonField || "item inteiro"})` : "") + ".");
      if (stats.missing) ctx.warn?.(`${stats.missing} de ${stats.total} item(ns) não têm o campo “${params.jsonField}” e foram ignorados.`);
      // no modo JSON, comentários e vírgulas sobrando não seguem adiante: “texto” traz o JSON limpo
      let textOut = text;
      if (params.listMode === "JSON (array)") {
        textOut = JSON.stringify(parseJsonLoose(text), null, 2);
        if (stripJsonExtras(text.trim()) !== text.trim()) {
          ctx.log?.("Comentários/vírgulas extras do arquivo foram ignorados — “texto (inteiro)” traz o JSON limpo.");
        }
      }
      const out = { text: { type: "text", value: textOut } };
      if (items.length) out.items = items.length === 1 ? { type: "text", value: items[0] } : { type: "text", values: items };
      else ctx.warn?.("Nenhum item encontrado com esse separador — a porta “itens (lista)” fica vazia.");
      return out;
    },
  },

  /* ----- Texto / LLM ----- */
  "openai-text": {
    title: "OpenAI — Texto",
    icon: "🤖",
    category: "Texto (LLM)",
    desc: "GPT via Chat Completions",
    help: "Monta uma conversa com a Instrução de sistema (opcional) + o prompt recebido na entrada e envia ao modelo GPT escolhido, com a temperatura configurada. Devolve o texto da primeira resposta na saída “texto”. O campo “Formato de saída” anexa ao final do prompt instruções de formatação (JSON, lista, CSV… ou um template seu) e remove cercas de código da resposta quando aplicável. Autenticação: chave OpenAI (Bearer).",
    endpoint: "POST https://api.openai.com/v1/chat/completions",
    inputs: [{ key: "prompt", label: "prompt", dtype: "text" }],
    outputs: [{ key: "text", label: "texto", dtype: "text" }],
    params: [
      { key: "model", label: "Modelo", widget: "select", options: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.4-mini"], default: "gpt-5.6-terra" },
      { key: "system", label: "Instrução de sistema", widget: "textarea", default: "" },
      { key: "outputFormat", label: "Formato de saída", widget: "select", optionsFn: outputFormatOptions, manage: "output-templates", default: "livre" },
      { key: "temperature", label: "Temperatura", widget: "number", default: 0.8, min: 0, max: 2, step: 0.1 },
    ],
    async run(inputs, params, ctx) {
      const prompt = inputs.prompt?.value;
      if (!prompt) throw new Error("Entrada “prompt” vazia — conecte um node de texto.");
      const finalPrompt = applyOutputFormat(prompt, params.outputFormat, ctx);
      let text = await callOpenAIText({ prompt: finalPrompt, system: params.system, model: params.model, temperature: Number(params.temperature) });
      text = cleanFormattedOutput(text, params.outputFormat);
      return { text: { type: "text", value: text } };
    },
  },

  "claude-text": {
    title: "Claude — Texto",
    icon: "✴️",
    category: "Texto (LLM)",
    desc: "Anthropic Messages API",
    help: "Envia o prompt (com Instrução de sistema opcional e max_tokens 4096) ao modelo Claude escolhido e devolve os blocos de texto da resposta na saída “texto”. O campo “Formato de saída” anexa ao final do prompt instruções de formatação (JSON, lista, CSV… ou um template seu) e remove cercas de código da resposta quando aplicável. Autenticação: chave Anthropic (x-api-key), com acesso direto do navegador habilitado.",
    endpoint: "POST https://api.anthropic.com/v1/messages",
    inputs: [{ key: "prompt", label: "prompt", dtype: "text" }],
    outputs: [{ key: "text", label: "texto", dtype: "text" }],
    params: [
      { key: "model", label: "Modelo", widget: "select", options: ["claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-haiku-4-5-20251001"], default: "claude-sonnet-5" },
      { key: "system", label: "Instrução de sistema", widget: "textarea", default: "" },
      { key: "outputFormat", label: "Formato de saída", widget: "select", optionsFn: outputFormatOptions, manage: "output-templates", default: "livre" },
      { key: "temperature", label: "Temperatura", widget: "number", default: 0.8, min: 0, max: 1, step: 0.1 },
    ],
    async run(inputs, params, ctx) {
      const prompt = inputs.prompt?.value;
      if (!prompt) throw new Error("Entrada “prompt” vazia — conecte um node de texto.");
      const finalPrompt = applyOutputFormat(prompt, params.outputFormat, ctx);
      let text = await callClaudeText({ prompt: finalPrompt, system: params.system, model: params.model, temperature: Number(params.temperature) });
      text = cleanFormattedOutput(text, params.outputFormat);
      return { text: { type: "text", value: text } };
    },
  },

  "claude-code": {
    title: "Claude Code — Texto",
    icon: "✳️",
    category: "Texto (LLM)",
    local: true,
    desc: "claude -p na sua máquina",
    help: "Envia o prompt para a CLI do Claude Code instalada no seu computador (claude -p), usando o login que você já tem nela — assinatura ou API key. Roda pelo servidor local, sem ferramentas (não lê nem altera arquivos) e sem customizações/CLAUDE.md. Com um “Schema de saída” (JSON Schema embutido, seu ou personalizado), a resposta vem validada nesse formato (--json-schema): a porta “texto / JSON” traz o JSON formatado e, se ele tiver uma lista (array na raiz ou uma única propriedade array), a porta “itens (lista)” entrega essa lista e os nodes seguintes rodam uma vez por item. Sem schema, vale o “Formato de saída” como nos outros nodes de texto. Custo estimado, modelo e duração ficam no 🐞 Debug.",
    endpoint: "POST {servidor local}/claude/run → claude -p --output-format json [--json-schema …]",
    inputs: [{ key: "prompt", label: "prompt", dtype: "text" }],
    outputs: [
      { key: "text", label: "texto / JSON", dtype: "text" },
      { key: "items", label: "itens (lista)", dtype: "text" },
    ],
    params: [
      { key: "model", label: "Modelo", widget: "select", options: [
        { value: "", label: "Padrão da sua CLI" },
        { value: "claude-opus-5", label: "Claude Opus 5" },
        { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
        { value: "claude-fable-5-1", label: "Claude Fable 5.1" },
        { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      ], default: "" },
      { key: "effort", label: "Esforço", widget: "select", optionsFn: claudeEffortOptions, default: "" },
      { key: "system", label: "Instrução de sistema", widget: "textarea", default: "" },
      { key: "schema", label: "Schema de saída (JSON)", widget: "select", optionsFn: outputSchemaOptions, manage: "output-schemas", default: "" },
      { key: "schemaCustom", label: "JSON Schema personalizado", widget: "textarea", showIf: p => p.schema === "custom",
        default: '{\n  "type": "object",\n  "properties": {\n    "titulo": { "type": "string" },\n    "itens": { "type": "array", "items": { "type": "string" } }\n  },\n  "required": ["titulo", "itens"]\n}' },
      { key: "outputFormat", label: "Formato de saída", widget: "select", optionsFn: outputFormatOptions, manage: "output-templates", default: "livre", showIf: p => !p.schema },
    ],
    async run(inputs, params, ctx) {
      const prompt = inputs.prompt?.value;
      if (!prompt) throw new Error("Entrada “prompt” vazia — conecte um node de texto.");
      const schema = resolveOutputSchema(params.schema, params.schemaCustom);
      const finalPrompt = schema ? prompt : applyOutputFormat(prompt, params.outputFormat, ctx);
      if (schema) ctx.log?.("Saída estruturada: schema enviado com --json-schema.");
      ctx.progress("Executando claude -p no servidor local…");
      const r = await callLocal("/claude/run", { method: "POST", body: {
        prompt: finalPrompt,
        system: params.system || "",
        model: params.model || "",
        effort: params.effort || "",
        json_schema: schema,
      } });
      ctx.log?.(`${r.model || "modelo padrão"} · ${((r.duration_ms || 0) / 1000).toFixed(1)}s` +
        (r.cost_usd != null ? ` · custo estimado US$ ${Number(r.cost_usd).toFixed(4)}` : ""));
      if (!schema) return { text: { type: "text", value: cleanFormattedOutput(r.text, params.outputFormat) } };

      if (r.structured == null) throw new Error("O Claude Code não devolveu a saída estruturada.");
      const out = { text: { type: "text", value: JSON.stringify(r.structured, null, 2) } };
      const list = listFromStructured(r.structured);
      if (list?.length) {
        const values = list.map(v => (typeof v === "string" ? v : JSON.stringify(v)));
        out.items = values.length === 1 ? { type: "text", value: values[0] } : { type: "text", values };
        ctx.log?.(`${values.length} item(ns) na porta “itens (lista)”.`);
      } else {
        ctx.log?.("A saída não tem uma lista única — a porta “itens (lista)” fica vazia.");
      }
      return out;
    },
  },

  "gemini-text": {
    title: "Gemini — Texto",
    icon: "💠",
    category: "Texto (LLM)",
    desc: "Google generateContent",
    help: "Envia o prompt (com systemInstruction opcional) ao modelo Gemini escolhido e devolve o texto concatenado das parts da resposta na saída “texto”. O campo “Formato de saída” anexa ao final do prompt instruções de formatação (JSON, lista, CSV… ou um template seu) e remove cercas de código da resposta quando aplicável. Autenticação: chave da API do Google (query string).",
    endpoint: "POST https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent",
    inputs: [{ key: "prompt", label: "prompt", dtype: "text" }],
    outputs: [{ key: "text", label: "texto", dtype: "text" }],
    params: [
      { key: "model", label: "Modelo", widget: "select", options: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite", "gemini-2.5-pro", "gemini-2.5-flash"], default: "gemini-3.5-flash" },
      { key: "system", label: "Instrução de sistema", widget: "textarea", default: "" },
      { key: "outputFormat", label: "Formato de saída", widget: "select", optionsFn: outputFormatOptions, manage: "output-templates", default: "livre" },
      { key: "temperature", label: "Temperatura", widget: "number", default: 0.8, min: 0, max: 2, step: 0.1 },
    ],
    async run(inputs, params, ctx) {
      const prompt = inputs.prompt?.value;
      if (!prompt) throw new Error("Entrada “prompt” vazia — conecte um node de texto.");
      const finalPrompt = applyOutputFormat(prompt, params.outputFormat, ctx);
      let text = await callGeminiText({ prompt: finalPrompt, system: params.system, model: params.model, temperature: Number(params.temperature) });
      text = cleanFormattedOutput(text, params.outputFormat);
      return { text: { type: "text", value: text } };
    },
  },

  /* ----- Utilidades ----- */
  "split-text": {
    title: "Dividir Texto → Lista",
    icon: "🔀",
    category: "Utilidades",
    desc: "Separa texto em vários itens",
    help: "Divide o texto recebido em vários itens conforme o Separador — linhas, parágrafos (blocos separados por linha em branco, bom para itens de várias linhas), vírgula, ponto e vírgula, JSON (array, ou objeto com uma única lista) ou uma coluna de CSV — removendo numeração e marcadores iniciais (“1.”, “-”, “•”) nos modos de linha/vírgula. A saída em lista faz os nodes seguintes executarem uma vez por item (fan-out). Não chama nenhuma API.",
    inputs: [{ key: "text", label: "texto", dtype: "text" }],
    outputs: [{ key: "items", label: "itens", dtype: "text" }],
    params: [
      { key: "mode", label: "Separador", widget: "select", options: LIST_MODES, default: "linhas" },
      { key: "csvColumn", label: "Coluna do CSV (número ou nome)", widget: "text", default: "1", showIf: p => p.mode === "CSV (coluna)" },
      { key: "csvHeader", label: "CSV tem cabeçalho", widget: "checkbox", default: true, showIf: p => p.mode === "CSV (coluna)" },
      { key: "maxItems", label: "Máx. de itens (0 = todos)", widget: "number", default: 0, min: 0, step: 1 },
    ],
    async run(inputs, params) {
      const text = inputs.text?.value;
      if (!text) throw new Error("Entrada “texto” vazia — conecte um node de texto.");
      const items = splitTextToItems(text, params.mode, {
        csvColumn: params.csvColumn, csvHeader: params.csvHeader !== false, maxItems: Number(params.maxItems) || 0,
      });
      if (!items.length) throw new Error("Nenhum item encontrado após a divisão.");
      return {
        items: items.length === 1
          ? { type: "text", value: items[0] }
          : { type: "text", values: items },
      };
    },
  },

  /* ----- Imagem ----- */
  "openai-image": {
    title: "OpenAI — Gerar Imagem",
    icon: "🎨",
    category: "Imagem",
    desc: "gpt-image-2 / gpt-image-1",
    help: "Gera imagens a partir do prompt recebido. A entrada “imagens” é opcional: quando conectada, todas as imagens recebidas (uma ou uma lista inteira) são enviadas juntas como referência numa única chamada ao endpoint /images/edits — útil para composição, variações e transferência de estilo. Sem imagens, usa /images/generations. A resposta em base64 vira dataURL na saída “imagem”. O campo “Fundo” manda o parâmetro background para a API: com “Transparente” a resposta vem em PNG com canal alfa — pedir fundo transparente só no prompt não produz alfa nenhum. Com “Quantidade por prompt” > 1, chama a API uma vez por imagem. Se o prompt for uma lista, executa para cada item. Autenticação: chave OpenAI.",
    endpoint: "POST https://api.openai.com/v1/images/generations (ou /images/edits com imagens de referência)",
    inputs: [
      { key: "prompt", label: "prompt", dtype: "text" },
      { key: "images", label: "imagens (opcional)", dtype: "image", list: true, multi: true },
    ],
    outputs: [{ key: "image", label: "imagem", dtype: "image" }],
    params: [
      { key: "model", label: "Modelo", widget: "select", options: ["gpt-image-2", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"], default: "gpt-image-2" },
      { key: "size", label: "Tamanho", widget: "select", optionsFn: imageSizeOptions, freeFn: imageSizeFree, hintFn: imageSizeHint, checkFn: imageSizeCheck, customExample: "LARGURAxALTURA, por exemplo 2048x1152", default: "1024x1024" },
      { key: "quality", label: "Qualidade", widget: "select", optionsFn: imageQualityOptions, default: "medium" },
      { key: "background", label: "Fundo", widget: "select", options: [
          { value: "auto", label: "Automático (o modelo decide)" },
          { value: "transparent", label: "Transparente (PNG com alfa)" },
          { value: "opaque", label: "Opaco" },
        ], default: "auto", hint: "Pedir “fundo transparente” só no prompt não basta: o alfa vem deste campo." },
      { key: "n", label: "Quantidade por prompt", widget: "number", default: 1, min: 1, max: 4, step: 1 },
    ],
    async run(inputs, params, ctx) {
      const prompt = inputs.prompt?.value;
      if (!prompt) throw new Error("Entrada “prompt” vazia — conecte um node de texto.");
      const refVal = inputs.images;
      const refs = refVal ? (Array.isArray(refVal.values) ? refVal.values : [refVal.value]) : [];
      if (refs.length) ctx.log?.(`Usando ${refs.length} imagem(ns) de referência via /images/edits.`);
      const n = Math.max(1, Math.min(4, Number(params.n) || 1));
      const values = [];
      const errors = [];
      for (let i = 0; i < n; i++) {
        try {
          if (n > 1) ctx.progress(`Gerando imagem ${i + 1}/${n}…`);
          values.push(refs.length
            ? await callOpenAIImageEdit({ images: refs, prompt, model: params.model, size: params.size, background: params.background })
            : await callOpenAIImage({ prompt, model: params.model, size: params.size, quality: params.quality, background: params.background }));
        } catch (err) {
          errors.push(`Imagem ${i + 1}: ${err.message || err}`);
          ctx.log?.(`✖ Falha na imagem ${i + 1}/${n}: ${err.message || err}`);
        }
      }
      if (!values.length) throw new Error(errors.join("\n") || "Nenhuma imagem gerada.");
      if (errors.length) ctx.log?.(`⚠ ${errors.length} de ${n} imagem(ns) falharam — as demais foram mantidas.`);
      return { image: values.length === 1 ? { type: "image", value: values[0] } : { type: "image", values } };
    },
  },

  "openai-image-edit": {
    title: "OpenAI — Editar Imagem",
    icon: "🖌️",
    category: "Imagem",
    desc: "Edita imagens com prompt",
    help: "Envia as imagens de entrada + o prompt num formulário multipart para o endpoint de edição e devolve a imagem editada como dataURL na saída “imagem”. Aceita várias conexões de imagem (e listas): todas entram juntas como referência numa única chamada — útil para combinar/compor imagens. O prompt em lista faz fan-out normalmente. O campo “Fundo” com “Transparente” pede à API um PNG com canal alfa (útil para recortar o personagem do cenário). Autenticação: chave OpenAI.",
    endpoint: "POST https://api.openai.com/v1/images/edits (multipart/form-data)",
    inputs: [
      { key: "image", label: "imagens", dtype: "image", list: true, multi: true },
      { key: "prompt", label: "prompt", dtype: "text" },
    ],
    outputs: [{ key: "image", label: "imagem", dtype: "image" }],
    params: [
      { key: "model", label: "Modelo", widget: "select", options: ["gpt-image-2", "gpt-image-1.5", "gpt-image-1"], default: "gpt-image-2" },
      { key: "size", label: "Tamanho", widget: "select", optionsFn: imageSizeOptions, freeFn: imageSizeFree, hintFn: imageSizeHint, checkFn: imageSizeCheck, customExample: "LARGURAxALTURA, por exemplo 2048x1152", default: "1024x1024" },
      { key: "background", label: "Fundo", widget: "select", options: [
          { value: "auto", label: "Automático (o modelo decide)" },
          { value: "transparent", label: "Transparente (PNG com alfa)" },
          { value: "opaque", label: "Opaco" },
        ], default: "auto", hint: "Pedir “fundo transparente” só no prompt não basta: o alfa vem deste campo." },
    ],
    async run(inputs, params, ctx) {
      const refVal = inputs.image;
      const refs = refVal ? (Array.isArray(refVal.values) ? refVal.values : [refVal.value]) : [];
      const prompt = inputs.prompt?.value;
      if (!refs.length) throw new Error("Entrada “imagens” vazia — conecte um ou mais nodes de imagem.");
      if (!prompt) throw new Error("Entrada “prompt” vazia — conecte um node de texto.");
      if (refs.length > 1) ctx.log?.(`Editando com ${refs.length} imagens de referência numa única chamada.`);
      const out = await callOpenAIImageEdit({ images: refs, prompt, model: params.model, size: params.size, background: params.background });
      return { image: { type: "image", value: out } };
    },
  },

  "hf-image": {
    title: "Hugging Face — Imagem",
    icon: "🤗",
    category: "Imagem",
    desc: "Inference API (FLUX, SDXL…)",
    help: "Chama a Inference API do Hugging Face para o repositório informado (tarefa texto → imagem, ex.: FLUX.2-klein-4B, FLUX.2-dev, Qwen/Qwen-Image, FLUX.1-schnell). A resposta binária é convertida em dataURL na saída “imagem”. Com “Quantidade por prompt” > 1, repete a chamada. Autenticação: token HF (Bearer).",
    endpoint: "POST https://router.huggingface.co/hf-inference/models/{repo}",
    inputs: [{ key: "prompt", label: "prompt", dtype: "text" }],
    outputs: [{ key: "image", label: "imagem", dtype: "image" }],
    params: [
      { key: "model", label: "Modelo (repo)", widget: "text", default: "black-forest-labs/FLUX.2-klein-4B" },
      { key: "n", label: "Quantidade por prompt", widget: "number", default: 1, min: 1, max: 6, step: 1 },
    ],
    async run(inputs, params, ctx) {
      const prompt = inputs.prompt?.value;
      if (!prompt) throw new Error("Entrada “prompt” vazia — conecte um node de texto.");
      const n = Math.max(1, Math.min(6, Number(params.n) || 1));
      const values = [];
      const errors = [];
      for (let i = 0; i < n; i++) {
        try {
          if (n > 1) ctx.progress(`Gerando imagem ${i + 1}/${n}…`);
          values.push(await callHFImage({ prompt, model: params.model }));
        } catch (err) {
          errors.push(`Imagem ${i + 1}: ${err.message || err}`);
          ctx.log?.(`✖ Falha na imagem ${i + 1}/${n}: ${err.message || err}`);
        }
      }
      if (!values.length) throw new Error(errors.join("\n") || "Nenhuma imagem gerada.");
      if (errors.length) ctx.log?.(`⚠ ${errors.length} de ${n} imagem(ns) falharam — as demais foram mantidas.`);
      return { image: values.length === 1 ? { type: "image", value: values[0] } : { type: "image", values } };
    },
  },

  /* ----- 3D ----- */
  "trellis-3d": {
    title: "TRELLIS — Imagem → 3D",
    icon: "🧊",
    category: "3D",
    desc: "HF Space da Microsoft",
    help: "Conecta ao Space configurado via cliente Gradio e roda o pipeline do TRELLIS: /preprocess_image (recorte/fundo), /get_seed, /image_to_3d (gera a estrutura 3D — etapa lenta) e /extract_glb (malha final). Devolve a URL do arquivo GLB na saída “modelo 3D”. Se o pipeline padrão não existir no space, tenta os endpoints alternativos /generate_3d, /run e /predict. Autenticação: token HF (opcional, mas recomendado).",
    endpoint: "Gradio Space: /preprocess_image → /image_to_3d → /extract_glb",
    inputs: [{ key: "image", label: "imagem", dtype: "image" }],
    outputs: [{ key: "model", label: "modelo 3D", dtype: "model3d" }],
    params: [
      { key: "space", label: "Space (Hugging Face)", widget: "text", default: "microsoft/TRELLIS" },
      { key: "randomizeSeed", label: "Seed aleatória", widget: "checkbox", default: true },
      { key: "seed", label: "Seed", widget: "number", default: 0, min: 0, step: 1 },
      { key: "textureSize", label: "Tamanho da textura", widget: "select", options: ["512", "1024", "2048"], default: "1024" },
    ],
    async run(inputs, params, ctx) {
      const image = inputs.image?.value;
      if (!image) throw new Error("Entrada “imagem” vazia — conecte um node de imagem.");
      const url = await callTrellis({
        image,
        space: params.space,
        seed: params.seed,
        randomizeSeed: params.randomizeSeed,
        textureSize: params.textureSize,
      }, ctx);
      return { model: { type: "model3d", value: url } };
    },
  },

  /* ----- Áudio (modelos locais) ----- */
  "qwen3-tts-voice": {
    title: "Qwen3-TTS — Voz",
    icon: "🎙️",
    category: "Áudio",
    local: true,
    desc: "Perfil de voz persistente",
    help: "Cria (ou reutiliza) um PERFIL DE VOZ no servidor local e o entrega na saída “voz” — conecte-a a um ou vários nodes “Qwen3-TTS — Fala” para que todos falem com exatamente a mesma voz. Origens: descrição (o VoiceDesign cria a voz falando a frase de referência), speaker pré-definido (+ estilo opcional) ou áudio de referência (clonagem; exige a transcrição exata, que pode vir da entrada “transcrição”). Em todos os casos o perfil guarda um áudio de referência fixo, a transcrição e a seed em D:\\modelos\\qwen3-tts\\vozes\\<nome>, e o servidor calcula uma única vez o prompt de clonagem (códigos da referência + embedding do speaker), salvo em disco — toda geração posterior usa o mesmo condicionamento, mesmo depois de reiniciar. Se o nome já existir, o perfil salvo é reutilizado sem gerar nada (avisa se os parâmetros mudaram); “Recriar” substitui o perfil uma vez e se desmarca sozinho. A saída “áudio de referência” traz o clipe que define a voz.",
    endpoint: "POST {servidor local}/qwen3-tts/voices",
    inputs: [
      { key: "ref_audio", label: "áudio de referência (clonar)", dtype: "audio" },
      { key: "ref_text", label: "transcrição (opcional)", dtype: "text" },
    ],
    outputs: [
      { key: "voice", label: "voz", dtype: "voice" },
      { key: "audio", label: "áudio de referência", dtype: "audio" },
    ],
    params: [
      { key: "name", label: "Nome da voz (perfil)", widget: "text", default: "narrador" },
      { key: "source", label: "Origem da voz", widget: "select", options: [
        { value: "design", label: "Descrição (voice design)" },
        { value: "speaker", label: "Speaker pré-definido" },
        { value: "audio", label: "Áudio de referência (clonar)" },
      ], default: "design" },
      { key: "instruct", label: "Descrição da voz", widget: "textarea", showIf: p => p.source === "design",
        default: "Voz masculina adulta, grave e aveludada, ritmo calmo, dicção clara, tom de narrador de documentário." },
      { key: "speaker", label: "Speaker", widget: "select", options: QWEN_TTS_SPEAKERS, default: "Aiden", showIf: p => p.source === "speaker" },
      { key: "style", label: "Estilo/emoção (opcional)", widget: "textarea", default: "", showIf: p => p.source === "speaker" },
      { key: "refText", widget: "textarea",
        labelFn: p => p.source === "audio" ? "Transcrição exata do áudio (ou use a entrada)" : "Frase de referência (falada para criar a voz)",
        default: "Olá! Esta é a minha voz de referência. Com ela, todas as falas do projeto vão manter o mesmo timbre, o mesmo ritmo e a mesma entonação." },
      { key: "language", label: "Idioma", widget: "select", options: QWEN_TTS_LANGUAGES, default: "Portuguese" },
      { key: "seed", label: "Seed do perfil", widget: "number", default: 42, min: 0, step: 1 },
      { key: "xVectorOnly", label: "Só embedding (x-vector): dispensa transcrição, menos fiel", widget: "checkbox", default: false, showIf: p => p.source === "audio" },
      { key: "overwrite", label: "Recriar se a voz já existir (uma vez)", widget: "checkbox", default: false },
    ],
    async run(inputs, params, ctx) {
      const name = String(params.name || "").trim();
      if (!name) throw new Error("Dê um nome à voz — é por ele que o perfil é salvo e reutilizado.");
      if (inputs.ref_audio && params.source !== "audio") {
        ctx.log?.("Áudio conectado, mas a origem não é “Áudio de referência” — ele foi ignorado.");
      }
      // a entrada “transcrição” substitui o campo “Frase de referência”, e em “Descrição” isso é quase
      // sempre acidente: o modelo fala o texto inteiro para criar a voz
      const refText = inputs.ref_text?.value ?? params.refText ?? "";
      if (inputs.ref_text?.value != null && params.source !== "audio") {
        ctx.warn?.(`A entrada “transcrição” está conectada e SUBSTITUIU a “Frase de referência” `
          + `(${String(inputs.ref_text.value).length} caracteres). Em “${params.source === "design"
            ? "Descrição (voice design)" : "Speaker pré-definido"}” essa entrada serve só para clonagem — `
          + `desconecte-a se quer a frase digitada no node.`);
      }
      // o servidor também recusa, mas aqui o erro é instantâneo — sem esperar a GPU começar
      if (params.source !== "audio") {
        const seg = refSeconds(refText);
        if (seg > 30) {
          const dur = seg >= 90 ? `${Math.round(seg / 60)} min` : `${Math.round(seg)} s`;
          throw new Error(`A frase de referência tem ${refText.length} caracteres — cerca de ${dur} de `
            + `fala, muito acima do limite de 30 s. Ela é falada inteira pelo modelo para criar a voz `
            + `(1 s de áudio custa ~11 s de GPU), e uma referência longa estraga a clonagem: o fim dela `
            + `vira prefixo de todas as falas. Use uma frase de 5–15 s.`);
        }
      }
      const body = {
        name,
        source: params.source,
        instruct: params.source === "design" ? params.instruct : params.source === "speaker" ? params.style : "",
        speaker: params.speaker,
        ref_text: refText,
        language: params.language,
        seed: Math.max(0, Math.floor(Number(params.seed) || 0)),
        x_vector_only: Boolean(params.xVectorOnly),
        overwrite: Boolean(params.overwrite),
      };
      if (params.source === "audio") {
        if (!inputs.ref_audio?.value) throw new Error("Origem “Áudio de referência”: conecte um node de áudio (ex.: Áudio (upload)) à entrada.");
        body.ref_audio = inputs.ref_audio.value;
      }
      ctx.progress(params.overwrite ? "Recriando o perfil de voz no servidor local…" : "Criando/verificando o perfil de voz no servidor local…");
      const r = await callLocal("/qwen3-tts/voices", { method: "POST", body });
      for (const line of r.log || []) ctx.log?.(line);
      if (r.warning) ctx.warn?.(r.warning);
      if (params.overwrite) ctx.setParam?.("overwrite", false); // recriar é uma ação única
      refreshLocalVoices();
      return {
        voice: { type: "voice", value: r.voice.name },
        // perfil reutilizado não entra de novo no histórico
        audio: { type: "audio", value: r.reference_audio, noHistory: r.reused },
      };
    },
  },

  "qwen3-tts": {
    title: "Qwen3-TTS — Fala",
    icon: "🗣️",
    category: "Áudio",
    local: true,
    desc: "Texto → fala (GPU local)",
    help: "Converte o texto em fala com o Qwen3-TTS rodando no servidor local. A voz vem da entrada “voz” (perfil do node “Qwen3-TTS — Voz”) ou, sem ela, do campo “Voz”: voz salva, speaker pré-definido (com estilo/emoção opcional) ou descrição (voice design — sorteia uma voz nova a cada execução). Consistência entre gerações: perfis clonados usam um prompt fixo em cache; a seed (da voz, fixa ou aleatória — a usada fica no debug) é reaplicada em cada trecho; a amostragem “Equilibrado” reduz variações sem travar; se uma geração entrar em loop (não termina), o servidor detecta e refaz com seeds derivadas; textos longos são divididos em frases geradas com o mesmo condicionamento (evita a voz derivar ao longo do áudio); volume normalizado e silêncio aparado deixam todos os clipes no mesmo nível. Em voice design com vários trechos, o 1º trecho vira referência e os demais são clonados dele. Estilo/emoção não funciona com vozes clonadas (limitação do modelo Base). Lista de textos → um áudio por item; “Várias vozes” gera o mesmo texto em cada voz marcada (vozes salvas e/ou speakers pré-definidos) — um áudio por voz, na ordem da lista, com o nome da voz na prévia e no {voz} do Coletar resultados; a entrada “voz” também aceita vários nodes Voz conectados (um áudio por voz; com lista de textos, todas as combinações texto × voz); “Takes” > 1 gera variações com seeds seguidas (seed, seed+1…) para escolher a melhor. Cada áudio da prévia tem um ↻ que refaz SÓ ele, com a seed seguinte, e o substitui no lugar (Shift+clique escolhe a seed; o mesmo ↻ existe no visualizador ⤢). A prévia lista TODOS os áudios numa área rolável dentro do node. Quando alguma combinação falha, ela fica registrada e o botão “↻ Refazer os que falharam” tenta de novo só essas — o que já deu certo não é gerado outra vez.",
    endpoint: "POST {servidor local}/qwen3-tts/tts",
    inputs: [
      { key: "text", label: "texto", dtype: "text" },
      { key: "voice", label: "voz (opcional, aceita várias)", dtype: "voice", multi: true },
    ],
    outputs: [{ key: "audio", label: "áudio", dtype: "audio" }],
    params: [
      { key: "voiceSource", label: "Voz (sem entrada “voz”)", widget: "select", options: [
        { value: "saved", label: "Voz salva (perfil)" },
        { value: "speaker", label: "Speaker pré-definido" },
        { value: "design", label: "Descrição — muda a cada execução" },
        { value: "multi", label: "Várias vozes (uma geração por voz)" },
      ], default: "saved" },
      { key: "savedVoice", label: "Voz salva", widget: "select", optionsFn: localVoiceOptions, manage: "local-voices", default: "", showIf: p => p.voiceSource === "saved" },
      { key: "voices", label: "Vozes — marque várias", widget: "multicheck", optionsFn: voiceTargetOptions, default: [], showIf: p => p.voiceSource === "multi" },
      { key: "speaker", label: "Speaker", widget: "select", options: QWEN_TTS_SPEAKERS, default: "Aiden", showIf: p => p.voiceSource === "speaker" },
      { key: "instruct", widget: "textarea", default: "", showIf: p => p.voiceSource !== "saved",
        labelFn: p => p.voiceSource === "design" ? "Descrição da voz"
          : p.voiceSource === "multi" ? "Estilo/emoção (opcional, só nos speakers)" : "Estilo/emoção (opcional)" },
      { key: "language", label: "Idioma", widget: "select", options: QWEN_TTS_LANGUAGES, default: "Portuguese" },
      { key: "modelSize", label: "Modelo", widget: "select", options: [
        { value: "1.7B", label: "1.7B — melhor qualidade" },
        { value: "0.6B", label: "0.6B — mais leve" },
      ], default: "1.7B" },
      { key: "sampling", label: "Amostragem", widget: "select", options: [
        { value: "equilibrado", label: "Equilibrado — consistente (recomendado)" },
        { value: "estavel", label: "Estável — mínima variação, pode travar em loop" },
        { value: "padrao", label: "Padrão do modelo" },
        { value: "expressivo", label: "Expressivo — mais variação" },
      ], default: "equilibrado" },
      { key: "seedMode", label: "Seed", widget: "select", options: [
        { value: "profile", label: "Da voz (perfil)" },
        { value: "fixed", label: "Fixa" },
        { value: "random", label: "Aleatória" },
      ], default: "profile" },
      { key: "seed", label: "Seed fixa", widget: "number", default: 42, min: 0, step: 1, showIf: p => p.seedMode === "fixed" },
      { key: "takes", label: "Takes por texto (seeds seguidas)", widget: "number", default: 1, min: 1, max: 4, step: 1 },
      { key: "split", label: "Dividir texto longo em frases (evita deriva)", widget: "checkbox", default: true },
      { key: "maxChars", label: "Máx. caracteres por trecho", widget: "number", default: 220, min: 40, max: 2000, step: 10, showIf: p => p.split },
      { key: "pauseMs", label: "Pausa entre trechos (ms)", widget: "number", default: 250, min: 0, max: 3000, step: 50, showIf: p => p.split },
      { key: "normalize", label: "Volume", widget: "select", options: [
        { value: "rms", label: "Normalizar loudness (RMS −20 dBFS)" },
        { value: "peak", label: "Normalizar pico (−1 dBFS)" },
        { value: "off", label: "Sem normalização" },
      ], default: "rms" },
      { key: "trimSilence", label: "Cortar silêncio nas pontas", widget: "checkbox", default: true },
    ],
    async run(inputs, params, ctx) {
      const text = inputs.text?.value;
      if (!text || !String(text).trim()) throw new Error("Entrada “texto” vazia — conecte um node de texto.");
      // alvos: a voz conectada, as vozes marcadas (“Várias vozes”) ou a escolha única do campo “Voz”
      const voiceIn = inputs.voice?.value;
      let targets;
      if (voiceIn) {
        targets = [{ mode: "voice", voice: voiceIn }];
        ctx.log?.(`Usando a voz conectada: “${voiceIn}”.`);
      } else if (params.voiceSource === "multi") {
        const selected = (Array.isArray(params.voices) ? params.voices : []).filter(Boolean);
        if (!selected.length) throw new Error("Marque ao menos uma voz em “Vozes — marque várias”.");
        targets = selected.map(v => (v.startsWith("speaker:")
          ? { mode: "speaker", speaker: v.slice("speaker:".length) }
          : { mode: "voice", voice: v.replace(/^voice:/, "") }));
        ctx.log?.(`Várias vozes (${targets.length}): ${targets.map(t => t.voice || t.speaker).join(", ")}.`);
      } else if (params.voiceSource === "speaker") {
        targets = [{ mode: "speaker", speaker: params.speaker }];
      } else if (params.voiceSource === "design") {
        if (!String(params.instruct || "").trim()) throw new Error("Descreva a voz no campo “Descrição da voz”.");
        ctx.warn?.("Voz por descrição sem perfil: cada execução sorteia uma voz nova. Para manter a mesma voz entre gerações, crie um perfil com o node “Qwen3-TTS — Voz”.");
        targets = [{ mode: "design" }];
      } else {
        if (!params.savedVoice) {
          throw new Error("Nenhuma voz definida — conecte um node “Qwen3-TTS — Voz” à entrada “voz” ou escolha uma voz salva.");
        }
        targets = [{ mode: "voice", voice: params.savedVoice }];
      }

      const takes = Math.max(1, Math.min(4, Math.floor(Number(params.takes) || 1)));
      const values = [];
      const metas = []; // texto, seed e voz de cada áudio — nome no Coletar, “Salvar como voz”…
      const errors = [];
      const failed = []; // combinações que falharam, para o “↻ Refazer os que falharam” da prévia
      for (const [vi, target] of targets.entries()) {
        const name = target.voice || target.speaker || "descrição";
        for (let t = 0; t < takes; t++) {
          const label = [
            targets.length > 1 ? `voz ${vi + 1}/${targets.length} (${name})` : "",
            takes > 1 ? `take ${t + 1}/${takes}` : "",
          ].filter(Boolean).join(" · ");
          try {
            ctx.progress(label ? `Gerando ${label}…` : "Gerando fala no servidor local…");
            const r = await callLocal("/qwen3-tts/tts", { method: "POST",
              body: ttsBody({ text, target, params, take: t }) });
            for (const line of r.log || []) ctx.log?.(targets.length > 1 ? `[${name}] ${line}` : line);
            values.push(r.audio);
            metas.push(ttsItemMeta(text, target, params, t, r.seed));
          } catch (err) {
            const msg = err.message || String(err);
            errors.push(label ? `${label}: ${msg}` : msg);
            // guarda a combinação inteira: é o que permite refazer só ela depois
            failed.push({ ...ttsItemMeta(text, target, params, t, null), error: msg });
            ctx.log?.(`✖ Falha${label ? ` (${label})` : ""}: ${msg}`);
          }
        }
      }
      if (!values.length) throw new Error(errors.join("\n"));
      if (errors.length) {
        ctx.warn?.(`${errors.length} de ${targets.length * takes} geração(ões) falharam — as demais foram mantidas:\n${errors.join("\n")}`);
      }
      const out = values.length === 1
        ? { type: "audio", value: values[0], meta: metas[0] }
        : { type: "audio", values, meta: metas };
      if (failed.length) out.failed = failed;
      return { audio: out };
    },

    /* Refaz UM áudio: a prévia chama isto com o meta do item e uma seed nova. Os parâmetros de
       áudio vêm do node (valem os ajustes atuais); a voz e o texto vêm do meta do próprio item.
       Sem `seed`, repete a combinação como ela foi pedida (usado no “refazer os que falharam”). */
    async regenerateItem({ meta, params, seed }) {
      const target = ttsTargetFromMeta(meta, params);
      const body = seed == null
        ? ttsBody({ text: meta.text, target, params, take: meta.take || 0, language: meta.language })
        : ttsBody({ text: meta.text, target, params, seedMode: "fixed", seed, take: 0, language: meta.language });
      const r = await callLocal("/qwen3-tts/tts", { method: "POST", body });
      return { value: r.audio, meta: { ...meta, seed: r.seed }, log: r.log || [] };
    },
  },

  /* ----- Saída ----- */
  "viewer": {
    title: "Visualizador",
    icon: "👁️",
    category: "Saída",
    desc: "Mostra texto, imagem ou 3D",
    help: "Exibe o que chegar na entrada (texto, imagem ou modelo 3D) na prévia do node — clique na prévia para ampliar, navegar com as setas e editar imagens pelo chat. Recebendo uma lista, mostra todos os itens em galeria. Ao executar via ▶, reaproveita os outputs já existentes dos nodes anteriores (só roda o que falta) e se atualiza automaticamente quando um node conectado a ele é executado. Não produz saídas nem chama APIs.",
    inputs: [{ key: "input", label: "entrada", dtype: "any" }],
    outputs: [],
    params: [],
    async run(inputs) {
      const v = inputs.input;
      if (!v) throw new Error("Nada conectado ao visualizador.");
      return { __display: v };
    },
  },

  "collector": {
    title: "Coletar resultados",
    icon: "🧺",
    category: "Saída",
    desc: "Junta tudo que o loop gerou",
    help: "Junta num só lugar tudo o que chega — os itens de uma lista/loop (ex.: os N áudios de um node Fala ligado a uma lista de falas) e de várias conexões ao mesmo tempo — sem rodar de novo por item. Com os itens coletados: “⇩ Baixar .zip” (um arquivo por item + manifest.json com o texto, a seed e a voz de cada um), “📁 Pasta…” (no Chrome, escolhe uma pasta do computador; os arquivos são gravados nela a cada execução enquanto “Salvar na pasta a cada execução” estiver marcado, ou na hora com “Salvar agora”), a saída “áudio único” (todos os áudios emendados na ordem, com a pausa configurada) e a saída “texto único” (todos os textos juntos com o separador). A saída “lista” repassa os itens para outro node. Nome dos arquivos: {n} = número do item, {voz} = voz/speaker que gerou o áudio (vazio nos demais), {texto} = início do texto/prompt que gerou o item, {tipo} = image/audio/text. Não chama nenhuma API.",
    inputs: [{ key: "input", label: "itens (aceita várias conexões)", dtype: "any", list: true, multi: true }],
    outputs: [
      { key: "list", label: "lista", dtype: "any" },
      { key: "audio", label: "áudio único", dtype: "audio" },
      { key: "text", label: "texto único", dtype: "text" },
    ],
    params: [
      { key: "files", label: "Arquivos", widget: "collector" },
      { key: "pattern", label: "Nome dos arquivos ({n}, {voz}, {texto}, {tipo})", widget: "text", default: "{n}_{voz}_{texto}" },
      { key: "autoSave", label: "Salvar na pasta a cada execução", widget: "checkbox", default: true },
      { key: "pauseMs", label: "Pausa entre áudios no áudio único (ms)", widget: "number", default: 400, min: 0, max: 5000, step: 50 },
      { key: "separator", label: "Separador do texto único", widget: "select", options: ["linha", "linha em branco", "vírgula", "nenhum"], default: "linha" },
    ],
    async run(inputs, params, ctx) {
      const items = collectedItems(inputs.input);
      if (!items.length) throw new Error("Nada chegou — conecte a saída de um node que roda em loop (ex.: Fala, Gerar Imagem) ou vários nodes.");
      const counts = {};
      for (const it of items) counts[it.type] = (counts[it.type] || 0) + 1;
      ctx.log?.(`${items.length} item(ns) coletado(s): ${Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(", ")}.`);
      const out = { list: packItems(items) };

      const audios = items.filter(it => it.type === "audio");
      if (audios.length) {
        ctx.progress(`Juntando ${audios.length} áudio(s)…`);
        const script = audios.map(a => a.meta?.text).filter(Boolean).join("\n");
        const joined = await concatAudioDataUrls(audios.map(a => a.value), Number(params.pauseMs) || 0);
        out.audio = script ? { type: "audio", value: joined, meta: { text: script } } : { type: "audio", value: joined };
      }
      const texts = items.filter(it => it.type === "text");
      if (texts.length) {
        const sep = { "linha": "\n", "linha em branco": "\n\n", "vírgula": ", ", "nenhum": "" }[params.separator] ?? "\n";
        out.text = { type: "text", value: texts.map(t => t.value).join(sep) };
      }

      const dir = ctx.node?._dirHandle;
      if (dir && params.autoSave !== false) {
        try {
          ctx.progress(`Salvando na pasta “${dir.name}”…`);
          const files = await buildCollectedFiles(items, params.pattern, ctx.log);
          await writeFilesToFolder(dir, files);
          ctx.log?.(`${files.length - 1} arquivo(s) + manifest.json salvos na pasta “${dir.name}”.`);
        } catch (err) {
          ctx.warn?.(`Não foi possível salvar na pasta “${dir.name}” (${err.message || err}) — clique em “Salvar agora”.`);
        }
      }
      return out;
    },
  },
};

const NODE_CATEGORIES = ["Entrada", "Texto (LLM)", "Utilidades", "Imagem", "3D", "Áudio", "Saída"];
