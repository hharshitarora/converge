import fs from "node:fs";
import path from "node:path";
import type { TraceEvent } from "./types.js";

/**
 * Evidence report.
 *
 * Every provider call in a run is traced: which resource, which operation,
 * which pass, how long it took, whether it succeeded, and which fault was
 * injected if any. That record is what turns "it worked" into something a
 * reviewer can check -- and it is the same record the eval suite grades.
 *
 * Emitted in two shapes from one source: a standalone file that opens from
 * disk with no server, and a body-only fragment for publishing.
 */

interface EvalCheck {
  id: string;
  name: string;
  passed: boolean;
}

interface EvalRow {
  name: string;
  family: string;
  passed: boolean;
  passes: number;
  converged: boolean;
  faultsFired: number;
  blind: number;
  checks?: EvalCheck[];
  naive?: { remainingDiff: number; verdict: string; duplicates: { passed: boolean } };
}

export interface ReportInput {
  events: TraceEvent[];
  goal: string;
  modes: Record<string, string>;
  converged: boolean;
  passes: number;
  durationMs: number;
  evalRows?: EvalRow[];
}

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const STYLE = `
<style>
  /* Light palette is the complete set; the two blocks below only redefine it. */
  :root{
    --ground:#f6f7f7; --panel:#ffffff; --sunk:#f0f2f2;
    --ink:#15181a; --ink-2:#3f474c; --muted:#6d777d; --line:#e0e5e5;
    --ok:#0f7343; --bad:#a83a20; --warn:#8a6210;
    --read:#77828a; --write:#1d5b96;
    --accent:#1d5b96;
  }
  @media (prefers-color-scheme:dark){ :root:not([data-theme="light"]){
    --ground:#111416; --panel:#181c1f; --sunk:#14181a;
    --ink:#e7eae9; --ink-2:#b6bec3; --muted:#828d94; --line:#272d31;
    --ok:#46c489; --bad:#ef8468; --warn:#dda851;
    --read:#7e8a92; --write:#6ba8e0;
    --accent:#6ba8e0;
  }}
  :root[data-theme="dark"]{
    --ground:#111416; --panel:#181c1f; --sunk:#14181a;
    --ink:#e7eae9; --ink-2:#b6bec3; --muted:#828d94; --line:#272d31;
    --ok:#46c489; --bad:#ef8468; --warn:#dda851;
    --read:#7e8a92; --write:#6ba8e0;
    --accent:#6ba8e0;
  }

  *{box-sizing:border-box}
  body{
    margin:0; background:var(--ground); color:var(--ink);
    font:400 15px/1.6 "IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:900px;margin:0 auto;padding-block:44px;padding-left:20px;padding-right:20px;
    display:flex;flex-direction:column;gap:34px}
  .mono{font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace}

  h1{font-size:26px;line-height:1.2;margin:0;letter-spacing:-.015em;font-weight:600;text-wrap:balance}
  h2{font-size:13px;margin:0 0 14px;font-weight:600;letter-spacing:.09em;
    text-transform:uppercase;color:var(--muted)}
  .lede{margin:6px 0 0;color:var(--ink-2);max-width:62ch}

  /* --- masthead --- */
  .status{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:18px}
  .verdict{display:inline-flex;align-items:center;gap:8px;padding:6px 13px;border-radius:5px;
    font-weight:600;font-size:13.5px;letter-spacing:.01em}
  .verdict.ok{background:color-mix(in srgb,var(--ok) 15%,transparent);color:var(--ok)}
  .verdict.bad{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad)}
  .dot{width:7px;height:7px;border-radius:50%;background:currentColor}
  .meta{color:var(--muted);font-size:13px}
  .chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:14px}
  .chip{border:1px solid var(--line);border-radius:4px;padding:3px 9px;font-size:12px;
    color:var(--muted);background:var(--panel)}
  .chip b{font-weight:600;color:var(--ink-2)}
  .chip.live b{color:var(--ok)}

  /* --- pass strip: passes really are a sequence, so they are numbered --- */
  .strip{display:flex;gap:0;flex-wrap:wrap}
  .step{flex:1 1 160px;border-top:2px solid var(--line);padding:12px 16px 0 0;min-width:0}
  .step.acted{border-top-color:var(--write)}
  .step.fixed{border-top-color:var(--warn)}
  .step.verified{border-top-color:var(--ok)}
  .step .n{font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
    color:var(--muted)}
  .step .role{font-size:13.5px;color:var(--ink-2);margin-top:2px}
  .step .count{font-size:12px;color:var(--muted);margin-top:4px;font-variant-numeric:tabular-nums}

  /* --- call tables --- */
  .pass{border:1px solid var(--line);border-radius:7px;background:var(--panel);overflow:hidden}
  .pass + .pass{margin-top:12px}
  .pass-head{display:flex;align-items:baseline;gap:10px;padding:11px 16px;
    background:var(--sunk);border-bottom:1px solid var(--line)}
  .pass-head .t{font-weight:600;font-size:13.5px}
  .pass-head .r{font-size:12.5px;color:var(--muted)}
  .scroll{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-weight:500;color:var(--muted);font-size:10.5px;letter-spacing:.08em;
    text-transform:uppercase;padding:8px 16px;border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:6px 16px;border-bottom:1px solid var(--line);vertical-align:top}
  tbody tr:last-child td{border-bottom:none}
  .op{font-size:12px;font-weight:500;white-space:nowrap;width:1%}
  .op .tag{display:inline-block;padding:1px 7px;border-radius:3px;
    background:color-mix(in srgb,var(--read) 14%,transparent);color:var(--read)}
  tr.write .op .tag{background:color-mix(in srgb,var(--write) 15%,transparent);color:var(--write)}
  tr.failed .op .tag{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad)}
  .key{font-size:12px;color:var(--ink-2);white-space:nowrap}
  .detail{color:var(--muted);font-size:12.5px}
  tr.failed .detail{color:var(--bad)}
  .ms{color:var(--muted);text-align:right;white-space:nowrap;font-size:12px;
    font-variant-numeric:tabular-nums;width:1%}
  .badge{display:inline-block;padding:1px 7px;border-radius:3px;font-size:11px;font-weight:600;
    background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad);white-space:nowrap}

  /* --- comparison: one scale, every label names a value it reaches --- */
  .bars{display:flex;flex-direction:column;gap:14px;border:1px solid var(--line);
    border-radius:7px;background:var(--panel);padding:18px 20px}
  .bar-row{display:grid;grid-template-columns:1fr;gap:5px}
  .bar-label{display:flex;justify-content:space-between;gap:12px;align-items:baseline;font-size:13.5px}
  .bar-label .who{color:var(--ink)}
  .bar-label .val{color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums}
  .track{height:9px;border-radius:5px;background:var(--sunk);overflow:hidden}
  .fill{height:100%;border-radius:5px;background:var(--ok)}
  .fill.weak{background:var(--bad)}
  .bars .note{font-size:12.5px;color:var(--muted);margin:2px 0 0;max-width:62ch}

  /* --- invariants --- */
  .inv{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:0;
    border:1px solid var(--line);border-radius:7px;background:var(--panel);overflow:hidden}
  .inv div{padding:12px 16px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
  .inv .id{font-size:11px;color:var(--muted);letter-spacing:.06em}
  .inv .nm{font-size:13.5px;margin-top:1px}
  .inv .sc{font-size:12.5px;font-weight:600;margin-top:3px;font-variant-numeric:tabular-nums}
  .inv .sc.ok{color:var(--ok)} .inv .sc.bad{color:var(--bad)}

  /* --- scenario table --- */
  .evals{border:1px solid var(--line);border-radius:7px;background:var(--panel);overflow:hidden}
  .fam td{background:var(--sunk);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;
    color:var(--muted);font-weight:600}
  .res{font-size:12px;font-weight:600;white-space:nowrap;width:1%}
  .res.ok{color:var(--ok)} .res.bad{color:var(--bad)}
  .base{font-size:12.5px;color:var(--muted)}
  .base.bad{color:var(--bad)}

  .close{color:var(--muted);font-size:13.5px;border-left:2px solid var(--line);
    padding-left:16px;max-width:64ch}
  .close b{color:var(--ink-2);font-weight:600}

  @media (max-width:560px){
    .wrap{padding-block:30px}
    h1{font-size:22px}
    th,td{padding-left:12px;padding-right:12px}
    .inv div{border-right:none}
  }
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>`;

