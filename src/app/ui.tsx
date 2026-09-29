"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { normalizeWord, total, type Direction, type Game } from "@/lib/game";

type Snapshot = { id: string; code: string; player: 0 | 1; opponentPresent: boolean; game: Game; serverNow: string };
type Queue = "idle" | "waiting" | "expired";
const kana = [..."あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん"];
const extras = [..."がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽぁぃぅぇぉゃゅょっゎゔー"];
const arrows: Record<Direction, [number, number]> = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
const directionName: Record<Direction, string> = { up: "上", down: "下", left: "左", right: "右" };
const endName: Record<string, string> = { timeout: "時間切れ", repeat: "同じ語の再使用", "n-ending": "末尾「ん」", "no-move": "手詰まり", resign: "降参", score: "20手終了" };

function useClock(deadline: string | null, serverNow: string | null) {
  const [tick, setTick] = useState(0);
  const [offset, setOffset] = useState(0);
  useEffect(() => { if (serverNow) setOffset(Date.parse(serverNow) - Date.now()); }, [serverNow]);
  useEffect(() => {
    const timer = setInterval(() => setTick(v => v + 1), 100);
    return () => clearInterval(timer);
  }, []);
  void tick;
  return deadline ? Math.max(0, (Date.parse(deadline) - Date.now() - offset) / 1000) : null;
}

