"use client";

import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

interface RevealProps {
  children: ReactNode;
  /** Stagger offset in seconds — pass `index * 0.06` when revealing a list. */
  delay?: number;
  className?: string;
}

/**
 * Subtle fade + rise entrance, used for dashboard cards and status rows so
 * content arrives with a small sense of hierarchy instead of popping in all
 * at once. A no-op (renders children directly, no animation) when the user
 * has requested reduced motion.
 */
export function Reveal({ children, delay = 0, className }: RevealProps) {
  const reduceMotion = useReducedMotion();

  if (reduceMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
