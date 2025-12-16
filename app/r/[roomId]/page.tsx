"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
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

// ✅ ทำให้รองรับห้องเก่า (บาง field อาจยังไม่มี)
type Room = {
  createdAt?: number;
  status?: "lobby" | "playing";
  hostUid?: string;
  slots?: Record<"1" | "2" | "3" | "4", Slot>;
  game?: { phase: "lobby" | "playing"; startedAt: number | null };
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

  // derived safe fields
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const status: "lobby" | "playing" = (room?.status ?? "lobby") as any;
  const game = room?.game ?? {
    phase: "lobby" as const,
    startedAt: null as number | null,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const phase: "lobby" | "playing" = (game.phase ?? "lobby") as any;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const slots: Record<"1" | "2" | "3" | "4", Slot> = {
    ...EMPTY_SLOTS,
    ...(room?.slots ?? {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  // ✅ auto migrate เติม schema ให้ห้องเก่า
  useEffect(() => {
    if (!room) return;

    const needSlots = !room.slots;
    const needGame = !room.game;
    const needStatus = !room.status;
    const needCreatedAt = !room.createdAt;

    if (!needSlots && !needGame && !needStatus && !needCreatedAt) return;

    update(ref(db, `rooms/${roomId}`), {
      slots: room.slots ?? { 1: null, 2: null, 3: null, 4: null },
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
    await runTransaction(slotRef, (current) => {
      if (current?.uid === uid) return null;
      return current;
    });

    setMySlot(null);
  };

  const claimSlot = async (slot: 1 | 2 | 3 | 4) => {
    if (!uid) return;
    if (status !== "lobby") return alert("Game already started.");

    // ถ้าอยู่ slot อื่นอยู่แล้ว -> ปล่อยก่อน
    if (mySlot && mySlot !== slot) {
      await leaveSlot();
    }

    const slotRef = ref(db, `rooms/${roomId}/slots/${slot}`);
    const result = await runTransaction(slotRef, (current) => {
      if (current === null) return { uid, name, ready: false };
      if (current?.uid === uid) return current; // allow refresh
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
    await runTransaction(slotRef, (current) => {
      if (!current || current.uid !== uid) return current;
      return { ...current, ready: !current.ready };
    });
  };

  // helpers for start condition (2-4 people)
  const currentPlayers = useMemo(() => {
    return [slots["1"], slots["2"], slots["3"], slots["4"]].filter(
      (x) => x !== null
    ) as NonNullable<Slot>[];
  }, [slots]);

  const playerCount = currentPlayers.length;
  const everyoneReady =
    playerCount > 0 && currentPlayers.every((p) => p.ready === true);
  const iAmSlot1 = slots["1"]?.uid === uid;

  const canStart =
    status === "lobby" &&
    phase === "lobby" &&
    playerCount >= 2 &&
    playerCount <= 4 &&
    everyoneReady;

  const startGameBySlot1 = async () => {
    if (!uid) return;
    if (!iAmSlot1) {
      return alert("Start ได้เฉพาะ Player 1 เท่านั้น");
    }
    if (!canStart) {
      return alert(
        "Start ไม่ได้: ต้องมี 2–4 คน และทุกคนที่อยู่ในห้องต้อง Ready ครบ"
      );
    }

    // re-check from server snapshot (กัน race)
    const snap = await get(roomRef);
    const latest = (snap.val() as Room) ?? null;
    if (!latest) return;

    const latestSlots = (latest.slots ?? EMPTY_SLOTS) as Record<
      "1" | "2" | "3" | "4",
      Slot
    >;
    const latestPlayers = [
      latestSlots["1"],
      latestSlots["2"],
      latestSlots["3"],
      latestSlots["4"],
    ].filter((x) => x !== null) as NonNullable<Slot>[];
    const latestCount = latestPlayers.length;
    const latestEveryoneReady =
      latestCount > 0 && latestPlayers.every((p) => p.ready === true);

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
      return alert(
        "Start ไม่ได้: ต้องมี 2–4 คน และทุกคนที่อยู่ในห้องต้อง Ready ครบ"
      );
    }

    // กัน start ซ้อน
    const gameRef = ref(db, `rooms/${roomId}/game`);
    await runTransaction(gameRef, (g) => {
      if (!g || g.phase !== "lobby") return g;
      return { ...g, phase: "playing", startedAt: Date.now() };
    });

    await update(ref(db, `rooms/${roomId}`), { status: "playing" });
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

          {/* ✅ Start button เฉพาะ Player 1 */}
          {iAmSlot1 && status === "lobby" && (
            <button onClick={startGameBySlot1} disabled={!canStart}>
              Start (Player 1 only)
            </button>
          )}

          <span style={{ color: "#666" }}>
            เงื่อนไข: ต้องมี 2–4 คน และทุกคนที่อยู่ในห้องต้อง Ready —
            เริ่มได้เฉพาะ Player 1
          </span>
        </div>

        {phase === "playing" && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 12,
              background: "#f6f6f6",
            }}
          >
            🎮 Game started! (dummy) — ต่อไปค่อยใส่ gameplay จริงได้เลย
          </div>
        )}
      </div>
    </main>
  );
}
