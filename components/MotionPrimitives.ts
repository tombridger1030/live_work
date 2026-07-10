// Shared animation constants for the app-wide motion foundation.
// Ledger and Tally import these rather than defining their own springs.
export const appSpring = { type: "spring", duration: 0.32, bounce: 0 } as const;
export const appQuick = { duration: 0.18, ease: [0.2, 0, 0, 1] } as const;
export const appSlow = { type: "spring", duration: 0.48, bounce: 0 } as const;
export const pressSpring = { type: "spring", duration: 0.22, bounce: 0 } as const;
export const traySpring = { type: "spring", duration: 0.4, bounce: 0 } as const;
export const staggerStep = 0.06;
export const reducedMotionTransition = { duration: 0.01, ease: "linear" } as const;

export function motionTransition<T>(reduceMotion: boolean, transition: T): T | typeof reducedMotionTransition {
  return reduceMotion ? reducedMotionTransition : transition;
}
