# Two-minute demo script

## Record it in two takes

**Take A — the live proof (~25 seconds).** One command against your real apps:

```bash
npm run converge -- run "Onboard Acme Corp, Pro tier, primary contact ops@acme.com"
```

The header reads `slack=live notion=live linear=live github=live`. Then cut to the four
apps side by side: `#acme-corp-onboarding` with the kickoff brief, the Acme Corp page in
Notion, HAR-5/6/7 in Linear, `acme-corp-integration` on GitHub. This is the beat that
satisfies "clearly prove each of the 3+ integrations was used".

**Take B — the mechanism (~90 seconds).** One command, fully scripted, ~29 seconds of
tool time:

```bash
npm run converge -- demo
```

This always runs against the local twins regardless of `.env` — it has to be fast,
repeatable, and safe to break on camera. Narrate over it using the beats below.

Splice A in front of B. Nothing to type on camera in either take.

---

Run `npm run converge -- demo` and narrate over it. The sequence is scripted — no typing,
nothing to fumble. About 28 seconds of tool time, so you have room to talk.

Record at a terminal font size readable on a laptop. Don't shrink the window to fit more
in; judges watching at 720p need the plan lines legible. ~100 columns is right.

---

## Beat 1 — the problem (0:00–0:16)

> "Ask an agent to onboard a customer across four apps, and one call fails. Here's the
> thing: the agent can't tell whether its write landed. A timeout and a lost
> acknowledgement look identical — and in both cases the write usually *did* land. So it
> retries, and now you've got two Slack channels and two Notion records. Nothing alerts,
> because as far as the agent knows, it recovered."

## Beat 2 — one request, four apps (0:16–0:36)

*(steps 1–2)*

> "Converge does something different. The model never takes actions — it compiles the
> request into a desired-state document, schema-validated before anything is touched.
> Then you see the plan: seven resources across Slack, Notion, Linear and GitHub. Apply,
> and it converges — and 'converged' means it re-read every one of them and confirmed it."

**If running live:** cut to the four apps showing the real channel, page, issues and repo.
This is where you prove the integrations. ~5 seconds.

## Beat 3 — one workflow, not four integrations (0:36–0:52)

*(step 3 — the kickoff brief)*

> "And these aren't four integrations running side by side. That kickoff message is
> composed from what the other apps returned — every id in it is the real Notion page,
> the real Linear issues, the real repo. It literally cannot be written until they exist."

## Beat 4 — idempotence (0:52–1:02)

*(step 4)*

> "Run it again. Nothing happens — there's nothing left to do. Re-running is free, so a
> half-finished onboarding just gets finished, never duplicated."

## Beat 5 — the kill shot (1:02–1:30)

*(steps 5–7 — the most important 30 seconds, don't rush)*

> "Now I'll break it the way a real person does. Archive the Slack channel. Delete the
> Notion record."
>
> "The agent notices — and notice *how*: this is the same call that produced the plan.
> Planning, verification and drift detection are one function, so they can't disagree."
>
> "Apply. It repairs exactly those two and touches nothing else. Census: still one of
> each."

**Optional, if you have a spare five seconds — this one lands well:**

> "And the Notion page came back with a *new* id — so the Slack message that referenced
> it rewrote itself to match. Nobody coded that. It falls out of convergence."

## Beat 6 — the fault that breaks everyone else (1:30–1:48)

*(step 8)*

> "Last one. I'm injecting `lost_ack` — the write lands, the acknowledgement is lost. This
> is the fault that duplicates a conventional agent.
>
> Watch the trace: the create fails, and we do *not* retry it. Writes are never retried
> in-pass. The next pass re-observes, finds the channel already there, moves on. Recovery
> doesn't come from retrying. It comes from re-observing."

## Beat 7 — how we know (1:48–2:00)

*(step 9 — the eval suite)*

> "53 scenarios, seeded and reproducible. Six invariants, all passing. We ran the same
> fault matrix against a conventional retrying agent — one with proper error handling —
> and it left the world wrong in 14 of 28. Run the same job three times and it makes
> twelve duplicate objects.
>
> Reads may be retried. Writes may never be."

---

## Pre-flight checklist

- [ ] `npm run eval` passes 53/53
- [ ] `npm run converge -- demo` runs clean start to finish
- [ ] Terminal font large, window ~100 cols
- [ ] If demoing live: `CONVERGE_LIVE=1`, tokens in `.env`, all four apps open in tabs
- [ ] Video is ~2:00, uploaded, **link public**, pasted into the README
- [ ] Repo public and opens in a logged-out browser
- [ ] Google Form submitted (one entry, repo link + video link)

## If something breaks on camera

Everything runs against local twins by default — no network dependency, no credential
that can expire mid-take. If a live app misbehaves, drop `CONVERGE_LIVE` and re-record;
the twins tell the identical story, and the eval suite is where the evidence lives anyway.
