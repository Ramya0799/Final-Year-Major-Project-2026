import { TopNav } from "@/components/TopNav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { bearingDegrees, evaluateRouteDeviation, haversineDistanceMeters, normalizeRelativeBearing, calculateRoute } from "@shared/routing";
import { deriveRouteProgress } from "@shared/route-progress";
import { readRouteSelection, routeDestination } from "@shared/route-selection";
import { campusEdges, campusNodes, DEVIATION_THRESHOLD_METERS, destinations, getNode } from "@shared/pathfinder";
import { readCompassHeading, smoothHeading } from "@/lib/deviceHeading";
import { Camera, Compass, LocateFixed, Map as MapIcon, MapPin, Navigation, RotateCcw, ShieldAlert, Smartphone, X } from "lucide-react";
import React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";

type CameraStatus = "idle" | "loading" | "active" | "error";
type LocationStatus = "idle" | "requesting" | "active" | "signal-lost" | "denied" | "error";
type OrientationStatus = "idle" | "unsupported" | "requesting" | "granted" | "denied";
type LocationState = { latitude: number; longitude: number; accuracy: number; timestamp: number };
type OrientationEventWithPermission = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> };
type CompassEvent = DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number };

const stopStream = (stream: MediaStream | null) => {
  stream?.getTracks().forEach((track) => track.stop());
};

