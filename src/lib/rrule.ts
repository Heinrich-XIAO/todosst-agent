// A day-level subset of RFC 5545 RRULE, so schedules made in todosst (which
// stores RRULE strings) run unchanged here: repeat: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO".
//
// Supported: FREQ (DAILY, WEEKLY, MONTHLY, YEARLY), INTERVAL, BYDAY (with
// ordinals like 1MO or -1FR inside a month), BYMONTHDAY (negative counts from
// the month's end), BYMONTH, UNTIL, COUNT. Time-of-day parts (BYHOUR,
// BYMINUTE, BYSECOND) and WKST are ignored because tasks are day-based.
// Anything else throws so the author sees it.

export type RuleWeekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type Rule = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byday: { day: RuleWeekday; n: number | null }[];
  bymonthday: number[];
  bymonth: number[];
  until: string | null; // YYYY-MM-DD, inclusive
  count: number | null;
  dtstart: string | null; // YYYY-MM-DD from a DTSTART line
};

const RFC_DAYS: Record<string, RuleWeekday> = { MO: "mon", TU: "tue", WE: "wed", TH: "thu", FR: "fri", SA: "sat", SU: "sun" };
const IGNORED = new Set(["BYHOUR", "BYMINUTE", "BYSECOND", "WKST"]);

export function isRruleSpec(s: string): boolean {
  return /^\s*(?:(?:DTSTART[^\n]*\n\s*)?(?:RRULE:)?FREQ=)/i.test(s);
}

function rfcDate(v: string, field: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(v.trim());
  if (!m) throw new Error(`${field} must look like 20261231, got "${v}"`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function intList(v: string, field: string, min: number, max: number): number[] {
  return v.split(",").map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > max || (min > 0 && n < min)) throw new Error(`bad ${field} value "${p}"`);
    return n;
  });
}

export function parseRrule(spec: string): Rule {
  const rule: Rule = { freq: "DAILY", interval: 1, byday: [], bymonthday: [], bymonth: [], until: null, count: null, dtstart: null };
  let freq: string | null = null;
  for (const rawLine of spec.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const dt = /^DTSTART(?:;[^:]*)?:(.+)$/i.exec(line);
    if (dt) {
      rule.dtstart = rfcDate(dt[1], "DTSTART");
      continue;
    }
    for (const part of line.replace(/^RRULE:/i, "").split(";")) {
      if (!part.trim()) continue;
      const [k, v = ""] = part.split("=").map((x) => x.trim());
      const key = k.toUpperCase();
      const val = v.toUpperCase();
      if (IGNORED.has(key)) continue;
      if (key === "FREQ") freq = val;
      else if (key === "INTERVAL") {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1) throw new Error(`bad INTERVAL "${v}"`);
        rule.interval = n;
      } else if (key === "BYDAY") {
        rule.byday = val.split(",").map((p) => {
          const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(p.trim());
          if (!m) throw new Error(`bad BYDAY value "${p}"`);
          const n = m[1] ? Number(m[1]) : null;
          if (n !== null && (n === 0 || Math.abs(n) > 5)) throw new Error(`BYDAY ordinal must be 1..5 or -1..-5, got "${p}"`);
          return { day: RFC_DAYS[m[2]], n };
        });
      } else if (key === "BYMONTHDAY") rule.bymonthday = intList(val, "BYMONTHDAY", -31, 31);
      else if (key === "BYMONTH") rule.bymonth = intList(val, "BYMONTH", 1, 12);
      else if (key === "UNTIL") rule.until = rfcDate(val, "UNTIL");
      else if (key === "COUNT") {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1) throw new Error(`bad COUNT "${v}"`);
        rule.count = n;
      } else throw new Error(`RRULE part ${key} is not supported here`);
    }
  }
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    throw new Error(`RRULE FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY, got ${freq ?? "nothing"}`);
  }
  rule.freq = freq;
  const ordinal = rule.byday.some((d) => d.n !== null);
  if (ordinal && (freq === "DAILY" || freq === "WEEKLY")) throw new Error(`BYDAY ordinals only work with MONTHLY or YEARLY`);
  if (ordinal && freq === "YEARLY" && !rule.bymonth.length) throw new Error(`YEARLY BYDAY ordinals need BYMONTH`);
  if (rule.bymonthday.length && freq === "WEEKLY") throw new Error(`BYMONTHDAY does not work with WEEKLY`);
  return rule;
}

