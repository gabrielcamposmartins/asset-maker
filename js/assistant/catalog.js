/* ============================================================
   catalog.js — catálogo de nodes gerado de NODE_DEFS
   ============================================================
   compact: uma linha por tipo (vai no system prompt do agente);
   describeNodeType: detalhes de um tipo (tool describe_node_type).
   ============================================================ */

import { app } from "./bridge.js";

/* widgets preenchidos só pelo usuário (arquivos, pasta do Coletar) */
export const USER_ONLY_WIDGETS = new Set(["file", "textfile", "collector"]);

/* opções que dependem da Biblioteca, do servidor local ou do arquivo carregado */
function dynamicHint(fn) {
  switch (fn?.name) {
    case "outputFormatOptions": return "livre|json-objeto|json-array|lista-linhas|csv|markdown|xml|tpl:<id de template de saída>";
    case "outputSchemaOptions":
      return `""(nenhum)|sch:<id de schema salvo>|${Object.keys(app.BUILTIN_SCHEMAS).map(k => "builtin:" + k).join("|")}|custom`;
    case "localVoiceOptions": return "<nome de uma voz salva no servidor local>";
    case "claudeEffortOptions": return '""(padrão)|low|medium|high|xhigh|max (o que a CLI local aceitar)';
    case "imageSizeOptions": return "tamanhos do model escolhido (auto|1024x1024|2048x1152|3840x2160…); nos modelos novos vale qualquer LARGURAxALTURA";
    case "imageQualityOptions": return "qualidades aceitas pelo model escolhido (ex.: auto|low|medium|high)";
    case "voiceTargetOptions": return "voice:<nome da voz>|speaker:<speaker>";
    case "jsonListOptions":
    case "jsonFieldOptions": return "<depende do arquivo carregado>";
    default: return null;
  }
}

/* opções de um select/multicheck como [{value, label}] (avaliando optionsFn com os params dados) */
export function optionList(p, params = {}) {
  let raw = p.options || [];
  if (typeof p.optionsFn === "function") {
    try { raw = p.optionsFn(params) || []; } catch { raw = []; }
  }
  return raw.map(o => (typeof o === "string" ? { value: o, label: o } : o)).filter(o => o && o.value !== undefined);
}

/* condição de visibilidade legível: "p => p.mode === 'x'" → "mode === 'x'" */
export function visibleWhen(p) {
  if (typeof p.showIf !== "function") return null;
  return p.showIf.toString()
    .replace(/^\s*(?:function\s*)?\(?\s*(\w+)\s*\)?\s*=>\s*/, "")
    .replace(/\b(?:p|params)\./g, "")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

export function paramLabel(p, params = {}) {
  if (typeof p.labelFn === "function") {
    try { return p.labelFn(params); } catch { /* usa o label fixo */ }
  }
  return p.label || p.key;
}

function defaultsOf(type) {
  const params = {};
  for (const p of app.NODE_DEFS[type].params) params[p.key] = p.default ?? "";
  return params;
}

/* resumo de um param na notação compacta: model=sel(a*|b) temperature=num[0..2]=0.8 */
function compactParam(p, defaults) {
  const cond = visibleWhen(p) ? ` (se ${visibleWhen(p)})` : "";
  if (USER_ONLY_WIDGETS.has(p.widget)) return `${p.key}=arquivo(só o usuário)`;
  if (p.widget === "select" || p.widget === "multicheck") {
    const hint = dynamicHint(p.optionsFn);
    // selects de modelo: só a lista curada (baseOptions); os modelos vindos das APIs aparecem no describe_node_type
    const base = p.baseOptions ? { options: p.baseOptions } : p;
    const fromApi = p.baseOptions ? optionList(p).length - p.baseOptions.length : 0;
    const opts = hint ?? optionList(base, defaults).map(o => (o.value === "" ? '""' : o.value) + (o.value === p.default ? "*" : "")).join("|")
      + (fromApi > 0 ? `|+${fromApi} da API (describe_node_type)` : "");
    return `${p.key}=${p.widget === "multicheck" ? "lista" : "sel"}(${opts})${cond}`;
  }
  if (p.widget === "number") {
    const range = p.min !== undefined || p.max !== undefined ? `[${p.min ?? ""}..${p.max ?? ""}]` : "";
    return `${p.key}=num${range}=${p.default ?? 0}${cond}`;
  }
  if (p.widget === "checkbox") return `${p.key}=bool=${Boolean(p.default)}${cond}`;
  const def = typeof p.default === "string" && p.default && p.default.length <= 40 ? `="${p.default}"` : "";
  return `${p.key}=txt${def}${cond}`;
}

function portList(ports) {
  if (!ports?.length) return "—";
  return ports.map(pt => `${pt.key}:${pt.dtype}${pt.multi ? "(multi)" : ""}${pt.list ? "(lista)" : ""}`).join(", ");
}

/* uma linha por tipo de node — ~2 mil tokens para todos */
export function compactCatalog() {
  return Object.entries(app.NODE_DEFS).map(([type, def]) => {
    const defaults = defaultsOf(type);
    const params = def.params.map(p => compactParam(p, defaults)).join(" ");
    return `- ${type} “${def.title}” [${def.category}${def.local ? ", LOCAL" : ""}] in: ${portList(def.inputs)} | out: ${portList(def.outputs)}` +
      (params ? ` | ${params}` : "");
  }).join("\n");
}

export function nodeTypes() {
  return Object.keys(app.NODE_DEFS);
}

/* detalhes de um tipo, para a tool describe_node_type */
export function describeNodeType(type) {
  const def = app.NODE_DEFS[type];
  if (!def) return null;
  const defaults = defaultsOf(type);
  const lines = [
    `${type} — ${def.title} (${def.category})${def.local ? " · roda no servidor local" : ""}`,
    String(def.help || def.desc || "").trim(),
    "Entradas:",
    ...(def.inputs.length ? def.inputs.map(pt => `- ${pt.key} (${pt.label}): ${pt.dtype}` +
      `${pt.multi ? " · aceita várias conexões" : ""}${pt.list ? " · recebe a lista inteira (não roda por item)" : ""}`) : ["- nenhuma"]),
    "Saídas:",
    ...(def.outputs.length ? def.outputs.map(pt => `- ${pt.key} (${pt.label}): ${pt.dtype}`) : ["- nenhuma"]),
    "Params:",
  ];
  for (const p of def.params) {
    const parts = [`- ${p.key} (${paramLabel(p, defaults)}) — ${p.widget || "text"}`];
    if (USER_ONLY_WIDGETS.has(p.widget)) parts.push("preenchido só pelo usuário (arquivo/pasta)");
    else if (p.widget === "select" || p.widget === "multicheck") {
      const hint = dynamicHint(p.optionsFn);
      const opts = optionList(p, defaults);
      parts.push("opções: " + (opts.length
        ? opts.map(o => `${o.value === "" ? '""' : o.value}${o.label !== o.value ? ` (${o.label})` : ""}`).join(", ")
        : hint || "—"));
      if (hint) parts.push(`formato: ${hint}`);
    }
    if (p.min !== undefined || p.max !== undefined) parts.push(`faixa ${p.min ?? "−∞"}..${p.max ?? "∞"}`);
    if (p.default !== undefined && p.default !== "" && !USER_ONLY_WIDGETS.has(p.widget)) parts.push(`padrão ${JSON.stringify(p.default)}`);
    if (visibleWhen(p)) parts.push(`visível quando ${visibleWhen(p)}`);
    lines.push(parts.join(" · "));
  }
  return lines.filter(Boolean).join("\n");
}
