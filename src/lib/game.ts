export type Player = 0 | 1;
export type Owner = Player | null;
export type Direction = "up" | "upRight" | "right" | "downRight" | "down" | "downLeft" | "left" | "upLeft";
export type Cell = { kana: string; owner: Owner } | null;
export type Position = { row: number; col: number };
export type Score = { cells: number; first: number; voiced: number };
export type Skill = "shift" | "extend" | "overwrite";
export const skillCost: Record<Skill, number> = { shift: 5, extend: 7, overwrite: 10 };
export const cellPoints = 3;
export const newKanaPoints = 0.5;
export const voicedPoints = 0.8;
export type EndReason = "score" | "timeout" | "repeat" | "n-ending" | "no-move" | "resign" | "agreed";
export type ControlKind = "undo" | "pause" | "resume" | "finish";
export type ControlRequest = { kind: ControlKind; by: Player; expiresAt: string; remainingMs: number };
export type MoveBefore = Pick<Game, "board" | "tail" | "usedWords" | "usedKana" | "scores" | "releasePoints" | "turn">;
export type Game = {
  board: Cell[][];
  tail: Position;
  usedWords: string[];
  usedKana: string[];
  scores: [Score, Score];
  releasePoints: [number, number];
  moves: Move[];
  turn: Player;
  status: "waiting" | "playing" | "paused" | "finished";
  ready: [boolean, boolean];
  dictionary: boolean;
  deadlineAt: string | null;
  remainingMs: number | null;
  pendingRequest: ControlRequest | null;
  winner: Player | null;
  endReason: EndReason | null;
  version: number;
};
export type Move = { player: Player; word: string; direction: Direction; placed: Position[]; at: string; skill?: Skill | null; before?: MoveBefore };
export type MoveInput = { word: string; direction: Direction; skill?: Skill | null };
export type Decision =
  | { kind: "invalid"; reason: string }
  | { kind: "forfeit"; game: Game }
  | { kind: "applied"; game: Game };

const small = new Set([..."ぁぃぅぇぉゃゅょっゎ"]);
const voiced = new Set([..."がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽゔ"]);
const voiceGroups = ["かが", "きぎ", "くぐ", "けげ", "こご", "さざ", "しじ", "すず", "せぜ", "そぞ", "ただ", "ちぢ", "つづ", "てで", "とど", "はばぱ", "ひびぴ", "ふぶぷ", "へべぺ", "ほぼぽ", "うゔ"];
const deltas: Record<Direction, Position> = {
  up: { row: -1, col: 0 }, down: { row: 1, col: 0 },
  left: { row: 0, col: -1 }, right: { row: 0, col: 1 },
  upRight: { row: -1, col: 1 }, downRight: { row: 1, col: 1 },
  downLeft: { row: 1, col: -1 }, upLeft: { row: -1, col: -1 },
};
export const directions = Object.keys(deltas) as Direction[];
const format = /^[ぁ-んゔー]{2,6}$/u;
const terminal = (c: string) => c === "ー" || small.has(c);
export const total = (s: Score) => Math.round((s.cells + s.first + s.voiced) * 10) / 10;
export function canShift(from: string, to: string): boolean {
  return from !== to && voiceGroups.some(group => group.includes(from) && group.includes(to));
}

export function normalizeWord(input: string): string {
  let out = "";
  for (const ch of input.trim().normalize("NFC")) {
    const n = ch.codePointAt(0)!;
    out += n >= 0x30a1 && n <= 0x30f6 ? String.fromCodePoint(n - 0x60) : ch;
  }
  return out.normalize("NFC");
}

export function isDictionaryWord(word: string, maxLength = 4): boolean {
  const letters = [...word];
  return format.test(word) && letters.length >= 2 && letters.length <= maxLength &&
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
    releasePoints: [0, 0],
    moves: [], turn: first, status: "waiting", ready: [false, false], dictionary,
    deadlineAt: null, remainingMs: null, pendingRequest: null,
    winner: null, endReason: null, version: 0,
  };
}

function finish(game: Game, winner: Player | null, endReason: EndReason, bump = true): Game {
  return { ...game, status: "finished", deadlineAt: null, remainingMs: null, pendingRequest: null,
    winner, endReason, version: game.version + (bump ? 1 : 0) };
}

