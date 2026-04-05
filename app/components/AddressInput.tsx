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
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    const trimmed = address.trim();
    if (trimmed.length < 5) {
      setSuggestions([]);
      setShowDropdown(false);
      return;
    }
    if (suggestions.includes(address)) return;

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/autocomplete?q=${encodeURIComponent(trimmed)}`);
        if (res.ok) {
          const data = await res.json();
          setSuggestions(data);
          setShowDropdown(data.length > 0);
          setSelectedIndex(-1);
        }
      } catch (err) {
        console.error(err);
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [address]);

  const submit = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !disabled) {
      setShowDropdown(false);
      onSubmit(trimmed);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        prev < suggestions.length - 1 ? prev + 1 : prev
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
        const selected = suggestions[selectedIndex];
        setAddress(selected);
        submit(selected);
      } else {
        submit(address);
      }
    } else if (e.key === "Escape") {
      setShowDropdown(false);
    }
  };

  const handleSelect = (suggestion: string) => {
    setAddress(suggestion);
    submit(suggestion);
  };

  return (
    <div ref={wrapperRef} className="w-full max-w-xl relative">
      <div className="relative group">
        <div className="absolute -inset-0.5 rounded-2xl bg-gradient-to-r from-blue-500/20 via-violet-500/20 to-blue-500/20 opacity-0 blur transition-opacity duration-500 group-focus-within:opacity-100" />
        <div className="relative flex items-center rounded-2xl border border-zinc-200 bg-white shadow-sm transition-shadow duration-300 focus-within:shadow-lg focus-within:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:focus-within:border-zinc-700">
          <svg
            className="ml-4 h-5 w-5 shrink-0 text-zinc-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setShowDropdown(true);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search for any property address..."
            disabled={disabled}
            className="flex-1 bg-transparent px-3 py-4 text-base outline-none placeholder:text-zinc-400 disabled:opacity-50 dark:placeholder:text-zinc-500"
          />
          {disabled && (
            <div className="mr-4">
              <span className="h-5 w-5 block animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
            </div>
          )}
          {!disabled && address.trim() && (
            <button
              type="button"
              onClick={() => submit(address)}
              className="mr-2 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Go
            </button>
          )}
        </div>
      </div>

      {showDropdown && suggestions.length > 0 && !disabled && (
        <ul className="absolute z-10 w-full mt-2 rounded-xl border border-zinc-200 bg-white py-1 shadow-xl dark:border-zinc-800 dark:bg-zinc-900 overflow-hidden">
          {suggestions.map((suggestion, idx) => (
            <li
              key={idx}
              onClick={() => handleSelect(suggestion)}
              className={`cursor-pointer px-4 py-3 text-sm transition-colors ${
                idx === selectedIndex
                  ? "bg-zinc-100 dark:bg-zinc-800"
                  : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/50"
              }`}
            >
              <div className="flex items-center gap-3">
                <svg className="h-4 w-4 shrink-0 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                </svg>
                <span>{suggestion}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
