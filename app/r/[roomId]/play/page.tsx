"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { ref, onValue, runTransaction } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/useAuth";

// shadcn/ui (ถ้าคุณมีอยู่แล้ว)
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// dnd-kit
import {
  DndContext,
  PointerSensor,
  useDroppable,
  useDraggable,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";

type Suit = "C" | "D" | "H" | "S";
type CardT = { id: string; r: number; s: Suit }; // 1..13

type Slot = null | { uid: string; name: string; ready: boolean };

type DiscardCard = CardT & { fromUid: string | null; at: number };

type Origin = { kind: "stock" | "discard"; fromUid: string | null };

type MeldKind = "set" | "run";
type Meld = {
  id: string;
  ownerUid: string;
  kind: MeldKind;
  cards: CardT[];
  createdAt: number;
};

type GamePlayer = {
  name: string;
  hand: CardT[];
  hasMelded: boolean;
  score: number;
  scoredCards: CardT[];
  lastTurnTookDiscardFromUid?: string | null;
};

type GameState = {
  phase: "playing";
  startedAt: number | null;

  turnUid: string | null;
  step: "draw" | "discard";

  headCardId: string | null; // หัว (ฐาน)
  stock: CardT[];
  discard: DiscardCard[]; // discard[0] = head เสมอ (หลัง init)

  cardOrigins: Record<string, Origin>;
  tableMelds: Meld[];
  players: Record<string, GamePlayer>;

  winnerUid: string | null;
  endedAt: number | null;
};

type Room = {
  status?: "lobby" | "playing";
  slots?: Record<"1" | "2" | "3" | "4", Slot>;
  game?: Partial<GameState>;
};

const EMPTY_SLOTS: Record<"1" | "2" | "3" | "4", Slot> = {
  "1": null,
  "2": null,
  "3": null,
  "4": null,
};

function cardLabel(c: CardT) {
  const r =
    c.r === 1
      ? "A"
      : c.r === 11
      ? "J"
      : c.r === 12
      ? "Q"
      : c.r === 13
      ? "K"
      : String(c.r);
  const s = c.s === "C" ? "♣" : c.s === "D" ? "♦" : c.s === "H" ? "♥" : "♠";
  return `${r}${s}`;
}

function suitColor(s: Suit) {
  return s === "H" || s === "D" ? "text-red-600" : "text-slate-900";
}

function makeDeck(): CardT[] {
  const suits: Suit[] = ["C", "D", "H", "S"];
  const deck: CardT[] = [];
  for (const s of suits) {
    for (let r = 1; r <= 13; r++)
      deck.push({ id: `${s}-${r}-${crypto.randomUUID()}`, r, s });
  }
  return deck;
}

function shuffle<T>(arr: T[]) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isValidSet(cards: CardT[]) {
  if (cards.length < 3) return false;
  const r = cards[0].r;
  if (!cards.every((c) => c.r === r)) return false;
  const suits = new Set(cards.map((c) => c.s));
  return suits.size === cards.length;
}
function isValidRun(cards: CardT[]) {
  if (cards.length < 3) return false;
  const s = cards[0].s;
  if (!cards.every((c) => c.s === s)) return false;
  const rs = [...cards.map((c) => c.r)].sort((a, b) => a - b);
  for (let i = 1; i < rs.length; i++) if (rs[i] !== rs[i - 1] + 1) return false;
  return true;
}
function classifyMeld(cards: CardT[]): { ok: boolean; kind?: MeldKind } {
  if (isValidSet(cards)) return { ok: true, kind: "set" };
  if (isValidRun(cards)) return { ok: true, kind: "run" };
  return { ok: false };
}

/** ---------- UI: Card component ---------- */
function PlayingCard({
  c,
  head,
  selected,
  onClick,
  small,
}: {
  c: CardT;
  head?: boolean;
  selected?: boolean;
  onClick?: () => void;
  small?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      className={[
        "relative select-none rounded-xl border bg-white shadow-sm",
        small ? "h-16 w-12" : "h-24 w-16",
        selected ? "ring-2 ring-slate-900" : "hover:-translate-y-0.5",
        "transition",
        "cursor-pointer",
      ].join(" ")}
    >
      {head && (
        <div className="absolute -top-2 -left-2">
          <Badge className="text-[10px] px-2 py-0.5">HEAD</Badge>
        </div>
      )}
      <div className="p-2 flex flex-col h-full justify-between">
        <div className={["font-bold text-sm", suitColor(c.s)].join(" ")}>
          {cardLabel(c)}
        </div>
        <div className="text-[10px] text-slate-500 text-right">Dummy</div>
      </div>
    </div>
  );
}

/** ---------- DnD helpers ---------- */
function DraggableCard({
  c,
  head,
  selected,
  onClick,
}: {
  c: CardT;
  head?: boolean;
  selected?: boolean;
  onClick?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: `hand:${c.id}`,
    });

  const style: React.CSSProperties = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : {};

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={isDragging ? "opacity-70" : ""}
      {...listeners}
      {...attributes}
    >
      <PlayingCard c={c} head={head} selected={selected} onClick={onClick} />
    </div>
  );
}

