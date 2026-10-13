import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestCore, makeUser, makeWorkspace, type TestCore } from "../__tests__/helpers.js";
import { analyze, fold, normalizeTerm, parseQuery, stem, tokenize } from "./analyzer.js";
import { InvertedIndex, buildSnippet } from "./inverted-index.js";

describe("analyzer", () => {
  it("folds diacritics and case", () => {
    expect(fold("Café ÜBER")).toBe("cafe uber");
    expect(fold("don’t")).toBe("dont");
  });

  it("stems common inflections consistently", () => {
    const pairs: Array<[string, string]> = [
      ["tasks", "task"],
      ["running", "run"],
      ["edited", "edit"],
      ["queries", "query"],
      ["collaboration", "collaborate"],
      ["quickly", "quick"],
      ["classes", "class"],
      ["status", "status"],
      ["2026", "2026"],
    ];
    for (const [word, expected] of pairs) expect(stem(word), word).toBe(expected);
    expect(stem("edit")).toBe(stem("edits"));
  });

  it("drops stop words and single letters but keeps digits", () => {
    expect(normalizeTerm("The")).toBeNull();
    expect(normalizeTerm("a")).toBeNull();
    expect(normalizeTerm("7")).toBe("7");
    expect(analyze("The tasks of the team")).toEqual(["task", "team"]);
  });

  it("keeps source offsets", () => {
    const text = "Hello, Wörld!";
    const tokens = tokenize(text);
    expect(tokens.map((t) => text.slice(t.start, t.end))).toEqual(["Hello", "Wörld"]);
    expect(tokens.map((t) => t.term)).toEqual(["hello", "world"]);
  });

  it("parses queries with a trailing prefix", () => {
    expect(parseQuery("release check")).toEqual({ terms: ["release", "check"], prefix: "check" });
    expect(parseQuery("release ")).toEqual({ terms: ["release"], prefix: null });
    expect(parseQuery("the")).toEqual({ terms: [], prefix: "the" });
    expect(parseQuery("x").prefix).toBeNull();
  });
});

describe("InvertedIndex", () => {
  type Meta = { ws: string };
  const make = () => {
    const index = new InvertedIndex<Meta>([
      { name: "title", weight: 3 },
      { name: "body", weight: 1 },
    ]);
    index.upsert("d1", { title: "Release checklist", body: "Run tests, build the client, back up the database." }, { ws: "a" });
    index.upsert("d2", { title: "Meeting notes", body: "We discussed the release date and the checklist owner." }, { ws: "a" });
    index.upsert("d3", { title: "Database migration", body: "Plan the migration of the database schema." }, { ws: "b" });
    return index;
  };

  it("ranks title matches above body matches", () => {
    const results = make().search("release", { limit: 10 });
    expect(results.map((r) => r.key)).toEqual(["d1", "d2"]);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score as number);
  });

  it("rewards entries matching more query terms", () => {
    const results = make().search("database migration", { limit: 10 });
    expect(results[0]?.key).toBe("d3");
    expect(results.map((r) => r.key)).toContain("d1");
  });

  it("matches the last word as a prefix", () => {
    expect(make().search("migr", { limit: 10 }).map((r) => r.key)).toEqual(["d3"]);
    expect(make().search("migr ", { limit: 10 })).toEqual([]);
  });

  it("filters, updates and removes entries", () => {
    const index = make();
    expect(index.search("database", { limit: 10, filter: (m) => m.ws === "a" }).map((r) => r.key)).toEqual(["d1"]);
    index.upsert("d1", { title: "Renamed", body: "nothing relevant" }, { ws: "a" });
    expect(index.search("checklist", { limit: 10 }).map((r) => r.key)).toEqual(["d2"]);
    expect(index.remove("d2")).toBe(true);
    expect(index.remove("d2")).toBe(false);
    expect(index.search("checklist", { limit: 10 })).toEqual([]);
    expect(index.removeWhere((m) => m.ws === "b")).toBe(1);
    expect(index.size).toBe(1);
  });

  it("returns nothing for stop-word-only queries", () => {
    expect(make().search("the and", { limit: 5 })).toEqual([]);
  });
});

