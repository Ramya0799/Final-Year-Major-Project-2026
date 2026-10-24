import { describe, expect, it } from "vitest";
import { headingFromOrientation, readCompassHeading, smoothHeading } from "./deviceHeading";

const close = (value: number, expected: number) => expect(Math.abs(((value - expected + 540) % 360) - 180)).toBeLessThan(0.5);

describe("AR compass heading", () => {
  it("returns the rear-camera direction for an upright phone", () => {
    close(headingFromOrientation(0, 90, 0), 0);
    // alpha turns counter-clockwise, so alpha 90 means the camera faces west, not east.
    close(headingFromOrientation(90, 90, 0), 270);
    close(headingFromOrientation(270, 90, 0), 90);
    close(headingFromOrientation(180, 75, 0), 180);
  });

  it("uses the top edge when the phone is held flat", () => {
    close(headingFromOrientation(0, 0, 0), 0);
    close(headingFromOrientation(90, 0, 0), 270);
    close(headingFromOrientation(300, 5, 3), 60);
  });

  it("uses the iOS compass heading directly", () => {
    expect(readCompassHeading({ alpha: 10, beta: 90, gamma: 0, webkitCompassHeading: 123 })).toEqual({ heading: 123, relativeOnly: false });
    expect(readCompassHeading({ alpha: 10, beta: 90, gamma: 0, webkitCompassHeading: 123, webkitCompassAccuracy: -1 }).heading).toBeNull();
  });

  it("ignores orientation readings that are not tied to north", () => {
    expect(readCompassHeading({ alpha: 40, beta: 90, gamma: 0, absolute: false })).toEqual({ heading: null, relativeOnly: true });
    expect(readCompassHeading({ alpha: null, beta: null, gamma: null })).toEqual({ heading: null, relativeOnly: false });
    close(readCompassHeading({ alpha: 90, beta: 90, gamma: 0, absolute: true }).heading ?? -1, 270);
  });

  it("smooths jitter the short way around north", () => {
    expect(smoothHeading(null, 370)).toBe(10);
    close(smoothHeading(350, 10, 0.5), 0);
    close(smoothHeading(10, 350, 0.5), 0);
    close(smoothHeading(90, 100, 0.25), 92.5);
  });
});
