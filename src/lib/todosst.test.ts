import { describe, expect, test } from "bun:test";
import { compileWithFunction, evaluate, type LogEntry } from "./runtime";
import {
  buildBackup,
  buildSnapshot,
  dateToDay,
  dayToDate,
  openBackup,
  planImport,
  rruleFromTask,
  sameRule,
  scheduleFromRrule,
  type Snapshot,
  type TodosstNode,
} from "./todosst";

const NOW = new Date(2026, 10, 19, 9, 0).getTime(); // Thu 2026-11-19 09:00 local

const node = (title: string, parentId: string | null, order: number, metadata: TodosstNode["metadata"] = {}, isCompleted = false): TodosstNode => ({
  v: 2,
  title,
  isCompleted,
  parentId,
  order,
  metadata,
});

function program(files: Record<string, string>, log: LogEntry[] = [], days = ["2026-11-19"]) {
  return evaluate(files, log, { now: NOW, days, compile: compileWithFunction });
}

const SNAP: Snapshot = {
  v: 1,
  todos: [
    { id: "a", node: node("buy milk", null, 0, { dueAt: new Date(2026, 10, 20).getTime(), dueTimeMin: 17 * 60 + 30, description: "2%" }) },
    { id: "b", node: node("health", null, 1) },
    { id: "c", node: node("stretch", "b", 0, { recur: "FREQ=DAILY" }) },
    { id: "d", node: node("gym", "b", 1, { recur: "FREQ=WEEKLY;BYDAY=TH,MO" }) },
    { id: "e", node: node("read", "b", 2, { recur: "FREQ=DAILY", mode: "time", threshold: 30 }) },
    { id: "f", node: node("old thing", null, 2, {}, true) },
    { id: "g", node: node("no sugar", "b", 3, { recur: "FREQ=DAILY", neg: true }) },
    { id: "h", node: node("open todosst", null, 3, { recur: "FREQ=DAILY", habit: true }) },
    { id: "i", node: node("work", null, 4) },
    { id: "j", node: node("outreach", "i", 0) },
    { id: "k", node: node("email", "j", 0) },
    { id: "l", node: node("email", "i", 1) },
    { id: "m", node: node("water plants", "b", 4, { recur: "FREQ=DAILY;INTERVAL=3" }) },
    { id: "n", node: node("review", "i", 2, { recur: "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR" }) },
  ],
  history: [
    { todoId: "c", counts: { [dateToDay("2026-11-17")]: 1, [dateToDay("2026-11-18")]: 1 } },
    { todoId: "e", counts: { [dateToDay("2026-11-18")]: 45 } },
    { todoId: "m", counts: { [dateToDay("2026-11-16")]: 1 } },
  ],
};

describe("days", () => {
  test("day index round trip", () => {
    expect(dayToDate(dateToDay("2026-11-19"))).toBe("2026-11-19");
    expect(dateToDay("1970-01-02")).toBe(1);
  });
});