describe("buildSnippet", () => {
  it("centres on the first match and highlights terms", () => {
    const text = `${"lorem ipsum ".repeat(30)}the deployment checklist is ready ${"dolor ".repeat(30)}`;
    const snippet = buildSnippet(text, ["checklist"], 80);
    expect(snippet.text.startsWith("…")).toBe(true);
    expect(snippet.text.endsWith("…")).toBe(true);
    const [start, end] = snippet.highlights[0] as [number, number];
    expect(snippet.text.slice(start, end)).toBe("checklist");
  });

  it("returns short texts unchanged", () => {
    expect(buildSnippet("short text", ["nothing"])).toEqual({ text: "short text", highlights: [] });
  });
});

describe("SearchService", () => {
  let core: TestCore;
  beforeEach(() => {
    core = createTestCore();
  });
  afterEach(() => core.close());

  it("indexes documents, comments and tasks and filters by membership", async () => {
    const alice = await makeUser(core, "searchalice");
    const bob = await makeUser(core, "searchbob");
    const shared = makeWorkspace(core, alice.id, [{ username: "searchbob", role: "viewer" }]);
    const privateWs = makeWorkspace(core, alice.id);
    const doc = core.services.documents.create(alice.id, shared, { title: "Roadmap", content: "Quarterly roadmap with search improvements" });
    core.services.documents.create(alice.id, privateWs, { title: "Secret roadmap", content: "confidential" });
    core.services.comments.create(alice.id, doc.id, { body: "The roadmap needs a search section" });
    core.services.tasks.create(alice.id, shared, {
      title: "Improve search ranking",
      description: "BM25 tuning",
      status: "todo",
      priority: "high",
      assigneeId: null,
      dueDate: null,
      labels: ["search"],
      documentId: null,
    });

    const aliceHits = core.services.search.search(alice.id, { q: "roadmap", types: ["document", "comment", "task"], limit: 10 });
    expect(aliceHits.map((h) => h.title)).toEqual(expect.arrayContaining(["Roadmap", "Secret roadmap", "Comment on “Roadmap”"]));
    const bobHits = core.services.search.search(bob.id, { q: "roadmap", types: ["document", "comment", "task"], limit: 10 });
    expect(bobHits.map((h) => h.title)).not.toContain("Secret roadmap");
    expect(bobHits.length).toBe(2);

    const tasks = core.services.search.search(bob.id, { q: "search", types: ["task"], limit: 10 });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ type: "task", title: "Improve search ranking" });
    expect(() => core.services.search.search(bob.id, { q: "x", workspaceId: privateWs, types: ["document"], limit: 5 })).toThrow(
      /not found/,
    );

    // Losing membership removes results immediately.
    core.services.workspaces.removeMember(alice.id, shared, bob.id);
    expect(core.services.search.search(bob.id, { q: "roadmap", types: ["document"], limit: 10 })).toEqual([]);
  });

  it("follows renames, deletions and rebuilds from the database", async () => {
    const u = await makeUser(core);
    const ws = makeWorkspace(core, u.id);
    const doc = core.services.documents.create(u.id, ws, { title: "Alpha", content: "body text" });
    core.services.comments.create(u.id, doc.id, { body: "comment body" });
    core.services.documents.rename(u.id, doc.id, "Gamma");
    const find = (q: string) => core.services.search.search(u.id, { q, types: ["document", "comment", "task"], limit: 10 });
    expect(find("alpha")).toEqual([]);
    expect(find("gamma").map((h) => h.type)).toEqual(["document"]);
    expect(find("comment")[0]?.title).toBe("Comment on “Gamma”");
    const stats = core.services.search.rebuild();
    expect(stats.entries).toBe(2);
    expect(find("gamma")).toHaveLength(1);
    core.services.documents.delete(u.id, doc.id);
    expect(find("comment")).toEqual([]);
    expect(core.services.search.stats().entries).toBe(0);
  });

  it("drops entries of deleted workspaces", async () => {
    const u = await makeUser(core);
    const ws = makeWorkspace(core, u.id);
    core.services.documents.create(u.id, ws, { title: "Ephemeral", content: "" });
    core.services.workspaces.delete(u.id, ws);
    expect(core.services.search.stats().entries).toBe(0);
  });
});
