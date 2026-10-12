/* ============================================================
   library-ops.js — Biblioteca (prompts, prompts de agentes, templates,
   schemas e pastas) para as tools do assistente, sem modais
   ============================================================ */

import { app } from "./bridge.js";

export const KINDS = ["prompt", "agent", "template", "schema"];
const CONTENT_FIELD = { prompt: "text", agent: "text", template: "instruction", schema: "schema" };
const ID_PREFIX = { prompt: "p", agent: "a", template: "t", schema: "s" };
export const KIND_NOUN = { prompt: "prompt", agent: "prompt de agente", template: "template de saída", schema: "schema de saída" };

function newItemId(kind) {
  return ID_PREFIX[kind] + Date.now() + Math.random().toString(36).slice(2, 5);
}

/* valor que se escreve num node para usar o item */
export function usageOf(kind, item) {
  if (kind === "prompt" || kind === "agent") return `{{${item.name}}}`;
  if (kind === "template") return `outputFormat = "tpl:${item.id}"`;
  return `schema = "sch:${item.id}"`;
}

function checkKind(kind) {
  if (!KINDS.includes(kind)) throw new Error(`kind precisa ser um de: ${KINDS.join(", ")}.`);
}

function oneLine(s, max = 100) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/* lista (sem id) ou item completo (com id) */
export function readLibrary({ kind, query, id } = {}) {
  const kinds = kind ? [kind] : KINDS;
  kinds.forEach(checkKind);
  if (id) {
    for (const k of kinds) {
      const item = app.LIBRARY[k].get().find(x => x.id === id);
      if (item) {
        return [`${KIND_NOUN[k]} ${item.id} “${item.name}”${app.libraryFolder(item) ? ` · pasta ${app.libraryFolder(item)}` : ""}`,
          `uso: ${usageOf(k, item)}`, "conteúdo:", String(item[CONTENT_FIELD[k]] ?? "")].join("\n");
      }
    }
    const builtin = app.BUILTIN_SCHEMAS[String(id).replace(/^builtin:/, "")];
    if (builtin) return `schema embutido “${builtin.name}” · uso: schema = "builtin:${String(id).replace(/^builtin:/, "")}"\n${JSON.stringify(builtin.schema, null, 2)}`;
    return `ERRO: nenhum item com id “${id}”.`;
  }
  const q = String(query || "").toLowerCase();
  const lines = [];
  for (const k of kinds) {
    const items = app.LIBRARY[k].get().filter(x => !q || `${x.name} ${x[CONTENT_FIELD[k]]} ${app.libraryFolder(x)}`.toLowerCase().includes(q));
    lines.push(`${KIND_NOUN[k]}s (${items.length}):`);
    for (const x of items) {
      const folder = app.libraryFolder(x);
      const preview = k === "schema" ? schemaProps(x.schema) : oneLine(x[CONTENT_FIELD[k]]);
      lines.push(`- ${x.id} “${x.name}”${folder ? ` [${folder}]` : ""} · ${usageOf(k, x)} · ${preview}`);
    }
    const folders = app.libraryFolders(k);
    if (folders.length) lines.push(`  pastas: ${folders.join(", ")}`);
    if (k === "schema") {
      lines.push("  embutidos: " + Object.entries(app.BUILTIN_SCHEMAS).map(([key, b]) => `builtin:${key} “${b.name}”`).join(", "));
    }
  }
  return lines.join("\n");
}

function schemaProps(text) {
  try {
    const props = Object.keys(JSON.parse(text).properties || {});
    return props.length ? `propriedades: ${props.join(", ")}` : "sem propriedades";
  } catch { return "JSON inválido"; }
}

/* nodes do grafo aberto que usam um item (antes de renomear/excluir) */
export function referencesTo(kind, item) {
  const refs = [];
  for (const n of app.state.nodes) {
    for (const [key, v] of Object.entries(n.params || {})) {
      if (typeof v !== "string") continue;
      const hit = (kind === "prompt" || kind === "agent")
        ? new RegExp(`\\{\\{\\s*${item.name.replace(/[-]/g, "\\-")}\\s*\\}\\}`).test(v)
        : (kind === "template" ? v === "tpl:" + item.id : v === "sch:" + item.id);
      if (hit) refs.push(`${n.id}.${key}`);
    }
  }
  return refs;
}