export function setReady(game: Game, player: Player, now: Date): Game {
  if (game.status !== "waiting" || game.ready[player]) return game;
  const ready: [boolean, boolean] = [...game.ready] as [boolean, boolean];
  ready[player] = true;
  return { ...game, ready, status: ready.every(Boolean) ? "playing" : "waiting",
    deadlineAt: ready.every(Boolean) ? new Date(now.getTime() + 20_000).toISOString() : null,
    version: game.version + 1 };
}

export function expire(game: Game, now: Date): Game {
  if (game.pendingRequest && now.getTime() >= Date.parse(game.pendingRequest.expiresAt))
    return rejectControl(game, now);
  if (game.status !== "playing" || !game.deadlineAt || now.getTime() < Date.parse(game.deadlineAt)) return game;
  return finish(game, (1 - game.turn) as Player, "timeout");
}

function rejectControl(game: Game, now: Date): Game {
  const pending = game.pendingRequest!;
  return { ...game, pendingRequest: null,
    deadlineAt: game.status === "playing" ? new Date(now.getTime() + pending.remainingMs).toISOString() : null,
    version: game.version + 1 };
}

export function requestControl(game: Game, player: Player, kind: ControlKind, now: Date): Game | null {
  if (game.pendingRequest || (game.status !== "playing" && game.status !== "paused")) return null;
  if (game.status === "paused" ? kind !== "resume" : kind === "resume") return null;
  if (kind === "undo" && !game.moves.at(-1)?.before) return null;
  const remainingMs = game.status === "paused" ? game.remainingMs ?? 20_000
    : Math.max(0, Date.parse(game.deadlineAt!) - now.getTime());
  if (game.status === "playing" && remainingMs <= 0) return null;
  return { ...game, deadlineAt: null, pendingRequest: { kind, by: player,
    expiresAt: new Date(now.getTime() + 30_000).toISOString(), remainingMs }, version: game.version + 1 };
}

export function respondControl(game: Game, player: Player, accept: boolean, now: Date): Game | null {
  const request = game.pendingRequest;
  if (!request || now.getTime() >= Date.parse(request.expiresAt)) return null;
  if (accept && request.by === player) return null;
  if (!accept) return rejectControl(game, now);
  if (request.kind === "pause") return { ...game, status: "paused", pendingRequest: null,
    remainingMs: request.remainingMs, version: game.version + 1 };
  if (request.kind === "resume") return { ...game, status: "playing", pendingRequest: null,
    deadlineAt: new Date(now.getTime() + request.remainingMs).toISOString(), remainingMs: null,
    version: game.version + 1 };
  if (request.kind === "finish") return finish(game, null, "agreed");
  const last = game.moves.at(-1);
  if (!last?.before) return null;
  return { ...game, ...last.before, moves: game.moves.slice(0, -1), status: "playing", pendingRequest: null,
    remainingMs: null, deadlineAt: new Date(now.getTime() + 20_000).toISOString(),
    winner: null, endReason: null, version: game.version + 1 };
}

function placement(game: Game, word: string, direction: Direction, skill?: Skill | null): Position[] | null {
  const first = [...word][0], tail = game.board[game.tail.row][game.tail.col]?.kana;
  if (!deltas[direction] || !tail || !(skill === "shift" ? canShift(tail, first) : first === tail)) return null;
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
  const points = game.releasePoints?.[game.turn] || 0;
  for (const word of words) {
    if (!tail || used.has(word) || !isDictionaryWord(word, 6)) continue;
    const skills: (Skill | null)[] = [];
    if (word.startsWith(tail) && word.length <= 4) skills.push(null);
    if (points >= skillCost.shift && word.length <= 4 && canShift(tail, word[0])) skills.push("shift");
    if (points >= skillCost.extend && word.length >= 5 && word.startsWith(tail)) skills.push("extend");
    if (points >= skillCost.overwrite && word.length <= 4 && word.startsWith(tail)) skills.push("overwrite");
    for (const skill of skills) for (const direction of directions) {
      const cells = placement(game, word, direction, skill);
      if (cells && (skill !== "overwrite" || cells.some(p => game.board[p.row][p.col]?.owner === (1 - game.turn))))
        result.push({ word, direction, skill });
    }
  }
  return result;
}

export function hasLegalMove(game: Game, dictionaryWords: Iterable<string>): boolean {
  if (game.dictionary) return legalMoves(game, dictionaryWords).length > 0;
  const tail = game.board[game.tail.row][game.tail.col]?.kana;
  if (!tail) return false;
  for (const d of directions) {
    for (let step = 1; step <= ((game.releasePoints?.[game.turn] || 0) >= 7 ? 5 : 3); step++) {
      const p = advance(game.tail, d, step);
      if (!inside(p)) break;
      if (game.board[p.row][p.col]) continue;
      for (const kana of "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわ") {
        const word = tail + "あ".repeat(step - 1) + kana;
        if (!game.usedWords.includes(word) && (step <= 3 || (game.releasePoints?.[game.turn] || 0) >= 7)) return true;
      }
    }
  }
  return false;
}

