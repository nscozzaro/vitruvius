"use client";

import { useState, useEffect, useRef } from "react";

interface AddressInputProps {
  onSubmit: (address: string) => void;
  disabled?: boolean;
}

export default function AddressInput({ onSubmit, disabled }: AddressInputProps) {
  const [address, setAddress] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!address.trim()) {
        setSuggestions([]);
        return;
      }
      // If we already have exact match in suggestions, user probably selected it
      if (suggestions.includes(address)) return;

      try {
        const res = await fetch(`/api/autocomplete?q=${encodeURIComponent(address)}`);
        if (res.ok) {
          const data = await res.json();
          setSuggestions(data);
          setShowDropdown(data.length > 0);
        }
      } catch (err) {
        console.error(err);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [address]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = address.trim();
    if (trimmed) {
      setShowDropdown(false);
      onSubmit(trimmed);
    }
  };

  const handleSelect = (suggestion: string) => {
    setAddress(suggestion);
    setShowDropdown(false);
    onSubmit(suggestion);
  };

  return (
    <div ref={wrapperRef} className="w-full max-w-2xl relative">
      <form onSubmit={handleSubmit} className="w-full">
        <div className="flex gap-3">
          <input
            type="text"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setShowDropdown(true);
            }}
            placeholder="Enter a property address..."
            disabled={disabled}
            className="flex-1 rounded-lg border border-zinc-300 bg-white px-4 py-3 text-base
                       placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2
                       focus:ring-blue-500/20 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900
                       dark:placeholder:text-zinc-500"
          />
          <button
            type="submit"
            disabled={disabled || !address.trim()}
            className="rounded-lg bg-blue-600 px-6 py-3 text-base font-medium text-white
                       transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2
                       focus:ring-blue-500/20 disabled:opacity-50 disabled:hover:bg-blue-600"
          >
            {disabled ? "Collecting..." : "Analyze"}
          </button>
        </div>
      </form>

      {showDropdown && suggestions.length > 0 && !disabled && (
        <ul className="absolute z-10 w-full mt-2 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-900 overflow-hidden">
          {suggestions.map((suggestion, idx) => (
            <li
              key={idx}
              onClick={() => handleSelect(suggestion)}
              className="cursor-pointer px-4 py-3 text-sm text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800 border-b border-zinc-100 dark:border-zinc-800 last:border-0"
            >
              {suggestion}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
