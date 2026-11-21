import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUserId } from "./userScope";

// Direct two-way sync against a todosst Convex deployment.
//
// Users sign in once with their todosst username + password. We immediately
// exchange those credentials with todosst's `auth:signIn` action for a JWT +
// refresh token and discard the password. Subsequent syncs refresh the JWT
// automatically and call todosst's `todos:*` and `history:*` functions over
// Convex's HTTP API.

export const DEFAULT_TODOSST_URL = "https://kindly-mastiff-446.convex.cloud";

const COUNT_MAX = 9999;
const COUNT_TOKEN_RE = /^d(\d{3,7}):(\d{1,5})$/;
const REQUEST_TIMEOUT_MS = 30_000;

export function normalizeTodosstUrl(raw?: string): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_TODOSST_URL;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new ConvexError("Invalid todosst server URL.");
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "todosst.vercel.app" || host === "www.todosst.vercel.app") {
    return DEFAULT_TODOSST_URL;
  }
  if (parsed.protocol === "https:" && /^[a-z0-9-]+\.convex\.cloud$/.test(host)) {
    return `https://${host}`;
  }
  if (parsed.protocol === "http:" && (host === "127.0.0.1" || host === "localhost") && parsed.port) {
    return `http://${host}:${parsed.port}`;
  }
  throw new ConvexError("Server URL must be a Convex deployment (https://….convex.cloud) or todosst.vercel.app.");
}

// ---------- compact history codec (matches todosst/src/lib/recur.ts) ----------

function decodeHistoryPayload(json: string): { todoId: string; counts: Record<string, number> } | null {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    if (!o || typeof o !== "object" || o.v !== 1 || typeof o.todoId !== "string" || !o.todoId) return null;
    const counts: Record<string, number> = {};
    if (typeof o.c === "string" && o.c) {
      for (const token of o.c.split(";")) {
        const m = COUNT_TOKEN_RE.exec(token.trim());
        if (!m) continue;
        const day = Number(m[1]);
        const count = Math.min(Number(m[2]), COUNT_MAX);
        if (count > 0) counts[String(day)] = count;
      }
    }
    return { todoId: o.todoId, counts };
  } catch {
    return null;
  }
}

function encodeHistoryPayload(todoId: string, counts: Record<string, number>): string {
  const seen = new Map<number, number>();
  for (const [k, v] of Object.entries(counts)) {
    const day = Number(k);
    const count = Number(v);
    if (!Number.isFinite(day) || !Number.isFinite(count)) continue;
    const n = Math.min(Math.floor(count), COUNT_MAX);
    if (n <= 0) continue;
    const d = Math.floor(day);
    seen.set(d, Math.max(seen.get(d) ?? 0, n));
  }
  const c = Array.from(seen.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([d, n]) => `d${d}:${n}`)
    .join(";");
  return JSON.stringify({ v: 1, todoId, c });
}

// ---------- Convex HTTP wire helpers ----------

class RemoteAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteAuthError";
  }
}

function isAuthErrorMessage(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes("not authenticated") || lower.includes("unauthorized") || lower.includes("invalid token") || lower.includes("jwt");
}

function jwtExpired(token: string, skewMs = 60_000): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return true;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    if (typeof payload.exp !== "number") return true;
    return Date.now() + skewMs >= payload.exp * 1000;
  } catch {
    return true;
  }
}

async function convexCall<T>(
  url: string,
  kind: "query" | "mutation" | "action",
  path: string,
  args: Record<string, unknown>,
  token?: string,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${url}/api/${kind}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path, args, format: "json" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new ConvexError(`Could not reach todosst (${detail}).`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new RemoteAuthError(`HTTP ${res.status}`);
  }
  if (!res.ok && res.status !== 560) {
    const text = await res.text().catch(() => "");
    if (isAuthErrorMessage(text)) throw new RemoteAuthError(text);
    throw new ConvexError(`todosst request failed (${res.status}).`);
  }
  const body = (await res.json()) as { status?: string; value?: T; errorMessage?: string };
  if (body.status === "success") return body.value as T;
  const msg = body.errorMessage ?? "todosst returned an error.";
  if (isAuthErrorMessage(msg)) throw new RemoteAuthError(msg);
  throw new ConvexError(msg);
}

type AuthTokens = { token: string; refreshToken: string };

async function refreshRemoteSession(url: string, refreshToken: string): Promise<AuthTokens | null> {
  const res = await convexCall<{ tokens?: AuthTokens | null }>(url, "action", "auth:signIn", { refreshToken });
  const t = res?.tokens;
  if (!t || typeof t.token !== "string" || typeof t.refreshToken !== "string") return null;
  return t;
}

