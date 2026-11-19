// Moving between todosst (the tree app) and this agent app, in both
// directions, through todosst's own passphrase-protected backup file.
//
//   todosst -> agent: settings > export in todosst, then "import" here. Each
//   top-level folder becomes todosst/<folder>.js and completion history
//   becomes log entries. Re-importing replaces the todosst/ files and only
//   tops up log totals, so it never double counts.
//
//   agent -> todosst: "export" here writes a backup file; import it in
//   todosst with "merge by path" on. Tasks match by folder path + title, so
//   the tasks you already have are updated instead of duplicated.
//
// The file format (format/v/kdf/cipher) is byte-compatible with
// todosst/src/lib/vaultFile.ts. Keep the two in step.

import { periodKey, parseRepeat, slug, type LogEntry, type Per, type TaskInfo } from "./runtime";
import { formatRrule, parseRrule, ruleAnchored } from "./rrule";

// ---------- the todosst data model (subset of todosst/src/lib/crypto.ts) ----------

export type TodosstMeta = {
  description?: string;
  dueAt?: number | null;
  dueTimeMin?: number;
  recur?: string;
  mode?: "check" | "count" | "time";
  threshold?: number | null;
  counts?: Record<string, number>;
  habit?: boolean;
  neg?: boolean;
  completedAt?: number | null;
  [key: string]: unknown;
};

export type TodosstNode = {
  v: 2;
  title: string;
  isCompleted: boolean;
  parentId: string | null;
  order: number;
  metadata: TodosstMeta;
};

export type Snapshot = {
  v: 1;
  todos: { id: string; node: TodosstNode }[];
  history: { todoId: string; counts: Record<string, number> }[];
  // set on files written by this app; todosst ignores unknown fields
  source?: "todosst-agent";
};

// ---------- backup file (PBKDF2-SHA-256 -> AES-GCM-256) ----------

const FORMAT = "todosst-export";
const VERSION = 1;
const ITERATIONS = 310_000;

function b64(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: unb64(salt), iterations: ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function buildBackup(snapshot: Snapshot, passphrase: string): Promise<string> {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(snapshot)));
  return JSON.stringify({
    format: FORMAT,
    v: VERSION,
    createdAt: Date.now(),
    counts: { todos: snapshot.todos.length, history: snapshot.history.length },
    kdf: { name: "PBKDF2-SHA-256", iterations: ITERATIONS, salt },
    cipher: { name: "AES-GCM", iv: b64(iv) },
    ciphertext: b64(new Uint8Array(ct)),
  });
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

export async function openBackup(json: string, passphrase: string): Promise<Snapshot> {
  let env: unknown;
  try {
    env = JSON.parse(json);
  } catch {
    throw new Error("That is not a todosst backup file (not JSON).");
  }
  if (!isObj(env) || env.format !== FORMAT) throw new Error("That is not a todosst backup file.");
  if (env.v !== VERSION) throw new Error(`Unsupported backup version ${String(env.v)}.`);
  const salt = isObj(env.kdf) ? env.kdf.salt : null;
  const iv = isObj(env.cipher) ? env.cipher.iv : null;
  if (typeof salt !== "string" || typeof iv !== "string" || typeof env.ciphertext !== "string") {
    throw new Error("The backup file is missing its encryption fields.");
  }
  let text: string;
  try {
    const key = await deriveKey(passphrase, salt);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(env.ciphertext));
    text = new TextDecoder().decode(pt);
  } catch {
    throw new Error("Wrong passphrase, or the file is damaged.");
  }
  const snap = JSON.parse(text) as unknown;
  if (!isObj(snap) || snap.v !== 1 || !Array.isArray(snap.todos) || !Array.isArray(snap.history)) {
    throw new Error("The backup has an unexpected shape.");
  }
  for (const t of snap.todos) {
    if (!isObj(t) || typeof t.id !== "string" || !isObj(t.node) || typeof t.node.title !== "string") {
      throw new Error("The backup contains an invalid task.");
    }
    if (!isObj(t.node.metadata)) t.node.metadata = {};
  }
  return snap as unknown as Snapshot;
}

