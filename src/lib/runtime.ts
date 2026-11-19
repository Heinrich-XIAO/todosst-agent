// The program runtime. A user's todo system is a set of JavaScript files.
// Each file runs top to bottom and registers definitions through a few
// globals (task, note). evaluate() then answers "what does day D look like at
// time T" from those definitions plus the completion log. Pure: no DOM, no
// network. The browser runs it inside a Web Worker.

import { formatRrule, isRruleSpec, parseRrule, ruleAnchored, ruleOccurs, rulePer } from "./rrule";

export type Files = Record<string, string>;

// One append-only completion record. amount is negative for an undo.
export type LogEntry = { task: string; period: string; amount: number; at: number };

export type Per = "day" | "week" | "month" | "year" | "once";

export type ItemState = "now" | "later" | "late" | "waiting" | "done";

export type Item = {
  id: string;
  title: string;
  file: string;
  per: Per;
  period: string;
  goal: number;
  unit: string;
  progress: number;
  state: ItemState;
  from?: string;
  until?: string;
  group?: string;
  notes?: string;
  waitingFor?: string;
  date?: string;
};

export type Note = { text: string; file: string };

export type ProgramError = { file: string; message: string; line?: number };

export type DayView = { date: string; items: Item[]; notes: Note[] };

export type Evaluation = { days: DayView[]; errors: ProgramError[]; tasks: TaskInfo[] };

export type TaskInfo = {
  id: string;
  title: string;
  file: string;
  per: Per;
  repeat: string;
  goal: number;
  unit: string;
  // The schedule as an RRULE body ("FREQ=WEEKLY;BYDAY=MO"), with its start
  // date when the phase matters; null for one-off tasks, "custom" for
  // function repeats. Used to export the program to todosst.
  rrule: string | null;
  start?: string;
  date?: string;
  from?: string;
  until?: string;
  group?: string;
  notes?: string;
};

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type DayInfo = {
  date: string;
  weekday: Weekday;
  day: number;
  month: number;
  year: number;
  index: number;
};

export type Ctx = DayInfo & {
  now: Date;
  done: (task: string) => boolean;
  count: (task: string) => number;
  lastDone: (task: string) => Date | null;
  daysSince: (task: string) => number | null;
  streak: (task: string) => number;
};

type RepeatFn = (day: DayInfo) => boolean;

type TaskOptions = {
  id?: string;
  repeat?: string | RepeatFn;
  date?: string;
  start?: string;
  per?: Per;
  from?: string;
  until?: string;
  goal?: number;
  unit?: string;
  after?: string;
  when?: (ctx: Ctx) => boolean;
  group?: string;
  notes?: string;
};

type TaskDef = {
  id: string;
  title: string;
  file: string;
  per: Per;
  repeatLabel: string;
  rrule: string | null;
  start?: string;
  occurs: RepeatFn;
  date?: string;
  from?: string;
  until?: string;
  goal: number;
  unit: string;
  after?: string;
  when?: (ctx: Ctx) => boolean;
  group?: string;
  notes?: string;
};

type NoteDef = { text: string | ((ctx: Ctx) => string | null | false); file: string; when?: (ctx: Ctx) => boolean };

export const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_ALIASES: Record<string, Weekday> = {
  sun: "sun", sunday: "sun", mon: "mon", monday: "mon", tue: "tue", tues: "tue", tuesday: "tue",
  wed: "wed", wednesday: "wed", thu: "thu", thur: "thu", thurs: "thu", thursday: "thu",
  fri: "fri", friday: "fri", sat: "sat", saturday: "sat",
};