// ---------- internal DB helpers (tokens never leave the server) ----------

export const getConnection = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("todosstConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
  },
});

export const saveConnection = internalMutation({
  args: {
    userId: v.string(),
    url: v.string(),
    username: v.string(),
    token: v.string(),
    refreshToken: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("todosstConnections")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        url: args.url,
        username: args.username,
        token: args.token,
        refreshToken: args.refreshToken,
        connectedAt: now,
      });
    } else {
      await ctx.db.insert("todosstConnections", { ...args, connectedAt: now });
    }
  },
});

export const updateTokens = internalMutation({
  args: { userId: v.string(), token: v.string(), refreshToken: v.string() },
  handler: async (ctx, { userId, token, refreshToken }) => {
    const row = await ctx.db
      .query("todosstConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row) await ctx.db.patch(row._id, { token, refreshToken });
  },
});

export const deleteConnection = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const row = await ctx.db
      .query("todosstConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row) await ctx.db.delete(row._id);
  },
});

export const markSynced = internalMutation({
  args: { userId: v.string(), summary: v.string() },
  handler: async (ctx, { userId, summary }) => {
    const row = await ctx.db
      .query("todosstConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row) await ctx.db.patch(row._id, { lastSyncedAt: Date.now(), lastSummary: summary.slice(0, 500) });
  },
});

async function withRemoteAuth<T>(
  ctx: ActionCtx,
  userId: string,
  fn: (url: string, token: string) => Promise<T>,
): Promise<T> {
  const conn = await ctx.runQuery(internal.todosstSync.getConnection, { userId });
  if (!conn) throw new ConvexError("Not connected to todosst.");

  let token = conn.token;
  let refreshed = false;
  if (jwtExpired(token)) {
    const fresh = await refreshRemoteSession(conn.url, conn.refreshToken);
    if (!fresh) {
      throw new ConvexError("Your todosst session expired. Please reconnect with your username and password.");
    }
    await ctx.runMutation(internal.todosstSync.updateTokens, {
      userId,
      token: fresh.token,
      refreshToken: fresh.refreshToken,
    });
    token = fresh.token;
    refreshed = true;
  }

  try {
    return await fn(conn.url, token);
  } catch (e) {
    if (!(e instanceof RemoteAuthError) || refreshed) {
      if (e instanceof RemoteAuthError) {
        throw new ConvexError("Your todosst session expired. Please reconnect with your username and password.");
      }
      throw e;
    }
    const fresh = await refreshRemoteSession(conn.url, conn.refreshToken);
    if (!fresh) {
      throw new ConvexError("Your todosst session expired. Please reconnect with your username and password.");
    }
    await ctx.runMutation(internal.todosstSync.updateTokens, {
      userId,
      token: fresh.token,
      refreshToken: fresh.refreshToken,
    });
    try {
      return await fn(conn.url, fresh.token);
    } catch (e2) {
      if (e2 instanceof RemoteAuthError) {
        throw new ConvexError("Your todosst session expired. Please reconnect with your username and password.");
      }
      throw e2;
    }
  }
}

// ---------- public API ----------

export const status = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const s = identity.subject;
    const i = s.indexOf("|");
    const userId = i >= 0 ? s.slice(0, i) : s;
    const row = await ctx.db
      .query("todosstConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!row) return null;
    return {
      username: row.username,
      url: row.url,
      connectedAt: row.connectedAt,
      lastSyncedAt: row.lastSyncedAt ?? null,
      lastSummary: row.lastSummary ?? null,
    };
  },
});

export const connect = action({
  args: {
    username: v.string(),
    password: v.string(),
    url: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ username: string; url: string }> => {
    const userId = await requireUserId(ctx);
    const username = args.username.trim().toLowerCase();
    if (!username || !args.password) {
      throw new ConvexError("Enter your todosst username and password.");
    }
    const url = normalizeTodosstUrl(args.url);
    const res = await convexCall<{ tokens?: AuthTokens | null }>(url, "action", "auth:signIn", {
      provider: "password",
      params: { flow: "signIn", username, password: args.password },
    });
    const tokens = res?.tokens;
    if (!tokens || typeof tokens.token !== "string" || typeof tokens.refreshToken !== "string") {
      throw new ConvexError("Wrong todosst username or password.");
    }
    await ctx.runMutation(internal.todosstSync.saveConnection, {
      userId,
      url,
      username,
      token: tokens.token,
      refreshToken: tokens.refreshToken,
    });
    return { username, url };
  },
});