function DroppableZone({
  id,
  title,
  children,
  hint,
}: {
  id: string;
  title: string;
  children?: React.ReactNode;
  hint?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={[
        "rounded-2xl border-2 border-dashed p-3 min-h-[120px]",
        isOver ? "border-slate-900 bg-white/60" : "border-white/30 bg-white/10",
        "transition",
      ].join(" ")}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-white font-semibold">{title}</div>
        {hint && <div className="text-white/70 text-xs">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export default function PlayPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { uid, loading } = useAuth();
  const name = useMemo(() => search.get("name") || "Player", [search]);

  const [room, setRoom] = useState<Room | null>(null);
  const [selected, setSelected] = useState<Record<string, true>>({}); // เลือกไพ่ไว้เกิด
  const [meldTarget, setMeldTarget] = useState<"builder" | "none">("builder");

  const roomRef = useMemo(() => ref(db, `rooms/${roomId}`), [roomId]);

  useEffect(() => {
    const unsub = onValue(roomRef, (snap) =>
      setRoom((snap.val() as Room) ?? null)
    );
    return () => unsub();
  }, [roomRef]);

  const slots = useMemo(
    () => ({ ...EMPTY_SLOTS, ...(room?.slots ?? {}) } as any),
    [room?.slots]
  );
  const joinedUids = useMemo(() => {
    const uids = [
      slots["1"]?.uid,
      slots["2"]?.uid,
      slots["3"]?.uid,
      slots["4"]?.uid,
    ].filter(Boolean) as string[];
    return Array.from(new Set(uids));
  }, [slots]);

  const status = room?.status ?? "lobby";
  const game = (room?.game ?? {}) as Partial<GameState>;
  const phase = (game.phase ?? "lobby") as any;

  // guard
  useEffect(() => {
    if (!room) return;
    if (status !== "playing" || phase !== "playing") {
      const qs = new URLSearchParams({ name }).toString();
      router.replace(`/r/${roomId}?${qs}`);
    }
  }, [room, status, phase, router, roomId, name]);

  const g: GameState | null = useMemo(() => {
    if (!game || phase !== "playing") return null;
    return {
      phase: "playing",
      startedAt: game.startedAt ?? null,
      turnUid: game.turnUid ?? null,
      step: (game.step ?? "draw") as any,

      headCardId: game.headCardId ?? null,
      stock: (game.stock ?? []) as CardT[],
      discard: (game.discard ?? []) as DiscardCard[],

      cardOrigins: (game.cardOrigins ?? {}) as Record<string, Origin>,
      tableMelds: (game.tableMelds ?? []) as Meld[],
      players: (game.players ?? {}) as Record<string, GamePlayer>,

      winnerUid: (game.winnerUid ?? null) as any,
      endedAt: (game.endedAt ?? null) as any,
    };
  }, [game, phase]);

  const me = uid && g ? g.players[uid] : undefined;
  const isMyTurn = !!uid && !!g && g.turnUid === uid;
  const ended = !!g?.endedAt || !!g?.winnerUid;

  /** ✅ INIT ใหม่: แจกไพ่ + ตั้ง “หัว” เป็นฐานของกองกลาง (discard[0]) */
  useEffect(() => {
    if (!uid) return;
    if (!g) return;
    if (g.stock.length > 0 || g.discard.length > 0) return; // init แล้ว

    const gameRef = ref(db, `rooms/${roomId}/game`);
    runTransaction(gameRef, (cur: any) => {
      if (!cur || cur.phase !== "playing") return cur;

      if (
        (Array.isArray(cur.stock) && cur.stock.length > 0) ||
        (Array.isArray(cur.discard) && cur.discard.length > 0)
      ) {
        return cur;
      }

      const deck = shuffle(makeDeck());

      // แจก 7 ใบ/คน
      const hands: Record<string, CardT[]> = {};
      for (const puid of joinedUids) hands[puid] = [];
      for (let i = 0; i < 7; i++) {
        for (const puid of joinedUids) hands[puid].push(deck.pop()!);
      }

      // stock ที่เหลือ
      const stock = deck;

      // ตั้ง “หัว” = ใบแรกที่เปิดเป็นฐานกองกลาง (หยิบ 1 ใบจาก stock มาวาง discard)
      const head = stock.pop() ?? null;
      const headCardId = head?.id ?? null;

      const players: Record<string, GamePlayer> = {};
      const cardOrigins: Record<string, Origin> = {};

      for (const puid of joinedUids) {
        players[puid] = {
          name: cur.players?.[puid]?.name ?? "Player",
          hand: hands[puid],
          hasMelded: false,
          score: 0,
          scoredCards: [],
          lastTurnTookDiscardFromUid: null,
        };
        for (const c of hands[puid])
          cardOrigins[c.id] = { kind: "stock", fromUid: null };
      }

      cur.stock = stock;
      cur.discard = head ? [{ ...head, fromUid: null, at: Date.now() }] : [];
      cur.headCardId = headCardId;

      cur.players = players;
      cur.cardOrigins = cardOrigins;
      cur.tableMelds = [];
      cur.turnUid = cur.turnUid ?? joinedUids[0] ?? null;
      cur.step = "draw";
      cur.winnerUid = null;
      cur.endedAt = null;
      return cur;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, g, roomId, joinedUids.join("|")]);

  const headCard = useMemo(() => {
    if (!g?.headCardId) return null;
    // head อยู่ใน discard[0] เสมอ (หลัง init)
    return g.discard.find((x) => x.id === g.headCardId) ?? null;
  }, [g?.headCardId, g?.discard]);

  const topDiscard =
    g && g.discard.length ? g.discard[g.discard.length - 1] : null;
  const canTakeTopDiscard = !!g && g.discard.length >= 2; // ✅ ห้ามเก็บถ้ามีแค่หัวใบเดียว
  const stockCount = g?.stock.length ?? 0;

  const toggleSelect = (cardId: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[cardId]) delete next[cardId];
      else next[cardId] = true;
      return next;
    });
  };
  const clearSelection = () => setSelected({});

  /** --- actions --- */
  const drawStock = async () => {
    if (!uid || !g) return;
    if (!isMyTurn) return alert("ยังไม่ถึงตาคุณ");
    if (ended) return;
    if (g.step !== "draw") return alert("ต้องทิ้งก่อน");
    if (stockCount <= 0) return alert("กองจั่วหมด");

    const gameRef = ref(db, `rooms/${roomId}/game`);
    await runTransaction(gameRef, (cur: any) => {
      if (!cur || cur.phase !== "playing") return cur;
      if (cur.winnerUid || cur.endedAt) return cur;
      if (cur.turnUid !== uid || cur.step !== "draw") return cur;
      if (!Array.isArray(cur.stock) || cur.stock.length === 0) return cur;

      const card = cur.stock.pop();
      cur.players[uid].hand.push(card);
      cur.cardOrigins = cur.cardOrigins ?? {};
      cur.cardOrigins[card.id] = { kind: "stock", fromUid: null };

      cur.players[uid].lastTurnTookDiscardFromUid = null;
      cur.step = "discard";
      return cur;
    });
  };

  const takeTopDiscard = async () => {
    if (!uid || !g) return;
    if (!isMyTurn) return alert("ยังไม่ถึงตาคุณ");
    if (ended) return;
    if (g.step !== "draw") return alert("ต้องทิ้งก่อน");
    if (!canTakeTopDiscard)
      return alert("กองกลางมีแค่หัว ห้ามเก็บ (ต้องกินหัวถ้าจะเอาหัว)");

    const gameRef_toggle = ref(db, `rooms/${roomId}/game`);
    await runTransaction(gameRef_toggle, (cur: any) => {
      if (!cur || cur.phase !== "playing") return cur;
      if (cur.winnerUid || cur.endedAt) return cur;
      if (cur.turnUid !== uid || cur.step !== "draw") return cur;
      if (!Array.isArray(cur.discard) || cur.discard.length < 2) return cur;

      const card = cur.discard.pop(); // ใบบนสุดเท่านั้น
      cur.players[uid].hand.push(card);

      cur.players[uid].lastTurnTookDiscardFromUid = card.fromUid ?? null;

      cur.cardOrigins = cur.cardOrigins ?? {};
      cur.cardOrigins[card.id] = {
        kind: "discard",
        fromUid: card.fromUid ?? null,
      };

      cur.step = "discard";
      return cur;
    });
  };

  /** ✅ กินหัว: เก็บทั้งกองกลางเข้ามือ แล้วตั้งหัวใบใหม่ทันที */
  const eatHead = async () => {
    if (!uid || !g) return;
    if (!isMyTurn) return alert("ยังไม่ถึงตาคุณ");
    if (ended) return;
    if (g.step !== "draw") return alert("ต้องทิ้งก่อน");
    if (g.discard.length === 0) return alert("กองกลางว่าง");

    const gameRef = ref(db, `rooms/${roomId}/game`);
    await runTransaction(gameRef, (cur: any) => {
      if (!cur || cur.phase !== "playing") return cur;
      if (cur.winnerUid || cur.endedAt) return cur;
      if (cur.turnUid !== uid || cur.step !== "draw") return cur;

      cur.discard = Array.isArray(cur.discard) ? cur.discard : [];
      const pile: DiscardCard[] = cur.discard;

      // ย้ายทั้งกองเข้ามือ
      for (const c of pile) {
        cur.players[uid].hand.push({ id: c.id, r: c.r, s: c.s });
        cur.cardOrigins = cur.cardOrigins ?? {};
        // ถือว่า "ได้มาจากกองกลาง" (รวมถึงหัว) เพื่อให้ rule “มีไพ่กองกลาง” ใช้ง่าย
        cur.cardOrigins[c.id] = { kind: "discard", fromUid: c.fromUid ?? null };
      }

      // ตั้งหัวใบใหม่
      cur.stock = Array.isArray(cur.stock) ? cur.stock : [];
      const newHead = cur.stock.pop() ?? null;
      cur.discard = newHead
        ? [{ ...newHead, fromUid: null, at: Date.now() }]
        : [];
      cur.headCardId = newHead?.id ?? null;

      cur.players[uid].lastTurnTookDiscardFromUid = null;
      cur.step = "discard";
      return cur;
    });
  };

  const discardCardById = async (cardId: string) => {
    if (!uid || !g) return;
    if (!isMyTurn) return alert("ยังไม่ถึงตาคุณ");
    if (ended) return;
    if (g.step !== "discard") return alert("ต้องจั่ว/เก็บก่อน");

    const gameRef = ref(db, `rooms/${roomId}/game`);
    await runTransaction(gameRef, (cur: any) => {
      if (!cur || cur.phase !== "playing") return cur;
      if (cur.winnerUid || cur.endedAt) return cur;
      if (cur.turnUid !== uid || cur.step !== "discard") return cur;

      const hand: CardT[] = cur.players?.[uid]?.hand ?? [];
      const idx = hand.findIndex((c) => c.id === cardId);
      if (idx < 0) return cur;

      const [card] = hand.splice(idx, 1);

      cur.discard = Array.isArray(cur.discard) ? cur.discard : [];
      cur.discard.push({ ...card, fromUid: uid, at: Date.now() });

      cur.cardOrigins = cur.cardOrigins ?? {};
      cur.cardOrigins[card.id] = { kind: "discard", fromUid: uid };

      // next turn
      const uids: string[] = Object.keys(cur.players ?? {});
      const curIndex = uids.indexOf(uid);
      const nextUid = uids[(curIndex + 1) % uids.length] ?? null;
      cur.turnUid = nextUid;
      cur.step = "draw";
      return cur;
    });

    clearSelection();
  };

  const layMeld = async () => {
    if (!uid || !g) return;
    if (!isMyTurn) return alert("ยังไม่ถึงตาคุณ");
    if (ended) return;
    if (g.step !== "discard") return alert("ต้องจั่ว/เก็บก่อน");

    const ids = Object.keys(selected);
    if (ids.length < 3) return alert("เลือก 3 ใบขึ้นไปเพื่อเกิด");

    const gameRef = ref(db, `rooms/${roomId}/game`);
    await runTransaction(gameRef, (cur: any) => {
      if (!cur || cur.phase !== "playing") return cur;
      if (cur.winnerUid || cur.endedAt) return cur;
      if (cur.turnUid !== uid || cur.step !== "discard") return cur;

      const hand: CardT[] = cur.players?.[uid]?.hand ?? [];
      const picked: CardT[] = [];
      const pickedIdx: number[] = [];

      for (const id of ids) {
        const idx = hand.findIndex((c) => c.id === id);
        if (idx < 0) return cur;
        picked.push(hand[idx]);
        pickedIdx.push(idx);
      }

      const cls = classifyMeld(picked);
      if (!cls.ok) return cur;

      // เกิด: ต้องมีไพ่ “ได้มาจากกองกลาง” อย่างน้อย 1 ใบ
      const origins: Record<string, Origin> = cur.cardOrigins ?? {};
      const hasDiscardCard = picked.some(
        (c) => origins[c.id]?.kind === "discard"
      );
      if (!hasDiscardCard) return cur;

      pickedIdx.sort((a, b) => b - a).forEach((i) => hand.splice(i, 1));

      const meld: Meld = {
        id: crypto.randomUUID(),
        ownerUid: uid,
        kind: cls.kind!,
        cards: picked,
        createdAt: Date.now(),
      };
      cur.tableMelds = Array.isArray(cur.tableMelds) ? cur.tableMelds : [];
      cur.tableMelds.push(meld);

      cur.players[uid].hasMelded = true;
      cur.players[uid].scoredCards = Array.isArray(cur.players[uid].scoredCards)
        ? cur.players[uid].scoredCards
        : [];
      cur.players[uid].scoredCards.push(...picked);

      return cur;
    });

    clearSelection();
  };

  /** ---------- Drag & Drop wiring ---------- */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const onDragEnd = async (e: DragEndEvent) => {
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : "";

    if (!activeId.startsWith("hand:")) return;
    const cardId = activeId.replace("hand:", "");

    if (overId === "zone:discard") {
      // ทิ้งด้วย drag
      await discardCardById(cardId);
      return;
    }

    if (overId === "zone:meld") {
      // เพิ่มเข้า selected (เหมือนลากไปโซนจัดชุด)
      toggleSelect(cardId);
      return;
    }
  };

  if (!room || !g) {
    return (
      <main className="p-6">
        <div className="text-lg font-semibold">Loading...</div>
      </main>
    );
  }

  // แสดงกองกลางแบบ “หัว + ไพ่ทับหัวล่าสุด 1-2 ใบ”
  const head = g.discard.length ? g.discard[0] : null;
  const tail = g.discard.length > 1 ? g.discard.slice(-2) : [];
  const showDiscard = [head, ...tail.filter((x) => x.id !== head?.id)].filter(
    Boolean
  ) as DiscardCard[];

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      {/* TABLE BACKGROUND */}
      <div className="min-h-screen w-full bg-gradient-to-b from-emerald-950 via-emerald-900 to-emerald-950 text-white">
        <div className="max-w-6xl mx-auto p-6">
          {/* TOP BAR */}
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="text-2xl font-bold">
                Room {roomId} — Dummy Table
              </div>
              <div className="text-white/80 mt-1">
                Turn:{" "}
                <b>
                  {g.turnUid === uid
                    ? "YOU"
                    : g.players[g.turnUid ?? ""]?.name ?? "-"}
                </b>{" "}
                • Step: <b>{g.step}</b> • Stock: <b>{stockCount}</b>
              </div>
            </div>

            <div className="flex gap-2 items-center">
              <Badge
                variant="secondary"
                className="bg-white/15 text-white border-white/20"
              >
                {isMyTurn ? "Your turn" : "Waiting"}
              </Badge>
            </div>
          </div>

          {/* TABLE LAYOUT */}
          <div className="mt-6 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
            {/* CENTER TABLE */}
            <div className="rounded-3xl border border-white/15 bg-white/5 p-5 shadow-xl">
              <div className="flex items-center justify-between">
                <div className="text-lg font-semibold">Center</div>
                <div className="text-white/70 text-sm">
                  กองกลางมี “หัว” เป็นฐาน — ทิ้งไพ่จะกองต่อบนหัว
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* STOCK */}
                <Card className="bg-white/10 border-white/15 text-white">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">กองจั่ว</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="text-white/80">เหลือ {stockCount} ใบ</div>
                    <Button
                      onClick={drawStock}
                      disabled={
                        !uid ||
                        loading ||
                        !isMyTurn ||
                        ended ||
                        g.step !== "draw" ||
                        stockCount <= 0
                      }
                      className="w-full"
                    >
                      จั่ว
                    </Button>
                  </CardContent>
                </Card>

                {/* DISCARD (DROP ZONE) */}
                <DroppableZone
                  id="zone:discard"
                  title="กองกลาง (ทิ้ง / วางด้วย drag)"
                  hint="ลากไพ่จากมือมาทิ้งที่นี่"
                >
                  <div className="flex items-center gap-2">
                    {/* แสดงแบบ fan: หัว + 1-2 ใบล่าสุด */}
                    <div className="relative h-24">
                      {showDiscard.map((c, i) => (
                        <div
                          key={c.id}
                          className="absolute"
                          style={{ left: i * 26, top: i === 0 ? 0 : 6 }}
                        >
                          <PlayingCard
                            c={c}
                            head={c.id === g.headCardId}
                            small
                          />
                        </div>
                      ))}
                    </div>

                    <div className="ml-2 text-white/80 text-sm">
                      <div>
                        บนสุด: <b>{topDiscard ? cardLabel(topDiscard) : "—"}</b>
                      </div>
                      <div>
                        หัว:{" "}
                        <b>{g.headCardId ? cardLabel(g.discard[0]) : "—"}</b>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Button
                      variant="secondary"
                      className="bg-white/15 text-white border border-white/20"
                      onClick={takeTopDiscard}
                      disabled={
                        !uid ||
                        loading ||
                        !isMyTurn ||
                        ended ||
                        g.step !== "draw" ||
                        !canTakeTopDiscard
                      }
                    >
                      เก็บใบบนสุด
                    </Button>

                    <Button
                      variant="secondary"
                      className="bg-white/15 text-white border border-white/20"
                      onClick={eatHead}
                      disabled={
                        !uid ||
                        loading ||
                        !isMyTurn ||
                        ended ||
                        g.step !== "draw" ||
                        g.discard.length === 0
                      }
                    >
                      กินหัว
                    </Button>
                  </div>
                </DroppableZone>

                {/* MELD BUILDER ZONE */}
                <DroppableZone
                  id="zone:meld"
                  title="Meld Builder (ลากไพ่เข้ามา)"
                  hint="ลากไพ่มาที่นี่เพื่อเลือกสำหรับ “เกิด”"
                >
                  <div className="flex flex-wrap gap-2">
                    {Object.keys(selected).length === 0 ? (
                      <div className="text-white/70 text-sm">
                        ยังไม่เลือกไพ่
                      </div>
                    ) : (
                      Object.keys(selected).map((id) => {
                        const c = me?.hand.find((x) => x.id === id);
                        if (!c) return null;
                        return (
                          <div key={id}>
                            <PlayingCard
                              c={c}
                              head={c.id === g.headCardId}
                              small
                            />
                          </div>
                        );
                      })
                    )}
                  </div>

                  <div className="mt-3 flex gap-2">
                    <Button
                      onClick={layMeld}
                      disabled={
                        !uid ||
                        loading ||
                        !isMyTurn ||
                        ended ||
                        g.step !== "discard"
                      }
                      className="flex-1"
                    >
                      เกิด (ใช้ไพ่ที่เลือก)
                    </Button>
                    <Button
                      variant="secondary"
                      className="bg-white/15 text-white border border-white/20"
                      onClick={clearSelection}
                    >
                      Clear
                    </Button>
                  </div>
                </DroppableZone>
              </div>

              {/* TABLE MELDS */}
              <div className="mt-6">
                <div className="font-semibold mb-2">กองบนโต๊ะ</div>
                {g.tableMelds.length === 0 ? (
                  <div className="text-white/70 text-sm">ยังไม่มีใครเกิด</div>
                ) : (
                  <div className="grid gap-2">
                    {g.tableMelds.map((m) => (
                      <div
                        key={m.id}
                        className="rounded-2xl border border-white/15 bg-white/5 p-3"
                      >
                        <div className="flex justify-between flex-wrap gap-2">
                          <div className="font-semibold">
                            {m.kind === "run" ? "เรียง" : "ตอง"}{" "}
                            <span className="text-white/70 font-normal">
                              by {g.players[m.ownerUid]?.name ?? "?"}
                            </span>
                          </div>
                          <div className="text-white/80">
                            {m.cards.map(cardLabel).join("  ")}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* RIGHT SIDEBAR */}
            <div className="space-y-4">
              <Card className="bg-white/10 border-white/15 text-white">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Scoreboard</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {Object.entries(g.players).map(([puid, p]) => (
                    <div
                      key={puid}
                      className="flex items-center justify-between rounded-xl border border-white/15 bg-white/5 px-3 py-2"
                    >
                      <div>
                        <div className="font-semibold">{p.name}</div>
                        <div className="text-white/70 text-xs">
                          hand: {p.hand?.length ?? 0} •{" "}
                          {p.hasMelded ? "เคยเกิด" : "ยังไม่เกิด"}
                        </div>
                      </div>
                      <div className="font-bold">{p.score ?? 0}</div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* YOUR HAND */}
              <Card className="bg-white/10 border-white/15 text-white">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    Your Hand (ลากไพ่ได้)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-white/70 text-sm mb-2">
                    ลากไปที่ “กองกลาง” เพื่อทิ้ง หรือ “Meld Builder”
                    เพื่อเลือกไพ่
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {(me?.hand ?? []).map((c) => (
                      <DraggableCard
                        key={c.id}
                        c={c}
                        head={c.id === g.headCardId}
                        selected={!!selected[c.id]}
                        onClick={() => toggleSelect(c.id)}
                      />
                    ))}
                  </div>

                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="secondary"
                      className="bg-white/15 text-white border border-white/20"
                      onClick={() =>
                        setMeldTarget(
                          meldTarget === "builder" ? "none" : "builder"
                        )
                      }
                    >
                      {meldTarget === "builder" ? "Meld: ON" : "Meld: OFF"}
                    </Button>

                    <div className="ml-auto text-white/70 text-sm">
                      {isMyTurn ? "✅ ตาคุณ" : "⏳ รอคนอื่น"} /{" "}
                      {g.step === "draw" ? "ต้องจั่ว/เก็บ" : "ต้องทิ้ง"}
                    </div>
                  </div>
                </CardContent>
              </Card>

              <div className="text-white/60 text-xs">
                ตอนนี้เป็น “ขั้นแรก” เน้นโต๊ะ + drag/drop + กองกลางมีหัวเป็นฐาน
                ✅ เดี๋ยวขั้นต่อไปค่อยทำฝากแบบ drag ลงกอง
                และอนิเมชันเหมือนเกมจริง
              </div>
            </div>
          </div>
        </div>
      </div>
    </DndContext>
  );
}
