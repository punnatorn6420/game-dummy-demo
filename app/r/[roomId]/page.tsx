"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import {
  ref,
  onValue,
  runTransaction,
  update,
  get,
  onDisconnect,
  set as fbSet,
} from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/useAuth";

type Slot = null | { uid: string; name: string; ready: boolean };

// รองรับห้องเก่า
type Room = {
  createdAt?: number;
  status?: "lobby" | "playing";
  hostUid?: string;
  slots?: Record<"1" | "2" | "3" | "4", Slot>;
  game?: {
    phase?: "lobby" | "playing";
    startedAt?: number | null;
    // engine state (optional)
    turnUid?: string | null;
    step?: "draw" | "discard";
    headCardId?: string | null;
    stock?: unknown[];
    discard?: unknown[];
    tableMelds?: unknown[];
    players?: Record<string, unknown>;
    cardOrigins?: Record<string, unknown>;
    winnerUid?: string | null;
    endedAt?: number | null;
  };
};

const EMPTY_SLOTS: Record<"1" | "2" | "3" | "4", Slot> = {
  "1": null,
  "2": null,
  "3": null,
  "4": null,
};

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { uid, loading } = useAuth();

  const name = useMemo(() => search.get("name") || "Player", [search]);

  const [room, setRoom] = useState<Room | null>(null);
  const [mySlot, setMySlot] = useState<1 | 2 | 3 | 4 | null>(null);

  const roomRef = useMemo(() => ref(db, `rooms/${roomId}`), [roomId]);

  // realtime room
  useEffect(() => {
    const unsub = onValue(roomRef, (snap) =>
      setRoom((snap.val() as Room) ?? null)
    );
    return () => unsub();
  }, [roomRef]);

  // safe normalize
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const status: "lobby" | "playing" = (room?.status ?? "lobby") as any;
  const phase: "lobby" | "playing" =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((room?.game?.phase ?? "lobby") as any) ?? "lobby";
  const slots: Record<"1" | "2" | "3" | "4", Slot> = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: any = room?.slots ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s: any = { ...EMPTY_SLOTS };
    s["1"] = raw["1"] ?? raw[1] ?? null;
    s["2"] = raw["2"] ?? raw[2] ?? null;
    s["3"] = raw["3"] ?? raw[3] ?? null;
    s["4"] = raw["4"] ?? raw[4] ?? null;

    (["1", "2", "3", "4"] as const).forEach((k) => {
      const v = s[k];
      const ok =
        v &&
        typeof v === "object" &&
        typeof v.uid === "string" &&
        typeof v.name === "string" &&
        typeof v.ready === "boolean";
      s[k] = ok ? (v as Slot) : null;
    });

    return s as Record<"1" | "2" | "3" | "4", Slot>;
  }, [room?.slots]);

  // ✅ redirect all players to /play when phase=playing
  useEffect(() => {
    if (!room) return;
    if (phase !== "playing") return;

    const qs = new URLSearchParams({ name }).toString();
    router.replace(`/r/${roomId}/play?${qs}`);
  }, [phase, room, roomId, name, router]);

  // ✅ auto migrate for old rooms
  useEffect(() => {
    if (!room) return;

    const needSlots = !room.slots;
    const needGame = !room.game;
    const needStatus = !room.status;
    const needCreatedAt = !room.createdAt;

    if (!needSlots && !needGame && !needStatus && !needCreatedAt) return;

    update(ref(db, `rooms/${roomId}`), {
      slots: room.slots ?? { "1": null, "2": null, "3": null, "4": null },
      game: room.game ?? { phase: "lobby", startedAt: null },
      status: room.status ?? "lobby",
      createdAt: room.createdAt ?? Date.now(),
    });
  }, [room, roomId]);

  // presence (optional)
  useEffect(() => {
    if (!uid) return;
    const connectedRef = ref(db, ".info/connected");
    const presenceRef = ref(db, `rooms/${roomId}/presence/${uid}`);

    const unsub = onValue(connectedRef, async (snap) => {
      if (snap.val() === true) {
        await fbSet(presenceRef, { online: true, at: Date.now(), name });
        await onDisconnect(presenceRef).remove();
      }
    });

    return () => unsub();
  }, [uid, roomId, name]);

  const roomLink = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/r/${roomId}`;
  }, [roomId]);

  const copyLink = async () => {
    await navigator.clipboard.writeText(roomLink);
    alert("Copied room link!");
  };

  const leaveSlot = async () => {
    if (!uid || !mySlot) return;

    const slotRef = ref(db, `rooms/${roomId}/slots/${mySlot}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTransaction(slotRef, (current: any) => {
      if (current?.uid === uid) return null;
      return current;
    });

    setMySlot(null);
  };

  const claimSlot = async (slot: 1 | 2 | 3 | 4) => {
    if (!uid) return;
    if (status !== "lobby") return alert("Game already started.");

    if (mySlot && mySlot !== slot) await leaveSlot();

    const slotRef = ref(db, `rooms/${roomId}/slots/${slot}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await runTransaction(slotRef, (current: any) => {
      if (current === null) return { uid, name, ready: false };
      if (current?.uid === uid) return current; // refresh ok
      return; // abort
    });

    if (!result.committed) return alert(`Slot ${slot} is taken.`);
    setMySlot(slot);
  };

  const toggleReady = async () => {
    if (!uid) return;
    if (!mySlot) return alert("Pick a slot first.");
    if (status !== "lobby") return;

    const slotRef = ref(db, `rooms/${roomId}/slots/${mySlot}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTransaction(slotRef, (current: any) => {
      if (!current || current.uid !== uid) return current;
      return { ...current, ready: !current.ready };
    });
  };

  const currentPlayers = useMemo(() => {
    return [slots["1"], slots["2"], slots["3"], slots["4"]].filter(
      Boolean
    ) as NonNullable<Slot>[];
  }, [slots]);

  const playerCount = currentPlayers.length;
  const everyoneReady =
    playerCount > 0 && currentPlayers.every((p) => p.ready === true);
  const iAmSlot1 = slots["1"]?.uid === uid;

  // ✅ ตาม flow เราเริ่มเกมเมื่อพร้อม 2–4 คนและ ready ครบ
  const canStart =
    status === "lobby" &&
    phase === "lobby" &&
    playerCount >= 2 &&
    playerCount <= 4 &&
    everyoneReady;

  const startGameBySlot1 = async () => {
    if (!uid) return;
    if (!iAmSlot1) return alert("Start ได้เฉพาะ Player 1 เท่านั้น");
    if (!canStart)
      return alert("Start ไม่ได้: ต้องมี 2–4 คน และทุกคน Ready ครบ");

    // re-check from server (กัน race)
    const snap = await get(roomRef);
    const latest = (snap.val() as Room) ?? null;
    if (!latest) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: any = latest.slots ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const latestSlots: any = {
      "1": raw["1"] ?? raw[1] ?? null,
      "2": raw["2"] ?? raw[2] ?? null,
      "3": raw["3"] ?? raw[3] ?? null,
      "4": raw["4"] ?? raw[4] ?? null,
    };

    const latestPlayers = [
      latestSlots["1"],
      latestSlots["2"],
      latestSlots["3"],
      latestSlots["4"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ].filter((p: any) => p && typeof p.ready === "boolean");

    const latestCount = latestPlayers.length;
    const latestEveryoneReady =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      latestCount > 0 && latestPlayers.every((p: any) => p.ready === true);
    const latestStatus = (latest.status ?? "lobby") as "lobby" | "playing";
    const latestPhase = (latest.game?.phase ?? "lobby") as "lobby" | "playing";
    const latestSlot1Uid = latestSlots["1"]?.uid;

    if (latestSlot1Uid !== uid)
      return alert("Start ได้เฉพาะ Player 1 เท่านั้น");

    if (
      !(
        latestStatus === "lobby" &&
        latestPhase === "lobby" &&
        latestCount >= 2 &&
        latestCount <= 4 &&
        latestEveryoneReady
      )
    ) {
      return alert("Start ไม่ได้: ต้องมี 2–4 คน และทุกคน Ready ครบ");
    }

    // ✅ init engine state (แจก/สับไพ่จริงจะไปทำในหน้า /play แบบ transaction)
    await update(ref(db, `rooms/${roomId}`), {
      status: "playing",
      game: {
        phase: "playing",
        startedAt: Date.now(),
        turnUid: latestSlot1Uid ?? null,
        step: "draw",
        headCardId: null,
        stock: [],
        discard: [],
        tableMelds: [],
        players: {},
        cardOrigins: {},
        winnerUid: null,
        endedAt: null,
      },
    });
  };

  const renderSlot = (slotNo: 1 | 2 | 3 | 4) => {
    const slot = slots[String(slotNo) as "1"] ?? null;
    const takenByMe = slot?.uid === uid;

    return (
      <div
        key={slotNo}
        style={{
          border: "1px solid #ddd",
          borderRadius: 12,
          padding: 12,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontWeight: 700 }}>Player {slotNo}</div>
          <div style={{ color: "#666", fontSize: 14 }}>
            {slot
              ? `${slot.name} ${slot.ready ? "✅ Ready" : "⌛ Not ready"}`
              : "Empty"}
          </div>
        </div>

        {status === "lobby" && !loading && uid && (
          <div style={{ display: "flex", gap: 8 }}>
            {!slot && <button onClick={() => claimSlot(slotNo)}>Take</button>}
            {takenByMe && <button onClick={leaveSlot}>Leave</button>}
          </div>
        )}
      </div>
    );
  };

  if (!room) {
    return (
      <main style={{ padding: 24 }}>
        <h2>Loading room...</h2>
      </main>
    );
  }

  const myReady =
    mySlot && slots[String(mySlot) as "1"]?.uid === uid
      ? slots[String(mySlot) as "1"]?.ready
      : false;

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: 24 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Room: {roomId}</h1>
          <div style={{ color: "#666" }}>
            Status: <b>{status}</b> | Phase: <b>{phase}</b> | Players:{" "}
            <b>{playerCount}/4</b>
          </div>
          <div style={{ color: "#999", fontSize: 13 }}>You: {name}</div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={copyLink}>Copy Link</button>
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        {([1, 2, 3, 4] as const).map(renderSlot)}
      </div>

      <div
        style={{ marginTop: 16, borderTop: "1px solid #eee", paddingTop: 16 }}
      >
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <button
            onClick={toggleReady}
            disabled={loading || !uid || !mySlot || status !== "lobby"}
          >
            {myReady ? "Unready" : "Ready"}
          </button>

          {iAmSlot1 && status === "lobby" && (
            <button onClick={startGameBySlot1} disabled={!canStart}>
              Start (Player 1 only)
            </button>
          )}

          <span style={{ color: "#666" }}>
            เงื่อนไข: 2–4 คน และทุกคน Ready — เริ่มได้เฉพาะ Player 1
          </span>
        </div>
      </div>
    </main>
  );
}
