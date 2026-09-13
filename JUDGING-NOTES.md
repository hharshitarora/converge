# Judging crib sheet

Not part of the submission — this is for you, so you can speak to any part of Converge
without reading the source.

---

## The one-sentence version

> Most agents execute a script and hope. Converge compiles the request into a
> desired-state document, diffs it against the real world, and applies only the
> difference — so re-running is free, failures heal themselves, and a duplicate is
> structurally impossible rather than something you clean up afterwards.

## The six things to know cold

**1. Why don't you get duplicates?**
Because we never create anything without first looking for it by *natural key* — the
channel name, the page title, the issue title, the repo name. Identity lives in the apps
themselves, not in a state file we own. So even with our state deleted, we find what
already exists.

**2. What happens when a write fails?**
Nothing, on purpose. Writes are attempted exactly once per pass and never retried on the
spot. The next pass re-reads the world and decides from fact instead of guesswork. That
one rule — *reads may be retried, writes may never be* — is the core of the system.

**3. Why is that rule necessary?**
Because a failed write is ambiguous. A timeout and a lost acknowledgement are
indistinguishable at the call site, and in both cases the write usually landed. Retrying
on the spot is guessing, and the guess is wrong about half the time. That's how agents
silently duplicate things.

**4. How do you know it worked?**
Convergence is defined as "a fresh read of every resource shows zero difference from the
spec." We only claim success after that read passes. If an app can't be read at all, we
report that resource as *blind* and explicitly refuse to claim success.

**5. How is this different from just retrying with idempotency keys?**
Idempotency keys are per-call and per-vendor — Slack, Notion, Linear and GitHub all
handle them differently, and two of them don't really offer them. Convergence is a
property of the whole run, works across every app uniformly, and additionally gives you
drift repair and free re-runs, which idempotency keys don't.

**6. How did you test it?**
56 generated scenarios with deterministic seeded fault injection, six failure modes
across four apps, checked against six invariants — all passing. Plus a baseline: we built
a conventional retrying agent and ran it through the identical matrix. It left the world
wrong in 14 of 28 scenarios.

## Numbers worth memorising

| | |
|---|---|
| Scenarios / invariants | **56 / 8**, all passing |
| Baseline agent, same faults | **14 of 28** scenarios left the world wrong |
| Baseline, same job run 3× | **12 duplicate objects** (we produce 0) |
| Apps integrated | **4** — Slack, Notion, Linear, GitHub |
| Convergence, typical | **2 passes** (1 to act, 1 to verify) |

## Likely questions, and honest answers

**"Isn't this just Terraform?"**
The execution model is deliberately borrowed, yes — that's the insight. Two differences
that matter: Terraform treats its state file as authoritative, so losing it is a
catastrophe; ours is a cache, and losing it changes nothing. And the spec here is written
by a model from a natural-language request, which is exactly why the plan has to be inert,
validated data rather than tool calls.

**"What if the model plans something wrong?"**
Then we execute it faithfully, and that's a real limitation — it's in the README. What we
do guarantee is that a *malformed* plan never reaches the apps: it's schema-validated and
structurally checked first, the model gets one repair round, and there's a deterministic
template fallback. Note also that `plan` shows a human the full diff before anything is
touched.

**"Does it delete things?"**
Only if you ask. Orphans - things the spec used to declare and no longer does - are always
*reported*, but removed only under `--prune`. This is the one place the ledger genuinely
matters: "should no longer exist" isn't something any app can tell you, it's only knowable
by remembering we once asked for it. That sets the failure direction - lose the ledger and
we under-delete, never over-delete. GitHub repos are never deleted automatically at all:
that provider implements no destroy method, which is a stronger guarantee than a flag,
because there's no code path to reach by accident. Slack and Notion archive rather than
erase.

**"What if two people run it at once?"**
Both could observe "absent" before either creates. Natural keys mean the app usually
rejects the second — Slack does — but Notion would allow both. A lease would fix it; we
didn't build one. It's in the limitations.

**"Why only four apps / why onboarding?"**
The resource model generalises — a provider is about 80 lines — but we only proved it on
one workflow. We deliberately picked a boring, legible workflow so the execution model
was the interesting part rather than the domain.

**"Did the tests actually find anything?"**
Five real bugs, all in the README - and the most important one the tests did NOT find.
Running against real Notion produced four duplicate pages, because Notion's search is
eventually consistent: a page created seconds ago isn't indexed, so every pass saw
"absent" and created another. Our twins were strongly consistent, so all 56 scenarios
sailed past it. The guarantee had been resting on an unstated assumption - that
natural-key lookup is read-after-write consistent. It's now stated, and every provider
uses a strongly consistent read. That's the honest headline: the eval suite is only as
good as the fidelity of its twins. An infinite create loop when a Slack channel was
archived (it still owns the name, so the create could never succeed), and a frozen pass
counter that made "fail only on pass 1" mean "fail on every pass". And a duplicated Slack
message: planning read every resource at once, but the message is found by searching its
channel, so it needs the channel's id first — with an empty ledger it was looked up too
early, reported absent, and posted twice. Reads now run in dependency layers. Notably two
of the four were bugs in the *twins* rather than the system - an over-lenient test double
certifies real bugs as safe, so the twins were fixed to match what the real APIs do. None
of the four was found by reading the code.

## What to say if asked what you'd do next

An interactive confirmation gate on `--prune`; leases for concurrent runs; and a continuous
drift watcher — the plan function already does the work, it just needs a scheduler, so
onboarding stays correct a month later rather than only at the moment it ran.
