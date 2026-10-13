import type { CommentDto, TaskDto } from "@rcp/shared";
import { describe, expect, it } from "vitest";
import { buildThreads } from "./CommentsPanel";
import { highlightParts } from "./SearchPage";
import { groupTasks, optimisticPosition } from "./TaskBoard";

function task(id: string, status: TaskDto["status"], position: number): TaskDto {
  return {
    id,
    workspaceId: "ws_1",
    title: id,
    description: "",
    status,
    priority: "medium",
    assignee: null,
    dueDate: null,
    labels: [],
    position,
    documentId: null,
    createdBy: "u",
    createdAt: "",
    updatedAt: "",
  };
}

function comment(id: string, parentId: string | null, createdAt: string): CommentDto {
  return {
    id,
    documentId: "doc_1",
    workspaceId: "ws_1",
    parentId,
    author: null,
    body: id,
    anchor: null,
    resolvedAt: null,
    resolvedBy: null,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("task board helpers", () => {
  it("groups tasks by status ordered by position", () => {
    const columns = groupTasks([task("b", "todo", 2048), task("a", "todo", 1024), task("c", "done", 5)]);
    expect(columns.todo.map((t) => t.id)).toEqual(["a", "b"]);
    expect(columns.done.map((t) => t.id)).toEqual(["c"]);
    expect(columns.review).toEqual([]);
  });

  it("computes optimistic positions matching the server's rules", () => {
    const column = [task("a", "todo", 1024), task("b", "todo", 2048), task("c", "todo", 3072)];
    expect(optimisticPosition(column, null, "x")).toBe(4096);
    expect(optimisticPosition(column, "b", "x")).toBe(1536);
    expect(optimisticPosition(column, "a", "x")).toBe(0);
    // Moving within the same column ignores the moving task itself.
    expect(optimisticPosition(column, null, "c")).toBe(3072);
    expect(optimisticPosition(column, "missing", "x")).toBe(4096);
  });
});

describe("comment threads", () => {
  it("nests replies chronologically under newest-first roots", () => {
    const threads = buildThreads([
      comment("r1", null, "2026-01-01T00:00:00Z"),
      comment("r2", null, "2026-01-02T00:00:00Z"),
      comment("c2", "r1", "2026-01-03T00:00:00Z"),
      comment("c1", "r1", "2026-01-02T12:00:00Z"),
    ]);
    expect(threads.map((t) => t.root.id)).toEqual(["r2", "r1"]);
    expect(threads[1]?.replies.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});

describe("search highlighting", () => {
  it("splits snippets into highlighted parts and ignores bad ranges", () => {
    expect(
      highlightParts("the release checklist", [
        [12, 21],
        [4, 11],
      ]),
    ).toEqual([
      { text: "the ", hit: false },
      { text: "release", hit: true },
      { text: " ", hit: false },
      { text: "checklist", hit: true },
    ]);
    expect(highlightParts("abc", [[2, 10]])).toEqual([{ text: "abc", hit: false }]);
  });
});