export function play(game: Game, player: Player, input: MoveInput, now: Date, dictionaryWords: ReadonlySet<string>): Decision {
  if (game.status !== "playing" || game.pendingRequest || game.turn !== player) return { kind: "invalid", reason: "手番ではありません" };
  const timed = expire(game, now);
  if (timed !== game) return { kind: "forfeit", game: timed };
  const word = normalizeWord(input.word);
  const letters = [...word];
  const skill = input.skill || null;
  if (skill && !Object.hasOwn(skillCost, skill)) return { kind: "invalid", reason: "スキルが正しくありません" };
  const maxLength = skill === "extend" ? 6 : 4;
  if (!format.test(word) || letters.length < 2 || letters.length > maxLength || terminal(letters[0]) || terminal(letters.at(-1)!))
    return { kind: "invalid", reason: `2〜${maxLength}文字のひらがなで入力してください。語頭と語尾に小文字・ーは使えません` };
  if (game.usedWords.includes(word)) return { kind: "forfeit", game: finish(game, (1 - player) as Player, "repeat") };
  if (letters.at(-1) === "ん") return { kind: "forfeit", game: finish(game, (1 - player) as Player, "n-ending") };
  if (skill && (game.releasePoints?.[player] || 0) < skillCost[skill]) return { kind: "invalid", reason: "文字解放ポイントが足りません" };
  if (skill === "extend" && letters.length <= 4) return { kind: "invalid", reason: "長い言葉のスキルは5〜6文字で使えます" };
  if (game.dictionary && !dictionaryWords.has(word)) return { kind: "invalid", reason: "辞書にない言葉です" };
  const cells = placement(game, word, input.direction, skill);
  if (!cells) return { kind: "invalid", reason: "語頭がつながらないか、盤外・語尾の空マス不足があります" };
  if (skill === "overwrite" && !cells.some(p => game.board[p.row][p.col]?.owner === (1 - player)))
    return { kind: "invalid", reason: "経路に相手のマスがありません" };
  const board = game.board.map(row => row.map(cell => cell && { ...cell }));
  const score = { ...game.scores[player] };
  const opponentScore = { ...game.scores[1 - player] };
  const releasePoints: [number, number] = [...(game.releasePoints || [0, 0])] as [number, number];
  if (skill) releasePoints[player] -= skillCost[skill];
  const seen = new Set(game.usedKana);
  if (skill === "shift") seen.add(letters[0]);
  letters.slice(1).forEach((kana, i) => {
    const p = cells[i];
    const occupied = board[p.row][p.col] !== null;
    if (!occupied) {
      board[p.row][p.col] = { kana, owner: player };
      score.cells += cellPoints;
    } else if (skill === "overwrite" && board[p.row][p.col]?.owner === (1 - player)) {
      board[p.row][p.col] = { kana, owner: player };
      opponentScore.cells -= cellPoints;
      score.cells += cellPoints;
    }
    if (kana !== "ー") {
      if (!seen.has(kana)) { score.first += newKanaPoints; releasePoints[player] += 2; }
      if (voiced.has(kana)) score.voiced = Math.round((score.voiced + voicedPoints) * 10) / 10;
      seen.add(kana);
    }
  });
  const scores: [Score, Score] = game.scores.map((s, i) => i === player ? score : opponentScore) as [Score, Score];
  const next: Game = {
    ...game, board, scores, releasePoints, usedWords: [...game.usedWords, word], usedKana: [...seen],
    tail: cells.at(-1)!, turn: (1 - player) as Player,
    deadlineAt: new Date(now.getTime() + 20_000).toISOString(),
    moves: [...game.moves, { player, word, direction: input.direction, placed: cells, at: now.toISOString(), skill,
      before: { board: game.board, tail: game.tail, usedWords: game.usedWords, usedKana: game.usedKana,
        scores: game.scores, releasePoints: game.releasePoints || [0, 0], turn: game.turn } }],
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
  if (game.status !== "playing" && game.status !== "paused" && game.status !== "waiting") return game;
  return finish(game, (1 - player) as Player, "resign");
}
