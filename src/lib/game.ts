export type Player = 0 | 1;
export type Owner = Player | null;
export type Direction = "up" | "down" | "left" | "right";
export type Cell = { kana: string; owner: Owner } | null;
export type Position = { row: number; col: number };
export type Score = { cells: number; first: number; voiced: number };
export type EndReason = "score" | "timeout" | "repeat" | "n-ending" | "no-move" | "resign";
export type Game = {
  board: Cell[][];
  tail: Position;
  usedWords: string[];
  usedKana: string[];
  scores: [Score, Score];
  moves: Move[];
  turn: Player;
  status: "waiting" | "playing" | "finished";
  ready: [boolean, boolean];
  dictionary: boolean;
  deadlineAt: string | null;
  winner: Player | null;
  endReason: EndReason | null;
  version: number;
};
export type Move = { player: Player; word: string; direction: Direction; placed: Position[]; at: string };
export type MoveInput = { word: string; direction: Direction };
export type Decision =
  | { kind: "invalid"; reason: string }
  | { kind: "forfeit"; game: Game }
  | { kind: "applied"; game: Game };

const small = new Set([..."ぁぃぅぇぉゃゅょっゎ"]);
const voiced = new Set([..."がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽゔ"]);
const deltas: Record<Direction, Position> = {
  up: { row: -1, col: 0 }, down: { row: 1, col: 0 },
  left: { row: 0, col: -1 }, right: { row: 0, col: 1 },
};
export const directions = Object.keys(deltas) as Direction[];
const format = /^[ぁ-んゔー]{2,4}$/u;
const terminal = (c: string) => c === "ー" || small.has(c);
export const total = (s: Score) => s.cells + s.first + s.voiced;

export function normalizeWord(input: string): string {
  let out = "";
  for (const ch of input.trim().normalize("NFC")) {
    const n = ch.codePointAt(0)!;
    out += n >= 0x30a1 && n <= 0x30f6 ? String.fromCodePoint(n - 0x60) : ch;
  }
  return out.normalize("NFC");
}

export function isDictionaryWord(word: string): boolean {
  const letters = [...word];
  return format.test(word) && letters.length >= 2 && letters.length <= 4 &&
    !terminal(letters[0]) && !terminal(letters.at(-1)!) && letters.at(-1) !== "ん";
}

function inside(p: Position) { return p.row >= 0 && p.row < 8 && p.col >= 0 && p.col < 8; }
function advance(p: Position, d: Direction, n: number): Position {
  return { row: p.row + deltas[d].row * n, col: p.col + deltas[d].col * n };
}

export function initialGame(starter: string, first: Player, dictionary: boolean): Game {
  const word = normalizeWord(starter);
  if (!isDictionaryWord(word)) throw new Error("Invalid starter");
  const board: Cell[][] = Array.from({ length: 8 }, () => Array<Cell>(8).fill(null));
  const col = Math.floor((8 - [...word].length) / 2);
  [...word].forEach((kana, i) => { board[3][col + i] = { kana, owner: null }; });
  return {
    board, tail: { row: 3, col: col + [...word].length - 1 }, usedWords: [word],
    usedKana: [...new Set([...word])], scores: [{ cells: 0, first: 0, voiced: 0 }, { cells: 0, first: 0, voiced: 0 }],
    moves: [], turn: first, status: "waiting", ready: [false, false], dictionary,
    deadlineAt: null, winner: null, endReason: null, version: 0,
  };
}

function finish(game: Game, winner: Player | null, endReason: EndReason, bump = true): Game {
  return { ...game, status: "finished", deadlineAt: null, winner, endReason, version: game.version + (bump ? 1 : 0) };
}

export function setReady(game: Game, player: Player, now: Date): Game {
  if (game.status !== "waiting" || game.ready[player]) return game;
  const ready: [boolean, boolean] = [...game.ready] as [boolean, boolean];
  ready[player] = true;
  return { ...game, ready, status: ready.every(Boolean) ? "playing" : "waiting",
    deadlineAt: ready.every(Boolean) ? new Date(now.getTime() + 15_000).toISOString() : null,
    version: game.version + 1 };
}

export function expire(game: Game, now: Date): Game {
  if (game.status !== "playing" || !game.deadlineAt || now.getTime() < Date.parse(game.deadlineAt)) return game;
  return finish(game, (1 - game.turn) as Player, "timeout");
}