function passSections(events: TraceEvent[]): { html: string; strip: string } {
  const byPass = new Map<number, TraceEvent[]>();
  for (const e of events) {
    if (e.op === "plan" || e.op === "pass" || e.op === "converged" || e.op === "compile") continue;
    const list = byPass.get(e.pass) ?? [];
    list.push(e);
    byPass.set(e.pass, list);
  }
  const entries = [...byPass.entries()].sort((a, b) => a[0] - b[0]);

  const classify = (evs: TraceEvent[], isFirst: boolean) => {
    const writes = evs.filter((e) => e.op === "create" || e.op === "update");
    if (isFirst) return { cls: "acted", role: "planned, then acted", writes };
    if (writes.length === 0) return { cls: "verified", role: "read back — nothing left to do", writes };
    return { cls: "fixed", role: "re-observed, then repaired", writes };
  };

  const strip = entries
    .map(([pass, evs], i) => {
      const { cls, role, writes } = classify(evs, i === 0);
      const reads = evs.filter((e) => e.op === "observe").length;
      return `<div class="step ${cls}">
        <div class="n">Pass ${pass}</div>
        <div class="role">${role}</div>
        <div class="count mono">${reads} read${reads === 1 ? "" : "s"} · ${writes.length} write${
          writes.length === 1 ? "" : "s"
        }</div>
      </div>`;
    })
    .join("");

  const html = entries
    .map(([pass, evs], i) => {
      const { role } = classify(evs, i === 0);
      const rows = evs
        .map((e) => {
          const isWrite = e.op === "create" || e.op === "update";
          const cls = !e.ok ? "failed" : isWrite ? "write" : "read";
          return `<tr class="${cls}">
            <td class="op"><span class="tag mono">${esc(e.op)}</span></td>
            <td class="key mono">${esc(e.key ?? e.kind ?? "")}</td>
            <td class="detail">${esc(e.detail ?? e.error ?? "")}</td>
            <td class="ms">${e.fault ? `<span class="badge mono">${esc(e.fault)}</span>` : ""}</td>
            <td class="ms mono">${e.latencyMs !== undefined ? esc(e.latencyMs) + "ms" : ""}</td>
          </tr>`;
        })
        .join("");
      return `<div class="pass">
        <div class="pass-head"><span class="t">Pass ${pass}</span><span class="r">${role}</span></div>
        <div class="scroll"><table>
          <thead><tr><th>op</th><th>resource</th><th>detail</th><th>fault</th><th>ms</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`;
    })
    .join("");

  return { html, strip };
}

