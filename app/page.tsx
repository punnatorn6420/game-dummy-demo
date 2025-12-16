"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ref, set } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/useAuth";
import { genRoomCode } from "@/lib/room";

export default function Home() {
  const router = useRouter();
  const [name, setName] = useState("Pun");
  const { uid, loading } = useAuth();

  const createRoom = async () => {
    if (!uid) return;

    const roomId = genRoomCode();
    await set(ref(db, `rooms/${roomId}`), {
      createdAt: Date.now(),
      status: "lobby",
      hostUid: uid,
      slots: { 1: null, 2: null, 3: null, 4: null },
      game: { phase: "lobby", startedAt: null },
    });

    router.push(`/r/${roomId}?name=${encodeURIComponent(name)}`);
  };

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      <h1>Dummy 4 Players Lobby</h1>
      <p style={{ color: "#666" }}>
        Create room → ส่งลิงก์ให้เพื่อน → เลือก Slot 1-4 → Ready ครบถึงเริ่ม
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="your name"
        />
        <button onClick={createRoom} disabled={loading || !uid}>
          {loading ? "Signing in..." : "Create room"}
        </button>
      </div>
    </main>
  );
}
