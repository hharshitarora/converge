# Two-minute demo script

Run `npm run converge -- demo` and narrate over it. The whole sequence is scripted —
no typing, nothing to fumble, ~11 seconds of tool time plus your narration pace.

Record at a terminal font size large enough to read on a laptop. Don't shrink the window
to fit more in; judges watching at 720p need the plan lines legible.

---

## Beat 1 — the problem (0:00–0:18)

> "Ask an agent to onboard a customer across four apps, and one call fails. Here's the
> thing: the agent can't tell whether its write landed. A timeout and a lost
> acknowledgement look identical — and in both cases the write usually *did* land. So it
> retries, and now you've got two Slack channels and two Notion records. Nothing alerts,
> because as far as the agent knows, it recovered."

## Beat 2 — one request, four apps (0:18–0:40)

*(steps 1–2 on screen)*

> "Converge does something different. The model never takes actions — it compiles the
> request into a desired-state document, which gets schema-validated before anything is
> touched. Then you see the plan: six resources across Slack, Notion, Linear and GitHub.
> Apply it, and it converges — and 'converged' here means it re-read every one of them
> and confirmed it."

**If running live:** cut to the four apps showing the real channel, page, issues and repo.
This is where you prove the integrations. Keep it to ~5 seconds.

## Beat 3 — idempotence (0:40–0:52)

*(step 3)*

> "Run it again. Nothing happens — there's nothing left to do. Re-running is free, so a
> half-finished onboarding just gets finished, never duplicated."

## Beat 4 — the kill shot (0:52–1:22)

*(steps 4–6 — the most important 30 seconds of the demo, don't rush it)*

> "Now I'll break it the way a real person does. Archive the Slack channel. Delete the
> Notion record."
>
> "The agent notices — and notice *how*: this is the exact same call that produced the
> plan. Planning, verification and drift detection are one function, so they can't
> disagree with each other."
>
> "Apply. It repairs exactly those two and touches nothing else. Census: still one of
> each. Nothing duplicated."

## Beat 5 — the fault that breaks everyone else (1:22–1:42)

*(step 7)*

> "Last one. I'm injecting `lost_ack` — the write lands, but the acknowledgement is lost.
> This is the fault that duplicates a conventional agent.
>
> Watch the trace: the create fails, and we do *not* retry it. Writes are never retried
> in-pass. The next pass re-observes, finds the channel already exists, and moves on.
> Recovery doesn't come from retrying. It comes from re-observing."

## Beat 6 — how we know (1:42–2:00)

*(step 8 — the eval suite)*

> "53 scenarios, seeded and reproducible. Six invariants, all passing. And we ran the
> same fault matrix against a conventional retrying agent — one with proper error
> handling — and it left the world wrong in 14 of 28. Run the same job three times and it
> makes ten duplicate objects.
>
> Reads may be retried. Writes may never be."

---

## Pre-flight checklist

- [ ] `npm run eval` passes 53/53
- [ ] `npm run converge -- demo` runs clean start to finish
- [ ] Terminal font large, window ~100 cols
- [ ] If demoing live: `CONVERGE_LIVE=1`, tokens in `.env`, all four apps open in tabs
- [ ] Video is ~2:00, uploaded, **link is public** and pasted into the README
- [ ] Repo is public and opens in a logged-out browser

## If something breaks on camera

Everything runs against local twins by default, so there is no network dependency and no
credential that can expire mid-take. If a live app misbehaves, drop `CONVERGE_LIVE` and
re-record — the twins tell the identical story, and the eval suite is where the real
evidence lives anyway.
