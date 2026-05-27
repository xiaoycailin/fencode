"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Item = {
  value: string;
  label: string;
};

export function SettingsSelect({
  value,
  items,
  onChange,
  placeholder = "Select",
}: {
  value: string;
  items: Item[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const active = items.find((item) => item.value === value);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, []);

  return (
    <div className="config-select config-select-inline" ref={ref}>
      <button type="button" className="config-select-trigger" onClick={() => setOpen((current) => !current)}>
        <span>{active?.label ?? placeholder}</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="config-select-menu">
          {items.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`config-select-item${item.value === value ? " active" : ""}`}
              onClick={() => {
                setOpen(false);
                onChange(item.value);
              }}
            >
              <span><b>{item.label}</b></span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