// ---------- days ----------

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** todosst's day index (local calendar day as days since epoch) -> YYYY-MM-DD. */
export function dayToDate(idx: number): string {
  const d = new Date(idx * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function dateToDay(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- schedules ----------

const WEEK = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const NAMES: Record<string, string> = { MO: "mon", TU: "tue", WE: "wed", TH: "thu", FR: "fri", SA: "sat", SU: "sun" };

export type Schedule = { repeat: string; start?: string; approximate?: string };

/**
 * A todosst RRULE as an agent repeat. Common rules get the readable names
 * ("daily", "mon,thu", "every 3 days"); everything else stays an RRULE,
 * which the runtime runs directly. `anchorDate` fixes the phase of interval
 * rules that carry no DTSTART (todosst anchored those at creation, which a
 * backup does not record; a past window day has the right phase).
 */
export function scheduleFromRrule(recur: string, anchorDate: string): Schedule {
  const lines = recur
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^EXRULE[:;]/i.test(l));
  const text = lines.join("\n");
  let rule;
  try {
    rule = parseRrule(text);
  } catch (err) {
    // keep the frequency and interval, note what was dropped
    const freq = /FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/i.exec(text)?.[1]?.toUpperCase() ?? "DAILY";
    const interval = Number(/INTERVAL=(\d+)/i.exec(text)?.[1] ?? 1);
    const repeat = interval > 1 ? `FREQ=${freq};INTERVAL=${interval}` : `FREQ=${freq}`;
    return { repeat, start: interval > 1 ? anchorDate : undefined, approximate: err instanceof Error ? err.message : String(err) };
  }
  const start = rule.dtstart ?? anchorDate;
  const plain = !rule.until && rule.count === null && !rule.bymonth.length;
  const days = rule.byday.map((d) => d.day);
  const plainDays = rule.byday.every((d) => d.n === null);
  if (plain && !rule.bymonthday.length && plainDays) {
    if (rule.freq === "DAILY" && !days.length) return rule.interval === 1 ? { repeat: "daily" } : { repeat: `every ${rule.interval} days`, start };
    if (rule.freq === "WEEKLY" && rule.interval === 1) {
      if (!days.length) return { repeat: "weekly" };
      const set = new Set<string>(days);
      const key = WEEK.map((w) => NAMES[w]).filter((w) => set.has(w));
      if (key.join(",") === "mon,tue,wed,thu,fri") return { repeat: "weekdays" };
      if (key.join(",") === "sat,sun") return { repeat: "weekends" };
      return { repeat: key.join(",") };
    }
    if (rule.freq === "MONTHLY" && rule.interval === 1 && !days.length) return { repeat: "monthly" };
    if (rule.freq === "YEARLY" && rule.interval === 1 && !days.length) return { repeat: "yearly" };
  }
  if (plain && rule.freq === "MONTHLY" && rule.interval === 1 && !days.length && rule.bymonthday.length === 1 && rule.bymonthday[0] > 0) {
    return { repeat: `monthly ${rule.bymonthday[0]}` };
  }
  const body = formatRrule({ ...rule, dtstart: null });
  return ruleAnchored(rule) || rule.dtstart ? { repeat: body, start } : { repeat: body };
}

/** An agent task's schedule as a todosst RRULE (null for one-offs). */
export function rruleFromTask(t: Pick<TaskInfo, "rrule" | "start">): string | null {
  if (t.rrule === null) return null;
  // a function repeat has no RRULE; daily keeps every day it was done
  if (t.rrule === "custom") return "FREQ=DAILY";
  return t.start ? `DTSTART:${t.start.replace(/-/g, "")}T000000Z\n${t.rrule}` : t.rrule;
}

/** Equal schedules, ignoring DTSTART (todosst anchors DTSTART-less rules at creation). */
export function sameRule(a: string, b: string): boolean {
  const body = (s: string) =>
    s
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^RRULE:/i, ""))
      .filter((l) => l && !/^DTSTART/i.test(l))
      .join(";")
      .toUpperCase()
      .split(";")
      .filter(Boolean)
      .sort()
      .join(";");
  return body(a) === body(b);
}

// ---------- todosst -> agent ----------

export const IMPORT_DIR = "todosst/";
const MAX_ID = 80;
const MAX_FILE = 90_000;
const LOG_HORIZON_DAYS = 400;