export const disconnect = action({
  args: {},
  handler: async (ctx): Promise<void> => {
    const userId = await requireUserId(ctx);
    const conn = await ctx.runQuery(internal.todosstSync.getConnection, { userId });
    if (conn) {
      // Best-effort remote session sign-out; always remove local connection.
      try {
        await convexCall(conn.url, "action", "auth:signOut", {}, conn.token);
      } catch {
        // ignore if already expired
      }
      await ctx.runMutation(internal.todosstSync.deleteConnection, { userId });
    }
  },
});

type RawTodoRow = { _id: string; _creationTime: number; node?: string };
type RawHistoryRow = { _id: string; payload?: string };

export const pullRemote = action({
  args: {},
  handler: async (ctx): Promise<{
    todos: { id: string; createdAt: number; node: Record<string, unknown> }[];
    history: { id: string; todoId: string; counts: Record<string, number> }[];
  }> => {
    const userId = await requireUserId(ctx);
    return await withRemoteAuth(ctx, userId, async (url, token) => {
      const [rawTodos, rawHistory] = await Promise.all([
        convexCall<RawTodoRow[]>(url, "query", "todos:list", {}, token),
        convexCall<RawHistoryRow[]>(url, "query", "history:list", {}, token),
      ]);
      const todos: { id: string; createdAt: number; node: Record<string, unknown> }[] = [];
      for (const r of rawTodos ?? []) {
        if (!r.node) continue;
        try {
          const parsed = JSON.parse(r.node) as Record<string, unknown>;
          if (!parsed || typeof parsed !== "object" || typeof parsed.title !== "string") continue;
          if (!parsed.metadata || typeof parsed.metadata !== "object") parsed.metadata = {};
          todos.push({ id: r._id, createdAt: r._creationTime ?? 0, node: parsed });
        } catch {
          // skip malformed row
        }
      }
      const history: { id: string; todoId: string; counts: Record<string, number> }[] = [];
      for (const r of rawHistory ?? []) {
        if (!r.payload) continue;
        const decoded = decodeHistoryPayload(r.payload);
        if (decoded) history.push({ id: r._id, todoId: decoded.todoId, counts: decoded.counts });
      }
      return { todos, history };
    });
  },
});

export const applyRemote = action({
  args: {
    creates: v.array(
      v.object({
        clientId: v.string(),
        parentId: v.union(v.string(), v.null()),
        nodeJson: v.string(),
      }),
    ),
    updates: v.array(
      v.object({
        id: v.string(),
        nodeJson: v.string(),
      }),
    ),
    histories: v.array(
      v.object({
        historyId: v.optional(v.string()),
        todoId: v.string(),
        counts: v.record(v.string(), v.number()),
      }),
    ),
    summary: v.string(),
  },
  handler: async (ctx, args): Promise<{ created: number; updated: number; histories: number }> => {
    const userId = await requireUserId(ctx);
    if (args.creates.length > 2000 || args.updates.length > 2000 || args.histories.length > 2000) {
      throw new ConvexError("Too many changes in one sync batch.");
    }
    const result = await withRemoteAuth(ctx, userId, async (url, token) => {
      const idMap = new Map<string, string>();
      let created = 0;
      for (const item of args.creates) {
        const parsed = JSON.parse(item.nodeJson) as Record<string, unknown>;
        parsed.parentId = item.parentId ? (idMap.get(item.parentId) ?? item.parentId) : null;
        const newId = await convexCall<string>(url, "mutation", "todos:create", { node: JSON.stringify(parsed) }, token);
        idMap.set(item.clientId, newId);
        created++;
      }
      let updated = 0;
      for (const item of args.updates) {
        await convexCall(url, "mutation", "todos:update", { id: item.id, node: item.nodeJson }, token);
        updated++;
      }
      let histories = 0;
      for (const item of args.histories) {
        const todoId = idMap.get(item.todoId) ?? item.todoId;
        const payload = encodeHistoryPayload(todoId, item.counts);
        await convexCall(
          url,
          "mutation",
          "history:put",
          item.historyId ? { id: item.historyId, payload } : { payload },
          token,
        );
        histories++;
      }
      return { created, updated, histories };
    });
    await ctx.runMutation(internal.todosstSync.markSynced, { userId, summary: args.summary });
    return result;
  },
});

export const recordSync = mutation({
  args: { summary: v.string() },
  handler: async (ctx, { summary }) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db
      .query("todosstConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row) await ctx.db.patch(row._id, { lastSyncedAt: Date.now(), lastSummary: summary.slice(0, 500) });
  },
});
