"use client";

import { useEffect, useMemo, useState } from "react";
import { ThemeControls } from "@/components/theme-provider";

type AppLink = { id: string; name: string; url: string; description: string; kind: "LAN" | "Docker"; externalOnly?: boolean };

const apps: AppLink[] = [
  { id: "games", name: "Game Library", url: "/games", description: "Steam and Windows-game inventory", kind: "LAN" },
  { id: "openshorts", name: "OpenShorts", url: "http://192.168.1.16:5175", description: "AI clips, shorts and YouTube Studio", kind: "Docker" },
  { id: "bookorbit", name: "BookOrbit", url: "http://192.168.1.16:3050", description: "Ebook, audiobook, comic & PDF library · opens separately", kind: "Docker", externalOnly: true },
  { id: "tapmap", name: "TapMap", url: "http://192.168.1.16:8085", description: "Live 3D globe & socket GeoIP visualizer", kind: "Docker" },
  { id: "netwatch", name: "NetWatch", url: "http://192.168.1.16:8087", description: "Real-time process & network bandwidth telemetry", kind: "Docker" },
  { id: "gods-eye", name: "God's Eye View", url: "http://192.168.1.16:4173", description: "Cesium 3D Globe + TomTom Traffic", kind: "LAN" },
  { id: "real-estate", name: "Houston Real Estate", url: "/real-estate", description: "TomTom Map Agent ($400k-$1.2M)", kind: "LAN" },
  { id: "seerr", name: "Seerr (Assemblrr)", url: "http://192.168.1.16:5055", description: "Media requests, discovery & automation", kind: "Docker" },
  { id: "jellyfin", name: "Jellyfin", url: "http://192.168.1.16:8096", description: "Media streaming server · Assemblrr", kind: "Docker" },
  { id: "sonarr", name: "Sonarr", url: "http://192.168.1.16:8989", description: "TV series automation · Assemblrr", kind: "Docker" },
  { id: "radarr", name: "Radarr", url: "http://192.168.1.16:7878", description: "Movie collection automation · Assemblrr", kind: "Docker" },
  { id: "prowlarr", name: "Prowlarr", url: "http://192.168.1.16:9696", description: "Indexer manager · Assemblrr", kind: "Docker" },
  { id: "bazarr", name: "Bazarr", url: "http://192.168.1.16:6767", description: "Subtitle management · Assemblrr", kind: "Docker" },
  { id: "qbittorrent", name: "qBittorrent", url: "http://192.168.1.16:8081", description: "Torrent client · opens separately", kind: "Docker", externalOnly: true },
  { id: "comfyui", name: "ComfyUI", url: "http://192.168.1.16:8188", description: "Image workflows", kind: "LAN" },
  { id: "handy", name: "Handy", url: "http://192.168.1.16:8086", description: "Offline speech-to-text & dictation studio", kind: "LAN" },
  { id: "stremio", name: "Stremio", url: "http://192.168.1.16:8100", description: "Video library and player", kind: "Docker" },
  { id: "sabnzbd", name: "SABnzbd", url: "http://192.168.1.16:8282", description: "Download queue · opens separately", kind: "Docker", externalOnly: true },
  { id: "vpn", name: "PIA · Gluetun", url: "/vpn", description: "VPN status, exit IP and port forwarding", kind: "Docker" },
  { id: "iptv", name: "go-IPTV", url: "/api/iptv/", description: "Live TV, VOD, series and EPG", kind: "LAN" },
];