export default function ARNavigation() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const locationWatchRef = useRef<number | null>(null);
  const lastRerouteAt = useRef(0);
  const smoothedHeadingRef = useRef<number | null>(null);
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>("idle");
  const [locationStatus, setLocationStatus] = useState<LocationStatus>("idle");
  const [orientationStatus, setOrientationStatus] = useState<OrientationStatus>("idle");
  const [location, setLocation] = useState<LocationState | undefined>();
  const [heading, setHeading] = useState<number | null>(null);
  const [compassMissing, setCompassMissing] = useState(false);
  // Same validated handoff as the map page (query string first, then the saved selection).
  const [initialSelection] = useState(() => readRouteSelection(sessionStorage, window.location.search));
  const [sourceNodeId, setSourceNodeId] = useState(initialSelection.sourceNodeId);
  const destinationId = initialSelection.destinationId;
  const [currentWaypointIndex, setCurrentWaypointIndex] = useState(0);
  const [cameraError, setCameraError] = useState("");
  const [locationError, setLocationError] = useState("");
  const [deviationMessage, setDeviationMessage] = useState("");

  const destination = routeDestination(destinationId) ?? destinations[0];
  const route = useMemo(() => calculateRoute(campusNodes, campusEdges, sourceNodeId, destination.nodeId), [destination.nodeId, sourceNodeId]);
  const routeNodes = useMemo(() => route.nodeIds.map(getNode).filter((node): node is NonNullable<typeof node> => Boolean(node)), [route.nodeIds]);
  const progress = useMemo(() => location
    ? deriveRouteProgress(location, routeNodes, currentWaypointIndex)
    : { currentWaypointIndex, totalWaypoints: routeNodes.length, remainingDistance: route.totalDistance, progressPercent: 0, isComplete: false, distanceToCurrentWaypoint: 0, arrivalThreshold: 18 },
  [currentWaypointIndex, location, route.totalDistance, routeNodes]);
  const activeIndex = Math.max(currentWaypointIndex, progress.currentWaypointIndex);
  const nextWaypointIndex = Math.min(activeIndex + 1, Math.max(0, routeNodes.length - 1));
  const nextWaypoint = routeNodes[nextWaypointIndex] ?? routeNodes[0];
  const distanceToNext = location && nextWaypoint ? Math.round(haversineDistanceMeters(location, nextWaypoint)) : null;
  const targetBearing = nextWaypoint ? bearingDegrees(location ?? routeNodes[Math.min(activeIndex, routeNodes.length - 1)] ?? campusNodes[0], nextWaypoint) : 0;
  const relativeBearing = heading === null ? 0 : normalizeRelativeBearing(targetBearing, heading);
  const arrowRotation = heading === null ? 0 : Math.max(-80, Math.min(80, relativeBearing));
  const directionLabel = progress.isComplete ? "You have arrived" : heading === null ? (compassMissing ? "No compass on this device — follow the map" : "Hold your phone upright to find direction") : Math.abs(relativeBearing) <= 18 ? "Continue straight" : Math.abs(relativeBearing) > 145 ? "Turn around" : relativeBearing > 0 ? "Turn right" : "Turn left";
  const instruction = progress.isComplete ? `You have reached ${destination.name}.` : nextWaypoint ? `Continue toward ${nextWaypoint.name}.` : "Route ready.";

  const setLocationFromPosition = (position: GeolocationPosition) => {
    const next: LocationState = { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy, timestamp: position.timestamp };
    setLocation(next);
    setLocationStatus("active");
    setLocationError("");
  };

  const handleLocationError = (positionError: GeolocationPositionError) => {
    if (positionError.code === 1) {
      setLocationStatus("denied");
      setLocationError("Location permission was denied. AR alignment is unavailable; use the map for reliable turn-by-turn guidance.");
    } else if (positionError.code === 2) {
      setLocationStatus("signal-lost");
      setLocationError("Live location is temporarily unavailable. The route remains visible while PathFinder waits for recovery.");
    } else {
      setLocationStatus("error");
      setLocationError("Location timed out. Try again outdoors or continue with map navigation.");
    }
  };

  const requestLocation = () => {
    if (!navigator.geolocation) {
      setLocationStatus("error");
      setLocationError("Geolocation is unavailable in this browser. Open map navigation to continue.");
      return;
    }
    setLocationStatus("requesting");
    navigator.geolocation.getCurrentPosition(setLocationFromPosition, handleLocationError, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 });
    if (locationWatchRef.current !== null) navigator.geolocation.clearWatch(locationWatchRef.current);
    locationWatchRef.current = navigator.geolocation.watchPosition(setLocationFromPosition, handleLocationError, { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 });
  };

  const enableOrientation = async () => {
    if (!("DeviceOrientationEvent" in window)) {
      setOrientationStatus("unsupported");
      return;
    }
    setOrientationStatus("requesting");
    setCompassMissing(false);
    smoothedHeadingRef.current = null;
    try {
      const eventWithPermission = DeviceOrientationEvent as OrientationEventWithPermission;
      if (typeof eventWithPermission.requestPermission === "function" && await eventWithPermission.requestPermission() !== "granted") {
        setOrientationStatus("denied");
        return;
      }
      setOrientationStatus("granted");
    } catch {
      setOrientationStatus("denied");
    }
  };

  const enableCamera = async () => {
    if (!window.isSecureContext && window.location.hostname !== "localhost") {
      setCameraStatus("error");
      setCameraError("Camera access requires HTTPS. Open map navigation to continue on this connection.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus("error");
      setCameraError("Camera access is unavailable in this browser. Open map navigation to continue.");
      return;
    }
    setCameraStatus("loading");
    setCameraError("");
    // iOS only shows the motion/compass prompt while the tap is still being handled,
    // so ask for it before waiting on the camera prompt.
    await enableOrientation();
    stopStream(streamRef.current);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraStatus("active");
      requestLocation();
    } catch (startError) {
      setCameraStatus("error");
      const denied = startError instanceof DOMException && startError.name === "NotAllowedError";
      setCameraError(denied ? "Camera permission was denied. Allow camera access or use map navigation as the reliable fallback." : "Camera could not be started. Check browser permissions and HTTPS, then try again.");
      stopStream(streamRef.current);
      streamRef.current = null;
    }
  };

  const exitCamera = () => {
    stopStream(streamRef.current);
    streamRef.current = null;
    if (locationWatchRef.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(locationWatchRef.current);
    locationWatchRef.current = null;
    setCameraStatus("idle");
  };

  useEffect(() => {
    if (orientationStatus !== "granted") return;
    // Android Chrome's plain "deviceorientation" is not tied to north; the absolute event is.
    // iOS has no absolute event but adds webkitCompassHeading to "deviceorientation".
    const eventName = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
    const handler = (event: Event) => {
      const reading = readCompassHeading(event as CompassEvent);
      if (reading.heading === null) {
        if (reading.relativeOnly) setCompassMissing(true);
        return;
      }
      setCompassMissing(false);
      smoothedHeadingRef.current = smoothHeading(smoothedHeadingRef.current, reading.heading);
      setHeading(Math.round(smoothedHeadingRef.current) % 360);
    };
    window.addEventListener(eventName, handler, true);
    return () => window.removeEventListener(eventName, handler, true);
  }, [orientationStatus]);

  useEffect(() => {
    if (!location || !routeNodes.length) return;
    const nextProgress = deriveRouteProgress(location, routeNodes, currentWaypointIndex);
    if (nextProgress.currentWaypointIndex > currentWaypointIndex) setCurrentWaypointIndex(nextProgress.currentWaypointIndex);
    if (!cameraStatus || cameraStatus !== "active") return;
    const deviation = evaluateRouteDeviation(location, routeNodes, DEVIATION_THRESHOLD_METERS, lastRerouteAt.current, 15000);
    if (!deviation.shouldReroute) {
      if (!deviation.isOffRoute) setDeviationMessage("");
      return;
    }
    const safeNodes = campusNodes.filter((node) => node.isActive && node.isAccessible);
    const nearestSafeNode = safeNodes.reduce((closest, node) => haversineDistanceMeters(location, node) < haversineDistanceMeters(location, closest) ? node : closest, safeNodes[0]);
    if (!nearestSafeNode) return;
    lastRerouteAt.current = Date.now();
    setSourceNodeId(nearestSafeNode.id);
    setCurrentWaypointIndex(0);
    setDeviationMessage(`Route updated from ${nearestSafeNode.name}.`);
  }, [cameraStatus, currentWaypointIndex, location, routeNodes]);

  useEffect(() => () => {
    stopStream(streamRef.current);
    if (locationWatchRef.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(locationWatchRef.current);
  }, []);

  return <div className="min-h-screen bg-slate-950 text-white"><TopNav transparent /><main className="container py-5 sm:py-8">
    <div className="mb-5 flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm font-bold uppercase tracking-[0.18em] text-cyan-300">Browser AR guidance</p><h1 className="mt-1 font-display text-3xl font-bold tracking-tight">Follow your route to {destination.name}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">Camera guidance is an assisted overlay. GPS and compass quality vary by device; map navigation remains the reliable fallback.</p></div><Badge className="border border-amber-300/30 bg-amber-300/10 text-amber-200 hover:bg-amber-300/10"><ShieldAlert className="mr-1.5 h-3.5 w-3.5" />Experimental browser capability</Badge></div>
    <section className="relative mx-auto max-w-5xl overflow-hidden rounded-[2rem] border border-white/10 bg-slate-900 shadow-2xl"><div className="relative aspect-[9/15] max-h-[680px] min-h-[560px] sm:aspect-[16/10]">
      <video ref={videoRef} playsInline muted className={`absolute inset-0 h-full w-full object-cover ${cameraStatus === "active" ? "opacity-100" : "opacity-0"}`} aria-label="Live rear camera preview" />
      <div className={`absolute inset-0 ${cameraStatus === "active" ? "bg-gradient-to-b from-slate-950/55 via-transparent to-slate-950/85" : "ar-fallback"}`} />
      {(cameraStatus === "idle" || cameraStatus === "loading" || cameraStatus === "error") && <div className="absolute inset-0 grid place-items-center p-6"><div className="max-w-md text-center"><div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-cyan-400 text-slate-950">{cameraStatus === "loading" ? <Navigation className="h-7 w-7 animate-pulse" /> : <Camera className="h-7 w-7" />}</div><h2 className="mt-5 font-display text-2xl font-bold">{cameraStatus === "loading" ? "Starting camera guidance…" : "Camera-first guidance, with a safe fallback."}</h2><p className="mt-3 leading-7 text-slate-300">PathFinder uses the selected route, camera, GPS, and device orientation only after permission. It never invents campus geometry or presents an uncalibrated overlay as world-locked AR.</p><div className="mt-6 flex flex-wrap justify-center gap-3">{cameraStatus !== "loading" && <Button onClick={enableCamera} className="bg-cyan-400 font-bold text-slate-950 hover:bg-cyan-300"><Camera className="mr-2 h-4 w-4" />Enable camera & location</Button>}<Link href="/map" className="inline-flex items-center rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold hover:bg-white/10"><MapIcon className="mr-2 h-4 w-4" />Open map navigation</Link></div>{(cameraError || locationError) && <p role="alert" className="mt-4 rounded-xl border border-rose-300/30 bg-rose-500/10 p-3 text-sm text-rose-100">{cameraError || locationError}</p>}</div></div>}
      {cameraStatus === "active" && <><div className="absolute left-5 right-5 top-5 flex items-center justify-between gap-3"><div className="rounded-full bg-slate-950/70 px-3 py-1.5 text-xs font-bold backdrop-blur">AR route · {destination.name}</div><div className="flex items-center gap-2"><Link href="/map" className="inline-flex min-h-9 items-center rounded-full bg-slate-950/70 px-3 text-xs font-bold backdrop-blur hover:bg-slate-900" onClick={exitCamera}>Return to map</Link><button type="button" onClick={exitCamera} className="grid h-9 w-9 place-items-center rounded-full bg-slate-950/70 backdrop-blur" aria-label="Exit AR"><X className="h-4 w-4" /></button></div></div><div className="absolute left-1/2 top-[22%] w-[min(20rem,calc(100%-2.5rem))] -translate-x-1/2 text-center">{progress.isComplete ? <div className="ar-arrow-stage" role="img" aria-label={`Arrived at ${destination.name}`}><MapPin className="ar-arrival h-24 w-24" /></div> : heading === null ? <div className="ar-arrow-stage" role="img" aria-label="Direction unavailable until compass is ready"><Compass className="ar-compass-wait h-20 w-20" /></div> : <div className="ar-arrow-stage"><div className="ar-arrow" style={{ transform: `rotateX(52deg) rotateZ(${arrowRotation}deg)` }} role="img" aria-label={`${directionLabel}, bearing ${Math.round(targetBearing)} degrees`}><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 3 58 57 32 43 6 57Z" /></svg></div></div>}<p className="mx-auto mt-2 w-fit rounded-full bg-slate-950/75 px-4 py-2 text-center text-sm font-bold backdrop-blur">{directionLabel}</p></div><div className="absolute bottom-5 left-5 right-5 rounded-2xl bg-slate-950/85 p-4 backdrop-blur"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-bold uppercase tracking-[.16em] text-cyan-300">Next instruction</p><p className="mt-1 font-display text-lg font-bold">{instruction}</p><p className="mt-1 truncate text-xs text-slate-300">Next waypoint: {nextWaypoint?.name ?? destination.name}</p></div><div className="shrink-0 text-right"><p className="font-mono text-2xl font-medium text-cyan-300">{distanceToNext === null ? "—" : `${distanceToNext} m`}</p><p className="text-xs text-slate-300">{heading === null ? "heading unavailable" : `facing ${heading}° · target ${Math.round(targetBearing)}°`}</p></div></div><div className="mt-3 h-1.5 rounded-full bg-white/15"><div className="h-full rounded-full bg-cyan-400 transition-[width] duration-300" style={{ width: `${progress.progressPercent}%` }} /></div><div className="mt-2 flex items-center justify-between text-[11px] text-slate-300"><span>{progress.progressPercent}% route progress</span><span>{progress.remainingDistance} m remaining</span></div>{deviationMessage && <p className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-xs text-amber-100">{deviationMessage}</p>}{locationError && locationStatus !== "active" && <p role="status" className="mt-3 rounded-lg border border-rose-300/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">{locationError}</p>}</div></>}
    </div></section>
    <section className="mx-auto mt-5 grid max-w-5xl gap-4 md:grid-cols-3"><article className="rounded-2xl border border-white/10 bg-white/5 p-5"><Compass className="h-5 w-5 text-cyan-300" /><h2 className="mt-3 font-semibold">Motion & orientation</h2><p className="mt-1 text-sm leading-6 text-slate-300">{heading === null ? "Heading unavailable until the device sends a compass reading." : `Compass heading: ${heading}°.`} AR arrow uses target bearing minus device heading.</p>{compassMissing && heading === null && <p className="mt-2 text-xs text-amber-200">This device reports motion but not a compass direction, so the arrow cannot be aligned. Use the map for directions.</p>}<Button variant="outline" onClick={enableOrientation} className="mt-4 border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white"><Smartphone className="mr-2 h-4 w-4" />{orientationStatus === "granted" ? "Refresh orientation" : "Enable motion & orientation"}</Button>{orientationStatus === "unsupported" && <p className="mt-2 text-xs text-amber-200">Device orientation is not supported here. The map remains the reliable directional guide.</p>}{orientationStatus === "denied" && <p className="mt-2 text-xs text-amber-200">Compass access was denied or unavailable. The overlay is not accurately aligned.</p>}</article><article className="rounded-2xl border border-white/10 bg-white/5 p-5"><LocateFixed className="h-5 w-5 text-cyan-300" /><h2 className="mt-3 font-semibold">Live route status</h2><p className="mt-1 text-sm leading-6 text-slate-300">{locationStatus === "active" ? `GPS connected · ±${Math.round(location?.accuracy ?? 0)} m` : locationStatus === "requesting" ? "Requesting location permission…" : locationStatus === "signal-lost" ? "Signal lost; waiting for recovery." : "No live position shared yet."}</p><Button variant="outline" onClick={requestLocation} className="mt-4 border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white"><LocateFixed className="mr-2 h-4 w-4" />{locationStatus === "active" ? "Refresh location" : "Enable live location"}</Button></article><article className="rounded-2xl border border-white/10 bg-white/5 p-5"><RotateCcw className="h-5 w-5 text-cyan-300" /><h2 className="mt-3 font-semibold">Future 3D readiness</h2><p className="mt-1 text-sm leading-6 text-slate-300">The route and waypoint contracts are independent of rendering. A future Autodesk GLB/glTF campus model can consume this same verified route state without rewriting navigation.</p><p className="mt-3 text-xs text-amber-200">Indoor GPS may be unreliable; approved indoor positioning and floor data are still required.</p></article></section>
    <div className="mx-auto mt-5 flex max-w-5xl justify-start"><Link href="/map" onClick={exitCamera} className="inline-flex items-center gap-2 text-sm font-semibold text-cyan-300 hover:text-cyan-200"><MapIcon className="h-4 w-4" />Return to map navigation</Link></div>
  </main></div>;
}
