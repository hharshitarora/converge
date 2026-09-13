import fs from "node:fs";
import path from "node:path";

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
  /**
   * Id counter, persisted WITH the world rather than held in the module.
   *
   * It lived in a module-level variable once, which reset on every process
   * start while the world itself persisted to disk -- so a second CLI run
   * minted C_0001 again and collided with a channel that already had it.
   * Writes then landed on whichever record matched first, and convergence
   * looped forever updating a field it was writing to the wrong object.
   *
   * Real services never recycle ids, so a twin that does is not a simpler
   * model of one: it is a wrong one, and the eval suite that trusts it grades
   * against fiction.
   */
  seq: number;
}

const empty = (): WorldData => ({
  slack: { channels: [], messages: [] },
  notion: { pages: [] },
  linear: { issues: [] },
  github: { repos: [] },
  seq: 0,
});

export class MockWorld {
  data: WorldData;
  /** Every mutation, so evals can assert on side effects, not just end state. */
  writeLog: { app: string; op: string; target: string }[] = [];

  constructor(data?: WorldData) {
    this.data = data ?? empty();
    // Tolerate worlds written before the counter existed.
    if (typeof this.data.seq !== "number") this.data.seq = 0;
  }

  /** Allocate an id that is unique for the life of this world, not this process. */
  private nextId(prefix: string): string {
    this.data.seq += 1;
    return prefix + "_" + String(this.data.seq).padStart(4, "0");
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
      id: this.nextId("C"),
      name,
      topic,
      purpose,
      archived: false,
    };
    this.data.slack.channels.push(ch);
    this.record("slack", "create_channel", name);
    return ch;
  }

  findMessage(channelId: string, marker: string) {
    return this.data.slack.messages.find(
      (m) => m.channelId === channelId && m.text.includes(marker),
    );
  }
  createMessage(channelId: string, text: string): SlackMessage {
    const m: SlackMessage = { id: this.nextId("msg"), channelId, text };
    this.data.slack.messages.push(m);
    this.record("slack", "post_message", channelId);
    return m;
  }

  // --- Notion ------------------------------------------------------------
  findPage(parentId: string, title: string) {
    return this.data.notion.pages.find(
      (p) => p.parentId === parentId && p.title === title && !p.archived,
    );
  }
  createPage(parentId: string, title: string, props: Record<string, unknown>) {
    const pg: NotionPage = {
      id: this.nextId("page"),
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
      id: this.nextId("iss"),
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
      id: this.nextId("repo"),
      name,
      description,
      private: true,
      topics,
    };
    this.data.github.repos.push(repo);
    this.record("github", "create_repo", name);
    return repo;
  }

  /**
   * Count of LIVE objects, used to assert "no duplicates".
   *
   * Archived channels and pages are excluded deliberately: two objects are
   * only a duplicate if both are actually present to a user. An archived
   * channel is the result of a removal, not a second copy.
   */
  census(): Record<string, number> {
    return {
      "slack.channel": this.data.slack.channels.filter((c) => !c.archived).length,
      "slack.message": this.data.slack.messages.length,
      "notion.page": this.data.notion.pages.filter((p) => !p.archived).length,
      "linear.issue": this.data.linear.issues.length,
      "github.repo": this.data.github.repos.length,
    };
  }
}
