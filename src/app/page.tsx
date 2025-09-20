"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import MessageInput from "@/components/MessageInput";
import HeadTopBar from "@/components/HeadTopBar";

interface Message {
  role: "user" | "advisor";
  text: string;
}

export default function Page() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  const endRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const handleScroll = () => {
    const c = containerRef.current;
    if (!c) return;
    const nearBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 100;
    setAutoScroll(nearBottom);
  };

  const handleSend = async (text: string) => {
    setMessages((m) => [...m, { role: "user", text }]);
    setLoading(true);

    const res = await fetch("/api/synthesizer-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userScenario: text }),
    });
    const data = await res.json();

    setMessages((m) => [...m, { role: "advisor", text: data.advice }]);
    setLoading(false);
  };

  useEffect(() => {
    if (autoScroll) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading, autoScroll]);

  return (
    <div className="flex flex-col h-dvh bg-[#fdf9f3] font-serif">
      <HeadTopBar />
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-6 py-6 space-y-4 w-full"
      >
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`w-fit max-w-[80%] text-sm ${
              msg.role === "user"
                ? "ml-auto bg-gradient-to-br from-red-800 to-red-600 text-white rounded-2xl px-4 py-3"
                : "mr-auto bg-[#f8f1e4] border border-[#e6d5b8] text-black rounded-2xl px-4 py-3"
            }`}
          >
            {msg.role === "advisor" ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  p: ({ node, ...props }) => (
                    <p
                      className="mb-3 leading-relaxed text-justify"
                      {...props}
                    />
                  ),
                  li: ({ node, ...props }) => (
                    <li className="mb-1 list-decimal ml-5" {...props} />
                  ),
                  strong: ({ node, ...props }) => (
                    <strong className="font-bold" {...props} />
                  ),
                }}
              >
                {msg.text}
              </ReactMarkdown>
            ) : (
              msg.text
            )}
          </div>
        ))}
        {loading && <div className="mr-auto">…thinking</div>}
        <div ref={endRef} />
      </div>
      <div className="px-6 pb-4">
        <MessageInput onSend={handleSend} />
      </div>
    </div>
  );
}
