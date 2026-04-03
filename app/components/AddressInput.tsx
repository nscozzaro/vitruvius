"use client";

import { useState } from "react";

interface AddressInputProps {
  onSubmit: (address: string) => void;
  disabled?: boolean;
}

export default function AddressInput({ onSubmit, disabled }: AddressInputProps) {
  const [address, setAddress] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = address.trim();
    if (trimmed) {
      onSubmit(trimmed);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-2xl">
      <div className="flex gap-3">
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
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
  );
}
