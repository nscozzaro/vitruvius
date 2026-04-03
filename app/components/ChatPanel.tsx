"use client";

import { useState } from "react";
import type { CollectionResults } from "@/app/lib/api";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatPanelProps {
  data: CollectionResults;
}

export default function ChatPanel({ data }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content: `I've collected data for ${data.geocoded?.address}. I found ${
        data.footprint ? `a ${data.footprint.length}-point building footprint` : "no footprint"
      }${data.elevation_m ? `, elevation ${data.elevation_m}m` : ""}${
        data.assessor?.sqft ? `, ${data.assessor.sqft} sqft` : ""
      }${data.assessor?.year_built ? `, built ${data.assessor.year_built}` : ""}. ${
        data.streetImages.length + data.listingPhotos.length
      } images collected.\n\nI can scaffold a building model from this data, or you can describe the building to help me get started. What would you like to do?`,
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const userMessage: Message = { role: "user", content: trimmed };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    // Phase 4: This will call /api/chat with the building JSON + user message
    // For now, show a placeholder response
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            "Chat with AI is coming in Phase 3-4. This will send your message along with the building JSON to Claude, which will return an updated building model.",
        },
      ]);
      setIsLoading(false);
    }, 1000);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 className="text-sm font-semibold">Chat</h2>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`text-sm leading-relaxed ${
              msg.role === "user"
                ? "ml-8 rounded-lg bg-blue-50 p-3 dark:bg-blue-900/20"
                : "text-zinc-700 dark:text-zinc-300"
            }`}
          >
            <div className="mb-1 text-xs font-medium text-zinc-400">
              {msg.role === "user" ? "You" : "Vitruvius AI"}
            </div>
            <div className="whitespace-pre-wrap">{msg.content}</div>
          </div>
        ))}
        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
            Thinking...
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder="Describe a change..."
            disabled={isLoading}
            className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm
                       placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none
                       focus:ring-1 focus:ring-blue-500/20 disabled:opacity-50
                       dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white
                       hover:bg-blue-700 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
