import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { campusEdges, campusNodes, getNode } from "@shared/pathfinder";
import { bearingDegrees, calculateRoute } from "@shared/routing";
import ARNavigation from "./ARNavigation";

const getUserMediaSpy = vi.hoisted(() => vi.fn());
const clearWatchSpy = vi.hoisted(() => vi.fn());
const watchPositionSpy = vi.hoisted(() => vi.fn());
const getCurrentPositionSpy = vi.hoisted(() => vi.fn());

vi.mock("@/components/TopNav", () => ({ TopNav: () => <div data-testid="top-nav" /> }));
vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return { ...actual, useLocation: () => ["/ar", vi.fn()] };
});

function createStream() {
  const stop = vi.fn();
  return { getTracks: () => [{ stop }] } as unknown as MediaStream;
}

beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem("aiet-source", "gate");
  sessionStorage.setItem("pathfinder-destination", "d10");
  getUserMediaSpy.mockResolvedValue(createStream());
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: getUserMediaSpy } });
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: getCurrentPositionSpy, watchPosition: watchPositionSpy.mockReturnValue(31), clearWatch: clearWatchSpy } });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
});

function installOrientationSupport({ absoluteEvent }: { absoluteEvent: boolean }) {
  Object.defineProperty(window, "DeviceOrientationEvent", { configurable: true, writable: true, value: class {} });
  if (absoluteEvent) Object.defineProperty(window, "ondeviceorientationabsolute", { configurable: true, writable: true, value: null });
}

function fireOrientation(type: string, reading: { alpha: number; beta: number; gamma: number; absolute: boolean }, times = 1) {
  act(() => {
    for (let index = 0; index < times; index += 1) window.dispatchEvent(Object.assign(new Event(type), reading));
  });
}

