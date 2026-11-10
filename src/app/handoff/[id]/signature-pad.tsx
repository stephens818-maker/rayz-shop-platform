"use client";

import { type PointerEvent, useRef, useState } from "react";

const W = 600;
const H = 200;

/** Signs with a finger, stylus or mouse. The result is SVG path data in a 600×200 box. */
export function SignaturePad({ onChange }: { onChange: (path: string) => void }) {
  const box = useRef<SVGSVGElement>(null);
  const [strokes, setStrokes] = useState<string[]>([]);
  const current = useRef<string[]>([]);
  const drawing = useRef(false);
  const draw = (s: string[]) => {
    current.current = s;
    setStrokes(s);
  };

  const point = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * W);
    const y = Math.round(((e.clientY - r.top) / r.height) * H);
    return `${Math.min(W, Math.max(0, x))} ${Math.min(H, Math.max(0, y))}`;
  };
  const publish = (s: string[]) => onChange(s.join(" "));

  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-2xl bg-zinc-50 ring-2 ring-zinc-300">
        <svg
          ref={box}
          viewBox={`0 0 ${W} ${H}`}
          className="block aspect-[3/1] w-full cursor-crosshair touch-none"
          role="img"
          aria-label="Signature box"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drawing.current = true;
            draw([...current.current, `M${point(e)}`]);
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            const s = current.current;
            draw([...s.slice(0, -1), `${s[s.length - 1]} L${point(e)}`]);
          }}
          onPointerUp={() => {
            drawing.current = false;
            publish(current.current);
          }}
          onPointerCancel={() => (drawing.current = false)}
        >
          <line x1="30" x2={W - 30} y1={H - 40} y2={H - 40} stroke="#d4d4d8" strokeWidth="2" />
          <text x="30" y={H - 14} fill="#a1a1aa" fontSize="18">
            Sign above the line
          </text>
          {strokes.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="#111318" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </svg>
      </div>
      {strokes.length > 0 && (
        <button
          type="button"
          className="min-h-12 px-4 text-base font-medium text-zinc-600 underline"
          onClick={() => {
            draw([]);
            publish([]);
          }}
        >
          Clear and sign again
        </button>
      )}
    </div>
  );
}
