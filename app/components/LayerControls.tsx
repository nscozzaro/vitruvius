"use client";

interface LayerVisibility {
  lot_boundary: boolean;
  monument: boolean;
  easement: boolean;
  road_centerline: boolean;
  label: boolean;
  quality: boolean;
}

interface LayerControlsProps {
  layers: LayerVisibility;
  onToggle: (layer: keyof LayerVisibility) => void;
  opacity: number;
  onOpacityChange: (value: number) => void;
}

const LAYER_CONFIG: Array<{
  key: keyof LayerVisibility;
  label: string;
  color: string;
}> = [
  { key: "lot_boundary", label: "Boundaries", color: "#0066FF" },
  { key: "monument", label: "Monuments", color: "#FF0000" },
  { key: "easement", label: "Easements", color: "#FFD700" },
  { key: "road_centerline", label: "Roads", color: "#00CC00" },
  { key: "label", label: "Labels", color: "#00FFFF" },
  { key: "quality", label: "Quality halos", color: "#888888" },
];

export default function LayerControls({
  layers,
  onToggle,
  opacity,
  onOpacityChange,
}: LayerControlsProps) {
  return (
    <div className="border-t border-zinc-200 px-3 py-3 dark:border-zinc-700">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
        Layers
      </h3>

      <div className="space-y-1.5">
        {LAYER_CONFIG.map(({ key, label, color }) => (
          <label key={key} className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={layers[key]}
              onChange={() => onToggle(key)}
              className="h-3.5 w-3.5 rounded border-zinc-300 dark:border-zinc-600"
            />
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: color }}
            />
            <span className="text-zinc-600 dark:text-zinc-300">{label}</span>
          </label>
        ))}
      </div>

      <div className="mt-3">
        <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
          Overlay Opacity
        </label>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={100}
            value={opacity}
            onChange={(e) => onOpacityChange(parseInt(e.target.value, 10))}
            className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-zinc-200 dark:bg-zinc-700"
          />
          <span className="w-8 text-right text-xs text-zinc-500">{opacity}%</span>
        </div>
      </div>
    </div>
  );
}

export type { LayerVisibility };