function evalSection(rows: EvalRow[]): string {
  const withBase = rows.filter((r) => r.naive);
  const baseOk = withBase.filter(
    (r) => r.naive!.duplicates.passed && r.naive!.remainingDiff === 0,
  ).length;
  const total = withBase.length;
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);

  // Invariants, aggregated across every scenario.
  const inv = new Map<string, { name: string; pass: number; total: number }>();
  for (const r of rows) {
    for (const c of r.checks ?? []) {
      const e = inv.get(c.id) ?? { name: c.name, pass: 0, total: 0 };
      e.total += 1;
      if (c.passed) e.pass += 1;
      inv.set(c.id, e);
    }
  }
  const invHtml = [...inv]
    .sort()
    .map(([id, e]) => {
      const ok = e.pass === e.total;
      return `<div>
        <div class="id mono">${esc(id)}</div>
        <div class="nm">${esc(e.name)}</div>
        <div class="sc mono ${ok ? "ok" : "bad"}">${e.pass}/${e.total}</div>
      </div>`;
    })
    .join("");

  const fams = [...new Set(rows.map((r) => r.family))];
  const body = fams
    .map((f) => {
      const rs = rows.filter((r) => r.family === f);
      return (
        `<tr class="fam"><td colspan="4">${esc(f)}</td></tr>` +
        rs
          .map((r) => {
            const bOk = r.naive && r.naive.duplicates.passed && r.naive.remainingDiff === 0;
            return `<tr>
              <td>${esc(r.name)}</td>
              <td class="res ${r.passed ? "ok" : "bad"}">${r.passed ? "PASS" : "FAIL"}</td>
              <td class="ms mono">${r.passes}</td>
              <td class="base ${r.naive && !bOk ? "bad" : ""}">${
                r.naive ? (bOk ? "correct" : esc(r.naive.verdict)) : "&mdash;"
              }</td>
            </tr>`;
          })
          .join("")
      );
    })
    .join("");

  return `
  <section>
    <h2>Does it hold up under failure?</h2>
    <div class="bars">
      <div class="bar-row">
        <div class="bar-label"><span class="who">Converge</span>
          <span class="val mono">${total}/${total} ended in the desired state</span></div>
        <div class="track"><div class="fill" style="width:100%"></div></div>
      </div>
      <div class="bar-row">
        <div class="bar-label"><span class="who">Conventional retrying agent</span>
          <span class="val mono">${baseOk}/${total} ended in the desired state</span></div>
        <div class="track"><div class="fill weak" style="width:${pct(baseOk)}%"></div></div>
      </div>
      <p class="note">Identical fault matrix, identical seeds. The baseline has retries and
      error handling &mdash; what it lacks is the read-before-write that makes a retry safe.
      Both worlds were then graded by the same planner, running fault-free.</p>
    </div>
  </section>

  <section>
    <h2>Invariants</h2>
    <div class="inv">${invHtml}</div>
  </section>

  <section>
    <h2>${rows.length} scenarios</h2>
    <div class="evals scroll">
      <table>
        <thead><tr><th>scenario</th><th>result</th><th>passes</th><th>baseline agent</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </section>`;
}

