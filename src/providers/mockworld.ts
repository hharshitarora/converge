import fs from "node:fs";
import path from "node:path";
import { mockId } from "./support.js";

/**
 * In-memory twins of the four external apps, persisted to disk.
 *
 * Persistence is what makes these useful rather than toy: state survives
 * between CLI invocations, so drift is real. You can apply, then reach in and
 * delete a Slack channel exactly as a human would, then re-plan and watch the
 * agent notice. The demo therefore needs no credentials, and the eval suite
 * gets a world it can reset to a known seed.
 */

export interface SlackChannel {
  id: string;
  name: string;
  topic: string;
  purpose: string;
  archived: boolean;
}
export interface SlackMessage {
  id: string;
  channelId: string;
  text: string;
}
export interface NotionPage {
  id: string;
  parentId: string;
  title: string;
  props: Record<string, unknown>;
  archived: boolean;
}
export interface LinearIssue {
  id: string;
  identifier: string;
  teamKey: string;
  title: string;
  description: string;
  parentId?: string;
  state: string;
}
export interface GithubRepo {
  id: string;
  name: string;
  description: string;
  private: boolean;
  topics: string[];
}

export interface WorldData {
  slack: { channels: SlackChannel[]; messages: SlackMessage[] };
  notion: { pages: NotionPage[] };
  linear: { issues: LinearIssue[] };
  github: { repos: GithubRepo[] };
}

const empty = (): WorldData => ({
  slack: { channels: [], messages: [] },
  notion: { pages: [] },
  linear: { issues: [] },
  github: { repos: [] },
});

export class MockWorld {
  data: WorldData;
  /** Every mutation, so evals can assert on side effects, not just end state. */
  writeLog: { app: string; op: string; target: string }[] = [];

  constructor(data?: WorldData) {
    this.data = data ?? empty();
  }

  static load(file: string): MockWorld {
    try {
      const raw = fs.readFileSync(file, "utf8");
      return new MockWorld(JSON.parse(raw) as WorldData);
    } catch {
      return new MockWorld();
    }
  }

  save(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(this.data, null, 2));
  }

  reset() {
    this.data = empty();
    this.writeLog = [];
  }

  record(app: string, op: string, target: string) {
    this.writeLog.push({ app, op, target });
  }

  // --- Slack -------------------------------------------------------------
  findChannel(name: string) {
    // Prefer a live channel, but fall back to an archived one: it still owns
    // the name, and the caller needs to know that.
    const chans = this.data.slack.channels.filter((c) => c.name === name);
    return chans.find((c) => !c.archived) ?? chans[0];
  }
  createChannel(name: string, topic = "", purpose = ""): SlackChannel {
    // Real Slack returns `name_taken` here, archived channels included.
    // The twin must too, or it silently permits a duplicate the real API
    // would have refused -- and the eval would certify a bug as safe.
    if (this.findChannel(name)) {
      throw new Error("slack: name_taken (" + name + ")");
    }
    const ch: SlackChannel = {
      id: mockId("C"),
      name,
      topic,
      purpose,
      archived: false,
    };
    this.data.slack.channels.push(ch);
    this.record("slack", "create_channel", name);
    return ch;
  }

  // --- Notion ------------------------------------------------------------
  findPage(parentId: string, title: string) {
    return this.data.notion.pages.find(
      (p) => p.parentId === parentId && p.title === title && !p.archived,
    );
  }
  createPage(parentId: string, title: string, props: Record<string, unknown>) {
    const pg: NotionPage = {
      id: mockId("page"),
      parentId,
      title,
      props,
      archived: false,
    };
    this.data.notion.pages.push(pg);
    this.record("notion", "create_page", title);
    return pg;
  }

  // --- Linear ------------------------------------------------------------
  findIssue(teamKey: string, title: string) {
    return this.data.linear.issues.find(
      (i) => i.teamKey === teamKey && i.title === title,
    );
  }
  createIssue(
    teamKey: string,
    title: string,
    description: string,
    parentId?: string,
  ) {
    const n = this.data.linear.issues.filter((i) => i.teamKey === teamKey).length + 1;
    const issue: LinearIssue = {
      id: mockId("iss"),
      identifier: `${teamKey}-${n}`,
      teamKey,
      title,
      description,
      parentId,
      state: "Todo",
    };
    this.data.linear.issues.push(issue);
    this.record("linear", "create_issue", title);
    return issue;
  }

  // --- GitHub ------------------------------------------------------------
  findRepo(name: string) {
    return this.data.github.repos.find((r) => r.name === name);
  }
  createRepo(name: string, description: string, topics: string[] = []) {
    const repo: GithubRepo = {
      id: mockId("repo"),
      name,
      description,
      private: true,
      topics,
    };
    this.data.github.repos.push(repo);
    this.record("github", "create_repo", name);
    return repo;
  }

  /** Count of externally-visible objects, used to assert "no duplicates". */
  census(): Record<string, number> {
    return {
      "slack.channel": this.data.slack.channels.length,
      "notion.page": this.data.notion.pages.filter((p) => !p.archived).length,
      "linear.issue": this.data.linear.issues.length,
      "github.repo": this.data.github.repos.length,
    };
  }
}