afterEach(() => {
  cleanup();
  delete (window as Partial<Window> & { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent;
  delete (window as { ondeviceorientationabsolute?: unknown }).ondeviceorientationabsolute;
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
  getUserMediaSpy.mockReset();
  getCurrentPositionSpy.mockReset();
  watchPositionSpy.mockReset();
  clearWatchSpy.mockReset();
  sessionStorage.clear();
});

describe("AR navigation", () => {
  it("uses the selected route destination and starts live camera/location guidance", async () => {
    const user = userEvent.setup();
    render(<ARNavigation />);

    expect(screen.getByRole("heading", { name: /Follow your route to Central Library/i })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Enable camera & location/i }));

    await waitFor(() => expect(getUserMediaSpy).toHaveBeenCalled());
    expect(watchPositionSpy).toHaveBeenCalled();
    expect(screen.getByText("AR route · Central Library")).toBeTruthy();
    expect(screen.getByText(/Next instruction/i)).toBeTruthy();
    expect(screen.getByText("heading unavailable")).toBeTruthy();
    expect(screen.queryByText("38 m")).toBeNull();
  });

  it("shows a permission-denied camera error and retains the map fallback", async () => {
    const user = userEvent.setup();
    getUserMediaSpy.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    render(<ARNavigation />);

    await user.click(screen.getByRole("button", { name: /Enable camera & location/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Camera permission was denied/i);
    expect(screen.getByRole("link", { name: /Open map navigation/i }).getAttribute("href")).toBe("/map");
  });

  it("handles denied location permission without fabricating a position", async () => {
    const user = userEvent.setup();
    getCurrentPositionSpy.mockImplementation((_success: PositionCallback, error: PositionErrorCallback) => error?.({ code: 1, message: "denied", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError));
    render(<ARNavigation />);

    await user.click(screen.getByRole("button", { name: /Enable live location/i }));
    expect(await screen.findByText(/Location permission was denied/i)).toBeTruthy();
    expect(screen.getByText(/No live position shared yet/i)).toBeTruthy();
  });

  it("stops camera tracks and GPS watch when returning to the map", async () => {
    const user = userEvent.setup();
    const stream = createStream();
    getUserMediaSpy.mockResolvedValueOnce(stream);
    render(<ARNavigation />);
    await user.click(screen.getByRole("button", { name: /Enable camera & location/i }));
    await waitFor(() => expect(screen.getByText("AR route · Central Library")).toBeTruthy());

    await user.click(screen.getByRole("link", { name: "Return to map" }));
    expect(clearWatchSpy).toHaveBeenCalledWith(31);
    expect((stream.getTracks()[0] as MediaStreamTrack).stop).toHaveBeenCalled();
  });

  it("updates the route overlay from a real GPS fix", async () => {
    const user = userEvent.setup();
    let success: PositionCallback | undefined;
    watchPositionSpy.mockImplementation((callback: PositionCallback) => { success = callback; return 31; });
    render(<ARNavigation />);
    await user.click(screen.getByRole("button", { name: /Enable camera & location/i }));

    await act(async () => success?.({ coords: { latitude: 13.0219, longitude: 74.98128, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) }, timestamp: Date.now(), toJSON: () => ({}) } as GeolocationPosition));
    expect(await screen.findByText(/GPS connected · ±5 m/i)).toBeTruthy();
  });

  it("turns the arrow the right way from a north-referenced compass reading", async () => {
    const user = userEvent.setup();
    installOrientationSupport({ absoluteEvent: true });
    const route = calculateRoute(campusNodes, campusEdges, "gate", "library");
    const target = bearingDegrees(getNode(route.nodeIds[0])!, getNode(route.nodeIds[1])!);
    // Upright phone: camera heading = 360 - alpha.
    const alphaFacing = (heading: number) => (360 - heading + 360) % 360;
    render(<ARNavigation />);
    await user.click(screen.getByRole("button", { name: /Enable camera & location/i }));
    await waitFor(() => expect(screen.getByText("AR route · Central Library")).toBeTruthy());

    fireOrientation("deviceorientationabsolute", { alpha: alphaFacing(target), beta: 90, gamma: 0, absolute: true });
    expect(screen.getAllByText("Continue straight").length).toBeGreaterThan(0);

    // Facing 90° to the right of the route means the user must turn left.
    fireOrientation("deviceorientationabsolute", { alpha: alphaFacing(target + 90), beta: 90, gamma: 0, absolute: true }, 40);
    expect(screen.getAllByText("Turn left").length).toBeGreaterThan(0);

    fireOrientation("deviceorientationabsolute", { alpha: alphaFacing(target - 90), beta: 90, gamma: 0, absolute: true }, 40);
    expect(screen.getAllByText("Turn right").length).toBeGreaterThan(0);
  });

  it("does not point the arrow from orientation data that is not tied to north", async () => {
    const user = userEvent.setup();
    installOrientationSupport({ absoluteEvent: false });
    render(<ARNavigation />);
    await user.click(screen.getByRole("button", { name: /Enable camera & location/i }));
    await waitFor(() => expect(screen.getByText("AR route · Central Library")).toBeTruthy());

    fireOrientation("deviceorientation", { alpha: 45, beta: 90, gamma: 0, absolute: false });
    expect(screen.getByText("heading unavailable")).toBeTruthy();
    expect(screen.getByText(/reports motion but not a compass direction/i)).toBeTruthy();
    expect(screen.getByRole("img", { name: /Direction unavailable until compass is ready/i })).toBeTruthy();
  });

  it("uses the route from the link and ignores an invalid saved destination", () => {
    sessionStorage.setItem("pathfinder-destination", "not-a-destination");
    window.history.replaceState({}, "", "/ar?source=gate&destination=d13");
    render(<ARNavigation />);
    expect(screen.getByRole("heading", { name: /Follow your route to Cafeteria/i })).toBeTruthy();

    cleanup();
    window.history.replaceState({}, "", "/ar");
    render(<ARNavigation />);
    expect(screen.getByRole("heading", { name: /Follow your route to Central Library/i })).toBeTruthy();
  });
});
