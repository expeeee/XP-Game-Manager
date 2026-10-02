"use client";

import { useEffect, useMemo, useState } from "react";
import { ThemeControls } from "@/components/theme-provider";

type Game = { id: string; title: string; source: "Steam" | "Folder"; installPath: string; available: boolean; platform: string; protonCompatibility: number; artUrl?: string };
type Library = { games: Game[]; scannedAt: string };

function GameArt({ game }: { game: Game }) {
  const [url, setUrl] = useState(game.artUrl || "");
  useEffect(() => {
    if (game.artUrl) { setUrl(game.artUrl); return; }
    fetch(`/api/games/art?title=${encodeURIComponent(game.title)}`)
      .then((response) => response.ok ? response.json() : null)
      .then((data) => setUrl(data?.artUrl || ""))
      .catch(() => setUrl(""));
  }, [game.artUrl, game.title]);
  return <div style={{ height: 118, borderRadius: 8, overflow: "hidden", background: "var(--accent-soft)", display: "grid", placeItems: "center", marginBottom: 12 }}>
    {url ? <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={() => setUrl("")} /> : <span style={{ color: "var(--muted)", fontSize: 12 }}>No cover found</span>}
  </div>;
}

export default function GamesPage() {
  const [library, setLibrary] = useState<Library | null>(null);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [error, setError] = useState("");
  const scan = async () => {
    setError("");
    try {
      const response = await fetch("/api/games", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Scan failed");
      setLibrary(data);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to scan the game library."); }
  };
  useEffect(() => { void scan(); }, []);
  const games = useMemo(() => (library?.games || []).filter((game) => (source === "all" || game.source === source) && game.title.toLowerCase().includes(query.toLowerCase())), [library, query, source]);
  return <main style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", padding: 24 }}>
    <header style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 28 }}><a href="/apps" style={{ color: "inherit", textDecoration: "none", fontWeight: 700 }}>← Home Server</a><span style={{ color: "var(--muted)" }}>/</span><strong>Game Library</strong><div style={{ marginLeft: "auto" }}><ThemeControls /></div></header>
    <section style={{ maxWidth: 1280, margin: "auto" }}>
      <p style={{ color: "var(--accent)", fontSize: 12, fontWeight: 800, letterSpacing: 1.4 }}>READ-ONLY INVENTORY</p><h1 style={{ margin: "6px 0" }}>Linux game library</h1><p style={{ color: "var(--muted)" }}>Steam artwork is loaded by app ID; folder games are matched automatically against the Steam store.</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, margin: "24px 0" }}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search games" style={{ flex: "1 1 260px", padding: 10, borderRadius: 8, border: "1px solid var(--line)", background: "var(--panel)", color: "var(--text)" }} /><select value={source} onChange={(event) => setSource(event.target.value)} style={{ padding: 10, borderRadius: 8, border: "1px solid var(--line)", background: "var(--panel)", color: "var(--text)" }}><option value="all">All sources</option><option value="Steam">Steam</option><option value="Folder">Folder</option></select><button onClick={() => void scan()} style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--accent)", background: "var(--accent)", color: "white", cursor: "pointer" }}>Rescan</button></div>
      {error && <p style={{ color: "#dc2626" }}>{error}</p>}<p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 16 }}>{library ? `${games.length} of ${library.games.length} games · scanned ${new Date(library.scannedAt).toLocaleString()}` : "Scanning game libraries…"}</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(255px, 1fr))", gap: 12 }}>{games.map((game) => <article key={game.id} style={{ border: "1px solid var(--line)", borderRadius: 10, background: "var(--panel)", padding: 12 }}><GameArt game={game} /><div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><strong>{game.title}</strong><span style={{ fontSize: 11, color: "var(--accent)" }}>{game.source}</span></div><p style={{ color: "var(--muted)", fontSize: 12, margin: "8px 0" }}>{game.platform} · {game.available ? "Available" : "Missing files"}</p><p style={{ color: "var(--accent)", fontSize: 12, fontWeight: 700, margin: "8px 0" }}>Proton support {game.protonCompatibility}/5</p><code style={{ display: "block", overflowWrap: "anywhere", color: "var(--muted)", fontSize: 11 }}>{game.installPath}</code></article>)}</div>
      {library && !games.length && <p style={{ color: "var(--muted)" }}>No games match this filter.</p>}
    </section>
  </main>;
}
