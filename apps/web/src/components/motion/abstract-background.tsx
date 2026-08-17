"use client";

import { motion, useReducedMotion } from "motion/react";

/**
 * Restrained, technical background decoration for the dashboard hero — a
 * faint dot grid plus two soft, slow-drifting color fields (not a literal
 * Haikei export, but the same family of layered-blob visual language).
 * Purely decorative: `aria-hidden`, never carries information, and the drift
 * is disabled under reduced motion rather than just slowed down.
 */
export function AbstractBackground() {
  const reduceMotion = useReducedMotion();

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-xl"
    >
      <svg className="absolute inset-0 h-full w-full opacity-[0.35]" aria-hidden>
        <defs>
          <pattern id="dp-grid" width="28" height="28" patternUnits="userSpaceOnUse">
            <circle cx="1.5" cy="1.5" r="1.5" className="fill-foreground/[0.06]" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#dp-grid)" />
      </svg>

      <motion.div
        className="absolute -top-24 -right-24 size-80 rounded-full bg-primary/20 blur-3xl"
        animate={reduceMotion ? undefined : { x: [0, 16, 0], y: [0, -10, 0] }}
        transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute -bottom-28 -left-16 size-72 rounded-full bg-info/15 blur-3xl"
        animate={reduceMotion ? undefined : { x: [0, -14, 0], y: [0, 12, 0] }}
        transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }}
      />

      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background" />
    </div>
  );
}
