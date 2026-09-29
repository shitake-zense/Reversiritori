import { NextResponse } from "next/server";
import { compareAndSwap, admin, dictionaryWords, matchByCode, newCode, newGame, seat, userFromRequest } from "@/lib/server";
import { expire, play, resign, setReady, type Direction, type Game, type Player } from "@/lib/game";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const validCode = (v: unknown) => typeof v === "string" && /^[A-HJ-NP-Z2-9]{8}$/i.test(v);

async function load(code: string, user: string) {
  const db = admin();
  const row = await matchByCode(db, code);
  if (!row) return null;
  const player = seat(row, user);
  return player === null ? null : { db, row, player };
}
function view(row: { id: string; code: string; player1: string; player2: string | null; state: Game }, player: Player, now = new Date()) {
  return { id: row.id, code: row.code, player, opponentPresent: !!row.player2, game: row.state, serverNow: now.toISOString() };
}

export async function GET(req: Request) {
  try {
    const user = await userFromRequest(req);
    if (!user) return json({ error: "認証が必要です" }, 401);
    const code = new URL(req.url).searchParams.get("code");
    if (!validCode(code)) return json({ error: "部屋コードが正しくありません" }, 400);
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await load(code!, user);
      if (!current) return json({ error: "部屋がないか、参加権限がありません" }, 404);
      const now = new Date();
      const next = expire(current.row.state, now);
      if (next === current.row.state) return json(view(current.row, current.player, now));
      const saved = await compareAndSwap(current.db, current.row, next, "expire");
      if (saved) return json(view({ ...current.row, state: saved }, current.player, now));
    }
    return json({ error: "状態が更新されました。再取得してください" }, 409);
  } catch { return json({ error: "状態を取得できませんでした" }, 500); }
}

export async function POST(req: Request) {
  try {
    const user = await userFromRequest(req);
    if (!user) return json({ error: "認証が必要です" }, 401);
    const body = await req.json();
    if (!body || typeof body !== "object") return json({ error: "入力が正しくありません" }, 400);
    const db = admin();
    if (body.action === "create") {
      if (typeof body.dictionary !== "boolean") return json({ error: "辞書モードが必要です" }, 400);
      for (let i = 0; i < 4; i++) {
        const code = newCode(), state = newGame(body.dictionary);
        const { data, error } = await db.from("matches")
          .insert({ code, player1: user, dictionary: body.dictionary, state, version: 0 })
          .select("*").single();
        if (!error) return json(view(data, 0), 201);
        if (error.code !== "23505") throw error;
      }
      return json({ error: "部屋コードを作れませんでした" }, 503);
    }
    if (body.action === "join") {
      if (!validCode(body.code)) return json({ error: "部屋コードが正しくありません" }, 400);
      const existing = await matchByCode(db, body.code);
      if (!existing) return json({ error: "部屋が見つかりません" }, 404);
      const already = seat(existing, user);
      if (already !== null) return json(view(existing, already));
      const { data, error } = await db.rpc("join_invite", { p_code: body.code.toUpperCase(), p_user: user });
      if (error) throw error;
      if (!data) return json({ error: "この部屋には参加できません" }, 409);
      const joined = await matchByCode(db, body.code);
      return json(view(joined!, 1));
    }
    if (!validCode(body.code)) return json({ error: "部屋コードが正しくありません" }, 400);
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await load(body.code, user);
      if (!current) return json({ error: "部屋がないか、参加権限がありません" }, 404);
      const { row, player } = current;
      const now = new Date();
      let next = expire(row.state, now);
      let operation: "expire" | "move" | "ready" | "resign" = "expire";
      if (next === row.state) {
        if (body.action === "ready") {
          if (!row.player2) return json({ error: "対戦相手を待っています" }, 409);
          next = setReady(row.state, player, now);
          operation = "ready";
        } else if (body.action === "move") {
          if (typeof body.word !== "string" || body.word.length > 32 ||
              !["up", "down", "left", "right"].includes(body.direction))
            return json({ error: "単語と方向を指定してください" }, 400);
          const decision = play(row.state, player, { word: body.word, direction: body.direction as Direction }, now, dictionaryWords);
          if (decision.kind === "invalid") return json({ error: decision.reason }, 422);
          next = decision.game;
          operation = "move";
        } else if (body.action === "resign") {
          if (row.state.status !== "playing") return json({ error: "対戦開始後に降参できます" }, 409);
          next = resign(row.state, player);
          operation = "resign";
        } else return json({ error: "操作が正しくありません" }, 400);
      }
      if (next === row.state) return json(view(row, player, now));
      const saved = await compareAndSwap(current.db, row, next, operation);
      if (saved) return json(view({ ...row, state: saved }, player, now));
    }
    return json({ error: "同時更新がありました。再試行してください" }, 409);
  } catch { return json({ error: "操作を確定できませんでした" }, 500); }
}
