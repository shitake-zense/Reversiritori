"use client";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { canShift, cellPoints, newKanaPoints, normalizeWord, skillCost, total, voicedPoints, type ControlKind, type Direction, type Game, type Skill } from "@/lib/game";

type Snapshot = { id: string; code: string; player: 0 | 1; opponentPresent: boolean; game: Game; serverNow: string };
type Queue = "idle" | "waiting" | "expired";
const kana = [..."あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん"];
const extras = [..."がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽゔぁぃぅぇぉゃゅょっゎー"];
const perimeter = [...kana, ...extras];
const arrows: Record<Direction, [number, number]> = { up: [-1, 0], upRight: [-1, 1], right: [0, 1], downRight: [1, 1], down: [1, 0], downLeft: [1, -1], left: [0, -1], upLeft: [-1, -1] };
const directionName: Record<Direction, string> = { up: "上", upRight: "右上", right: "右", downRight: "右下", down: "下", downLeft: "左下", left: "左", upLeft: "左上" };
const directionGlyph: Record<Direction, string> = { up: "↑", upRight: "↗", right: "→", downRight: "↘", down: "↓", downLeft: "↙", left: "←", upLeft: "↖" };
const padDirections: (Direction | null)[] = ["upLeft", "up", "upRight", "left", null, "right", "downLeft", "down", "downRight"];
const skillName: Record<Skill, string> = { shift: "濁音変換", extend: "6文字まで", overwrite: "相手マス上書き" };
const controlName: Record<ControlKind, string> = { undo: "1手戻る", pause: "中断", resume: "再開", finish: "引き分けで終了" };
const endName: Record<string, string> = { timeout: "時間切れ", repeat: "同じ語の再使用", "n-ending": "末尾「ん」", "no-move": "手詰まり", resign: "降参", agreed: "双方合意で終了", score: "20手終了" };

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
  const [skill, setSkill] = useState<Skill | null>(null);
  const [showHelp, setShowHelp] = useState(false);
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
      if (action === "move") { setWord(""); setSkill(null); }
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
      if (document.activeElement?.tagName === "INPUT") return;
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
      const vertical = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
      const horizontal = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
      const dr = vertical || (e.shiftKey ? arrows[direction][0] : 0);
      const dc = horizontal || (e.shiftKey ? arrows[direction][1] : 0);
      const next = (Object.entries(arrows) as [Direction, [number, number]][]).find(([, [r, c]]) => r === dr && c === dc);
      if (next) setDirection(next[0]);
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [direction]);
  useEffect(() => {
    if (!showHelp) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowHelp(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showHelp]);

  const g = snapshot?.game;
  const required = g?.board[g.tail.row][g.tail.col]?.kana || "";
  const normalized = normalizeWord(word);
  const preview = useMemo(() => {
    const result = new Map<string, { letter: string; occupied: boolean }>();
    if (!g || !(skill === "shift" ? canShift(required, normalized[0]) : normalized.startsWith(required)) || !arrows[direction]) return result;
    [...normalized].slice(1).forEach((ch, i) => {
      const [dr, dc] = arrows[direction];
      const row = g.tail.row + dr * (i + 1), col = g.tail.col + dc * (i + 1);
      if (row >= 0 && row < 8 && col >= 0 && col < 8)
        result.set(`${row},${col}`, { letter: ch, occupied: !!g.board[row][col] });
    });
    return result;
  }, [g, normalized, required, direction, skill]);
  const lastPath = useMemo(() => {
    const move = g?.moves.at(-1);
    if (!move) return new Set<string>();
    const cells = move.before?.tail ? [move.before.tail, ...move.placed] : move.placed;
    return new Set(cells.map(p => `${p.row},${p.col}`));
  }, [g]);
  const myTurn = !!g && g.status === "playing" && !g.pendingRequest && g.turn === snapshot?.player;
  const timerStyle = { "--timer-progress": `${Math.max(0, Math.min(100, (seconds ?? 20) * 5))}%` } as CSSProperties;

  return <main className={`app ${snapshot ? "in-match" : ""}`}>
    <header className="site-header"><div><p className="eyebrow">ことばの陣取り</p><h1>Reversiritori</h1></div><button className="help-button secondary" onClick={() => setShowHelp(true)} aria-label="遊び方とルールを開く">遊び方 ?</button></header>
    {authError && <div role="alert" className="notice error">{authError}</div>}
    {message && <div role="status" className="notice">{message}</div>}
    {!snapshot ? <section className="lobby panel">
      <div className="lobby-intro"><p className="eyebrow">二人で、言葉をつなぐ。</p><h2>一文字から、陣地が広がる。</h2><p>語尾から8方向へ言葉を伸ばす。各20秒、合計20手の勝負。</p></div>
      <div className="lobby-controls">
        <fieldset disabled={queue === "waiting" || busy}><legend>辞書チェック</legend><label><input type="radio" checked={dictionary} onChange={() => setDictionary(true)} /> ON <small>一般名詞のみ</small></label><label><input type="radio" checked={!dictionary} onChange={() => setDictionary(false)} /> OFF <small>自由な語</small></label></fieldset>
        <div className="lobby-actions"><button disabled={!token || busy} onClick={() => void act("create", { dictionary })}>部屋を作る</button>
          {queue === "waiting" ? <button className="secondary" onClick={() => void cancelQueue()}>相手を探しています… 取消</button> :
            <button className="secondary" disabled={!token || busy} onClick={() => void enterQueue()}>公開マッチを探す</button>}</div>
        {queue === "expired" && <p role="status">待機が期限切れになりました。もう一度探すか、部屋を作ってください。</p>}
        <form onSubmit={e => { e.preventDefault(); void act("join", { code: joinCode.trim().toUpperCase() }); }}><label htmlFor="join-code">招待コードで参加</label><div className="join-line"><input id="join-code" maxLength={8} autoComplete="off" value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} placeholder="8文字のコード" /><button disabled={!token || busy || joinCode.length !== 8}>参加</button></div></form>
      </div>
    </section> : <>
      <section className="match-head panel"><div><p className="eyebrow">ROOM {snapshot.code} · {g?.moves.length || 0}/20 手 · 辞書 {g?.dictionary ? "ON" : "OFF"}</p><h2>{g?.status === "finished" ? g.winner === null ? "引き分け" : g.winner === snapshot.player ? "勝利！" : "敗北" : g?.status === "paused" ? "試合中断中" : g?.pendingRequest ? "承認待ち" : myTurn ? "あなたの手番" : g?.status === "waiting" ? "対戦相手を待っています" : "相手の手番"}</h2>{g?.status === "finished" && <p>{endName[g.endReason || ""]}</p>}</div><div className="head-actions"><span className="connection" role="status">{connected ? "● 接続中" : "○ 再接続中"}</span><button className="text-button" onClick={() => void copyInvite()}>招待URLをコピー</button><button className="text-button" onClick={leaveView}>一覧へ</button></div></section>
      <section className="match-layout">
        <div className="game-area panel"><div className="kana-frame"><KanaRail letters={perimeter.slice(0, 21)} used={g?.usedKana || []} className="top" /><KanaRail letters={perimeter.slice(21, 41)} used={g?.usedKana || []} className="left" />
          <div className={`board-timer ${seconds === null ? "idle" : seconds <= 5 ? "urgent" : ""}`} style={timerStyle} aria-label={seconds === null ? "時計停止中" : `残り${seconds.toFixed(1)}秒`}><span className="timer-chip" role="timer">{seconds === null ? "—" : `${Math.ceil(seconds)}秒`}</span><div className="board" role="grid" aria-label="8かける8の対戦盤面">{g?.board.map((row, r) => row.map((cell, c) => {
            const tail = g.tail.row === r && g.tail.col === c;
            const key = `${r},${c}`;
            const ghost = preview.get(key);
            const onPath = lastPath.has(key);
            return <div key={`${r}-${c}`} role="gridcell" className={`cell ${cell?.owner === 0 ? "p1" : cell?.owner === 1 ? "p2" : ""} ${tail ? "tail" : ""} ${ghost && !ghost.occupied ? "ghost" : ""} ${ghost?.occupied ? "through" : ""} ${onPath ? "last-path" : ""}`} aria-label={`${r + 1}行${c + 1}列 ${cell?.kana || ghost?.letter || "空"}${tail ? " 語尾" : ""}${onPath ? " 直前の経路" : ""}${ghost?.occupied ? ` 入力文字${ghost.letter}が通過` : ""}${cell ? cell.owner === null ? " 中立" : cell.owner === 0 ? " 先手" : " 後手" : " 空マス"}`}>{cell?.kana || ghost?.letter || ""}{ghost?.occupied && <span className="pass-letter" aria-hidden="true">{ghost.letter}</span>}{tail && <span className="tail-dot" aria-hidden="true" />}</div>;
          }))}</div></div><KanaRail letters={perimeter.slice(41, 61)} used={g?.usedKana || []} className="right" /><KanaRail letters={perimeter.slice(61)} used={g?.usedKana || []} className="bottom" /></div><p className="path-key">点線のマスは直前の言葉の経路</p></div>
        <aside className="side"><div className="panel score-card"><p className="eyebrow">SCORE / 文字解放ポイント</p><div className="score-pair">{g?.scores.map((s, i) => <div key={i} className={`score-line ${i === snapshot.player ? "mine" : ""}`}><b>{i === snapshot.player ? "あなた" : "相手"}</b><strong>{total(s).toFixed(1)}</strong><span>{g.releasePoints?.[i] || 0}p</span><small>マス {s.cells} · 新仮名 {s.first.toFixed(1)} · 濁音 {s.voiced.toFixed(1)}</small></div>)}</div></div>
          <div className="panel input-card"><p className="eyebrow">次の言葉</p><form onSubmit={e => { e.preventDefault(); void act("move", { word, direction, skill }); }}><label htmlFor="word">「{required}」から始まる単語{skill === "shift" ? "（濁音変換可）" : ""}</label><input id="word" value={word} onChange={e => setWord(e.target.value)} autoComplete="off" disabled={!myTurn || busy} placeholder={skill === "shift" ? "濁音を変えても可" : `${required}…`} /><fieldset disabled={!myTurn || busy}><legend>置く方向</legend><div className="direction-pad">{padDirections.map((d, i) => d ? <button type="button" key={d} title={directionName[d]} aria-label={directionName[d]} aria-pressed={direction === d} className={direction === d ? "selected" : ""} onClick={() => setDirection(d)}>{directionGlyph[d]}</button> : <span key={i} className="pad-center" aria-hidden="true">{required || "□"}</span>)}</div></fieldset><fieldset disabled={!myTurn || busy} className="skill-picker"><legend>スキル · 残高 {g?.releasePoints?.[snapshot.player] || 0}p</legend><div className="skill-options"><button type="button" className={!skill ? "selected" : ""} aria-pressed={!skill} onClick={() => setSkill(null)}>使わない</button>{(Object.keys(skillCost) as Skill[]).map(s => <button type="button" key={s} className={skill === s ? "selected" : ""} aria-pressed={skill === s} disabled={(g?.releasePoints?.[snapshot.player] || 0) < skillCost[s]} onClick={() => setSkill(s)}>{skillName[s]} {skillCost[s]}p</button>)}</div></fieldset><button className="submit" disabled={!myTurn || busy || !word.trim()}>この言葉を置く</button></form>
            {g?.status === "waiting" && <div className="ready-box"><p>{snapshot.opponentPresent ? `準備: ${g.ready[0] ? "先手済" : "先手待ち"} / ${g.ready[1] ? "後手済" : "後手待ち"}` : "招待URLまたはコードを相手に送ってください"}</p><button disabled={!snapshot.opponentPresent || g.ready[snapshot.player] || busy} onClick={() => void act("ready")}>準備完了</button></div>}</div>
          {(g?.status === "playing" || g?.status === "paused") && <div className="panel control-card"><p className="eyebrow">対戦操作</p>{g.pendingRequest ? <div className="proposal"><p>{g.pendingRequest.by === snapshot.player ? `「${controlName[g.pendingRequest.kind]}」を提案中` : `相手が「${controlName[g.pendingRequest.kind]}」を提案しています`}</p><div>{g.pendingRequest.by !== snapshot.player && <button disabled={busy} onClick={() => void act("control_respond", { accept: true })}>承認</button>}<button className="secondary" disabled={busy} onClick={() => void act("control_respond", { accept: false })}>{g.pendingRequest.by === snapshot.player ? "撤回" : "断る"}</button></div></div> : <div className="control-actions">{g.status === "paused" ? <button disabled={busy} onClick={() => void act("control_request", { kind: "resume" })}>再開を提案</button> : <><button disabled={busy || !g.moves.at(-1)?.before} onClick={() => void act("control_request", { kind: "undo" })}>1手戻る</button><button disabled={busy} onClick={() => void act("control_request", { kind: "pause" })}>中断</button><button disabled={busy} onClick={() => void act("control_request", { kind: "finish" })}>終了を提案</button></>}</div>}<button className="text-button resign" disabled={busy} onClick={() => { if (window.confirm("降参しますか？")) void act("resign"); }}>降参する</button></div>}
        </aside>
      </section>
    </>}
    {showHelp && <div className="help-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setShowHelp(false); }}><section role="dialog" aria-modal="true" aria-labelledby="help-title" className="help-dialog panel"><div className="help-title"><h2 id="help-title">遊び方・ルール</h2><button className="text-button" onClick={() => setShowHelp(false)} aria-label="閉じる">閉じる ×</button></div><ol><li>双方が準備完了すると開始。各手番20秒、合計20手です。</li><li>語尾のマスから始まる2〜4文字の言葉と8方向の矢印を選びます。最後の文字は空マスへ。既存マスは文字が違っても通過し、上書きしません。</li><li>空マスは{cellPoints}点。新しい仮名は{newKanaPoints.toFixed(1)}点と文字解放2p、濁音・半濁音は使用ごとに{voicedPoints.toFixed(1)}点。共有する語頭は文字点の対象外です。</li><li>文字解放ポイントで濁音変換5p（ぎ→き、ば→は・ぱなど）、5〜6文字の言葉7p、相手マスの上書き10pを選べます。得点は消費されません。</li><li>直前の経路は盤面の点線で表示します。1手戻る・中断・引き分け終了は相手の承認が必要です。中断からの再開も双方で承認します。降参は一人で決められます。</li><li>同じ語、「ん」終わり、時間切れ、手詰まりは負け。辞書ONは一般名詞のみ、OFFは自由な語です。</li></ol><p><a href="/IPADIC-COPYING.txt" target="_blank" rel="noreferrer">辞書の出典・ライセンス</a></p></section></div>}
  </main>;
}

function KanaRail({ letters, used, className }: { letters: string[]; used: string[]; className: string }) {
  return <div className={`kana-rail ${className}`} aria-label="仮名の使用状況">{letters.map(ch => <span key={ch} className={used.includes(ch) ? "used" : ""}>{ch}</span>)}</div>;
}
