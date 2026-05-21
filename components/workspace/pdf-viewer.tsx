"use client";

import {
  ChevronDown,
  ChevronUp,
  Download,
  FileWarning,
  Loader2,
  Maximize2,
  RotateCw,
  Search,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Document, Page, Thumbnail, pdfjs } from "react-pdf";

import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

import type { DocumentStatus } from "@/lib/documents";
import { indexingStageLabel } from "@/lib/documents";

// Worker — resolved by the bundler (works with Next/Turbopack via import.meta.url).
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

const LETTER_RATIO = 11 / 8.5;
const WINDOW_BEFORE = 1;
const WINDOW_AFTER = 2;
const THUMB_WINDOW = 7;

type FileMeta = { url: string; mimeType: string; filename: string; expiresAt: string };
type LoadedFileMeta = FileMeta & { documentId: string };
type FileLoadError = { documentId: string; message: string };
type LoadedPageCount = { documentId: string; count: number };

type PdfViewerProps = {
  documentId: string;
  documentStatus: DocumentStatus;
  liveStage: string | null;
  liveProgress: number | null;
  currentPage: number;
  onPageChange: (page: number) => void;
  jumpTarget: { page: number; nonce: number } | null;
  highlightRange: { start: number; end: number } | null;
};

export function PdfViewer({
  documentId,
  documentStatus,
  liveStage,
  liveProgress,
  currentPage,
  onPageChange,
  jumpTarget,
  highlightRange
}: PdfViewerProps) {
  const [file, setFile] = useState<LoadedFileMeta | null>(null);
  const [fetchError, setFetchError] = useState<FileLoadError | null>(null);
  const [loadedPageCount, setLoadedPageCount] = useState<LoadedPageCount | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [containerWidth, setContainerWidth] = useState(680);
  const [findOpen, setFindOpen] = useState(false);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const ratios = useRef<Map<number, number>>(new Map());
  const pdfDocRef = useRef<unknown>(null);

  const activeFile = file?.documentId === documentId ? file : null;
  const activeFetchError = fetchError?.documentId === documentId ? fetchError.message : null;
  const numPages = loadedPageCount?.documentId === documentId ? loadedPageCount.count : 0;

  // ---- Load the inline signed URL --------------------------------------
  useEffect(() => {
    let cancelled = false;
    let refreshTimer: number | undefined;

    ratios.current.clear();
    pageRefs.current.clear();
    pdfDocRef.current = null;

    const loadFile = async () => {
      const res = await fetch(`/api/documents/${documentId}/file-url`, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(res.status === 404 ? "No encontrado" : "No se pudo abrir el archivo");
      }
      return (await res.json()) as FileMeta;
    };

    const refreshFile = () => {
      loadFile()
        .then((meta) => {
          if (cancelled) {
            return;
          }
          setFile({ ...meta, documentId });
          setFetchError(null);

          const expiresAt = new Date(meta.expiresAt).getTime();
          const refreshInMs = Number.isFinite(expiresAt)
            ? Math.max(10_000, expiresAt - Date.now() - 30_000)
            : 10 * 60 * 1000;
          refreshTimer = window.setTimeout(refreshFile, refreshInMs);
        })
        .catch((err: Error) => {
          if (!cancelled) {
            setFetchError({ documentId, message: err.message });
          }
        });
    };

    refreshFile();

    return () => {
      cancelled = true;
      if (refreshTimer) {
        window.clearTimeout(refreshTimer);
      }
    };
  }, [documentId]);

  // ---- Track container width -------------------------------------------
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) {
      return;
    }
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeFile]);

  const baseWidth = Math.max(320, Math.min(containerWidth - 72, 820));
  const pageWidth = Math.round(baseWidth * zoom);

  // ---- Observe page visibility to derive the current page --------------
  useEffect(() => {
    const root = canvasRef.current;
    if (!root || numPages === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page);
          ratios.current.set(page, entry.isIntersecting ? entry.intersectionRatio : 0);
        }
        let best = currentPage;
        let bestRatio = 0;
        ratios.current.forEach((ratio, page) => {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            best = page;
          }
        });
        if (best !== currentPage) {
          onPageChange(best);
        }
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] }
    );

    pageRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numPages, pageWidth]);

  const registerPage = useCallback((page: number, el: HTMLDivElement | null) => {
    if (el) {
      pageRefs.current.set(page, el);
    } else {
      pageRefs.current.delete(page);
    }
  }, []);

  const scrollToPage = useCallback((page: number) => {
    const el = pageRefs.current.get(page);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  // ---- React to external jump requests (tree clicks, thumbs) -----------
  useEffect(() => {
    if (jumpTarget) {
      scrollToPage(jumpTarget.page);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTarget?.nonce]);

  const goToPage = useCallback(
    (page: number) => {
      const clamped = Math.max(1, Math.min(numPages || 1, page));
      scrollToPage(clamped);
    },
    [numPages, scrollToPage]
  );

  // ---- Empty / progress states -----------------------------------------
  const isPdf = activeFile?.mimeType.toLowerCase().startsWith("application/pdf");
  const showProgressPlaceholder =
    !activeFile &&
    !activeFetchError &&
    ["uploading", "uploaded", "queued", "parsing", "structuring", "embedding"].includes(
      documentStatus
    );

  if (activeFetchError) {
    return (
      <ViewerShell>
        <div className="viewer-empty" role="status">
          <span className="ve-ico">
            <FileWarning size={24} aria-hidden="true" />
          </span>
          <h3>No se pudo abrir el documento</h3>
          <p>{activeFetchError}</p>
        </div>
      </ViewerShell>
    );
  }

  if (!activeFile) {
    return (
      <ViewerShell>
        {showProgressPlaceholder ? (
          <div className="viewer-progress" role="status" aria-live="polite">
            <div className="vp-stage">
              {liveStage ? indexingStageLabel(liveStage) : "Preparando el documento…"}
            </div>
            <div className="stage-bar is-live" style={{ width: "100%" }}>
              <i style={{ width: `${liveProgress ?? 8}%` }} />
            </div>
            <div className="vp-pct">{liveProgress ?? 0}%</div>
            <p style={{ color: "var(--muted)", fontSize: 13 }}>
              La vista previa aparece cuando el archivo está disponible.
            </p>
          </div>
        ) : (
          <div className="viewer-empty" role="status" aria-live="polite">
            <Loader2 className="spin" size={26} aria-hidden="true" />
            <p>Cargando documento…</p>
          </div>
        )}
      </ViewerShell>
    );
  }

  if (!isPdf) {
    return (
      <ViewerShell>
        <div className="viewer-empty">
          <span className="ve-ico">
            <FileWarning size={24} aria-hidden="true" />
          </span>
          <h3>Vista previa no disponible</h3>
          <p>Este formato no se puede previsualizar acá ({activeFile.mimeType}).</p>
          <a className="btn-primary" href={`/app/documents/${documentId}/download`} style={{ maxWidth: 200 }}>
            <Download size={14} aria-hidden="true" />
            Descargar
          </a>
        </div>
      </ViewerShell>
    );
  }

  const thumbStart = Math.max(1, currentPage - Math.floor(THUMB_WINDOW / 2));
  const thumbEnd = Math.min(numPages, thumbStart + THUMB_WINDOW + 2);

  return (
    <Document
      file={activeFile.url}
      className="stage glass-strong"
      loading={
        <ViewerShell>
          <div className="viewer-empty" role="status">
            <Loader2 className="spin" size={26} aria-hidden="true" />
            <p>Renderizando PDF…</p>
          </div>
        </ViewerShell>
      }
      error={
        <ViewerShell>
          <div className="viewer-empty">
            <span className="ve-ico">
              <FileWarning size={24} aria-hidden="true" />
            </span>
            <h3>No se pudo renderizar</h3>
            <p>El archivo parece dañado o no es un PDF válido.</p>
          </div>
        </ViewerShell>
      }
      onLoadSuccess={(pdf) => {
        setLoadedPageCount({ documentId, count: pdf.numPages });
        pdfDocRef.current = pdf;
      }}
    >
      {/* Vertical thumbnail strip */}
      <div className="thumb-strip" aria-label="Páginas">
        <div className="ts-head">
          <span>Páginas</span>
          <span style={{ color: "var(--ink-3)" }}>{numPages || "—"}</span>
        </div>
        {Array.from({ length: Math.max(0, thumbEnd - thumbStart + 1) }, (_, i) => thumbStart + i).map(
          (page) => {
            const inRange =
              highlightRange != null && page >= highlightRange.start && page <= highlightRange.end;
            return (
              <div
                key={page}
                className={`thumb-wrap ${page === currentPage ? "is-active" : ""} ${
                  inRange ? "is-highlight" : ""
                }`}
                aria-current={page === currentPage ? "true" : undefined}
              >
                <span className="thumb">
                  <Thumbnail
                    pageNumber={page}
                    width={64}
                    onItemClick={({ pageNumber }) => goToPage(pageNumber)}
                  />
                </span>
                <span className="thumb-num">{page}</span>
              </div>
            );
          }
        )}
      </div>

      {/* Canvas */}
      <div className="canvas" ref={canvasRef}>
        <PdfToolbar
          page={currentPage}
          numPages={numPages}
          zoom={zoom}
          findOpen={findOpen}
          onPrev={() => goToPage(currentPage - 1)}
          onNext={() => goToPage(currentPage + 1)}
          onJump={goToPage}
          onZoomIn={() => setZoom((z) => Math.min(2.4, Math.round((z + 0.15) * 100) / 100))}
          onZoomOut={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.15) * 100) / 100))}
          onFitWidth={() => setZoom(1)}
          onRotate={() => setRotation((r) => (r + 90) % 360)}
          onToggleFind={() => setFindOpen((v) => !v)}
          downloadHref={`/app/documents/${documentId}/download`}
          onFullscreen={() => canvasRef.current?.requestFullscreen?.()}
        />

        {findOpen ? (
          <FindPopover
            getDoc={() => pdfDocRef.current}
            numPages={numPages}
            onGoToPage={goToPage}
            onClose={() => setFindOpen(false)}
          />
        ) : null}

        <div className="canvas-inner">
          {Array.from({ length: numPages }, (_, i) => i + 1).map((page) => {
            const inWindow = page >= currentPage - WINDOW_BEFORE && page <= currentPage + WINDOW_AFTER;
            return (
              <div
                key={page}
                className="pdf-page-wrap"
                data-page={page}
                ref={(el) => registerPage(page, el)}
                style={inWindow ? undefined : { minHeight: Math.round(pageWidth * LETTER_RATIO) }}
              >
                {inWindow ? (
                  <Page
                    pageNumber={page}
                    width={pageWidth}
                    rotate={rotation}
                    renderTextLayer
                    renderAnnotationLayer
                    loading={
                      <div style={{ height: Math.round(pageWidth * LETTER_RATIO) }} aria-hidden="true" />
                    }
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </Document>
  );
}

function ViewerShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="stage glass-strong" style={{ gridTemplateColumns: "1fr", display: "grid" }}>
      <div className="canvas" style={{ alignItems: "center", justifyContent: "center" }}>
        {children}
      </div>
    </div>
  );
}

type PdfToolbarProps = {
  page: number;
  numPages: number;
  zoom: number;
  findOpen: boolean;
  onPrev: () => void;
  onNext: () => void;
  onJump: (page: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitWidth: () => void;
  onRotate: () => void;
  onToggleFind: () => void;
  onFullscreen: () => void;
  downloadHref: string;
};

function PdfToolbar({
  page,
  numPages,
  zoom,
  findOpen,
  onPrev,
  onNext,
  onJump,
  onZoomIn,
  onZoomOut,
  onFitWidth,
  onRotate,
  onToggleFind,
  onFullscreen,
  downloadHref
}: PdfToolbarProps) {
  const [draft, setDraft] = useState(String(page));
  const [lastPage, setLastPage] = useState(page);
  const hasPages = numPages > 0;

  // Sync the input with external page changes (React-recommended render-time reset).
  if (page !== lastPage) {
    setLastPage(page);
    setDraft(String(page));
  }

  return (
    <div className="pdf-toolbar" role="toolbar" aria-label="Controles del visor">
      <div className="group">
        <button className="tb-btn" type="button" title="Anterior" onClick={onPrev} disabled={page <= 1}>
          <ChevronUp size={14} aria-hidden="true" />
        </button>
        <div className="page-of">
          <input
            value={draft}
            disabled={!hasPages}
            inputMode="numeric"
            aria-label="Número de página"
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft) {
                onJump(Number(draft));
              }
            }}
            onBlur={() => draft && onJump(Number(draft))}
          />
          <span style={{ color: "var(--muted-2)" }}>/ {numPages || "—"}</span>
        </div>
        <button
          className="tb-btn"
          type="button"
          title="Siguiente"
          onClick={onNext}
          disabled={!hasPages || page >= numPages}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="group">
        <button className="tb-btn" type="button" title="Alejar" onClick={onZoomOut}>
          <ZoomOut size={14} aria-hidden="true" />
        </button>
        <span className="zoom-level">{Math.round(zoom * 100)}%</span>
        <button className="tb-btn" type="button" title="Acercar" onClick={onZoomIn}>
          <ZoomIn size={14} aria-hidden="true" />
        </button>
        <button className="tb-btn" type="button" title="Ajustar al ancho" onClick={onFitWidth}>
          <Maximize2 size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="group">
        <button
          className={`tb-btn ${findOpen ? "is-active" : ""}`}
          type="button"
          title="Buscar"
          aria-pressed={findOpen}
          onClick={onToggleFind}
          disabled={!hasPages}
        >
          <Search size={14} aria-hidden="true" />
        </button>
        <button className="tb-btn" type="button" title="Rotar" onClick={onRotate}>
          <RotateCw size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="group">
        <a className="tb-btn" href={downloadHref} title="Descargar">
          <Download size={14} aria-hidden="true" />
        </a>
        <button className="tb-btn" type="button" title="Pantalla completa" onClick={onFullscreen}>
          <Maximize2 size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

type FindMatch = { page: number };

function FindPopover({
  getDoc,
  numPages,
  onGoToPage,
  onClose
}: {
  getDoc: () => unknown;
  numPages: number;
  onGoToPage: (page: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<FindMatch[]>([]);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const indexRef = useRef<string[] | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runSearch = useCallback(
    async (raw: string) => {
      const q = raw.trim().toLowerCase();
      if (q.length < 2) {
        setMatches([]);
        setActive(0);
        return;
      }
      setSearching(true);
      try {
        // Build a per-page text index lazily, then cache it.
        if (!indexRef.current) {
          const doc = getDoc() as
            | { getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: { str?: string }[] }> }> }
            | null;
          if (!doc) {
            setSearching(false);
            return;
          }
          const pages: string[] = [];
          for (let i = 1; i <= numPages; i += 1) {
            const pageObj = await doc.getPage(i);
            const text = await pageObj.getTextContent();
            pages.push(text.items.map((it) => it.str ?? "").join(" ").toLowerCase());
          }
          indexRef.current = pages;
        }

        const found: FindMatch[] = [];
        indexRef.current.forEach((text, i) => {
          let from = 0;
          let at = text.indexOf(q, from);
          while (at !== -1) {
            found.push({ page: i + 1 });
            from = at + q.length;
            at = text.indexOf(q, from);
          }
        });
        setMatches(found);
        setActive(0);
        if (found.length > 0) {
          onGoToPage(found[0].page);
        }
      } finally {
        setSearching(false);
      }
    },
    [getDoc, numPages, onGoToPage]
  );

  const step = (dir: 1 | -1) => {
    if (matches.length === 0) {
      return;
    }
    const next = (active + dir + matches.length) % matches.length;
    setActive(next);
    onGoToPage(matches[next].page);
  };

  return (
    <div className="find-pop" role="search">
      <div className="find-row">
        <Search size={14} aria-hidden="true" style={{ color: "var(--muted-2)" }} />
        <input
          ref={inputRef}
          placeholder="Buscar en el documento"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (matches.length > 0) {
                step(e.shiftKey ? -1 : 1);
              } else {
                void runSearch(query);
              }
            }
            if (e.key === "Escape") {
              onClose();
            }
          }}
          aria-label="Buscar texto en el documento"
        />
        <button className="ico-btn" type="button" style={{ width: 26, height: 26 }} onClick={onClose} title="Cerrar">
          <X size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="find-foot">
        <span className="muted-mono">
          {searching
            ? "Buscando…"
            : matches.length > 0
              ? `${active + 1} de ${matches.length} coincidencias`
              : query.trim().length >= 2
                ? "Sin coincidencias"
                : "Escribí para buscar"}
        </span>
        <div className="row" style={{ gap: 2 }}>
          <button
            className="ico-btn"
            type="button"
            style={{ width: 26, height: 26 }}
            onClick={() => step(-1)}
            disabled={matches.length === 0}
            title="Anterior"
          >
            <ChevronUp size={12} aria-hidden="true" />
          </button>
          <button
            className="ico-btn"
            type="button"
            style={{ width: 26, height: 26 }}
            onClick={() => (matches.length === 0 ? void runSearch(query) : step(1))}
            title="Siguiente"
          >
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
