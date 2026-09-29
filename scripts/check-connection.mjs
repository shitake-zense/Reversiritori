// Run locally with `node --env-file=.env.local scripts/check-connection.mjs`.
// Never print keys, tokens, session data, or match rows.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !publishable || !secret) throw new Error("Missing environment variable");
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const browserRole = createClient(url, publishable, options);
const adminRole = createClient(url, secret, options);
const auth = await browserRole.auth.signInAnonymously();
console.log("anonymous auth:", auth.error?.code || (auth.error ? "failed" : "ok"));
const match = await adminRole.from("matches").select("id").limit(1);
console.log("matches table:", match.error?.code || "ok");
const queue = await adminRole.from("queue").select("user_id").limit(1);
console.log("queue table:", queue.error?.code || "ok");