describe("schedules", () => {
  test("common rules get readable names", () => {
    expect(scheduleFromRrule("FREQ=DAILY", "2026-11-19")).toEqual({ repeat: "daily" });
    expect(scheduleFromRrule("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "2026-11-19")).toEqual({ repeat: "weekdays" });
    expect(scheduleFromRrule("FREQ=WEEKLY;BYDAY=TH,MO", "2026-11-19")).toEqual({ repeat: "mon,thu" });
    expect(scheduleFromRrule("FREQ=MONTHLY;BYMONTHDAY=15", "2026-11-19")).toEqual({ repeat: "monthly 15" });
    expect(scheduleFromRrule("FREQ=YEARLY", "2026-11-19")).toEqual({ repeat: "yearly" });
    expect(scheduleFromRrule("FREQ=DAILY;INTERVAL=3", "2026-11-16")).toEqual({ repeat: "every 3 days", start: "2026-11-16" });
  });

  test("DTSTART wins over the inferred anchor", () => {
    expect(scheduleFromRrule("DTSTART:20261101T000000Z\nRRULE:FREQ=DAILY;INTERVAL=2", "2026-11-16")).toEqual({
      repeat: "every 2 days",
      start: "2026-11-01",
    });
  });

  test("other rules stay RRULEs and run in the runtime", () => {
    const s = scheduleFromRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR", "2026-11-13");
    expect(s).toEqual({ repeat: "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR", start: "2026-11-13" });
    const days = ["2026-11-13", "2026-11-20", "2026-11-27"];
    const ev = program({ "a.js": `task("Review", ${JSON.stringify(s)});` }, [], days);
    expect(ev.errors).toEqual([]);
    expect(ev.days.map((d) => d.items.length)).toEqual([1, 0, 1]);
  });

  test("unsupported parts fall back to frequency and interval", () => {
    const s = scheduleFromRrule("FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU,WE,TH,FR", "2026-11-19");
    expect(s.repeat).toBe("FREQ=MONTHLY");
    expect(s.approximate).toContain("BYSETPOS");
  });

  test("agent schedules go back as the same todosst rules", () => {
    const ev = program({
      "a.js": `
        task("A", { repeat: "daily" });
        task("B", { repeat: "mon,thu" });
        task("C", { repeat: "every 3 days", start: "2026-11-16" });
        task("D", { repeat: (d) => d.day === 1 });
        task("E");
        task("F", { repeat: "FREQ=MONTHLY;BYDAY=-1FR" });`,
    });
    const r = Object.fromEntries(ev.tasks.map((t) => [t.title, rruleFromTask(t)]));
    expect(r).toEqual({
      A: "FREQ=DAILY",
      B: "FREQ=WEEKLY;BYDAY=MO,TH",
      C: "DTSTART:20261116T000000Z\nFREQ=DAILY;INTERVAL=3",
      D: "FREQ=DAILY",
      E: null,
      F: "FREQ=MONTHLY;BYDAY=-1FR",
    });
    expect(sameRule(r.B!, "RRULE:FREQ=WEEKLY;BYDAY=MO,TH")).toBe(true);
    expect(sameRule(r.C!, "FREQ=DAILY;INTERVAL=3")).toBe(true);
    expect(sameRule(r.C!, "FREQ=DAILY;INTERVAL=2")).toBe(false);
  });
});

describe("runtime RRULE repeats", () => {
  const items = (repeat: string, days: string[], extra = "") =>
    program({ "a.js": `task("X", { repeat: ${JSON.stringify(repeat)}${extra} });` }, [], days).days.map((d) => d.items.length);

  test("last friday of the month", () => {
    expect(items("FREQ=MONTHLY;BYDAY=-1FR", ["2026-11-20", "2026-11-27"])).toEqual([0, 1]);
  });

  test("first monday", () => {
    expect(items("FREQ=MONTHLY;BYDAY=1MO", ["2026-11-02", "2026-11-09"])).toEqual([1, 0]);
  });

  test("COUNT stops after n occurrences", () => {
    expect(items("FREQ=DAILY;COUNT=2", ["2026-11-19", "2026-11-20", "2026-11-21"], `, start: "2026-11-19"`)).toEqual([1, 1, 0]);
  });

  test("UNTIL", () => {
    expect(items("FREQ=DAILY;UNTIL=20261120T235959Z", ["2026-11-20", "2026-11-21"])).toEqual([1, 0]);
  });

  test("plain YEARLY is a window over the whole year", () => {
    const ev = program({ "a.js": `task("Taxes", { repeat: "FREQ=YEARLY" });` });
    expect(ev.days[0].items[0].period).toBe("2026");
  });

  test("unsupported parts are errors", () => {
    const ev = program({ "a.js": `task("X", { repeat: "FREQ=HOURLY" });` });
    expect(ev.errors[0].message).toContain("FREQ");
  });
});

describe("todosst -> agent", () => {
  const plan = planImport(SNAP, { files: { "today.js": "", "todosst/gone.js": "" }, existing: [], now: NOW });
  const files = Object.fromEntries(plan.changes.filter((c) => c.source !== null).map((c) => [c.path, c.source as string]));

  test("folders become files, skipped kinds are counted", () => {
    expect(Object.keys(files).sort()).toEqual(["todosst/health.js", "todosst/inbox.js", "todosst/work.js"]);
    expect(plan.changes.find((c) => c.path === "todosst/gone.js")?.source).toBeNull();
    expect(plan.skipped).toEqual({ completed: 1, avoid: 1, habit: 1 });
    expect(plan.tasks).toBe(8);
  });

  test("the generated program runs without errors and keeps the details", () => {
    const ev = program(files);
    expect(ev.errors).toEqual([]);
    const t = Object.fromEntries(ev.tasks.map((x) => [x.id, x]));
    expect(t["buy-milk"]).toMatchObject({ date: "2026-11-20", until: "17:30", notes: "2%", per: "once" });
    expect(t["stretch"]).toMatchObject({ group: "health", per: "day", rrule: "FREQ=DAILY" });
    expect(t["read"]).toMatchObject({ goal: 30, unit: "min" });
    expect(t["gym"].rrule).toBe("FREQ=WEEKLY;BYDAY=MO,TH");
    expect(t["email"].group).toBe("work / outreach");
    expect(t["work-email"].group).toBe("work");
    expect(t["water-plants"].start).toBe("2026-11-16");
  });

  test("history becomes log totals", () => {
    expect(plan.log.filter((l) => l.task === "stretch").map((l) => l.period).sort()).toEqual(["2026-11-17", "2026-11-18"]);
    expect(plan.log.find((l) => l.task === "read")).toMatchObject({ period: "2026-11-18", amount: 45 });
  });

  test("re-importing the same snapshot changes nothing", () => {
    const again = planImport(SNAP, { files: { ...files }, existing: program(files).tasks, now: NOW });
    expect(again.changes).toEqual([]);
  });

  test("a task the agent moved out of todosst/ is kept, its history still imported", () => {
    const mine = { "routines.js": `task("Stretch", { repeat: "daily", from: "07:00" });` };
    const again = planImport(SNAP, { files: { ...files, ...mine }, existing: program({ ...files, ...mine }).tasks.filter((t) => t.file === "routines.js"), now: NOW });
    expect(again.kept).toBe(1);
    const next = { ...mine, ...Object.fromEntries(again.changes.filter((c) => c.source).map((c) => [c.path, c.source as string])) };
    expect(program(next).errors).toEqual([]);
    expect(again.log.some((l) => l.task === "stretch")).toBe(true);
  });
});

describe("agent -> todosst", () => {
  test("tasks, folders, completions and schedules", () => {
    const files = {
      "a.js": `
        task("Stretch", { repeat: "daily", group: "health" });
        task("Email", { group: "work / outreach", date: "2026-11-20", until: "09:30", notes: "be brief" });
        task("Buy milk");
        task("Read", { repeat: "daily", goal: 30, unit: "min" });`,
    };
    const log: LogEntry[] = [
      { task: "stretch", period: "2026-11-18", amount: 1, at: new Date(2026, 10, 18, 8).getTime() },
      { task: "buy-milk", period: "once", amount: 1, at: new Date(2026, 10, 19, 8).getTime() },
      { task: "read", period: "2026-11-18", amount: 20, at: 1 },
      { task: "read", period: "2026-11-18", amount: -5, at: 2 },
    ];
    const snap = buildSnapshot(program(files, log).tasks, log);
    const byTitle = Object.fromEntries(snap.todos.map((t) => [t.node.title, t]));
    expect(byTitle["outreach"].node.parentId).toBe(byTitle["work"].id);
    expect(byTitle["Email"].node.parentId).toBe(byTitle["outreach"].id);
    expect(byTitle["Email"].node.metadata).toMatchObject({ dueTimeMin: 570, description: "be brief" });
    expect(new Date(byTitle["Email"].node.metadata.dueAt!).getDate()).toBe(20);
    expect(byTitle["Buy milk"].node.isCompleted).toBe(true);
    expect(byTitle["Read"].node.metadata).toMatchObject({ mode: "time", threshold: 30, recur: "FREQ=DAILY" });
    const hist = Object.fromEntries(snap.history.map((h) => [h.todoId, h.counts]));
    expect(hist[byTitle["Stretch"].id]).toEqual({ [dateToDay("2026-11-18")]: 1 });
    expect(hist[byTitle["Read"].id]).toEqual({ [dateToDay("2026-11-18")]: 15 });
  });

  test("round trip: todosst -> agent -> todosst keeps paths, rules and history", () => {
    const plan = planImport(SNAP, { files: {}, existing: [], now: NOW });
    const files = Object.fromEntries(plan.changes.map((c) => [c.path, c.source as string]));
    const log = plan.log.map((l) => ({ ...l }));
    const back = buildSnapshot(program(files, log).tasks, log);
    const pathOf = (snap: Snapshot, id: string): string => {
      const t = snap.todos.find((x) => x.id === id)!;
      return t.node.parentId ? `${pathOf(snap, t.node.parentId)}/${t.node.title}` : t.node.title;
    };
    const paths = back.todos.map((t) => pathOf(back, t.id)).sort();
    expect(paths).toContain("health/stretch");
    expect(paths).toContain("work/outreach/email");
    expect(paths).toContain("work/email");
    const stretch = back.todos.find((t) => t.node.title === "stretch")!;
    expect(back.history.find((h) => h.todoId === stretch.id)?.counts).toEqual(SNAP.history[0].counts);
    const review = back.todos.find((t) => t.node.title === "review")!;
    expect(sameRule(review.node.metadata.recur!, "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR")).toBe(true);
  });
});

describe("backup file", () => {
  test("encrypts and opens with the passphrase", async () => {
    const file = await buildBackup(SNAP, "correct horse");
    expect(JSON.parse(file).format).toBe("todosst-export");
    expect((await openBackup(file, "correct horse")).todos.length).toBe(SNAP.todos.length);
    await expect(openBackup(file, "wrong pass")).rejects.toThrow("Wrong passphrase");
  });
});
