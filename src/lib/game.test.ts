import { describe, it, expect } from "vitest";
import { expire, initialGame, normalizeWord, play, setReady, total, type Game } from "./game";

const dictionary = new Set(["ねこ", "こま", "こあ", "こが", "こか", "こがま", "かさ", "さら", "らく", "まこあ", "まさあ"]);
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
    expect(result.game.scores[0]).toEqual({ cells: 1, first: 2, voiced: 1 });
    expect(total(result.game.scores[0])).toBe(4);
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
    expect(second.game.scores[1]).toEqual({ cells: 1, first: 4, voiced: 0 });
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
    expect(result.game.scores[0]).toEqual({ cells: 1, first: 4, voiced: 1 });
    expect(result.game.usedKana).toContain("が");
  });
  it("ends on repeated word and n before dictionary validation", () => {
    const g = ready();
    expect(play(g, 0, { word: "ねこ", direction: "down" }, new Date(1000), dictionary)).toMatchObject({ kind: "forfeit", game: { endReason: "repeat" } });
    expect(play(g, 0, { word: "こへん", direction: "down" }, new Date(1000), dictionary)).toMatchObject({ kind: "forfeit", game: { endReason: "n-ending" } });
  });
  it("expires at the exact server deadline and starts after both ready", () => {
    const waiting = initialGame("ねこ", 0, true);
    expect(setReady(waiting, 0, new Date(0)).deadlineAt).toBeNull();
    const g = ready();
    expect(expire(g, new Date(14999))).toBe(g);
    expect(expire(g, new Date(15000))).toMatchObject({ winner: 1, endReason: "timeout" });
  });
  it("finishes after exactly 20 moves and compares scores", () => {
    const g: Game = { ...ready(), moves: Array(19).fill({ player: 0, word: "x", direction: "up", placed: [], at: "" }),
      scores: [{ cells: 3, first: 2, voiced: 0 }, { cells: 4, first: 1, voiced: 0 }] };
    const result = play(g, 0, { word: "こあ", direction: "down" }, new Date(1000), dictionary);
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") expect(result.game).toMatchObject({ status: "finished", endReason: "score", winner: 0, version: g.version + 1 });
  });
});