// The period a rule's goal counts over: a rule that names days happens on
// those days; one that does not (plain WEEKLY, MONTHLY, YEARLY) is a window
// that lasts its whole week, month or year.
export function rulePer(rule: Rule): "day" | "week" | "month" | "year" {
  const namesDays = rule.byday.length > 0 || rule.bymonthday.length > 0;
  if (rule.freq === "DAILY" || namesDays) return "day";
  if (rule.freq === "WEEKLY") return "week";
  if (rule.freq === "MONTHLY" || rule.bymonth.length) return "month";
  return "year";
}

// Whether the rule's phase depends on its start date.
export function ruleAnchored(rule: Rule): boolean {
  return rule.interval > 1 || rule.count !== null;
}

/** Canonical RRULE body (no DTSTART) for a parsed rule. */
export function formatRrule(rule: Rule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byday.length) {
    const inv = Object.fromEntries(Object.entries(RFC_DAYS).map(([k, v]) => [v, k]));
    parts.push(`BYDAY=${rule.byday.map((d) => `${d.n ?? ""}${inv[d.day]}`).join(",")}`);
  }
  if (rule.bymonthday.length) parts.push(`BYMONTHDAY=${rule.bymonthday.join(",")}`);
  if (rule.bymonth.length) parts.push(`BYMONTH=${rule.bymonth.join(",")}`);
  if (rule.until) parts.push(`UNTIL=${rule.until.replace(/-/g, "")}T235959Z`);
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
  return parts.join(";");
}

export type RuleDay = { date: string; weekday: RuleWeekday; day: number; month: number; year: number; index: number };

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function weekNo(d: RuleDay): number {
  // index 0 (1970-01-01) was a Thursday; weeks start on Monday
  return Math.floor((d.index + 3) / 7);
}

function dayMatches(rule: Rule, d: RuleDay): boolean {
  const dim = daysInMonth(d.year, d.month);
  if (rule.bymonthday.length && !rule.bymonthday.some((n) => (n > 0 ? d.day === n : d.day === dim + n + 1))) return false;
  if (rule.byday.length) {
    const ok = rule.byday.some(({ day, n }) => {
      if (day !== d.weekday) return false;
      if (n === null) return true;
      return n > 0 ? Math.ceil(d.day / 7) === n : Math.floor((dim - d.day) / 7) === -n - 1;
    });
    if (!ok) return false;
  }
  return true;
}

/**
 * Whether day `d` is inside an occurrence of the rule (for week/month/year
 * rules, every day of a matching period counts). `anchor` is the start day.
 */
export function ruleOccurs(rule: Rule, anchor: RuleDay, d: RuleDay): boolean {
  if (d.index < anchor.index && (rule.dtstart || rule.count !== null)) return false;
  if (rule.until && d.date > rule.until) return false;
  if (rule.bymonth.length && !rule.bymonth.includes(d.month)) return false;
  if (!dayMatches(rule, d)) return false;
  const n = rule.interval;
  if (n === 1) return true;
  const mod = (x: number) => ((x % n) + n) % n === 0;
  if (rule.freq === "DAILY") return mod(d.index - anchor.index);
  if (rule.freq === "WEEKLY") return mod(weekNo(d) - weekNo(anchor));
  if (rule.freq === "MONTHLY") return mod(d.year * 12 + d.month - (anchor.year * 12 + anchor.month));
  return mod(d.year - anchor.year);
}
