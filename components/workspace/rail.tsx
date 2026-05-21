"use client";

import { Files, Inbox, MessageSquare, Search, Settings, Tag, Upload } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";

import type { DocumentStatus } from "@/lib/documents";
import { libStatus, libStatusLabel } from "@/lib/workspace";

export type WorkspaceDocSummary = {
  id: string;
  title: string | null;
  filename: string;
  status: DocumentStatus;
  pageHint: string | null;
  since: string | null;
};

type RailProps = {
  documents: WorkspaceDocSummary[];
  tenantInitials: string;
  hasActiveRun: boolean;
};

export function Rail({ documents, tenantInitials, hasActiveRun }: RailProps) {
  const pathname = usePathname();
  const [query, setQuery] = useState("");

  const activeId = useMemo(() => {
    const match = pathname?.match(/\/workspace\/documents\/([^/]+)/);
    return match?.[1] ?? null;
  }, [pathname]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return documents;
    }
    return documents.filter(
      (d) =>
        (d.title ?? "").toLowerCase().includes(q) || d.filename.toLowerCase().includes(q)
    );
  }, [documents, query]);

  return (
    <div className="rail-wrap">
      <aside className="glass rail" aria-label="Navegación">
        <Link className="brand" href="/app/workspace" aria-label="SDA — inicio del workspace">
          S
        </Link>
        <nav className="rail-nav" aria-label="Secciones">
          <button className="rail-btn is-active" type="button" title="Documentos" aria-current="page">
            <Files size={18} aria-hidden="true" />
            {hasActiveRun ? <span className="dot" aria-hidden="true" /> : null}
            <span className="sr-only">Documentos</span>
          </button>
          <button className="rail-btn" type="button" title="Buscar global (próximamente)" disabled>
            <Search size={18} aria-hidden="true" />
            <span className="sr-only">Buscar global (próximamente)</span>
          </button>
          <Link className="rail-btn" href="/app/invites" title="Invitaciones">
            <Inbox size={18} aria-hidden="true" />
            <span className="sr-only">Invitaciones</span>
          </Link>
          <button
            className="rail-btn"
            type="button"
            title="Chat (próximamente)"
            disabled
          >
            <MessageSquare size={18} aria-hidden="true" />
            <span className="sr-only">Chat (próximamente)</span>
          </button>
          <button className="rail-btn" type="button" title="Etiquetas (próximamente)" disabled>
            <Tag size={18} aria-hidden="true" />
            <span className="sr-only">Etiquetas (próximamente)</span>
          </button>
        </nav>
        <div className="rail-foot">
          <button className="rail-btn" type="button" title="Ajustes (próximamente)" disabled>
            <Settings size={18} aria-hidden="true" />
            <span className="sr-only">Ajustes (próximamente)</span>
          </button>
          <div className="rail-avatar" title="Tu cuenta">
            {tenantInitials}
          </div>
        </div>
      </aside>

      <div className="glass rail-flyout" role="navigation" aria-label="Biblioteca">
        <div className="section-label">
          <span>Biblioteca</span>
          <span className="count">{documents.length}</span>
        </div>

        <label className="search-input">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            placeholder="Buscar en biblioteca…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Buscar documentos"
          />
        </label>

        <div className="lib">
          {filtered.length === 0 ? (
            <p className="muted-mono" style={{ padding: "12px 4px" }}>
              Sin documentos.
            </p>
          ) : (
            filtered.map((doc) => {
              const bucket = libStatus(doc.status);
              return (
                <Link
                  key={doc.id}
                  href={`/app/workspace/documents/${doc.id}`}
                  className={`lib-item ${doc.id === activeId ? "is-selected" : ""} ${
                    bucket === "running" ? "is-running" : ""
                  }`}
                >
                  <span className="thumb">
                    <span>PDF</span>
                  </span>
                  <span className="body">
                    <span className="title">{doc.title ?? doc.filename}</span>
                    <span className="meta">
                      {[doc.pageHint, doc.since].filter(Boolean).join(" · ") || doc.filename}
                    </span>
                  </span>
                  <span className={`status status-${bucket}`}>{libStatusLabel(doc.status)}</span>
                </Link>
              );
            })
          )}
        </div>

        <Link className="upload-tile" href="/app/documents">
          <span className="ut-title">
            <Upload size={14} aria-hidden="true" style={{ color: "var(--teal-2)" }} />
            Subir documento
          </span>
          <span className="ut-sub">
            Se verifica con SHA-256 en tu navegador antes de subirse a tu Storage privado.
          </span>
        </Link>
      </div>
    </div>
  );
}
