import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply } from "./engine/apply.js";
import { buildPlan } from "./engine/plan.js";
import { FileStateLedger } from "./engine/state.js";
import { FaultInjector, type FaultMode, type FaultRule } from "./faults.js";
import { buildRegistry, MockWorld } from "./providers/index.js";
import { compile } from "./compile.js";
import { templateSpec } from "./spec.js";
import { fragmentHtml, standaloneHtml, writeReport } from "./report.js";
import type { Plan, RunContext, Spec, TraceEvent } from "./types.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(ROOT, ".converge");
const WORLD_FILE = path.join(DIR, "world.json");
const STATE_FILE = path.join(DIR, "state.json");
const SPEC_FILE = path.join(DIR, "spec.json");
const TRACE_DIR = path.join(DIR, "traces");
const REPORT_FILE = path.join(DIR, "report.html");

// --- tiny ANSI helpers ---------------------------------------------------
const C = {
  dim: (s: string) => "\x1b[2m" + s + "\x1b[0m",
  bold: (s: string) => "\x1b[1m" + s + "\x1b[0m",
  green: (s: string) => "\x1b[32m" + s + "\x1b[0m",
  yellow: (s: string) => "\x1b[33m" + s + "\x1b[0m",
  red: (s: string) => "\x1b[31m" + s + "\x1b[0m",
  cyan: (s: string) => "\x1b[36m" + s + "\x1b[0m",
  grey: (s: string) => "\x1b[90m" + s + "\x1b[0m",
};

function loadEnv() {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && process.env[m[1]] === undefined) {
      process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
    }
  }
}

const APP_LABEL: Record<string, string> = {
  "slack.channel": "Slack ch  ",
  "slack.message": "Slack msg ",
  "notion.page": "Notion    ",
  "linear.issue": "Linear    ",
  "github.repo": "GitHub    ",
};

function renderPlan(plan: Plan, spec: Spec) {
  const inSync = spec.resources.length - plan.changes.length - plan.blind.length;
  console.log();
  for (const r of spec.resources) {
    const change = plan.changes.find((c) => c.key === r.key);
    const blind = plan.blind.find((c) => c.key === r.key);
    const label = APP_LABEL[r.kind] ?? r.kind;

    if (blind) {
      console.log(
        "  " + label + C.red("?") + " " + r.naturalKey.padEnd(38) +
          C.red("unreadable") + C.grey(" (" + short(blind.unobservable ?? "") + ")"),
      );
    } else if (!change) {
      console.log(
        "  " + label + C.grey("=") + " " + C.grey(r.naturalKey.padEnd(38) + "in sync"),
      );
    } else if (change.action === "create") {
      console.log(
        "  " + label + C.green("+") + " " + r.naturalKey.padEnd(38) + C.green("create"),
      );
    } else {
      console.log(
        "  " + label + C.yellow("~") + " " + r.naturalKey.padEnd(38) +
          C.yellow("update: " + change.fields.map((f) => f.field).join(", ")),
      );
    }
  }
  console.log();
  const creates = plan.changes.filter((c) => c.action === "create").length;
  const updates = plan.changes.filter((c) => c.action === "update").length;
  console.log(
    "  " + C.bold("Plan:") + " " + creates + " to create, " + updates +
      " to update, " + inSync + " unchanged" +
      (plan.blind.length ? C.red(", " + plan.blind.length + " unreadable") : ""),
  );
  console.log();
}

function short(s: string) {
  return s.length > 46 ? s.slice(0, 46) + "..." : s;
}

/** Remove the zero-width identity marker so the message reads as a human sees it. */
function stripMarker(s: string) {
  return s.replace(/[​‌]/g, "");
}

function newCtx(
  injector: FaultInjector,
  world: MockWorld,
  verbose: boolean,
): { ctx: RunContext; events: TraceEvent[]; state: FileStateLedger } {
  const events: TraceEvent[] = [];
  const state = new FileStateLedger(STATE_FILE);
  const runId = "run_" + Date.now().toString(36);
  const ctx: RunContext = {
    runId,
    pass: 1,
    state,
    env: process.env,
    trace: (e) => {
      const full = { ...e, ts: Date.now(), runId, pass: ctx.pass } as TraceEvent;
      events.push(full);
      if (verbose || e.fault || !e.ok) {
        const mark = e.ok ? C.grey("·") : C.red("x");
        const fault = e.fault ? C.red(" [" + e.fault + "]") : "";
        console.log(
          "    " + mark + " " + C.grey(String(e.op).padEnd(10)) +
            C.grey((e.key ?? "").padEnd(28)) +
            C.grey(e.detail ?? e.error ?? "") + fault,
        );
      }
    },
  };
  return { ctx, events, state };
}

