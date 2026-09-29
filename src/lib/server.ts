import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import words from "@/data/words.json";
import { initialGame, type Game, type Player } from "./game";

export const dictionaryWords = new Set(words);
const starters = ["りんご", "さくら", "ねこ", "うみ", "そら", "やま", "かわ", "とり", "はな", "ほし", "くも", "ゆき", "さかな"].filter(w => dictionaryWords.has(w));
if (!starters.length) throw new Error("Starter dictionary is empty");
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function publicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase public environment variables are missing");
  return { url, key };
}
export function admin(): SupabaseClient {
  const { url } = publicConfig();
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error("SUPABASE_SECRET_KEY is missing");
  return createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
}
export async function userFromRequest(req: Request): Promise<string | null> {
  const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  const { url, key } = publicConfig();
  const auth = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await auth.auth.getUser(token);
  return error ? null : data.user?.id || null;
}
export function newCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map(v => alphabet[v % alphabet.length]).join("");
}
export function newGame(dictionary: boolean): Game {
  const starter = starters[Math.floor(Math.random() * starters.length)];
  const first = Math.random() < 0.5 ? 0 : 1;
  return initialGame(starter, first as Player, dictionary);
}
export type MatchRow = {
  id: string; code: string; player1: string; player2: string | null;
  dictionary: boolean; state: Game; version: number;
};
export async function matchByCode(db: SupabaseClient, code: string): Promise<MatchRow | null> {
  const { data, error } = await db.from("matches").select("*").eq("code", code.toUpperCase()).maybeSingle();
  if (error) throw error;
  return data as MatchRow | null;
}
export function seat(row: MatchRow, user: string): Player | null {
  return row.player1 === user ? 0 : row.player2 === user ? 1 : null;
}
export async function compareAndSwap(db: SupabaseClient, row: MatchRow, state: Game, operation: "expire" | "move" | "ready" | "resign"): Promise<Game | null> {
  const { data, error } = await db.rpc("commit_match_state", {
    p_id: row.id, p_version: row.version, p_state: state, p_operation: operation,
  });
  if (error) throw error;
  return data as Game | null;
}