function placement(game: Game, word: string, direction: Direction): Position[] | null {
  if (!deltas[direction] || [...word][0] !== game.board[game.tail.row][game.tail.col]?.kana) return null;
  const letters = [...word].slice(1);
  const cells = letters.map((_, index) => advance(game.tail, direction, index + 1));
  if (!cells.every(p => inside(p))) return null;
  if (game.board[cells.at(-1)!.row][cells.at(-1)!.col] !== null) return null;
  return cells;
}

export function legalMoves(game: Game, words: Iterable<string>): MoveInput[] {
  const tail = game.board[game.tail.row][game.tail.col]?.kana;
  const used = new Set(game.usedWords);
  const result: MoveInput[] = [];
  for (const word of words) {
    if (!word.startsWith(tail || "\0") || used.has(word) || !isDictionaryWord(word)) continue;
    for (const direction of directions) if (placement(game, word, direction)) result.push({ word, direction });
  }
  return result;
}

export function hasLegalMove(game: Game, dictionaryWords: Iterable<string>): boolean {
  if (game.dictionary) return legalMoves(game, dictionaryWords).length > 0;
  const tail = game.board[game.tail.row][game.tail.col]?.kana;
  if (!tail) return false;
  for (const d of directions) {
    for (let step = 1; step <= 3; step++) {
      const p = advance(game.tail, d, step);
      if (!inside(p)) break;
      if (game.board[p.row][p.col]) continue;
      for (const kana of "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわ") {
        if (!game.usedWords.includes(tail + "あ".repeat(step - 1) + kana)) return true;
      }
    }
  }
  return false;
}

export function play(game: Game, player: Player, input: MoveInput, now: Date, dictionaryWords: ReadonlySet<string>): Decision {
  if (game.status !== "playing" || game.turn !== player) return { kind: "invalid", reason: "手番ではありません" };
  const timed = expire(game, now);
  if (timed !== game) return { kind: "forfeit", game: timed };
  const word = normalizeWord(input.word);
  const letters = [...word];
  if (!format.test(word) || letters.length < 2 || letters.length > 4 || terminal(letters[0]) || terminal(letters.at(-1)!))
    return { kind: "invalid", reason: "2〜4文字のひらがなで入力してください。語頭と語尾に小文字・ーは使えません" };
  if (game.usedWords.includes(word)) return { kind: "forfeit", game: finish(game, (1 - player) as Player, "repeat") };
  if (letters.at(-1) === "ん") return { kind: "forfeit", game: finish(game, (1 - player) as Player, "n-ending") };
  if (game.dictionary && !dictionaryWords.has(word)) return { kind: "invalid", reason: "辞書にない言葉です" };
  const cells = placement(game, word, input.direction);
  if (!cells) return { kind: "invalid", reason: "語頭がつながらないか、盤外・語尾の空マス不足があります" };
  const board = game.board.map(row => row.map(cell => cell && { ...cell }));
  const score = { ...game.scores[player] };
  const seen = new Set(game.usedKana);
  letters.slice(1).forEach((kana, i) => {
    const p = cells[i];
    const occupied = board[p.row][p.col] !== null;
    if (!occupied) {
      board[p.row][p.col] = { kana, owner: player };
      score.cells++;
    }
    if (kana !== "ー") {
      if (!seen.has(kana)) score.first += 2;
      if (voiced.has(kana)) score.voiced++;
      seen.add(kana);
    }
  });
  const scores: [Score, Score] = game.scores.map((s, i) => i === player ? score : s) as [Score, Score];
  const next: Game = {
    ...game, board, scores, usedWords: [...game.usedWords, word], usedKana: [...seen],
    tail: cells.at(-1)!, turn: (1 - player) as Player,
    deadlineAt: new Date(now.getTime() + 15_000).toISOString(),
    moves: [...game.moves, { player, word, direction: input.direction, placed: cells, at: now.toISOString() }],
    version: game.version + 1,
  };
  if (next.moves.length === 20) {
    const a = total(scores[0]), b = total(scores[1]);
    return { kind: "applied", game: finish(next, a === b ? null : a > b ? 0 : 1, "score", false) };
  }
  if (!hasLegalMove(next, dictionaryWords)) return { kind: "applied", game: finish(next, player, "no-move", false) };
  return { kind: "applied", game: next };
}

export function resign(game: Game, player: Player): Game {
  if (game.status !== "playing" && game.status !== "waiting") return game;
  return finish(game, (1 - player) as Player, "resign");
}