export function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const pad = (n: number) => String(n).padStart(2, "0");

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad date "${s}", expected YYYY-MM-DD`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function addDays(date: string, n: number): string {
  const d = parseDate(date);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

// Days since 1970-01-01 in local calendar terms, so "every 3 days" counts
// calendar days regardless of DST.
function dayIndex(d: Date): number {
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

export function dayInfo(date: string): DayInfo {
  const d = parseDate(date);
  return {
    date,
    weekday: WEEKDAYS[d.getDay()],
    day: d.getDate(),
    month: d.getMonth() + 1,
    year: d.getFullYear(),
    index: dayIndex(d),
  };
}

export function periodKey(per: Per, date: string): string {
  if (per === "day") return date;
  if (per === "once") return "once";
  const d = parseDate(date);
  if (per === "year") return String(d.getFullYear());
  if (per === "month") return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `week-${dateKey(monday)}`;
}

function parseTime(s: string | undefined, field: string): string | undefined {
  if (s === undefined) return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`${field} must look like "08:30", got ${JSON.stringify(s)}`);
  return `${pad(Number(m[1]))}:${m[2]}`;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// rrule: the same schedule as an RRULE body, "custom" for functions, null
// for one-offs. anchor: the start date, when the schedule depends on one.
type Repeat = { per: Per; occurs: RepeatFn; label: string; rrule: string | null; anchor?: string };

const RFC: Record<Weekday, string> = { mon: "MO", tue: "TU", wed: "WE", thu: "TH", fri: "FR", sat: "SA", sun: "SU" };
const RFC_ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DEFAULT_ANCHOR = "2026-01-01";

function rruleRepeat(spec: string, start: string | undefined): Repeat {
  const rule = parseRrule(spec);
  if (start) {
    parseDate(start);
    rule.dtstart = start;
  }
  const anchorDate = rule.dtstart ?? DEFAULT_ANCHOR;
  const anchor = dayInfo(anchorDate);
  const per = rulePer(rule);
  let occurs: RepeatFn = (d) => ruleOccurs(rule, anchor, d);
  if (rule.count !== null) {
    // the first COUNT occurrences (by period), counted from the anchor
    let periods: Set<string> | null = null;
    const base = occurs;
    const limit = rule.count;
    occurs = (d) => {
      if (!periods) {
        const found = new Set<string>();
        let date = anchorDate;
        for (let i = 0; i < 366 * 30 && found.size < limit; i++, date = addDays(date, 1)) {
          if (base(dayInfo(date))) found.add(periodKey(per, date));
        }
        periods = found;
      }
      return base(d) && periods.has(periodKey(per, d.date));
    };
  }
  const body = formatRrule(rule);
  const anchored = ruleAnchored(rule) || rule.dtstart !== null;
  return { per, occurs, label: body, rrule: body, anchor: anchored ? anchorDate : undefined };
}

const always: RepeatFn = () => true;

// Turns a repeat spec into the days a task occurs on and the period its goal
// counts over. Unknown specs throw so the author sees the mistake.
export function parseRepeat(spec: string | RepeatFn | undefined, start: string | undefined): Repeat {
  if (typeof spec === "function") return { per: "day", occurs: spec, label: "custom", rrule: "custom" };
  if (spec === undefined) return { per: "once", occurs: always, label: "once", rrule: null };
  if (isRruleSpec(String(spec))) {
    try {
      return rruleRepeat(String(spec), start);
    } catch (err) {
      throw new Error(`repeat "${spec}": ${message(err)}`);
    }
  }
  const s = String(spec).toLowerCase().trim().replace(/\s+/g, " ");
  if (s === "daily" || s === "every day") return { per: "day", occurs: always, label: s, rrule: "FREQ=DAILY" };
  if (s === "weekdays") {
    return { per: "day", occurs: (d) => d.weekday !== "sat" && d.weekday !== "sun", label: s, rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" };
  }
  if (s === "weekends") return { per: "day", occurs: (d) => d.weekday === "sat" || d.weekday === "sun", label: s, rrule: "FREQ=WEEKLY;BYDAY=SA,SU" };
  if (s === "weekly" || s === "every week") return { per: "week", occurs: always, label: "weekly", rrule: "FREQ=WEEKLY" };
  if (s === "monthly" || s === "every month") return { per: "month", occurs: always, label: "monthly", rrule: "FREQ=MONTHLY" };
  if (s === "yearly" || s === "every year") return { per: "year", occurs: always, label: "yearly", rrule: "FREQ=YEARLY" };
  if (s === "once") return { per: "once", occurs: always, label: "once", rrule: null };
  let m = /^every (\d+) days?$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    if (n < 1) throw new Error(`repeat "${spec}": interval must be at least 1`);
    const anchor = dayInfo(start ?? DEFAULT_ANCHOR).index;
    return {
      per: "day",
      occurs: (d) => (((d.index - anchor) % n) + n) % n === 0,
      label: s,
      rrule: n === 1 ? "FREQ=DAILY" : `FREQ=DAILY;INTERVAL=${n}`,
      anchor: n > 1 ? (start ?? DEFAULT_ANCHOR) : undefined,
    };
  }
  m = /^monthly (?:on )?(?:the )?(\d{1,2})(?:st|nd|rd|th)?$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return { per: "day", occurs: (d) => d.day === n, label: s, rrule: `FREQ=MONTHLY;BYMONTHDAY=${n}` };
  }
  const days = s.replace(/^(every|on) /, "").split(/[ ,]+/).filter(Boolean);
  if (days.length && days.every((w) => DAY_ALIASES[w])) {
    const set = new Set(days.map((w) => DAY_ALIASES[w]));
    const byday = RFC_ORDER.filter((w) => set.has(w)).map((w) => RFC[w]).join(",");
    return { per: "day", occurs: (d) => set.has(d.weekday), label: [...set].join(","), rrule: `FREQ=WEEKLY;BYDAY=${byday}` };
  }
  throw new Error(
    `unknown repeat "${spec}". Use daily, weekdays, weekends, weekly, monthly, yearly, "mon,thu", "every 3 days", "monthly 15", an RRULE like "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", or a function (day) => boolean`,
  );
}

export type Compile = (source: string, globals: string[]) => (...args: unknown[]) => void;

// Line of the first stack frame that points into the compiled file. Best effort:
// engines number anonymous functions differently, so `offset` corrects for
// the wrapper lines the engine adds.
function errorLine(err: unknown): number | undefined {
  const stack = err instanceof Error ? err.stack ?? "" : "";
  const m = /<anonymous>:(\d+):\d+/.exec(stack) ?? /eval.*?:(\d+):\d+/.exec(stack);
  if (!m) return undefined;
  const line = Number(m[1]) - 2;
  return line > 0 ? line : undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type Program = { tasks: TaskDef[]; notes: NoteDef[]; errors: ProgramError[] };

const GLOBALS = ["task", "note"];

export function load(files: Files, compile: Compile): Program {
  const tasks: TaskDef[] = [];
  const notes: NoteDef[] = [];
  const errors: ProgramError[] = [];
  const seen = new Map<string, string>();
  for (const file of Object.keys(files).sort()) {
    if (!file.endsWith(".js")) continue;
    const pending: TaskDef[] = [];
    const pendingNotes: NoteDef[] = [];
    const task = (title: unknown, opts: TaskOptions = {}) => {
      if (typeof title !== "string" || !title.trim()) throw new Error("task() needs a title string");
      if (opts === null || typeof opts !== "object") throw new Error(`task("${title}"): options must be an object`);
      const id = slug(opts.id ?? title);
      if (!id) throw new Error(`task("${title}"): id is empty`);
      if (opts.date !== undefined) parseDate(opts.date);
      const repeat = parseRepeat(opts.repeat, opts.start);
      const goal = opts.goal ?? 1;
      if (typeof goal !== "number" || !(goal > 0)) throw new Error(`task("${title}"): goal must be a positive number`);
      pending.push({
        id,
        title: title.trim(),
        file,
        per: opts.per ?? repeat.per,
        repeatLabel: opts.date ? `on ${opts.date}` : repeat.label,
        rrule: repeat.rrule,
        start: repeat.anchor,
        occurs: repeat.occurs,
        date: opts.date,
        from: parseTime(opts.from, `task("${title}").from`),
        until: parseTime(opts.until, `task("${title}").until`),
        goal,
        unit: opts.unit ?? (goal > 1 ? "times" : ""),
        after: opts.after ? slug(opts.after) : undefined,
        when: opts.when,
        group: opts.group,
        notes: opts.notes,
      });
    };
    const note = (text: unknown, opts: { when?: (ctx: Ctx) => boolean } = {}) => {
      if (typeof text !== "string" && typeof text !== "function") throw new Error("note() needs a string or a function");
      pendingNotes.push({ text: text as NoteDef["text"], file, when: opts.when });
    };
    try {
      compile(files[file], GLOBALS)(task, note);
    } catch (err) {
      errors.push({ file, message: message(err), line: errorLine(err) });
      continue;
    }
    for (const def of pending) {
      const other = seen.get(def.id);
      if (other) {
        errors.push({ file, message: `task id "${def.id}" is already defined in ${other}. Give one of them an explicit id.` });
        continue;
      }
      seen.set(def.id, file);
      tasks.push(def);
    }
    notes.push(...pendingNotes);
  }
  for (const def of tasks) {
    if (def.after && !seen.has(def.after)) {
      errors.push({ file: def.file, message: `task "${def.title}" waits for "${def.after}", which no file defines` });
    }
  }
  return { tasks, notes, errors };
}

type Ledger = {
  total: (task: string, period: string) => number;
  doneDays: (task: string) => string[];
  last: (task: string) => number | null;
};

function ledger(log: LogEntry[], tasks: TaskDef[], goalOf: Map<string, number>): Ledger {
  const totals = new Map<string, number>();
  for (const e of log) {
    const k = `${e.task}\u0000${e.period}`;
    totals.set(k, (totals.get(k) ?? 0) + e.amount);
  }
  const lastAt = new Map<string, number>();
  const sorted = [...log].sort((a, b) => a.at - b.at);
  const running = new Map<string, number>();
  const completedAt = new Map<string, number[]>();
  for (const e of sorted) {
    const k = `${e.task}\u0000${e.period}`;
    const before = running.get(k) ?? 0;
    const after = before + e.amount;
    running.set(k, after);
    const goal = goalOf.get(e.task) ?? 1;
    if (before < goal && after >= goal) {
      const list = completedAt.get(e.task) ?? [];
      list.push(e.at);
      completedAt.set(e.task, list);
    } else if (before >= goal && after < goal) {
      completedAt.get(e.task)?.pop();
    }
  }
  for (const [task, list] of completedAt) if (list.length) lastAt.set(task, list[list.length - 1]);
  const perOf = new Map(tasks.map((t) => [t.id, t.per]));
  return {
    total: (task, period) => totals.get(`${task}\u0000${period}`) ?? 0,
    doneDays: (task) => {
      const goal = goalOf.get(task) ?? 1;
      const per = perOf.get(task);
      if (per !== "day") return [];
      const out: string[] = [];
      for (const [k, v] of totals) {
        const [t, p] = k.split("\u0000");
        if (t === task && v >= goal) out.push(p);
      }
      return out.sort();
    },
    last: (task) => lastAt.get(task) ?? null,
  };
}

function atTime(date: string, minutes: number): Date {
  const d = parseDate(date);
  d.setMinutes(minutes);
  return d;
}

const STATE_ORDER: Record<ItemState, number> = { late: 0, now: 1, waiting: 2, later: 3, done: 4 };

// The list for each requested day. `now` decides now/later/late for today;
// earlier days report what they were, later days what is planned.
export function evaluate(files: Files, log: LogEntry[], opts: { now: number; days: string[]; compile: Compile }): Evaluation {
  const program = load(files, opts.compile);
  const errors = [...program.errors];
  const byId = new Map(program.tasks.map((t) => [t.id, t]));
  const goalOf = new Map(program.tasks.map((t) => [t.id, t.goal]));
  const book = ledger(log, program.tasks, goalOf);
  const nowDate = new Date(opts.now);
  const today = dateKey(nowDate);
  const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
  const reported = new Set<string>();
  const report = (file: string, msg: string) => {
    const k = `${file}\u0000${msg}`;
    if (reported.has(k)) return;
    reported.add(k);
    errors.push({ file, message: msg });
  };

  const makeCtx = (date: string): Ctx => {
    const info = dayInfo(date);
    const resolve = (name: string) => {
      const id = slug(name);
      const def = byId.get(id);
      if (!def) throw new Error(`no task named "${name}"`);
      return def;
    };
    const progressOn = (def: TaskDef) => book.total(def.id, periodKey(def.per, date));
    return {
      ...info,
      now: date === today ? nowDate : atTime(date, 12 * 60),
      done: (name) => {
        const def = resolve(name);
        return progressOn(def) >= def.goal;
      },
      count: (name) => progressOn(resolve(name)),
      lastDone: (name) => {
        const at = book.last(resolve(name).id);
        return at === null ? null : new Date(at);
      },
      daysSince: (name) => {
        const at = book.last(resolve(name).id);
        return at === null ? null : info.index - dayInfo(dateKey(new Date(at))).index;
      },
      streak: (name) => {
        const def = resolve(name);
        const done = new Set(book.doneDays(def.id));
        let n = 0;
        let d = done.has(date) ? date : addDays(date, -1);
        for (let guard = 0; guard < 3660; guard++) {
          if (done.has(d)) n++;
          else if (def.occurs(dayInfo(d))) break;
          d = addDays(d, -1);
        }
        return n;
      },
    };
  };

  const days: DayView[] = opts.days.map((date) => {
    const info = dayInfo(date);
    const ctx = makeCtx(date);
    const items: Item[] = [];
    for (const def of program.tasks) {
      let shown: boolean;
      try {
        if (def.per === "once") {
          const period = "once";
          const done = book.total(def.id, period) >= def.goal;
          if (def.date) {
            if (date < def.date) shown = false;
            else if (done) {
              const at = book.last(def.id);
              shown = at !== null && dateKey(new Date(at)) === date;
            } else shown = date === def.date || date === today;
          } else if (done) {
            const at = book.last(def.id);
            shown = at !== null && dateKey(new Date(at)) === date;
          } else shown = date >= today;
        } else shown = def.occurs(info);
        if (shown && def.when) shown = Boolean(def.when(ctx));
      } catch (err) {
        report(def.file, `task "${def.title}": ${message(err)}`);
        continue;
      }
      if (!shown) continue;
      const period = periodKey(def.per, date);
      const progress = book.total(def.id, period);
      let state: ItemState;
      let waitingFor: string | undefined;
      if (progress >= def.goal) state = "done";
      else if (def.after && byId.has(def.after) && !ctx.done(def.after)) {
        state = "waiting";
        waitingFor = byId.get(def.after)!.title;
      } else if (def.per === "once" && def.date && def.date < date) state = "late";
      else if (date < today) state = "late";
      else if (date > today) state = "later";
      else if (def.from && nowMinutes < minutesOf(def.from)) state = "later";
      else if (def.until && nowMinutes >= minutesOf(def.until)) state = "late";
      else state = "now";
      items.push({
        id: def.id,
        title: def.title,
        file: def.file,
        per: def.per,
        period,
        goal: def.goal,
        unit: def.unit,
        progress,
        state,
        from: def.from,
        until: def.until,
        group: def.group,
        notes: def.notes,
        waitingFor,
        date: def.date,
      });
    }
    items.sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        (a.from ?? "99").localeCompare(b.from ?? "99") ||
        a.title.localeCompare(b.title),
    );
    const notes: Note[] = [];
    for (const n of program.notes) {
      try {
        if (n.when && !n.when(ctx)) continue;
        const text = typeof n.text === "function" ? n.text(ctx) : n.text;
        if (text) notes.push({ text: String(text), file: n.file });
      } catch (err) {
        report(n.file, `note: ${message(err)}`);
      }
    }
    return { date, items, notes };
  });

  const tasks: TaskInfo[] = program.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    file: t.file,
    per: t.per,
    repeat: t.repeatLabel,
    goal: t.goal,
    unit: t.unit,
    rrule: t.rrule,
    start: t.start,
    date: t.date,
    from: t.from,
    until: t.until,
    group: t.group,
    notes: t.notes,
  }));
  return { days, errors, tasks };
}

// Compiles with `new Function`, shadowing the worker's ambient capabilities so
// program files stay pure calculations over their inputs.
const SHADOWED = ["self", "globalThis", "fetch", "importScripts", "postMessage", "XMLHttpRequest", "WebSocket", "indexedDB", "caches", "close"];

export const compileWithFunction: Compile = (source, globals) => {
  const fn = new Function(...globals, ...SHADOWED, `"use strict";\n${source}`) as (...args: unknown[]) => void;
  return (...args) => fn(...args, ...SHADOWED.map(() => undefined));
};