export type ImportedLog = { task: string; period: string; amount: number; at: number };

export type ImportPlan = {
  // file path -> new source, or null to delete
  changes: { path: string; source: string | null }[];
  // target totals per (task, period); the server only adds what is missing
  log: ImportedLog[];
  tasks: number;
  kept: number;
  skipped: { completed: number; avoid: number; habit: number };
  approximate: string[];
};

type Opt = [string, unknown];

function literal(v: unknown): string {
  if (v === Infinity) return "Infinity";
  return JSON.stringify(v);
}

function taskLine(title: string, opts: Opt[]): string {
  const body = opts.map(([k, v]) => `${k}: ${literal(v)}`);
  const one = `task(${JSON.stringify(title)}${body.length ? `, { ${body.join(", ")} }` : ""});`;
  if (one.length <= 110) return one;
  return `task(${JSON.stringify(title)}, {\n${body.map((b) => `  ${b},`).join("\n")}\n});`;
}

function countsOf(node: TodosstNode, history: Map<string, Record<string, number>>, id: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const src of [history.get(id) ?? {}, node.metadata.counts ?? {}]) {
    for (const [k, v] of Object.entries(src)) {
      const day = Number(k);
      if (!Number.isInteger(day) || typeof v !== "number" || !(v > 0)) continue;
      out.set(day, Math.max(out.get(day) ?? 0, Math.floor(v)));
    }
  }
  return out;
}

function goalOf(meta: TodosstMeta): Opt[] {
  const t = typeof meta.threshold === "number" && Number.isFinite(meta.threshold) && meta.threshold >= 1 ? Math.floor(meta.threshold) : null;
  if (meta.mode === "time") return [["goal", t ?? 1], ["unit", "min"]];
  if (meta.mode === "count") return [["goal", t ?? Infinity], ["unit", "times"]];
  return t && t > 1 ? [["goal", t], ["unit", ""]] : [];
}

/**
 * Plans the import of a todosst snapshot into the program. `existing` is the
 * current program's task list: tasks defined outside todosst/ win over the
 * imported copy of the same task (their history is still imported).
 */