export default function AppsPage() {
  const [activeId, setActiveId] = useState("openshorts");
  const [opened, setOpened] = useState(["openshorts"]);
  const [appsCollapsed, setAppsCollapsed] = useState(false);
  useEffect(() => {
    try { setAppsCollapsed(localStorage.getItem("home-dashboard-apps-collapsed") === "true"); } catch {}
  }, []);
  function toggleApps() {
    const collapsed = !appsCollapsed;
    setAppsCollapsed(collapsed);
    try { localStorage.setItem("home-dashboard-apps-collapsed", String(collapsed)); } catch {}
  }
  const active = useMemo(() => apps.find((app) => app.id === activeId) ?? apps[0], [activeId]);
  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>
      <header className="apps-header" style={{ display: "flex", gap: 20, alignItems: "center", padding: "16px 24px", background: "var(--panel)", color: "var(--text)" }}>
        <a href="/" style={{ color: "inherit", textDecoration: "none", fontWeight: 700 }}>← Home Server</a>
        <strong>Web Apps</strong>
        <button type="button" onClick={toggleApps} aria-expanded={!appsCollapsed} aria-controls="available-apps" style={{ padding: "8px 12px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--panel)", color: "var(--text)", cursor: "pointer" }}>
          {appsCollapsed ? "Show apps" : "Hide apps"}
        </button>
        <div style={{ marginLeft: "auto" }}><ThemeControls /></div>
      </header>
      <section className="apps-layout" style={{ display: "grid", gridTemplateColumns: appsCollapsed ? "minmax(0, 1fr)" : "260px minmax(0, 1fr)", minHeight: "calc(100vh - 65px)" }}>
        <aside id="available-apps" aria-label="Available apps" hidden={appsCollapsed} style={{ display: appsCollapsed ? "none" : undefined, padding: 18, borderRight: "1px solid var(--line)" }}>
          <p style={{ fontSize: 11, letterSpacing: 1.5, fontWeight: 700, color: "var(--muted)" }}>AVAILABLE APPS</p>
          {apps.map((app) => <button aria-pressed={app.id === active.id} key={app.id} onClick={() => { setActiveId(app.id); setOpened(ids => ids.includes(app.id) ? ids : [...ids, app.id]); }} style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 8, padding: "12px 10px", borderRadius: 8, border: app.id === active.id ? "1px solid var(--accent)" : "1px solid var(--line)", background: app.id === active.id ? "var(--accent-soft)" : "var(--panel)", color: "var(--text)", cursor: "pointer" }}><strong style={{ display: "block" }}>{app.name}</strong><small style={{ color: "var(--muted)" }}>{app.kind} · {app.description}</small></button>)}
          <p style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.6, marginTop: 22 }}>Opened apps stay loaded when switching tabs. Direct launchers require a separate window if they enforce clickjacking security.</p>
        </aside>
        <section style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12, background: "var(--panel)" }}><div><strong>{active.name}</strong><small style={{ display: "block", color: "var(--muted)" }}>{active.url}</small></div><a href={active.url} target="_blank" rel="noreferrer" style={{ marginLeft: "auto", fontSize: 12 }}>Open separately ↗</a></div>
          {active.externalOnly && (
            <div style={{ padding: 28 }}>
              <h3 style={{ marginBottom: 8 }}>{active.name}</h3>
              <p style={{ color: "var(--muted)", marginBottom: 16 }}>This application enforces strict browser security policies (<code>X-Frame-Options: SAMEORIGIN</code>) that prevent embedded frames. Please access it directly in a dedicated tab:</p>
              <a href={active.url} target="_blank" rel="noreferrer" style={{ display: "inline-block", padding: "10px 18px", borderRadius: 8, background: "var(--accent)", color: "#fff", textDecoration: "none", fontWeight: 600 }}>Open {active.name} in New Tab ↗</a>
            </div>
          )}
          {apps.filter(app => opened.includes(app.id) && !app.externalOnly).map(app => <iframe key={app.id} title={app.name} src={app.url} allow="fullscreen; clipboard-read; clipboard-write; geolocation" allowFullScreen style={{ display: active.id === app.id ? "block" : "none", flex: 1, width: "100%", minHeight: "calc(100vh - 130px)", border: 0, background: "var(--panel)" }} />)}
        </section>
      </section>
    </main>
  );
}
