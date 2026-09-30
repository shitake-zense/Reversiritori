// Run against a configured server: node --env-file=.env.local scripts/check-full-game.mjs [base-url]
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const base = process.argv[2] || "http://localhost:3000";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
assert(url && key, "Supabase public environment variables are required");
const words = JSON.parse(await readFile(new URL("../src/data/words.json", import.meta.url), "utf8"));
const vectors = [["up", -1, 0], ["upRight", -1, 1], ["right", 0, 1], ["downRight", 1, 1], ["down", 1, 0], ["downLeft", 1, -1], ["left", 0, -1], ["upLeft", -1, -1]];

async function player() {
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await db.auth.signInAnonymously();
  assert.ifError(error);
  assert(data.session?.access_token);
  return data.session.access_token;
}
async function post(token, body) {
  const response = await fetch(`${base}/api/match`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  assert(response.ok, `HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}
function available(game) {
  const { row, col } = game.tail;
  const tail = game.board[row][col].kana;
  const used = new Set(game.usedWords);
  const candidates = [];
  for (const word of words) {
    if (word.length > 4 || word[0] !== tail || used.has(word)) continue;
    for (const [direction, dr, dc] of vectors) {
      const r = row + dr * (word.length - 1), c = col + dc * (word.length - 1);
      if (r < 0 || r > 7 || c < 0 || c > 7 || game.board[r][c]) continue;
      const nearby = vectors.reduce((sum, [, vr, vc]) => {
        for (let distance = 1; distance <= 3; distance++) {
          const nr = r + vr * distance, nc = c + vc * distance;
          if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && !game.board[nr][nc]) return sum + 1;
        }
        return sum;
      }, 0);
      candidates.push({ word, direction, nearby });
    }
  }
  candidates.sort((a, b) => a.word.length - b.word.length || b.nearby - a.nearby);
  return candidates;
}

for (let attempt = 1; attempt <= 3; attempt++) {
  const [first, second] = await Promise.all([player(), player()]);
  let state = await post(first, { action: "create", dictionary: true });
  await post(second, { action: "join", code: state.code });
  await post(first, { action: "ready", code: state.code });
  state = await post(second, { action: "ready", code: state.code });
  while (state.game.status === "playing" && state.game.moves.length < 20) {
    const move = available(state.game)[0];
    assert(move, "A playing game must have a legal move");
    const token = state.game.turn === 0 ? first : second;
    state = await post(token, { action: "move", code: state.code, word: move.word, direction: move.direction });
  }
  if (state.game.moves.length === 20) {
    assert.equal(state.game.status, "finished");
    assert.equal(state.game.endReason, "score");
    console.log(`Full-game check passed: 20 moves, winner ${state.game.winner === null ? "draw" : state.game.winner + 1}.`);
    process.exit(0);
  }
}
throw new Error("Three live dictionary games ended before 20 moves");
