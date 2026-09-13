# Converge

**An AI agent that onboards a customer across Slack, Notion, Linear and GitHub — and cannot corrupt them.**

Built for the Multi-App AI Agent Hackathon, 13 September 2026.

**Demo video:** _(link added before submission)_

---

## The problem

Ask an agent to onboard a new customer and it will do half a dozen things across four
apps. Now let one of those calls fail.

The agent cannot tell, from the error alone, whether its write landed. A timeout and a
lost acknowledgement look identical at the call site — and in both cases the write
usually *did* land. So the agent retries, and you get two Slack channels, two Notion
records, two Linear epics. Nothing alerts, because from the agent's own point of view
it recovered gracefully.

This is not a hypothetical. We built a conventional retrying agent — error handling,
exponential backoff, the works — and ran it through our fault matrix. It left the world
in a wrong or duplicated state in **14 of 28 scenarios**. Run the same onboarding three
times and it creates **12 duplicate objects**.

The problem isn't that it lacks error handling. The problem is that it *guesses*.

## What we built

Converge replaces the script with a **desired-state spec**, and replaces retrying with
**re-observing**.

```
$ converge run "Onboard Acme Corp, Pro tier, primary contact ops@acme.com"

  Slack ch  + acme-corp-onboarding                  create
  Notion    + Acme Corp                             create
  Linear    + Onboard Acme Corp                     create
  Linear    + Schedule kickoff call with Acme Corp  create
  Linear    + Provision production access           create
  GitHub    + acme-corp-integration                 create
  Slack msg + kickoff brief for Acme Corp           create

  Plan: 7 to create, 0 to update, 0 unchanged

  CONVERGED  verified by read-back in 2 passes, 43ms
```

Run it again and it does nothing, because there is nothing left to do:

```
  Plan: 0 to create, 0 to update, 7 unchanged
  CONVERGED  verified by read-back in 1 pass, 2ms
```

Archive the Slack channel by hand, delete the Notion page, clear a Linear description,
then run it again — it repairs exactly those three and touches nothing else.

### How it works

1. **The model plans; it never acts.** Claude Opus 5 compiles the request into a JSON
   desired-state document — a list of resources that should exist, each with a
   `naturalKey` by which the real app identifies it. That document is validated against
   a strict schema *and* our own structural rules before anything is touched. An invalid
   plan costs nothing, because it is still just text. If validation fails, the model gets
   the errors back and repairs it.

2. **One notion of correctness, used four ways.** `buildPlan()` reads the world and
   diffs it against the spec. That same call is the plan (before any write), the
   verification (after every write), and drift detection (a week later). They cannot
   disagree, because they are the same function.

3. **Reads may be retried. Writes may never be.** This is the central safety rule. A
   failed write is attempted exactly once per pass; then the next pass re-reads the
   world, which replaces the guess with a fact:

   | Fault | What the next pass observes | Result |
   |---|---|---|
   | `lost_ack` (write landed, ack lost) | resource exists | no action — **no duplicate** |
   | `partial_write` (fields missing) | field mismatch | update — **repaired** |
   | `error_500` | still absent | create — **completed** |
   | `auth_fail` | still unreadable | **reported as blind, never guessed** |

   Recovery does not come from retrying. It comes from re-observing.

4. **Identity lives in the apps, not in our state file.** Every resource is found by
   natural key — channel name, page title, issue title, repo name. The local ledger is a
   cache, never the truth. Delete it and re-run: nothing duplicates. `converge forget`
   proves this on demand.

5. **Success is only ever claimed after a fresh read confirms it.** If an app cannot be
   read, that resource is reported *blind* and the run refuses to claim convergence.
   Silence is never treated as success.

## External apps used

Four, all with real API integrations:

| App | Resource | Natural key | API |
|---|---|---|---|
| **Slack** | channel (+ topic, purpose, archived state) | channel name | Web API |
| **Notion** | account record page (+ body) | title under parent page | REST v1 |
| **Linear** | onboarding epic + sub-issues | title within team | GraphQL |
| **GitHub** | integration repo | repo name under owner | REST via `gh` |
| **Slack** | kickoff brief message | invisible marker in the text | Web API |

These are one workflow, not four parallel integrations. The final Slack message is
**composed from what the other apps returned** — its template carries `{{resource.key}}`
placeholders that resolve to the real Notion page id, the real Linear issue ids and the
real repo, so it cannot be written until those exist:

