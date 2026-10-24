import { z } from "zod";
import type { WorkflowContext, WorkflowState } from "./workflow-engine.js";

export type LibraryMetadata = {
  owner_id?: string;
  visibility?: "personal" | "practice";
  revision?: number;
  archived?: boolean;
};

type LibraryItem = LibraryMetadata & {
  id: string;
  name?: string;
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
  shortcut?: string;
  text?: string;
};

const visibility = z.enum(["personal", "practice"]);
const templateFields = z.object({
  name: z.string().trim().min(1).max(200),
  subjective: z.string().max(10000),
  objective: z.string().max(10000),
  assessment: z.string().max(10000),
  plan: z.string().max(10000),
});
const phraseFields = z.object({
  shortcut: z.string().trim().regex(/^\.[a-z][a-z0-9_-]{1,30}$/),
  text: z.string().trim().min(1).max(3000),
});

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function scope(item: LibraryItem): "personal" | "practice" {
  // Older saved templates predate ownership and stay shared within their practice.
  return item.owner_id && item.visibility === "personal" ? "personal" : "practice";
}

function visible(item: LibraryItem, ctx: WorkflowContext): boolean {
  return scope(item) === "practice" || item.owner_id === ctx.user.id;
}

function editable(item: LibraryItem, ctx: WorkflowContext): boolean {
  return visible(item, ctx) &&
    (item.owner_id === ctx.user.id || Boolean(ctx.user.is_admin));
}

function view(item: LibraryItem, ctx: WorkflowContext) {
  return {
    ...item,
    visibility: scope(item),
    revision: item.revision ?? 1,
    archived: Boolean(item.archived),
    can_edit: editable(item, ctx),
  };
}

function validateShortcut(items: LibraryItem[], candidate: LibraryItem) {
  if (candidate.archived || !candidate.shortcut) return;
  const conflicting = items.some((other) =>
    other.id !== candidate.id &&
    !other.archived &&
    other.shortcut === candidate.shortcut &&
    (scope(candidate) === "practice" ||
      scope(other) === "practice" ||
      other.owner_id === candidate.owner_id),
  );
  if (conflicting) fail(409, "This shortcut already exists in the selected library");
}

export function templateLibraryRequest(
  state: WorkflowState,
  ctx: WorkflowContext,
  method: string,
  url: URL,
  body: unknown,
): unknown {
  if (ctx.user.role !== "clinician") fail(403, "Clinical access required");
  const [resource, id, extra] = url.pathname.split("/").filter(Boolean);
  if ((resource !== "templates" && resource !== "phrases") || extra)
    fail(404, "Template library route not found");
  const items = state[resource] as LibraryItem[];
  if (method === "GET" && !id) {
    const includeArchived = url.searchParams.get("include_archived") === "true";
    return items
      .filter((item) => visible(item, ctx) && (includeArchived || !item.archived))
      .map((item) => view(item, ctx));
  }
  if (method === "POST" && !id) {
    const schema = resource === "templates" ? templateFields : phraseFields;
    const input = schema.extend({ visibility: visibility.default("personal") })
      .strict().parse(body);
    const item: LibraryItem = {
      ...input,
      id: ctx.id(resource === "templates" ? "template" : "phrase"),
      owner_id: ctx.user.id,
      revision: 1,
      archived: false,
    };
    if (resource === "phrases") validateShortcut(items, item);
    items.push(item);
    ctx.audit(`Created ${resource === "templates" ? "note template" : "smart phrase"}`, item.id);
    return view(item, ctx);
  }
  if (method === "PATCH" && id) {
    const item = items.find((candidate) => candidate.id === id && visible(candidate, ctx));
    if (!item) fail(404, "Template library item not found");
    if (!editable(item, ctx)) fail(403, "Only the author or a practice administrator may change this shared item");
    const schema = resource === "templates" ? templateFields : phraseFields;
    const { revision, ...changes } = schema.partial().extend({
      visibility: visibility.optional(),
      archived: z.boolean().optional(),
      revision: z.number().int().min(1),
    }).strict().parse(body);
    if (!Object.keys(changes).length) fail(400, "Choose a change to save");
    if (revision !== (item.revision ?? 1))
      fail(409, "This library item changed. Reload it before saving your changes.");
    // A shared item's author remains its owner. An administrator cannot make
    // somebody else's shared item private, which would remove the author's access.
    if (changes.visibility === "personal" && item.owner_id !== ctx.user.id)
      fail(403, "Create a personal copy to keep this item in your own library");
    const candidate: LibraryItem = { ...item, ...changes, revision: revision + 1 };
    if (resource === "phrases") validateShortcut(items, candidate);
    const wasArchived = Boolean(item.archived);
    Object.assign(item, candidate);
    const action = changes.archived === true ? "Archived" :
      changes.archived === false && wasArchived ? "Restored" : "Updated";
    ctx.audit(`${action} ${resource === "templates" ? "note template" : "smart phrase"}`, item.id);
    return view(item, ctx);
  }
  fail(405, "This template library action is not supported");
}