export default function GameApp() {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [authError, setAuthError] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [queue, setQueue] = useState<Queue>("idle");
  const [dictionary, setDictionary] = useState(true);
  const [joinCode, setJoinCode] = useState("");
  const [word, setWord] = useState("");
  const [direction, setDirection] = useState<Direction>("down");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [connected, setConnected] = useState(true);
  const [serverNow, setServerNow] = useState<string | null>(null);
  const seconds = useClock(snapshot?.game.deadlineAt || null, serverNow);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) { setAuthError("Supabaseの接続設定がありません。管理者に連絡してください。"); return; }
    const supabase = createClient(url, key);
    setClient(supabase);
    let active = true;
    async function signIn() {
      const current = await supabase.auth.getSession();
      const result = current.data.session ? current : await supabase.auth.signInAnonymously();
      if (!active) return;
      if (result.error || !result.data.session) {
        setAuthError("匿名サインインできません。SupabaseのAuthenticationで匿名サインインを有効にしてください。");
      } else setToken(result.data.session.access_token);
    }
    void signIn();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => setToken(session?.access_token || null));
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, []);
  useEffect(() => {
    const sync = () => setConnected(navigator.onLine);
    window.addEventListener("online", sync); window.addEventListener("offline", sync);
    return () => { window.removeEventListener("online", sync); window.removeEventListener("offline", sync); };
  }, []);

  const request = useCallback(async (path: string, method = "GET", body?: object) => {
    if (!client) throw new Error("接続準備中です");
    const session = await client.auth.getSession();
    const access = session.data.session?.access_token || token;
    if (!access) throw new Error("認証の準備中です");
    const response = await fetch(path, { method, headers: { Authorization: `Bearer ${access}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "通信に失敗しました");
    return data;
  }, [client, token]);
  const accept = useCallback((data: Snapshot) => {
    setSnapshot(data); setServerNow(data.serverNow); setQueue("idle"); setMessage("");
    localStorage.setItem("reversiritori_room", data.code);
    const url = new URL(window.location.href);
    url.searchParams.set("room", data.code);
    window.history.replaceState(null, "", url);
  }, []);
  const refresh = useCallback(async (code: string) => {
    const data = await request(`/api/match?code=${encodeURIComponent(code)}`) as Snapshot;
    setSnapshot(data); setServerNow(data.serverNow); setConnected(true);
  }, [request]);
  useEffect(() => {
    if (!token) return;
    const code = new URL(window.location.href).searchParams.get("room") || localStorage.getItem("reversiritori_room");
    if (!code) {
      void request("/api/queue").then(data => {
        if (data.status === "waiting") { setQueue("waiting"); setDictionary(data.dictionary); }
        else if (data.status === "matched") void request("/api/match", "POST", { action: "join", code: data.code }).then(accept).catch(e => setMessage(e.message));
      }).catch(() => {});
      return;
    }
    void request("/api/match", "POST", { action: "join", code }).then(accept).catch(e => {
      setMessage(e.message); localStorage.removeItem("reversiritori_room");
    });
  }, [token, request, accept]);
  useEffect(() => {
    if (!snapshot) return;
    const interval = setInterval(() => { void refresh(snapshot.code).catch(() => setConnected(false)); }, 2500);
    return () => clearInterval(interval);
  }, [snapshot?.code, refresh]);
  useEffect(() => {
    if (!snapshot || !client) return;
    const channel = client.channel(`match-${snapshot.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "matches", filter: `id=eq.${snapshot.id}` },
        () => { void refresh(snapshot.code).catch(() => setConnected(false)); })
      .subscribe(status => setConnected(status === "SUBSCRIBED" || navigator.onLine));
    return () => { void client.removeChannel(channel); };
  }, [snapshot?.id, client, refresh]);
  useEffect(() => {
    if (queue !== "waiting" || !token) return;
    const interval = setInterval(() => {
      void request("/api/queue").then(data => {
        if (data.status === "matched") void request("/api/match", "POST", { action: "join", code: data.code }).then(accept).catch(e => setMessage(e.message));
        else if (data.status === "expired") setQueue("expired");
      }).catch(e => setMessage(e.message));
    }, 2000);
    return () => clearInterval(interval);
  }, [queue, token, request, accept]);

  async function act(action: string, values: object = {}) {
    setBusy(true); setMessage("");
    try {
      if (queue === "waiting" && (action === "create" || action === "join")) {
        const cancelled = await request("/api/queue", "POST", { action: "cancel" });
        if (cancelled.status === "matched") {
          accept(await request("/api/match", "POST", { action: "join", code: cancelled.code }));
          return;
        }
        setQueue("idle");
      }
      const data = await request("/api/match", "POST", { action, ...(snapshot ? { code: snapshot.code } : {}), ...values });
      accept(data);
      if (action === "move") setWord("");
    } catch (e) { setMessage(e instanceof Error ? e.message : "操作に失敗しました"); }
    finally { setBusy(false); }
  }
  async function enterQueue() {
    setBusy(true); setMessage("");
    try {
      const data = await request("/api/queue", "POST", { action: "enter", dictionary });
      if (data.status === "matched") accept(await request("/api/match", "POST", { action: "join", code: data.code }));
      else setQueue("waiting");
    } catch (e) { setMessage(e instanceof Error ? e.message : "待機列へ入れませんでした"); }
    finally { setBusy(false); }
  }
  async function cancelQueue() {
    try {
      const cancelled = await request("/api/queue", "POST", { action: "cancel" });
      if (cancelled.status === "matched") accept(await request("/api/match", "POST", { action: "join", code: cancelled.code }));
      else setQueue("idle");
    }
    catch (e) { setMessage(e instanceof Error ? e.message : "取消できませんでした"); }
  }
  function leaveView() {
    localStorage.removeItem("reversiritori_room");
    const url = new URL(window.location.href); url.searchParams.delete("room");
    window.history.replaceState(null, "", url); setSnapshot(null); setMessage("");
  }
  async function copyInvite() {
    try { await navigator.clipboard.writeText(window.location.href); setMessage("招待URLをコピーしました"); }
    catch { setMessage("URL欄から招待URLをコピーしてください"); }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp") setDirection("up");
      else if (e.key === "ArrowDown") setDirection("down");
      else if (e.key === "ArrowLeft") setDirection("left");
      else if (e.key === "ArrowRight") setDirection("right");
      else return;
      if (document.activeElement?.tagName !== "INPUT") e.preventDefault();
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, []);

  const g = snapshot?.game;
  const required = g?.board[g.tail.row][g.tail.col]?.kana || "";
  const normalized = normalizeWord(word);
  const preview = useMemo(() => {
    const result = new Map<string, { letter: string; occupied: boolean }>();
    if (!g || !normalized.startsWith(required) || !arrows[direction]) return result;
    [...normalized].slice(1).forEach((ch, i) => {
      const [dr, dc] = arrows[direction];
      const row = g.tail.row + dr * (i + 1), col = g.tail.col + dc * (i + 1);
      if (row >= 0 && row < 8 && col >= 0 && col < 8)
        result.set(`${row},${col}`, { letter: ch, occupied: !!g.board[row][col] });
    });
    return result;
  }, [g, normalized, required, direction]);
  const myTurn = !!g && g.status === "playing" && g.turn === snapshot?.player;

  return <main className="app">
    <header className="site-header"><div><p className="eyebrow">ことばの陣取り</p><h1>Reversiritori</h1></div><span className="header-mark" aria-hidden="true">あ<span>→</span>ん</span></header>
    {authError && <div role="alert" className="notice error">{authError}</div>}
    {message && <div role="status" className="notice">{message}</div>}
    {!snapshot ? <section className="lobby panel">
      <div className="lobby-intro"><p className="eyebrow">二人で、言葉をつなぐ。</p><h2>一文字から、陣地が広がる。</h2><p>語尾のマスから言葉を伸ばして、自分のマスと新しい仮名を集めよう。各15秒、合計20手の勝負。</p></div>
      <div className="lobby-controls">
        <fieldset disabled={queue === "waiting" || busy}><legend>辞書チェック</legend><label><input type="radio" checked={dictionary} onChange={() => setDictionary(true)} /> ON <small>一般名詞のみ</small></label><label><input type="radio" checked={!dictionary} onChange={() => setDictionary(false)} /> OFF <small>自由な語</small></label></fieldset>
        <div className="lobby-actions"><button disabled={!token || busy} onClick={() => void act("create", { dictionary })}>部屋を作る</button>
          {queue === "waiting" ? <button className="secondary" onClick={() => void cancelQueue()}>相手を探しています… 取消</button> :
            <button className="secondary" disabled={!token || busy} onClick={() => void enterQueue()}>公開マッチを探す</button>}</div>
        {queue === "expired" && <p role="status">待機が期限切れになりました。もう一度探すか、部屋を作ってください。</p>}
        <form onSubmit={e => { e.preventDefault(); void act("join", { code: joinCode.trim().toUpperCase() }); }}><label htmlFor="join-code">招待コードで参加</label><div className="join-line"><input id="join-code" maxLength={8} autoComplete="off" value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} placeholder="8文字のコード" /><button disabled={!token || busy || joinCode.length !== 8}>参加</button></div></form>
      </div>
    </section> : <>
      <section className="match-head panel"><div><p className="eyebrow">ROOM {snapshot.code}</p><h2>{g?.status === "finished" ? g.winner === null ? "引き分け" : g.winner === snapshot.player ? "勝利！" : "敗北" : myTurn ? "あなたの手番" : g?.status === "waiting" ? "対戦相手を待っています" : "相手の手番"}</h2><p>{g?.status === "finished" ? endName[g.endReason || ""] : `${g?.moves.length || 0} / 20 手 · 辞書 ${g?.dictionary ? "ON" : "OFF"}`}</p></div><div className="head-actions"><span className="connection" role="status">{connected ? "● 接続中" : "○ 再接続中"}</span><button className="text-button" onClick={() => void copyInvite()}>招待URLをコピー</button><button className="text-button" onClick={leaveView}>部屋を閉じる</button></div></section>
      <section className="match-layout">
        <div className="game-area panel"><div className="kana-frame"><KanaRail letters={kana.slice(0, 12)} used={g?.usedKana || []} className="top" /><KanaRail letters={kana.slice(12, 23)} used={g?.usedKana || []} className="left" />
          <div className="board" role="grid" aria-label="8かける8の対戦盤面">{g?.board.map((row, r) => row.map((cell, c) => {
            const tail = g.tail.row === r && g.tail.col === c;
            const ghost = preview.get(`${r},${c}`);
            return <div key={`${r}-${c}`} role="gridcell" className={`cell ${cell?.owner === 0 ? "p1" : cell?.owner === 1 ? "p2" : ""} ${tail ? "tail" : ""} ${ghost && !ghost.occupied ? "ghost" : ""} ${ghost?.occupied ? "through" : ""}`} aria-label={`${r + 1}行${c + 1}列 ${cell?.kana || ghost?.letter || "空"}${tail ? " 語尾" : ""}${ghost?.occupied ? ` 入力文字${ghost.letter}が通過、盤面はそのまま` : ""}${cell ? cell.owner === null ? " 中立" : cell.owner === 0 ? " 先手" : " 後手" : " 空マス"}`}>{cell?.kana || ghost?.letter || ""}{ghost?.occupied && <span className="pass-letter" aria-hidden="true">{ghost.letter} 通過</span>}{tail && <span className="tail-dot" aria-hidden="true" />}</div>;
          }))}</div><KanaRail letters={kana.slice(23, 34)} used={g?.usedKana || []} className="right" /><KanaRail letters={kana.slice(34)} used={g?.usedKana || []} className="bottom" /></div><div className="extra-kana" aria-label="濁音、半濁音、小書き文字の使用状況">{extras.map(ch => <span key={ch} className={g?.usedKana.includes(ch) ? "used" : ""}>{ch}</span>)}</div></div>
        <aside className="side"><div className="panel clock-card"><p className="eyebrow">残り時間</p><strong className={seconds !== null && seconds <= 5 ? "urgent" : ""}>{seconds === null ? "—" : seconds.toFixed(1)}<small>{seconds === null ? "" : "秒"}</small></strong><p>サーバー時刻で確定します</p></div>
          <div className="panel score-card"><p className="eyebrow">SCORE</p>{g?.scores.map((s, i) => <div key={i} className={`score-line ${i === snapshot.player ? "mine" : ""}`}><b>{i === snapshot.player ? "あなた" : "相手"}</b><strong>{total(s)}</strong><small>マス {s.cells} + 新仮名 {s.first} + 濁点 {s.voiced}</small></div>)}</div>
          <div className="panel input-card"><p className="eyebrow">次の言葉</p><h3>「{required}」から始める</h3><p className="hint">2〜4文字。既存マスは文字が違っても通過でき、盤面は変わりません。最後の文字は空マスへ。</p><form onSubmit={e => { e.preventDefault(); void act("move", { word, direction }); }}><label htmlFor="word">言葉</label><input id="word" value={word} onChange={e => setWord(e.target.value)} autoComplete="off" disabled={!myTurn || busy} placeholder={`${required}…`} /><fieldset disabled={!myTurn || busy}><legend>置く方向（矢印キーでも選択）</legend><div className="directions">{(["up", "down", "left", "right"] as Direction[]).map(d => <button type="button" key={d} className={direction === d ? "selected" : ""} aria-pressed={direction === d} onClick={() => setDirection(d)}>{directionName[d]}</button>)}</div></fieldset><button className="submit" disabled={!myTurn || busy || !word.trim()}>この言葉を置く</button></form>
            {g?.status === "waiting" && <div className="ready-box"><p>{snapshot.opponentPresent ? `準備: ${g.ready[0] ? "先手済" : "先手待ち"} / ${g.ready[1] ? "後手済" : "後手待ち"}` : "招待URLまたはコードを相手に送ってください"}</p><button disabled={!snapshot.opponentPresent || g.ready[snapshot.player] || busy} onClick={() => void act("ready")}>準備完了</button></div>}
            {g?.status === "playing" && <button className="text-button resign" disabled={busy} onClick={() => { if (window.confirm("降参しますか？")) void act("resign"); }}>降参する</button>}</div>
        </aside>
      </section>
    </>}
    <section className="rules panel"><h2>遊び方</h2><ol><li>直前の語尾と同じ仮名から始まる2〜4文字の言葉を入力します。</li><li>上下左右へ伸ばします。既存マスは仮名が違っても通過でき、語尾は必ず空マスに置きます。</li><li>新しく埋めたマスは1点。共有した語頭以外で初めて使う仮名は+2点、濁音・半濁音は使うたび+1点です。</li><li>同じ語の再使用・「ん」終わり・時間切れ・手詰まりは負け。20手で高得点が勝ちです。</li></ol><p>辞書OFFでは実在しない語も入力できます。<a href="/IPADIC-COPYING.txt" target="_blank" rel="noreferrer">辞書の出典・ライセンス</a></p></section>
  </main>;
}

function KanaRail({ letters, used, className }: { letters: string[]; used: string[]; className: string }) {
  return <div className={`kana-rail ${className}`} aria-label="仮名の使用状況">{letters.map(ch => <span key={ch} className={used.includes(ch) ? "used" : ""}>{ch}</span>)}</div>;
}