export function planImport(
  snap: Snapshot,
  opts: { files: Record<string, string>; existing: TaskInfo[]; now: number },
): ImportPlan {
  const today = localDate(opts.now);
  const todayIdx = dateToDay(today);
  const history = new Map(snap.history.map((h) => [h.todoId, h.counts]));
  const byParent = new Map<string | null, { id: string; node: TodosstNode }[]>();
  const ids = new Set(snap.todos.map((t) => t.id));
  for (const t of snap.todos) {
    const parent = t.node.parentId && ids.has(t.node.parentId) ? t.node.parentId : null;
    const list = byParent.get(parent) ?? [];
    list.push(t);
    byParent.set(parent, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.node.order - b.node.order);

  const kept = new Map<string, TaskInfo>();
  for (const t of opts.existing) if (!t.file.startsWith(IMPORT_DIR)) kept.set(t.id, t);
  const used = new Set<string>(kept.keys());
  const plan: ImportPlan = { changes: [], log: [], tasks: 0, kept: 0, skipped: { completed: 0, avoid: 0, habit: 0 }, approximate: [] };

  // file -> sections of lines, grouped by folder path
  const files = new Map<string, { group: string; lines: string[] }[]>();
  const fileOf = new Map<string, string>();
  const takeFile = (rootTitle: string | null) => {
    const key = rootTitle ?? "\u0000inbox";
    let path = fileOf.get(key);
    if (path) return path;
    // inbox.js holds top-level tasks, so a folder called "inbox" gets another name
    let base = rootTitle === null ? "inbox" : slug(rootTitle).slice(0, 60) || "folder";
    if (rootTitle !== null && base === "inbox") base = "inbox-folder";
    const taken = new Set(fileOf.values());
    path = `${IMPORT_DIR}${base}.js`;
    for (let n = 2; taken.has(path); n++) path = `${IMPORT_DIR}${base}-${n}.js`;
    fileOf.set(key, path);
    files.set(path, []);
    return path;
  };

  const emit = (node: TodosstNode, todoId: string, trail: string[], root: string | null) => {
    const meta = node.metadata ?? {};
    const recurring = typeof meta.recur === "string" && meta.recur.trim() !== "";
    if (meta.neg) return void plan.skipped.avoid++;
    if (meta.habit) return void plan.skipped.habit++;
    if (!recurring && node.isCompleted) return void plan.skipped.completed++;
    const title = node.title.trim();
    if (!title) return;
    const counts = countsOf(node, history, todoId);

    // id: the title's slug, made unique with the folder path when needed
    let id = slug(title).slice(0, MAX_ID);
    const same = kept.get(id);
    const isKept = same !== undefined && same.title.toLowerCase() === title.toLowerCase();
    if (!isKept) {
      if (!id || used.has(id)) id = slug([...trail, title].join(" ")).slice(0, MAX_ID) || "task";
      for (let n = 2, base = id; used.has(id); n++) id = `${base.slice(0, MAX_ID - 4)}-${n}`;
      used.add(id);
    }

    const options: Opt[] = [];
    if (id !== slug(title)) options.push(["id", id]);
    let per: Per;
    if (recurring) {
      const latest = [...counts.keys()].sort((a, b) => b - a)[0];
      const sched = scheduleFromRrule(String(meta.recur), latest !== undefined ? dayToDate(latest) : today);
      options.push(["repeat", sched.repeat]);
      if (sched.start) options.push(["start", sched.start]);
      if (sched.approximate) plan.approximate.push(`${title}: ${sched.approximate} (was ${String(meta.recur).replace(/\s+/g, " ")})`);
      per = parseRepeat(sched.repeat, sched.start).per;
    } else {
      per = "once";
      if (typeof meta.dueAt === "number" && Number.isFinite(meta.dueAt)) {
        options.push(["date", localDate(meta.dueAt)]);
        const min = meta.dueTimeMin;
        if (typeof min === "number" && min >= 0 && min < 1440) options.push(["until", `${pad(Math.floor(min / 60))}:${pad(min % 60)}`]);
      }
    }
    options.push(...goalOf(meta));
    if (trail.length) options.push(["group", trail.join(" / ")]);
    const notes = typeof meta.description === "string" ? meta.description.trim() : "";
    if (notes) options.push(["notes", notes]);

    if (isKept) plan.kept++;
    else {
      const path = takeFile(root);
      const sections = files.get(path)!;
      const group = trail.join(" / ");
      let section = sections.find((s) => s.group === group);
      if (!section) sections.push((section = { group, lines: [] }));
      section.lines.push(taskLine(title, options));
      plan.tasks++;
    }

    // history -> log totals per agent period
    const totals = new Map<string, { amount: number; at: number }>();
    for (const [day, count] of counts) {
      if (day < todayIdx - LOG_HORIZON_DAYS) continue;
      const date = dayToDate(day);
      const period = periodKey(isKept ? kept.get(id)!.per : per, date);
      const [y, m, d] = date.split("-").map(Number);
      const at = new Date(y, m - 1, d, 12).getTime();
      const cur = totals.get(period) ?? { amount: 0, at: 0 };
      totals.set(period, { amount: cur.amount + count, at: Math.max(cur.at, at) });
    }
    for (const [period, { amount, at }] of totals) plan.log.push({ task: id, period, amount: Math.min(amount, 100_000), at });
  };

  const walk = (parent: string | null, trail: string[], root: string | null) => {
    for (const { id, node } of byParent.get(parent) ?? []) {
      const kids = byParent.get(id) ?? [];
      const recurring = typeof node.metadata?.recur === "string" && node.metadata.recur.trim() !== "";
      // a node with children is a folder; it is also a task when it repeats
      if (!kids.length || recurring) emit(node, id, trail, root ?? (kids.length ? node.title : null));
      if (kids.length) walk(id, [...trail, node.title.trim()], root ?? node.title);
    }
  };
  walk(null, [], null);

  const header = `// Imported from todosst on ${today}. Importing again replaces the files in todosst/.\n`;
  const next = new Map<string, string>();
  for (const [path, sections] of files) {
    const chunks: string[] = [header];
    for (const s of sections) chunks.push(`${s.group ? `\n// ${s.group}\n` : "\n"}${s.lines.join("\n")}\n`);
    // split very large folders so each file stays under the size limit
    let part = 1;
    let cur = "";
    for (const c of chunks) {
      if (cur.length + c.length > MAX_FILE && cur !== header) {
        next.set(part === 1 ? path : path.replace(/\.js$/, `-part${part}.js`), cur);
        part++;
        cur = header;
      }
      cur += c;
    }
    next.set(part === 1 ? path : path.replace(/\.js$/, `-part${part}.js`), cur);
  }
  for (const path of Object.keys(opts.files)) {
    if (path.startsWith(IMPORT_DIR) && !next.has(path)) plan.changes.push({ path, source: null });
  }
  for (const [path, source] of next) if (opts.files[path] !== source) plan.changes.push({ path, source });
  return plan;
}

// ---------- agent -> todosst ----------

const FOLDER_SEP = " / ";

/** The program and its log as a todosst snapshot (see the merge import in todosst). */
export function buildSnapshot(tasks: TaskInfo[], log: LogEntry[]): Snapshot {
  const todos: Snapshot["todos"] = [];
  const folders = new Map<string, string>();
  let order = 0;
  const folderId = (group: string | undefined): string | null => {
    const parts = (group ?? "").split(FOLDER_SEP).map((p) => p.trim()).filter(Boolean);
    let parent: string | null = null;
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join(FOLDER_SEP);
      let id = folders.get(path);
      if (!id) {
        id = `agent-folder:${path}`;
        folders.set(path, id);
        todos.push({ id, node: { v: 2, title: parts[i], isCompleted: false, parentId: parent, order: order++, metadata: {} } });
      }
      parent = id;
    }
    return parent;
  };

  // totals and the last completion time per task and period
  const totals = new Map<string, Map<string, { amount: number; at: number }>>();
  for (const e of log) {
    const m = totals.get(e.task) ?? new Map();
    const cur = m.get(e.period) ?? { amount: 0, at: 0 };
    m.set(e.period, { amount: cur.amount + e.amount, at: e.amount > 0 ? Math.max(cur.at, e.at) : cur.at });
    totals.set(e.task, m);
  }

  const history: Snapshot["history"] = [];
  for (const t of tasks) {
    const parentId = folderId(t.group);
    const meta: TodosstMeta = {};
    const recur = rruleFromTask(t);
    if (recur) meta.recur = recur;
    if (t.unit === "min") Object.assign(meta, { mode: "time", threshold: t.goal });
    else if (!Number.isFinite(t.goal)) Object.assign(meta, { mode: "count", threshold: null });
    else if (t.unit) Object.assign(meta, { mode: "count", threshold: t.goal });
    else Object.assign(meta, { mode: "check", threshold: t.goal });
    if (!recur) {
      if (t.date) {
        const [y, m, d] = t.date.split("-").map(Number);
        meta.dueAt = new Date(y, m - 1, d).getTime();
        if (t.until) {
          const [h, min] = t.until.split(":").map(Number);
          meta.dueTimeMin = h * 60 + min;
        }
      } else meta.dueAt = null;
    }
    if (t.notes) meta.description = t.notes;

    const counts: Record<string, number> = {};
    let done = false;
    let doneAt = 0;
    for (const [period, { amount, at }] of totals.get(t.id) ?? []) {
      if (!(amount > 0)) continue;
      const date = t.per === "day" && /^\d{4}-\d{2}-\d{2}$/.test(period) ? period : at ? localDate(at) : null;
      if (!date) continue;
      const day = String(dateToDay(date));
      counts[day] = Math.min(9999, Math.max(counts[day] ?? 0, Math.floor(amount)));
      if (period === "once" && amount >= t.goal) {
        done = true;
        doneAt = at;
      }
    }
    if (!recur) meta.completedAt = done ? doneAt || null : null;
    const id = `agent:${t.id}`;
    todos.push({ id, node: { v: 2, title: t.title, isCompleted: done, parentId, order: order++, metadata: meta } });
    if (Object.keys(counts).length) history.push({ todoId: id, counts });
  }
  return { v: 1, todos, history, source: "todosst-agent" };
}

export function backupFilename(now = new Date()): string {
  return `todosst-agent-export-${localDate(now.getTime())}.json`;
}
