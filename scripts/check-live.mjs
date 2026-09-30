// Run against a configured development server: node --env-file=.env.local scripts/check-live.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const base = process.argv[2] || "http://localhost:3000";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
assert(url && key, "Supabase public environment variables are required");

async function participant() {
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await db.auth.signInAnonymously();
  assert.ifError(error);
  assert(data.session?.access_token);
  return { db, token: data.session.access_token, id: data.user.id };
}

async function api(person, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${person.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  assert(response.ok, `${path}: HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

function legalMove(game, words) {
  const { row, col } = game.tail;
  const tail = game.board[row][col].kana;
  for (const word of words) {
    if (word.length > 4 || !word.startsWith(tail) || game.usedWords.includes(word)) continue;
    for (const [direction, dr, dc] of [["up", -1, 0], ["upRight", -1, 1], ["right", 0, 1], ["downRight", 1, 1], ["down", 1, 0], ["downLeft", 1, -1], ["left", 0, -1], ["upLeft", -1, -1]]) {
      const endRow = row + dr * (word.length - 1), endCol = col + dc * (word.length - 1);
      if (endRow >= 0 && endRow < 8 && endCol >= 0 && endCol < 8 && !game.board[endRow][endCol])
        return { word, direction };
    }
  }
  throw new Error("No legal dictionary move found");
}

const [one, two, outsider] = await Promise.all([participant(), participant(), participant()]);
const created = await api(one, "/api/match", { action: "create", dictionary: true });
assert.equal(created.player, 0);
const joined = await api(two, "/api/match", { action: "join", code: created.code });
assert.equal(joined.player, 1);
assert.equal(joined.game.version, created.game.version + 1);

const { data: participantRow, error: participantError } = await one.db.from("matches").select("id").eq("id", created.id).maybeSingle();
assert.ifError(participantError);
assert.equal(participantRow?.id, created.id);
const { data: outsiderRow, error: outsiderError } = await outsider.db.from("matches").select("id").eq("id", created.id).maybeSingle();
assert.ifError(outsiderError);
assert.equal(outsiderRow, null);
const outsiderApi = await fetch(`${base}/api/match?code=${created.code}`, { headers: { Authorization: `Bearer ${outsider.token}` } });
assert.equal(outsiderApi.status, 404);
const { error: directWriteError } = await one.db.from("matches").update({ code: created.code }).eq("id", created.id);
assert(directWriteError, "Client-side match writes must be denied");
const { error: directRpcError } = await outsider.db.rpc("join_invite", { p_code: created.code, p_user: outsider.id });
assert(directRpcError, "Client-side state-changing RPCs must be denied");

const readyOne = await api(one, "/api/match", { action: "ready", code: created.code });
assert.equal(readyOne.game.status, "waiting");
const readyTwo = await api(two, "/api/match", { action: "ready", code: created.code });
assert.equal(readyTwo.game.status, "playing");
assert(readyTwo.game.deadlineAt);
const initialSeconds = (Date.parse(readyTwo.game.deadlineAt) - Date.parse(readyTwo.serverNow)) / 1000;
assert(initialSeconds > 19 && initialSeconds <= 20.5, `A new turn must last 20 seconds, got ${initialSeconds}`);
const words = JSON.parse(await readFile(new URL("../src/data/words.json", import.meta.url), "utf8"));
const move = legalMove(readyTwo.game, words);
const current = readyTwo.game.turn === 0 ? one : two;
const sameMove = { action: "move", code: created.code, ...move };
const simultaneous = await Promise.all([0, 1].map(async () => {
  const response = await fetch(`${base}/api/match`, {
    method: "POST",
    headers: { Authorization: `Bearer ${current.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(sameMove),
  });
  return { status: response.status, value: await response.json() };
}));
assert.equal(simultaneous.filter(result => result.status === 200).length, 1, "Exactly one simultaneous move must commit");
const moved = simultaneous.find(result => result.status === 200).value;
assert.equal(moved.game.moves.length, 1);
assert.equal(moved.game.version, readyTwo.game.version + 1);
assert(moved.game.scores[readyTwo.game.turn].cells >= 1);
const afterRace = await api(current, `/api/match?code=${created.code}`);
assert.equal(afterRace.game.moves.length, 1);

const undoOffer = await api(one, "/api/match", { action: "control_request", code: created.code, kind: "undo" });
assert.equal(undoOffer.game.pendingRequest.kind, "undo");
assert.equal(undoOffer.game.deadlineAt, null);
const undone = await api(two, "/api/match", { action: "control_respond", code: created.code, accept: true });
assert.equal(undone.game.moves.length, 0);
assert.deepEqual(undone.game.releasePoints, [0, 0]);
assert.equal(undone.game.status, "playing");
const pauseOffer = await api(one, "/api/match", { action: "control_request", code: created.code, kind: "pause" });
assert.equal(pauseOffer.game.pendingRequest.kind, "pause");
const paused = await api(two, "/api/match", { action: "control_respond", code: created.code, accept: true });
assert.equal(paused.game.status, "paused");
assert.equal(paused.game.deadlineAt, null);
const resumeOffer = await api(one, "/api/match", { action: "control_request", code: created.code, kind: "resume" });
assert.equal(resumeOffer.game.pendingRequest.kind, "resume");
const resumed = await api(two, "/api/match", { action: "control_respond", code: created.code, accept: true });
assert.equal(resumed.game.status, "playing");
assert(resumed.game.deadlineAt);
const finishOffer = await api(one, "/api/match", { action: "control_request", code: created.code, kind: "finish" });
assert.equal(finishOffer.game.pendingRequest.kind, "finish");
const ended = await api(two, "/api/match", { action: "control_respond", code: created.code, accept: true });
assert.equal(ended.game.status, "finished");
assert.equal(ended.game.endReason, "agreed");
assert.equal(ended.game.winner, null);

const waiting = await api(one, "/api/queue", { action: "enter", dictionary: false });
assert.equal(waiting.status, "waiting");
const duplicateWait = await api(one, "/api/queue", { action: "enter", dictionary: false });
assert.equal(duplicateWait.status, "waiting");
const otherMode = await api(outsider, "/api/queue", { action: "enter", dictionary: true });
assert.equal(otherMode.status, "waiting", "Different dictionary modes must not be paired");
const cancelled = await api(outsider, "/api/queue", { action: "cancel" });
assert.equal(cancelled.status, "cancelled");
const paired = await api(two, "/api/queue", { action: "enter", dictionary: false });
assert.equal(paired.status, "matched");
const recovered = await api(one, "/api/queue");
assert.deepEqual(recovered, paired);
const queueJoined = await api(one, "/api/match", { action: "join", code: paired.code });
assert.equal(queueJoined.player, 0);
console.log("Live checks passed: invitation, privacy, readiness, concurrent move, undo, pause, resume, agreed finish, and separated public queues.");