function saveTrace(events: TraceEvent[], runId: string) {
  fs.mkdirSync(TRACE_DIR, { recursive: true });
  const f = path.join(TRACE_DIR, runId + ".jsonl");
  fs.writeFileSync(f, events.map((e) => JSON.stringify(e)).join("\n"));
  return f;
}

function parseFaults(argv: string[]): FaultRule[] {
  const rules: FaultRule[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fault" && argv[i + 1]) {
      // --fault lost_ack:slack.channel:create
      const [mode, kind, op] = argv[i + 1]!.split(":");
      rules.push({
        mode: mode as FaultRule["mode"],
        kind: kind || undefined,
        op: (op as FaultRule["op"]) || undefined,
        onlyPasses: [1],
        maxFires: 1,
      });
      i++;
    }
  }
  return rules;
}

async function main() {
  loadEnv();
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "help";
  const verbose = argv.includes("-v") || argv.includes("--verbose");
  const live = process.env.CONVERGE_LIVE === "1";

  const notionParent = process.env.NOTION_PARENT_PAGE_ID ?? "mock-parent";
  const teamKey = process.env.LINEAR_TEAM_KEY ?? "ENG";

  const world = MockWorld.load(WORLD_FILE);
  const injector = new FaultInjector(parseFaults(argv), Number(process.env.CONVERGE_SEED ?? 1));

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(
      [
        "",
        C.bold("converge") + " -- declarative convergence for multi-app agents",
        "",
        "  " + C.cyan("run") + ' "<request>"      compile a request, then converge the world to match',
        "  " + C.cyan("plan") + ' "<request>"     compile and show the diff; touch nothing',
        "  " + C.cyan("drift") + "               re-check the last spec against the world",
        "  " + C.cyan("reapply") + "             converge the last spec again (idempotence check)",
        "  " + C.cyan("forget") + "              delete the state ledger, then converge again",
        "  " + C.cyan("break") + " <target>      damage the mock world like a human would",
        "  " + C.cyan("census") + "              count objects in the mock world",
        "  " + C.cyan("message") + "             show the kickoff brief the agent composed",
        "  " + C.cyan("demo") + "                run the scripted two-minute demo",
        "  " + C.cyan("reset") + "               wipe the mock world and ledger",
        "",
        "  flags: -v  verbose trace",
        "         --fault <mode>[:<kind>][:<op>]   inject a fault on pass 1",
        "         modes: lost_ack partial_write error_500 rate_limit auth_fail timeout",
        "",
        "  break targets: slack-channel  notion-page  linear-desc  github-repo",
        "",
      ].join("\n"),
    );
    return;
  }

  if (cmd === "demo") {
    await runDemo();
    return;
  }

  if (cmd === "reset") {
    world.reset();
    world.save(WORLD_FILE);
    fs.rmSync(STATE_FILE, { force: true });
    fs.rmSync(SPEC_FILE, { force: true });
    console.log(C.green("reset: mock world and ledger cleared"));
    return;
  }

  if (cmd === "census") {
    const c = world.census();
    console.log();
    for (const [k, v] of Object.entries(c)) {
      console.log("  " + (APP_LABEL[k] ?? k) + String(v).padStart(3));
    }
    console.log();
    return;
  }

  if (cmd === "message") {
    // Show what actually got posted, markers stripped. The point is that the
    // ids in it came from the other three apps.
    const msgs = world.data.slack.messages;
    if (!msgs.length) {
      console.log(C.grey("  no messages posted yet"));
      return;
    }
    for (const m of msgs) {
      const ch = world.data.slack.channels.find((c) => c.id === m.channelId);
      console.log();
      console.log("  " + C.cyan("#" + (ch?.name ?? m.channelId)));
      for (const line of stripMarker(m.text).split("\n")) {
        console.log("  " + C.grey("| ") + line);
      }
      console.log();
      console.log("  " + C.dim("every id above was returned by another app during this run"));
      console.log();
    }
    return;
  }

  if (cmd === "break") {
    const target = argv[1];
    const d = world.data;
    if (target === "slack-channel" && d.slack.channels[0]) {
      d.slack.channels[0].archived = true;
      console.log(C.yellow("broke: archived Slack #" + d.slack.channels[0].name));
    } else if (target === "notion-page" && d.notion.pages[0]) {
      d.notion.pages[0].archived = true;
      console.log(C.yellow("broke: deleted Notion page '" + d.notion.pages[0].title + "'"));
    } else if (target === "linear-desc" && d.linear.issues[0]) {
      d.linear.issues[0].description = "";
      console.log(C.yellow("broke: cleared description on " + d.linear.issues[0].identifier));
    } else if (target === "github-repo" && d.github.repos[0]) {
      d.github.repos[0].description = "";
      console.log(C.yellow("broke: cleared description on repo " + d.github.repos[0].name));
    } else {
      console.log(C.red("nothing to break for target: " + target));
      return;
    }
    world.save(WORLD_FILE);
    return;
  }

  // --- commands that need a spec ----------------------------------------
  let spec: Spec;

  if (cmd === "run" || cmd === "plan") {
    const request = argv.slice(1).filter((a) => !a.startsWith("-")).join(" ");
    if (!request) {
      console.log(C.red('give me a request, e.g. converge run "onboard Acme Corp, Pro tier"'));
      process.exit(1);
    }
    console.log();
    console.log("  " + C.bold("Request: ") + C.dim(short(request)));
    const compiled = await compile({
      request,
      notionParentId: notionParent,
      linearTeamKey: teamKey,
      onEvent: (m) => console.log("  " + C.grey(m)),
    });
    spec = compiled.spec;
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(SPEC_FILE, JSON.stringify(spec, null, 2));
  } else if (cmd === "drift" || cmd === "reapply" || cmd === "forget") {
    if (!fs.existsSync(SPEC_FILE)) {
      console.log(C.red("no previous spec; run `converge run \"...\"` first"));
      process.exit(1);
    }
    spec = JSON.parse(fs.readFileSync(SPEC_FILE, "utf8")) as Spec;
  } else {
    console.log(C.red("unknown command: " + cmd));
    process.exit(1);
    return;
  }

  const { ctx, events, state } = newCtx(injector, world, verbose);
  if (cmd === "forget") {
    state.forget();
    console.log("  " + C.yellow("state ledger wiped -- every resource must be rediscovered"));
  }

  const g = {
    injector,
    pass: () => ctx.pass,
    // Silent faults never throw, so nothing else would ever record them --
    // and those are precisely the ones worth seeing in the evidence. Loud
    // faults are already attached to the failed call that raised them.
    onFault: (mode: FaultMode, op: string, kind: string) => {
      if (!FaultInjector.reportsAsSuccess(mode)) return;
      ctx.trace({
        op: op as TraceEvent["op"],
        kind,
        ok: false,
        fault: mode,
        detail: "injected silently; the call reported success",
      });
    },
  };
  const registry = buildRegistry(process.env, g, world);

  const modeLine = Object.entries(registry.modes)
    .map(([app, m]) => app + "=" + (m === "live" ? C.green("live") : C.grey("twin")))
    .join("  ");
  console.log("  " + C.dim("apps: ") + modeLine);

  // --- plan only ---------------------------------------------------------
  if (cmd === "plan" || cmd === "drift") {
    const plan = await buildPlan(spec, registry.providers, ctx);
    renderPlan(plan, spec);
    if (plan.converged) {
      console.log("  " + C.green("converged") + C.grey(" -- the world already matches the spec"));
      console.log();
    }
    world.save(WORLD_FILE);
    saveTrace(events, ctx.runId);
    return;
  }

  // --- apply -------------------------------------------------------------
  const t0 = Date.now();
  const result = await apply(spec, registry.providers, ctx);
  if (!live) world.save(WORLD_FILE);

  renderPlan(result.initialPlan, spec);

  const verdict = result.converged
    ? C.green("CONVERGED")
    : result.finalPlan.blind.length
      ? C.red("BLIND -- refusing to claim success")
      : C.red("NOT CONVERGED");

  console.log(
    "  " + verdict + C.grey(
      result.converged
        ? "  verified by read-back in " + result.passes +
          " pass" + (result.passes === 1 ? "" : "es") + ", " + (Date.now() - t0) + "ms"
        : "  after " + result.passes + " pass" + (result.passes === 1 ? "" : "es") +
          ", " + (Date.now() - t0) + "ms",
    ),
  );
  if (result.created.length)
    console.log("  " + C.grey("created: " + result.created.length + "  updated: " + result.updated.length));

  const faults = events.filter((e) => e.fault);
  if (faults.length) {
    console.log();
    console.log("  " + C.bold("faults survived:"));
    for (const f of faults) {
      console.log("    " + C.red(f.fault!) + C.grey(" on " + f.op + " " + (f.key ?? "")));
    }
  }

  if (result.finalPlan.blind.length) {
    console.log();
    console.log("  " + C.red("unreadable resources (state unknown, not guessed):"));
    for (const b of result.finalPlan.blind) {
      console.log("    " + C.red(b.key) + C.grey(" -- " + short(b.unobservable ?? "")));
    }
  }

  const traceFile = saveTrace(events, ctx.runId);

  // Evidence report: every call, its latency, its outcome, and what was
  // injected. Folds in the latest eval results when they exist.
  let evalRows;
  try {
    evalRows = JSON.parse(fs.readFileSync(path.join(DIR, "eval-report.json"), "utf8"));
  } catch {
    evalRows = undefined;
  }
  const reportInput = {
    events,
    goal: spec.goal,
    modes: registry.modes,
    converged: result.converged,
    passes: result.passes,
    durationMs: Date.now() - t0,
    evalRows,
  };
  writeReport(REPORT_FILE, standaloneHtml(reportInput));
  writeReport(path.join(DIR, "report.fragment.html"), fragmentHtml(reportInput));

  console.log();
  console.log("  " + C.grey("trace:    " + path.relative(ROOT, traceFile) + " (" + events.length + " events)"));
  console.log("  " + C.grey("evidence: " + path.relative(ROOT, REPORT_FILE)));
  console.log();

  if (!result.converged) process.exitCode = 2;
}

