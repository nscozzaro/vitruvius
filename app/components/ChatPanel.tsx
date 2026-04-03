"use client";

import { useState, useRef, useEffect } from "react";
import type { CollectionResults } from "@/app/lib/api";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatPanelProps {
  data: CollectionResults;
}

function buildSystemSummary(data: CollectionResults): string {
  const parts: string[] = [];
  parts.push(`Address: ${data.geocoded?.address}`);
  if (data.footprint) parts.push(`${data.footprint.length}-point building footprint`);
  if (data.elevation_m != null) parts.push(`Elevation: ${data.elevation_m}m`);
  if (data.assessor?.sqft) parts.push(`${data.assessor.sqft.toLocaleString()} sqft`);
  if (data.assessor?.bedrooms) parts.push(`${data.assessor.bedrooms} bed`);
  if (data.assessor?.bathrooms) parts.push(`${data.assessor.bathrooms} bath`);
  if (data.assessor?.year_built) parts.push(`Built ${data.assessor.year_built}`);
  if (data.assessor?.stories) parts.push(`${data.assessor.stories} stories`);
  const imgCount = data.streetImages.length + data.listingPhotos.length;
  if (imgCount > 0) parts.push(`${imgCount} images collected`);
  return parts.join(" · ");
}

export default function ChatPanel({ data }: ChatPanelProps) {
  const summary = buildSystemSummary(data);
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content: `I've collected data for this property. Here's what I found:\n\n${summary}\n\nI can help you design a building model based on this data, answer questions about the property, or scaffold an IFC file. What would you like to do?`,
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const userMessage: Message = { role: "user", content: trimmed };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, userMessage],
          propertyData: data,
        }),
      });

      if (!resp.ok) {
        throw new Error("Chat request failed");
      }

      const result = await resp.json();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: result.content },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, I encountered an error. Please try again.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-zinc-900 dark:bg-zinc-100">
            <svg className="h-3.5 w-3.5 text-white dark:text-zinc-900" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
            </svg>
          </div>
          <h2 className="text-sm font-semibold">AI Assistant</h2>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={
              msg.role === "user"
                ? "ml-8"
                : ""
            }
          >
            {msg.role === "user" ? (
              <div className="rounded-2xl rounded-tr-sm bg-zinc-900 px-4 py-3 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">
                {msg.content}
              </div>
            ) : (
              <div className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                <div className="whitespace-pre-wrap">{msg.content}</div>
              </div>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" />
            </span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
        <div className="flex items-end gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 focus-within:border-zinc-300 focus-within:ring-1 focus-within:ring-zinc-300/50 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:border-zinc-600">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Ask about the property or describe a design..."
            disabled={isLoading}
            rows={1}
            className="max-h-32 flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-zinc-400 disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-white transition-colors hover:bg-zinc-800 disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