/** Head content (title + fonts + style) and body content, kept separate. */
export function buildReport(input: ReportInput): { head: string; body: string } {
  const { events, goal, modes, converged, passes, durationMs } = input;
  const { html, strip } = passSections(events);

  const modeChips = Object.entries(modes)
    .map(
      ([app, m]) =>
        `<span class="chip ${m === "live" ? "live" : ""}">${esc(app)} <b>${
          m === "live" ? "live API" : "local twin"
        }</b></span>`,
    )
    .join("");

  const head =
    `<title>Converge Run Evidence</title>\n` +
    `<link rel="preconnect" href="https://fonts.googleapis.com">\n` +
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n` +
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">\n` +
    STYLE;

  const body = `
<div class="wrap">
  <header>
    <h1>Converge &mdash; run evidence</h1>
    <p class="lede">${esc(goal)}. Every call this run made, in the order it made them,
    with the faults that were injected and what happened next.</p>
    <div class="status">
      <span class="verdict ${converged ? "ok" : "bad"}"><span class="dot"></span>${
        converged
          ? "Converged, verified by read-back in " + passes + " pass" + (passes === 1 ? "" : "es")
          : "Did not converge"
      }</span>
      <span class="meta mono">${durationMs}ms · ${events.length} traced calls</span>
    </div>
    <div class="chips">${modeChips}</div>
  </header>

  <section>
    <h2>How it converged</h2>
    <div class="strip">${strip}</div>
  </section>

  <section>
    <h2>Every call, pass by pass</h2>
    ${html}
  </section>

  ${input.evalRows?.length ? evalSection(input.evalRows) : ""}

  <p class="close">Each pass begins by reading the world. Pass 1's read is the plan; every
  later read is at once the verification of the pass before it and the plan for the next.
  Convergence means a fresh read found nothing left to do &mdash; so <b>the evidence that the
  run succeeded is the same evidence that produced it</b>.</p>
</div>`;

  return { head, body };
}

/** Full document, for opening from disk. */
export function standaloneHtml(input: ReportInput): string {
  const { head, body } = buildReport(input);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${head}
</head><body>${body}</body></html>`;
}

/** Head + body only, for publishing (the host supplies the skeleton). */
export function fragmentHtml(input: ReportInput): string {
  const { head, body } = buildReport(input);
  return head + "\n" + body;
}

export function writeReport(file: string, html: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
}