```
:wave: *Acme Corp* is onboarding (Pro tier). Account owner: dana@ourco.com.
- Account record: {{notion.page:acme-corp}}      ->  page_0002
- Onboarding epic: {{linear.epic:acme-corp}}     ->  iss_0003
- Kickoff call: {{linear.task:kickoff:acme-corp}} ->  iss_0004
- Integration repo: {{github.repo:acme-corp}}    ->  repo_0006
```

That message also poses the most interesting identity question in the project: a Slack
message has no name, so what is its natural key? We embed a zero-width marker derived
from the resource key and search the channel for it. Post it twice and the second run
finds the first rather than duplicating it.

It produces one genuinely pleasing behaviour we did not write any code for. Delete the
Notion record and converge again: the page is recreated with a *new* id, the message that
quoted the old one no longer matches its desired text, and so it is rewritten to point at
the new page. **Cross-app referential integrity falls out of convergence for free** —
because "correct" is defined over the whole desired state, not per step.

Each app resolves to live or twin **independently**, based on whether its credential is
present — so if one token expires mid-demo, the other three still run for real.

The **twins** are in-memory implementations of all four apps that persist to disk. They
exist so the eval suite is fast and deterministic, and so the failure modes below can be
reproduced exactly. Crucially, **the same provider code runs against twins and live
APIs** — the eval suite exercises the real code path, not a parallel implementation.

## How to run

Requires Node 20+.

```bash
npm install
cp .env.example .env     # optional — runs against twins with no credentials at all

npm run converge -- run "Onboard Acme Corp, Pro tier"   # compile a request and converge
npm run converge -- reapply                             # idempotence: nothing happens
npm run converge -- break slack-channel                 # damage the world by hand
npm run converge -- drift                               # see exactly what broke
npm run converge -- reapply                             # repair only that
npm run converge -- forget                              # delete state, re-run, no duplicates
npm run converge -- census                              # count objects; proves no duplication

npm run eval                                            # 53-scenario reliability suite
```

Inject faults on any run:

```bash
npm run converge -- run "Onboard Acme Corp" --fault lost_ack:slack.channel:create -v
```

### Evidence

Every run writes `.converge/report.html` — open it in a browser. It shows how the run
converged pass by pass, then every single provider call in order: which resource, which
operation, how long it took, what came back, and which fault was injected. The latest
eval results are folded in underneath.

That report is the point of the design, not a nicety. Because convergence is defined as
"a fresh read found nothing left to do", **the evidence that the run succeeded is the
same evidence that produced it** — there is no separate success signal that could
disagree with reality.

Raw per-call traces are written as JSONL to `.converge/traces/`.

### Going live

Everything above runs with no credentials. To hit real APIs, set `CONVERGE_LIVE=1` and
whichever tokens you have in `.env`:

- `SLACK_BOT_TOKEN` — scopes `channels:manage`, `channels:read`, `chat:write`
- `NOTION_TOKEN` + `NOTION_PARENT_PAGE_ID` — share the parent page with the integration
- `LINEAR_API_KEY` + `LINEAR_TEAM_KEY`
- `GITHUB_OWNER` — uses the authenticated `gh` CLI
- `ANTHROPIC_API_KEY` — for the planner; without it a deterministic template planner is
  used instead, which is also what the evals run against

## How reliability was tested

`npm run eval` runs **53 scenarios** against the twins with **deterministic, seeded**
fault injection — every failure is exactly reproducible. Coverage is generated as a
matrix rather than hand-written, so it doesn't depend on the author's patience.

**Six failure modes**, chosen because each corrupts state a different way:

- `lost_ack` — the write succeeded server-side but the acknowledgement was lost. The
  single most destructive fault in multi-app automation, and the one that silently
  creates duplicates.
- `partial_write` — the resource exists but some fields never landed. An existence check
  passes while the record is wrong.
- `rate_limit`, `error_500`, `timeout` — loud failures.
- `auth_fail` — unrecoverable within a run; the correct behaviour is to stay blind.

**Seven scenario families:** happy path · idempotence (applied three times) · write
faults (every mode × every app) · read faults · unrecoverable auth failure · chaos (two
apps failing at once) · state independence (ledger deleted mid-sequence) · drift repair
(damage done outside the agent).

**Six invariants**, each phrased as something a user would notice — not as "was retry
called twice", which passes happily while the world is corrupt:

