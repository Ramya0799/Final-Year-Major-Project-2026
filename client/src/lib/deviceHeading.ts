/**
 * Compass helpers for the AR camera view.
 *
 * Headings are degrees clockwise from north (0 = north, 90 = east),
 * matching bearingDegrees() in shared/routing.ts.
 */

export type OrientationReading = {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  absolute?: boolean;
  /** iOS Safari only: clockwise degrees from magnetic north. */
  webkitCompassHeading?: number;
  /** iOS Safari only: negative when the compass is not calibrated. */
  webkitCompassAccuracy?: number;
};

export type CompassReading =
  | { heading: number; relativeOnly: false }
  | { heading: null; relativeOnly: boolean };

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

export const normalizeDegrees = (degrees: number) => ((degrees % 360) + 360) % 360;

/**
 * Direction the rear camera faces, from W3C device orientation angles.
 * `alpha` must be north-referenced (an absolute reading) for this to be a compass heading.
 *
 * When the phone is held nearly flat the camera points at the ground, so its
 * horizontal direction is unstable; in that case the top edge of the phone is used.
 */
export function headingFromOrientation(alpha: number, beta: number, gamma: number) {
  const sinA = Math.sin(toRadians(alpha));
  const cosA = Math.cos(toRadians(alpha));
  const sinB = Math.sin(toRadians(beta));
  const cosB = Math.cos(toRadians(beta));
  const sinG = Math.sin(toRadians(gamma));
  const cosG = Math.cos(toRadians(gamma));

  // Rear-camera axis (device -Z) in earth coordinates: x = east, y = north.
  const east = -cosA * sinG - sinA * sinB * cosG;
  const north = -sinA * sinG + cosA * sinB * cosG;
  if (Math.hypot(east, north) >= 0.35) return normalizeDegrees(toDegrees(Math.atan2(east, north)));

  // Nearly flat: top edge of the phone (device +Y).
  return normalizeDegrees(toDegrees(Math.atan2(-sinA * cosB, cosA * cosB)));
}

/**
 * Turns a deviceorientation / deviceorientationabsolute event into a compass heading.
 * Readings that are not tied to north (Android's relative `deviceorientation`) return
 * `heading: null, relativeOnly: true`, because pointing an arrow from them would be wrong.
 */
export function readCompassHeading(event: OrientationReading): CompassReading {
  const iosHeading = event.webkitCompassHeading;
  if (typeof iosHeading === "number" && Number.isFinite(iosHeading)) {
    if (typeof event.webkitCompassAccuracy === "number" && event.webkitCompassAccuracy < 0) return { heading: null, relativeOnly: false };
    return { heading: normalizeDegrees(iosHeading), relativeOnly: false };
  }
  if (event.alpha === null || event.beta === null || event.gamma === null) return { heading: null, relativeOnly: false };
  if (event.absolute !== true) return { heading: null, relativeOnly: true };
  return { heading: headingFromOrientation(event.alpha, event.beta, event.gamma), relativeOnly: false };
}

/** Low-pass filter for compass jitter that turns the short way around 0°/360°. */
export function smoothHeading(previous: number | null, next: number, factor = 0.25) {
  if (previous === null) return normalizeDegrees(next);
  const delta = ((next - previous + 540) % 360) - 180;
  return normalizeDegrees(previous + delta * factor);
}
