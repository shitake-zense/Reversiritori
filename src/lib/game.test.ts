import { describe, it, expect } from "vitest";
import { expire, hasLegalMove, initialGame, legalMoves, normalizeWord, play, requestControl, respondControl, setReady, total, type Game } from "./game";

const dictionary = new Set(["ねこ", "こま", "こあ", "こが", "こか", "こがま", "ごま", "こたつやま", "かさ", "さら", "らく", "まこあ", "まさあ"]);
function ready(starter = "ねこ") {
  return setReady(setReady(initialGame(starter, 0, true), 0, new Date(0)), 1, new Date(0));
}
describe("game rules", () => {
  it("normalizes katakana and combining voiced marks but requires written connection", () => {
    expect(normalizeWord(" コガ ")).toBe("こが");
    const g = ready();
    expect(play(g, 0, { word: "コマ", direction: "down" }, new Date(1000), dictionary).kind).toBe("applied");
    expect(play(g, 0, { word: "ごま", direction: "down" }, new Date(1000), dictionary).kind).toBe("invalid");
  });
  it("keeps the shared cell neutral and awards only newly placed kana", () => {
    const g = ready();
    const result = play(g, 0, { word: "こが", direction: "down" }, new Date(1000), dictionary);
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.game.board[g.tail.row][g.tail.col]).toEqual({ kana: "こ", owner: null });
    expect(result.game.scores[0]).toEqual({ cells: 3, first: 0.5, voiced: 0.8 });
    expect(total(result.game.scores[0])).toBe(4.3);
    expect(result.game.releasePoints[0]).toBe(2);
    expect(g.board[result.game.tail.row][result.game.tail.col]).toBeNull();
  });
  it("rejects collision and out of bounds without advancing", () => {
    const g = ready();
    expect(play(g, 0, { word: "こま", direction: "left" }, new Date(1000), dictionary).kind).toBe("invalid");
    const edge: Game = { ...g, tail: { row: 0, col: 7 }, board: g.board.map(r => [...r]) };
    edge.board[0][7] = { kana: "こ", owner: 1 };
    expect(play(edge, 0, { word: "こま", direction: "right" }, new Date(1000), dictionary).kind).toBe("invalid");
  });
  it("passes occupied kana even when letters differ, scores used letters, and lands on empty", () => {
    const first = play(ready(), 0, { word: "こま", direction: "down" }, new Date(1000), dictionary);
    expect(first.kind).toBe("applied");
    if (first.kind !== "applied") return;
    const second = play(first.game, 1, { word: "まさあ", direction: "up" }, new Date(2000), dictionary);
    expect(second.kind).toBe("applied");
    if (second.kind !== "applied") return;
    expect(second.game.board[3][4]).toEqual({ kana: "こ", owner: null });
    expect(second.game.board[4][4]).toEqual({ kana: "ま", owner: 0 });
    expect(second.game.board[2][4]).toEqual({ kana: "あ", owner: 1 });
    expect(second.game.scores[1]).toEqual({ cells: 3, first: 1, voiced: 0 });
    const blocked = { ...first.game, board: first.game.board.map(row => [...row]) };
    blocked.board[2][4] = { kana: "あ", owner: 0 };
    expect(play(blocked, 1, { word: "まさあ", direction: "up" }, new Date(2000), dictionary).kind).toBe("invalid");
  });
  it("keeps opponent ownership and scores a new voiced kana on a traversed cell", () => {
    const g = ready();
    const board = g.board.map(row => [...row]);
    board[4][4] = { kana: "あ", owner: 1 };
    const result = play({ ...g, board }, 0, { word: "こがま", direction: "down" }, new Date(1000), dictionary);
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.game.board[4][4]).toEqual({ kana: "あ", owner: 1 });
    expect(result.game.board[5][4]).toEqual({ kana: "ま", owner: 0 });
    expect(result.game.scores[0]).toEqual({ cells: 3, first: 1, voiced: 0.8 });
    expect(result.game.usedKana).toContain("が");
  });
  it("finds an OFF-mode move through an occupied neighbor", () => {
    const g = initialGame("ねこ", 0, false);
    const board = g.board.map(row => [...row]);
    for (const [r, c] of [[2, 4], [3, 5], [4, 4]]) board[r][c] = { kana: "あ", owner: 1 };
    expect(hasLegalMove({ ...g, board }, [])).toBe(true);
  });
  it("spends release points without lowering score when shifting the opening kana", () => {
    const g: Game = { ...ready(), releasePoints: [5, 0] };
    const result = play(g, 0, { word: "ごま", direction: "down", skill: "shift" }, new Date(1000), dictionary);
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.game.board[g.tail.row][g.tail.col]).toEqual({ kana: "こ", owner: null });
    expect(result.game.releasePoints[0]).toBe(2);
    expect(total(result.game.scores[0])).toBe(3.5);
    expect(result.game.usedKana).toContain("ご");
  });
  it("accepts a five-letter dictionary word only with the extension skill", () => {
    const g: Game = { ...ready(), releasePoints: [7, 0] };
    expect(legalMoves(g, dictionary)).toContainEqual({ word: "こたつやま", direction: "down", skill: "extend" });
    expect(play(g, 0, { word: "こたつやま", direction: "down" }, new Date(1000), dictionary).kind).toBe("invalid");
    const result = play(g, 0, { word: "こたつやま", direction: "down", skill: "extend" }, new Date(1000), dictionary);
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") expect(result.game.tail).toEqual({ row: 7, col: 4 });
  });
  it("overwrites only opposing cells on the path and transfers their cell points", () => {
    const g = ready();
    const board = g.board.map(row => [...row]);
    board[4][4] = { kana: "あ", owner: 1 };
    const started: Game = { ...g, board, scores: [{ cells: 0, first: 0, voiced: 0 }, { cells: 3, first: 0, voiced: 0 }], releasePoints: [10, 0] };
    const result = play(started, 0, { word: "こがま", direction: "down", skill: "overwrite" }, new Date(1000), dictionary);
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.game.board[4][4]).toEqual({ kana: "が", owner: 0 });
    expect(result.game.scores[0].cells).toBe(6);
    expect(result.game.scores[1].cells).toBe(0);
    expect(result.game.board[3][4]).toEqual({ kana: "こ", owner: null });
  });
  it("requires both players for undo, pause, resume and agreed finish", () => {
    const result = play(ready(), 0, { word: "こま", direction: "down" }, new Date(1000), dictionary);
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    const undo = requestControl(result.game, 1, "undo", new Date(2000))!;
    expect(undo.deadlineAt).toBeNull();
    expect(respondControl(undo, 1, true, new Date(3000))).toBeNull();
    const restored = respondControl(undo, 0, true, new Date(3000))!;
    expect(restored.moves).toHaveLength(0);
    expect(restored.board).toEqual(ready().board);
    expect(restored.releasePoints).toEqual([0, 0]);
    expect(restored.deadlineAt).toBe(new Date(23000).toISOString());
    const pause = requestControl(restored, 0, "pause", new Date(4000))!;
    const paused = respondControl(pause, 1, true, new Date(5000))!;
    expect(paused.status).toBe("paused");
    expect(expire(paused, new Date(999999))).toBe(paused);
    const resume = requestControl(paused, 1, "resume", new Date(6000))!;
    const continued = respondControl(resume, 0, true, new Date(7000))!;
    expect(continued.status).toBe("playing");
    const finish = requestControl(continued, 0, "finish", new Date(8000))!;
    expect(respondControl(finish, 1, true, new Date(9000))).toMatchObject({ status: "finished", winner: null, endReason: "agreed" });
  });
  it("returns a refused or expired proposal to the same turn with its remaining time", () => {
    const g = ready();
    const request = requestControl(g, 0, "pause", new Date(5000))!;
    const refused = respondControl(request, 1, false, new Date(6000))!;
    expect(refused.pendingRequest).toBeNull();
    expect(refused.turn).toBe(0);
    expect(refused.deadlineAt).toBe(new Date(21000).toISOString());
    const expired = expire(request, new Date(35000));
    expect(expired.pendingRequest).toBeNull();
    expect(expired.deadlineAt).toBe(new Date(50000).toISOString());
    expect(respondControl(expired, 1, true, new Date(35001))).toBeNull();
  });
  it("ends on repeated word and n before dictionary validation", () => {
    const g = ready();
    expect(play(g, 0, { word: "ねこ", direction: "down" }, new Date(1000), dictionary)).toMatchObject({ kind: "forfeit", game: { endReason: "repeat" } });
    expect(play(g, 0, { word: "こへん", direction: "down" }, new Date(1000), dictionary)).toMatchObject({ kind: "forfeit", game: { endReason: "n-ending" } });
  });
  it("expires at the exact 20-second server deadline and starts after both ready", () => {
    const waiting = initialGame("ねこ", 0, true);
    expect(setReady(waiting, 0, new Date(0)).deadlineAt).toBeNull();
    const g = ready();
    expect(expire(g, new Date(19999))).toBe(g);
    expect(expire(g, new Date(20000))).toMatchObject({ winner: 1, endReason: "timeout" });
  });
  it("places a word diagonally and rejects a diagonal endpoint that is occupied", () => {
    const g = ready();
    const result = play(g, 0, { word: "こま", direction: "upRight" }, new Date(1000), dictionary);
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.game.board[2][5]).toEqual({ kana: "ま", owner: 0 });
    const blocked = { ...g, board: g.board.map(row => [...row]) };
    blocked.board[2][5] = { kana: "あ", owner: 1 };
    expect(play(blocked, 0, { word: "こま", direction: "upRight" }, new Date(1000), dictionary).kind).toBe("invalid");
  });
  it("finishes after exactly 20 moves and compares scores", () => {
    const g: Game = { ...ready(), moves: Array(19).fill({ player: 0, word: "x", direction: "up", placed: [], at: "" }),
      scores: [{ cells: 3, first: 2, voiced: 0 }, { cells: 4, first: 1, voiced: 0 }] };
    const result = play(g, 0, { word: "こあ", direction: "down" }, new Date(1000), dictionary);
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") expect(result.game).toMatchObject({ status: "finished", endReason: "score", winner: 0, version: g.version + 1 });
  });
  it("declares a draw when 20 completed moves leave equal totals", () => {
    const g: Game = { ...ready(), moves: Array(19).fill({ player: 0, word: "x", direction: "up", placed: [], at: "" }),
      scores: [{ cells: 3, first: 2, voiced: 0 }, { cells: 8.5, first: 0, voiced: 0 }] };
    const result = play(g, 0, { word: "こあ", direction: "down" }, new Date(1000), dictionary);
    expect(result).toMatchObject({ kind: "applied", game: { status: "finished", winner: null, endReason: "score" } });
  });
});