| ID | Invariant | Result |
|---|---|---|
| I1 | no duplicates | **53/53** |
| I2 | no false success | **53/53** |
| I3 | no half-written state | **53/53** |
| I4 | bounded passes | **53/53** |
| I5 | no collateral objects | **53/53** |
| I6 | reached desired state, or said plainly that it couldn't | **53/53** |

### The baseline comparison

The same fault matrix, same seeds, run against a conventional retrying agent
(`evals/naive.ts`). It is not a straw man — it has retries and error handling and is the
shape most production agents have today. Both agents' final worlds are then graded by
the same planner, running fault-free: *forget how it got there, is the world actually
right?*

| | Converge | Conventional retrying agent |
|---|---|---|
| Scenarios ending in the desired state | **28/28** | **14/28** |
| Scenarios with duplicate objects | **0** | **6** |
| Duplicates after running the same job 3× | **0** | **12** |

Full generated report: [`.converge/eval-report.md`](.converge/eval-report.md) (regenerated by `npm run eval`).

### Bugs this suite actually caught

Both were found by the evals during the build, not by us reading the code:

1. **An infinite create loop.** Archiving a Slack channel made `observe` report it as
   absent, so the engine planned a create — but the archived channel still owns the name,
   so the create could never succeed, and every pass tried again. The twin was also too
   permissive: real Slack returns `name_taken`, so the twin now does too. An over-lenient
   twin would have certified a bug as safe. Fix: an archived channel is
   *present-but-wrong*, and the repair is to unarchive.

2. **Faults that never expired.** The apply loop built its context with a spread, so the
   pass counter the fault injector read was frozen at 1 — meaning "fail only on pass 1"
   actually meant "fail on every pass". Single-fault scenarios masked it; the chaos
   family exposed it.

3. **A duplicated Slack message.** Planning observed every resource concurrently, which
   looked harmless and was faster. But the kickoff message can only be *found* by
   searching the channel it lives in, so it needs the channel's id first. With an empty
   ledger, the message was looked up before the channel had been rediscovered, reported
   absent, and was posted twice. Dependencies constrain reads exactly as they constrain
   writes; observation now runs in dependency layers, concurrent within each layer. Only
   the state-loss scenarios caught this.

## Known limitations

- **No deletion.** The spec describes what should exist, never what should not. A
  resource removed from the spec is orphaned rather than cleaned up. Convergence is
  one-directional by design — we would rather leave a stray channel than delete a real
  one on a bad plan — but it is a genuine gap.
- **Blind resources stay blind.** If an app cannot be read at all (bad credentials), the
  run reports it and stops. It does not queue the work for later or route around the
  outage. It is honest, not resilient.
- **Natural keys must be stable.** Rename the customer and the spec describes a
  *different* resource; the old one is orphaned and a new one created. Renames need an
  explicit move operation we have not built.
- **Field-level coverage is partial.** We diff the fields the spec declares (topic,
  purpose, summary, description, archived). Slack channel membership, Notion database
  properties and Linear assignees/labels are not yet modelled.
- **Last-writer-wins within a pass.** Two converge runs racing on the same spec can both
  observe "absent" before either creates. Natural keys mean the app usually rejects the
  second (Slack does), but Notion would allow both. A lease would fix this; we have not
  built one.
- **The planner is the least reliable component.** The engine is deterministic and
  tested; the model is neither. That is why the evals run against a deterministic
  template planner — reliability numbers measured over a non-deterministic planner would
  be measuring the planner, not the engine. Schema validation plus one repair round plus
  a template fallback keeps a bad plan from ever reaching the apps, but a *plausible but
  wrong* plan would still be executed faithfully.
- **Four apps, one workflow.** The resource model generalises, but we have only proven
  it on customer onboarding.

## Layout

```
src/
  types.ts            the Provider contract and the single correctness predicate
  spec.ts             desired-state schema, structural validation, template planner
  compile.ts          request -> spec, via Claude Opus 5 with schema enforcement
  faults.ts           the six failure modes, seeded and deterministic
  engine/
    plan.ts           read the world, diff it — plan, verification and drift in one call
    apply.ts          the convergence loop and the never-retry-writes rule
    state.ts          the ledger (a cache, deliberately not the source of truth)
  providers/
    slack|notion|linear|github.ts   one file per app: client interface, twin, live, provider
    slackmessage.ts   the cross-app resource, composed from the others' results
    mockworld.ts      persistent in-memory twins of all four apps
evals/
  scenarios.ts        the generated 53-scenario matrix
  invariants.ts       the six invariants
  naive.ts            the conventional retrying agent, for comparison
  run.ts              runner and report generator
```
