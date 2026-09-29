import words from "../src/data/words.json";
import { initialGame, legalMoves, play, setReady, total, type Game, type MoveInput } from "../src/lib/game";

const dictionary = new Set(words);
const starters = ["りんご", "さくら", "ねこ", "うみ", "そら", "やま", "かわ", "とり", "はな", "ほし", "くも", "ゆき", "さかな"].filter(w => dictionary.has(w));
if (!starters.length) throw new Error("No starter in dictionary");
let seed = 92729;
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; }
function choose(game: Game): MoveInput | null {
  const moves = legalMoves(game, words);
  if (!moves.length) return null;
  if (process.argv[3] === "short") {
    const shortest = moves.filter(m => m.word.length === 2);
    return (shortest.length ? shortest : moves)[Math.floor(random() * (shortest.length || moves.length))];
  }
  // Human-like candidate choice: usually among a small random sample, occasionally longer.
  const sample = Array.from({ length: Math.min(8, moves.length) }, () => moves[Math.floor(random() * moves.length)]);
  return random() < 0.4 ? sample.sort((a, b) => b.word.length - a.word.length)[0] : sample[0];
}
const N = Number(process.argv[2] || 200);
let twenty = 0, turns = 0, cells = 0, firstDelta = 0, noMove = 0, blocked = 0, noWord = 0;
const tailCounts = new Map<string, number>();
for (let i = 0; i < N; i++) {
  const starter = starters[Math.floor(random() * starters.length)];
  let game = initialGame(starter, (i % 2) as 0 | 1, true);
  game = setReady(setReady(game, 0, new Date(0)), 1, new Date(0));
  for (let n = 0; n < 20 && game.status === "playing"; n++) {
    const move = choose(game);
    if (!move) throw new Error("Playing game without legal move");
    const decision = play(game, game.turn, move, new Date(n * 1000), dictionary);
    if (decision.kind !== "applied") throw new Error(JSON.stringify(decision));
    game = decision.game;
  }
  if (game.moves.length === 20) twenty++;
  if (game.endReason === "no-move") {
    noMove++;
    const reachable = [[1,0],[-1,0],[0,1],[0,-1]].some(([dr,dc]) => {
      return [1,2,3].some(step => {
        const row = game.tail.row + dr * step, col = game.tail.col + dc * step;
        return row >= 0 && row < 8 && col >= 0 && col < 8 && !game.board[row][col];
      });
    });
    if (reachable) noWord++; else blocked++;
    const tail = game.board[game.tail.row][game.tail.col]?.kana || "?";
    tailCounts.set(tail, (tailCounts.get(tail) || 0) + 1);
  }
  turns += game.moves.length;
  cells += game.scores[0].cells + game.scores[1].cells;
  const first = i % 2;
  firstDelta += total(game.scores[first]) - total(game.scores[1 - first]);
}
console.log(JSON.stringify({ games: N, reached20: twenty, reached20Rate: twenty / N,
  noMove, blocked, noWord, averageTurns: turns / N, averageClaimedCells: cells / N,
  averageFirstPlayerScoreAdvantage: firstDelta / N,
  commonDeadEnds: [...tailCounts].sort((a, b) => b[1] - a[1]).slice(0, 12) }, null, 2));