/**
 * The scripted demo.
 *
 * Each step really does shell out to the CLI, so what is on screen is the tool
 * being used, not a recording pretending to be one. Beats are paced for a
 * two-minute take with no typing and nothing to fumble.
 */
async function runDemo() {
  const { spawnSync } = await import("node:child_process");
  const self = fileURLToPath(import.meta.url);
  // Run each step through tsx, the same way a user would via `npm run converge`.
  const tsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

  const step = (title: string, note: string, args: string[], pause = 1400) => {
    console.log();
    console.log("  " + "\x1b[7m " + title + " \x1b[0m");
    if (note) console.log("  " + C.dim(note));
    console.log("  " + C.grey("$ converge " + args.join(" ")));
    spawnSync(process.execPath, [tsx, self, ...args], {
      stdio: "inherit",
      env: { ...process.env },
    });
    return new Promise((r) => setTimeout(r, pause));
  };

  console.log();
  console.log("  " + C.bold("CONVERGE") + C.grey("  -- an agent that cannot corrupt your apps"));

  await step("1. Start clean", "Nothing exists yet in any of the four apps.", ["reset"], 700);

  await step(
    "2. One request, four apps",
    "The model plans; it never acts. Its output is a document, not tool calls.",
    ["run", "Onboard Acme Corp, Pro tier, primary contact ops@acme.com"],
    2200,
  );

  await step(
    "3. The apps are one workflow, not four integrations",
    "The kickoff brief is composed from what the other three apps returned.",
    ["message"],
    2400,
  );

  await step(
    "4. Run it again",
    "Idempotent by construction: there is nothing left to do, so nothing happens.",
    ["reapply"],
    1800,
  );

  await step(
    "5. Now break it, the way a human does",
    "Archive the Slack channel and delete the Notion record by hand.",
    ["break", "slack-channel"],
    500,
  );
  await step("", "", ["break", "notion-page"], 900);

  await step(
    "6. The agent notices",
    "Same call that produced the plan is now drift detection. They cannot disagree.",
    ["drift"],
    2200,
  );

  await step(
    "7. It repairs exactly that, and nothing else",
    "Watch the census afterwards: still one of each. Nothing duplicated.",
    ["reapply"],
    1800,
  );
  await step("", "", ["census"], 1800);

  await step(
    "8. The fault that duplicates everyone else's agent",
    "lost_ack: the write LANDED, but the acknowledgement was lost. A retrying agent makes a second channel here.",
    ["reset"],
    600,
  );
  await step(
    "",
    "Writes are never retried in-pass. The next pass re-observes -- and finds it already exists.",
    ["run", "Onboard Acme Corp, Pro tier", "--fault", "lost_ack:slack.channel:create", "-v"],
    2500,
  );

  console.log();
  console.log("  " + "\x1b[7m 8. How we know it works \x1b[0m");
  console.log("  " + C.dim("53 scenarios, seeded and reproducible, against a conventional retrying agent."));
  console.log("  " + C.grey("$ npm run eval"));
  spawnSync(process.execPath, [tsx, path.join(ROOT, "evals", "run.ts")], {
    stdio: "inherit",
  });

  console.log();
  console.log("  " + C.bold("Reads may be retried. Writes may never be."));
  console.log("  " + C.dim("Recovery comes from re-observing, not from retrying."));
  console.log();
}

main().catch((e) => {
  console.error(C.red("\n  fatal: " + (e instanceof Error ? e.message : String(e)) + "\n"));
  process.exit(1);
});
