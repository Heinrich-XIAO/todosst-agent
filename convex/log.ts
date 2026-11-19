import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUserId } from "./userScope";

const HORIZON = 400 * 86_400_000;

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const rows = await ctx.db
      .query("log")
      .withIndex("by_user_at", (q) => q.eq("userId", userId).gte("at", Date.now() - HORIZON))
      .collect();
    return rows.map((r) => ({ task: r.task, period: r.period, amount: r.amount, at: r.at }));
  },
});

export const add = mutation({
  args: { task: v.string(), period: v.string(), amount: v.number() },
  handler: async (ctx, { task, period, amount }) => {
    const userId = await requireUserId(ctx);
    if (task.length > 120 || period.length > 40 || !Number.isFinite(amount) || Math.abs(amount) > 100_000) {
      throw new ConvexError("bad log entry");
    }
    await ctx.db.insert("log", { userId, task, period, amount, at: Date.now() });
  },
});

// Brings in history from a todosst backup. Each entry is the total a task
// should have for a period; only the missing part is added, so importing the
// same backup twice never double counts.
export const importTotals = mutation({
  args: { entries: v.array(v.object({ task: v.string(), period: v.string(), amount: v.number(), at: v.number() })) },
  handler: async (ctx, { entries }) => {
    const userId = await requireUserId(ctx);
    if (entries.length > 500) throw new ConvexError("too many entries in one batch");
    let added = 0;
    for (const { task, period, amount, at } of entries) {
      if (task.length > 120 || period.length > 40 || !Number.isFinite(amount) || amount <= 0 || amount > 100_000 || !Number.isFinite(at)) {
        throw new ConvexError("bad log entry");
      }
      const rows = await ctx.db
        .query("log")
        .withIndex("by_user_task_period", (q) => q.eq("userId", userId).eq("task", task).eq("period", period))
        .collect();
      const missing = amount - rows.reduce((sum, r) => sum + r.amount, 0);
      if (missing <= 0) continue;
      await ctx.db.insert("log", { userId, task, period, amount: missing, at: Math.min(at, Date.now()) });
      added++;
    }
    return added;
  },
});
