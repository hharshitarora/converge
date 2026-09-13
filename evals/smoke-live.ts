/**
 * Live request-shape smoke test.
 *
 * Runs every live client against the real API with a deliberately invalid
 * token. We are not testing that they work -- we cannot, without credentials.
 * We are testing that each request is well-formed enough to reach the service
 * and come back with the service's own authentication error.
 *
 * The failure this catches is the one that costs you a demo: a typo'd URL, a
 * wrong method, a malformed body or a missing header sitting undiscovered in a
 * code path nothing has ever executed, found at the worst possible moment.
 *
 *   npm run smoke
 *
 * An "auth rejected" line means the request shape is right. Anything else --
 * a 404, a JSON parse error, a thrown TypeError -- is a real bug.
 */

import { FaultInjector } from "../src/faults.js";
import { liveSlack } from "../src/providers/slack.js";
import { liveSlackMessage } from "../src/providers/slackmessage.js";
import { liveNotion } from "../src/providers/notion.js";
import { liveLinear } from "../src/providers/linear.js";

const g = { injector: FaultInjector.none(), pass: () => 1 };
const C = {
  ok: (s: string) => "\x1b[32m" + s + "\x1b[0m",
  bad: (s: string) => "\x1b[31m" + s + "\x1b[0m",
  grey: (s: string) => "\x1b[90m" + s + "\x1b[0m",
};

/** Errors that prove we reached the service and it understood the request. */
const AUTH_REJECTED =
  /invalid_auth|not_authed|token_revoked|invalid_token|API token is invalid|unauthorized|401|Authentication|missing_scope|account_inactive/i;

interface Case {
  name: string;
  run: () => Promise<unknown>;
}

const cases: Case[] = [
  {
    name: "slack  conversations.list",
    run: () => liveSlack("xoxb-not-a-real-token", g).findChannel("converge-smoke"),
  },
  {
    name: "slack  conversations.create",
    run: () => liveSlack("xoxb-not-a-real-token", g).createChannel("converge-smoke"),
  },
  {
    name: "slack  conversations.setTopic",
    run: () => liveSlack("xoxb-not-a-real-token", g).setTopic("C0000000000", "smoke"),
  },
  {
    name: "slack  conversations.unarchive",
    run: () => liveSlack("xoxb-not-a-real-token", g).unarchive("C0000000000"),
  },
  {
    name: "slack  conversations.history",
    run: () => liveSlackMessage("xoxb-not-a-real-token", g).findMessage("C0000000000", "x"),
  },
  {
    name: "slack  chat.postMessage",
    run: () => liveSlackMessage("xoxb-not-a-real-token", g).postMessage("C0000000000", "smoke"),
  },
  {
    name: "notion search",
    run: () => liveNotion("ntn_not_a_real_token", g).findPage("00000000000000000000000000000000", "Smoke"),
  },
  {
    name: "notion pages.create",
    run: () =>
      liveNotion("ntn_not_a_real_token", g).createPage(
        "00000000000000000000000000000000",
        "Smoke",
        "body",
      ),
  },
  {
    name: "linear teams query",
    run: () => liveLinear("lin_api_not_a_real_key", g).findIssue("ENG", "Smoke"),
  },
  {
    name: "linear issueCreate",
    run: () => liveLinear("lin_api_not_a_real_key", g).createIssue("ENG", "Smoke", "body"),
  },
];

async function main() {
  console.log();
  console.log("  live request-shape smoke test");
  console.log(C.grey("  invalid tokens on purpose: we want the service's own auth error back"));
  console.log();

  let bad = 0;
  for (const c of cases) {
    try {
      await c.run();
      // Reaching here with a junk token would itself be surprising.
      console.log("    " + C.bad("UNEXPECTED OK") + " " + c.name);
      bad += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (AUTH_REJECTED.test(msg)) {
        console.log("    " + C.ok("shape ok") + "  " + c.name.padEnd(30) + C.grey(msg.slice(0, 60)));
      } else {
        console.log("    " + C.bad("BAD SHAPE") + " " + c.name.padEnd(30) + C.bad(msg.slice(0, 90)));
        bad += 1;
      }
    }
  }

  console.log();
  if (bad) {
    console.log("  " + C.bad(bad + " request(s) are malformed, not merely unauthorised"));
    process.exitCode = 1;
  } else {
    console.log("  " + C.ok("every live request reached its service and was understood"));
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
