import { NextResponse } from "next/server";
import { admin, newCode, newGame, userFromRequest } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request) {
  try {
    const user = await userFromRequest(req);
    if (!user) return json({ error: "認証が必要です" }, 401);
    const db = admin();
    const { data, error } = await db.from("queue").select("matched_id, expires_at").eq("user_id", user).maybeSingle();
    if (error) throw error;
    if (!data || Date.parse(data.expires_at) <= Date.now()) return json({ status: "expired" });
    if (!data.matched_id) return json({ status: "waiting" });
    const { data: match, error: matchError } = await db.from("matches").select("code").eq("id", data.matched_id).single();
    if (matchError) throw matchError;
    return json({ status: "matched", code: match.code });
  } catch { return json({ error: "待機状態を取得できませんでした" }, 500); }
}

export async function POST(req: Request) {
  try {
    const user = await userFromRequest(req);
    if (!user) return json({ error: "認証が必要です" }, 401);
    const body = await req.json();
    const db = admin();
    if (body?.action === "cancel") {
      const { data, error } = await db.rpc("cancel_queue", { p_user: user });
      if (error) throw error;
      return json(data);
    }
    if (body?.action !== "enter" || typeof body.dictionary !== "boolean")
      return json({ error: "辞書モードを選んでください" }, 400);
    for (let i = 0; i < 4; i++) {
      const code = newCode();
      const { data, error } = await db.rpc("enter_queue", {
        p_user: user, p_dictionary: body.dictionary, p_code: code, p_state: newGame(body.dictionary),
      });
      if (!error) return data?.status === "mode_mismatch" ? json({ error: "別の辞書モードで待機中です。先に取消してください" }, 409) : json(data);
      if (error.code !== "23505") throw error;
    }
    return json({ error: "待機列へ入れませんでした" }, 503);
  } catch { return json({ error: "待機列を更新できませんでした" }, 500); }
}
