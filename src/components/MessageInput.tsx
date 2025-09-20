"use client";
import { useState } from "react";

export default function MessageInput({
  onSend,
}: {
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText("");
  };

  return (
    <div className="flex gap-2">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="Type your message…"
        className="flex-1 border rounded-xl px-4 py-2 outline-none focus:ring"
      />
      <button
        onClick={submit}
        className="bg-black text-white px-4 py-2 rounded-xl hover:opacity-90"
      >
        Send
      </button>
    </div>
  );
}