/* cria (sem id) ou edita (com id) um item — { ok, error?, item, message, warnings } */
export function saveLibraryItem({ kind, name, content, folder, id }) {
  checkKind(kind);
  const cfg = app.LIBRARY[kind];
  const items = cfg.get();
  const existing = id ? items.find(x => x.id === id) : null;
  if (id && !existing) return { ok: false, error: `nenhum ${KIND_NOUN[kind]} com id “${id}”. Use read_library para ver os ids.` };
  const finalName = String(name ?? existing?.name ?? "").trim();
  if (!finalName) return { ok: false, error: "informe o nome." };
  let value = content ?? existing?.[CONTENT_FIELD[kind]];
  if (value == null || String(value).trim() === "") return { ok: false, error: "informe o conteúdo." };
  const warnings = [];
  if (kind === "prompt" || kind === "agent") {
    const err = app.validatePromptName(finalName, existing?.id ?? null);
    if (err) return { ok: false, error: err };
    value = String(value).trim();
  } else if (kind === "schema") {
    const v = app.validateSchemaText(typeof value === "string" ? value : JSON.stringify(value));
    if (!v.ok) return { ok: false, error: v.msg };
    value = JSON.stringify(v.schema, null, 2);
  } else {
    value = String(value).trim();
  }
  if (existing && existing.name !== finalName && (kind === "prompt" || kind === "agent")) {
    const refs = referencesTo(kind, existing);
    if (refs.length) warnings.push(`{{${existing.name}}} ainda é usado em ${refs.join(", ")} — atualize esses params para {{${finalName}}}.`);
  }
  const folderName = folder === undefined ? (existing ? app.libraryFolder(existing) : "") : app.normalizeFolderName(folder);
  const item = existing || { id: newItemId(kind) };
  item.name = finalName;
  item[CONTENT_FIELD[kind]] = value;
  app.setItemFolder(item, folderName);
  if (!existing) items.push(item);
  cfg.save(items);
  app.registerFolder(kind, folderName);
  app.afterLibraryChange(kind);
  return {
    ok: true,
    item,
    warnings,
    message: `${existing ? "Atualizado" : "Criado"} ${KIND_NOUN[kind]} ${item.id} “${item.name}”${folderName ? ` na pasta ${folderName}` : ""} · uso: ${usageOf(kind, item)}`,
  };
}

export function findLibraryItem(kind, id) {
  checkKind(kind);
  return app.LIBRARY[kind].get().find(x => x.id === id) || null;
}

/* pastas sem modal (a confirmação de exclusão fica na tool) */
export function manageFolder({ kind, action, name, new_name }) {
  checkKind(kind);
  const folders = app.libraryFolders(kind);
  const clean = app.normalizeFolderName(name);
  const exists = (n) => folders.some(f => f.toLowerCase() === n.toLowerCase());
  if (!clean) return { ok: false, error: "informe o nome da pasta." };
  if (action === "create") {
    if (exists(clean)) return { ok: false, error: `a pasta “${clean}” já existe.` };
    return { ok: true, message: `Pasta “${app.createLibraryFolderNamed(kind, clean)}” criada em ${KIND_NOUN[kind]}s.` };
  }
  if (!folders.includes(clean)) return { ok: false, error: `a pasta “${clean}” não existe. Pastas: ${folders.join(", ") || "nenhuma"}.` };
  if (action === "rename") {
    // nome simples mantém a pasta no mesmo lugar; com / vale o caminho inteiro
    const target = app.folderTargetPath(clean, new_name || "");
    if (!target) return { ok: false, error: "informe new_name." };
    if (app.inFolderTree(clean, target) && target !== clean) {
      return { ok: false, error: `“${target}” está dentro de “${clean}” — uma pasta não pode virar subpasta dela mesma.` };
    }
    if (target.toLowerCase() !== clean.toLowerCase() && exists(target)) return { ok: false, error: `a pasta “${target}” já existe.` };
    return { ok: true, message: `Pasta renomeada para “${app.renameLibraryFolderTo(kind, clean, new_name || "")}” (subpastas e itens vão junto).` };
  }
  if (action === "delete") {
    const moved = app.LIBRARY[kind].get().filter(x => app.inFolderTree(clean, app.libraryFolder(x))).length;
    const subs = folders.filter(f => f !== clean && app.inFolderTree(clean, f)).length;
    app.deleteLibraryFolder(kind, clean);
    return {
      ok: true,
      message: `Pasta “${clean}” excluída${subs ? ` com ${subs} subpasta(s)` : ""}` +
        `${moved ? ` — ${moved} item(ns) foram para “Sem pasta”` : ""}.`,
    };
  }
  return { ok: false, error: "action precisa ser create, rename ou delete." };
}
