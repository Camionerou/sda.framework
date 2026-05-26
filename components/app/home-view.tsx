"use client";

import { useState, useRef } from "react";
import {
  FileText,
  Upload,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  GitBranch,
  ArrowRight,
  Search,
  Sparkles,
  FilePlus2,
  CloudUpload,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

const recentDocuments = [
  {
    id: "1",
    name: "Arquitectura del sistema v2.pdf",
    type: "pdf",
    status: "ready" as const,
    pages: 24,
    nodes: 87,
    updatedAt: "Hace 2 horas",
  },
  {
    id: "2",
    name: "Manual de usuario — Módulo ingestión.md",
    type: "md",
    status: "summarizing" as const,
    pages: 12,
    nodes: null,
    updatedAt: "Hace 15 min",
  },
  {
    id: "3",
    name: "Especificaciones API REST 2026.pdf",
    type: "pdf",
    status: "pending" as const,
    pages: 48,
    nodes: null,
    updatedAt: "Hace 1 hora",
  },
  {
    id: "4",
    name: "Roadmap Q2-Q3 2026.md",
    type: "md",
    status: "ready" as const,
    pages: 6,
    nodes: 22,
    updatedAt: "Ayer",
  },
  {
    id: "5",
    name: "Reporte de errores — Sprint 14.pdf",
    type: "pdf",
    status: "failed" as const,
    pages: 3,
    nodes: null,
    updatedAt: "Hace 3 días",
  },
];

const statusConfig = {
  ready: {
    label: "Listo",
    icon: CheckCircle2,
    class: "text-emerald-600",
    dot: "bg-emerald-500",
    spin: false,
  },
  summarizing: {
    label: "Procesando",
    icon: Loader2,
    class: "text-amber-500",
    dot: "bg-amber-400",
    spin: true,
  },
  pending: {
    label: "En cola",
    icon: Clock,
    class: "text-[#92918B]",
    dot: "bg-[#92918B]",
    spin: false,
  },
  failed: {
    label: "Error",
    icon: AlertCircle,
    class: "text-red-500",
    dot: "bg-red-500",
    spin: false,
  },
};

const quickActions = [
  { label: "Subir documento", icon: FilePlus2 },
  { label: "Buscar en docs", icon: Search },
  { label: "Ver grafo", icon: GitBranch },
  { label: "Resumir con IA", icon: Sparkles },
];

function DocRow({ doc }: { doc: (typeof recentDocuments)[0] }) {
  const s = statusConfig[doc.status];
  const StatusIcon = s.icon;

  return (
    <button className="group w-full flex items-center gap-4 px-4 py-3 rounded-xl hover:bg-[#FAF8F5] active:bg-[#F0EDE8] transition-colors text-left">
      {/* Status dot + file icon */}
      <div className="relative shrink-0">
        <div className="flex size-9 items-center justify-center rounded-lg bg-[#FAF8F5] group-hover:bg-white transition-colors border border-black/[0.06]">
          <FileText className="size-[17px] text-[#72706B]" />
        </div>
        <span className={cn("absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-white", s.dot)} />
      </div>

      {/* Name + meta */}
      <div className="flex-1 min-w-0">
        <p className="text-[13.5px] font-medium text-[#27251E] truncate leading-snug">
          {doc.name}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-[#92918B]">{doc.pages} pág.</span>
          {doc.nodes !== null && (
            <>
              <span className="text-[#92918B]/50 text-xs">·</span>
              <span className="flex items-center gap-1 text-xs text-[#92918B]">
                <GitBranch className="size-3" />
                {doc.nodes} nodos
              </span>
            </>
          )}
          <span className="text-[#92918B]/50 text-xs">·</span>
          <span className="text-xs text-[#92918B]">{doc.updatedAt}</span>
        </div>
      </div>

      {/* Status label */}
      <div className={cn("flex items-center gap-1.5 shrink-0 opacity-70 group-hover:opacity-100 transition-opacity", s.class)}>
        <StatusIcon className={cn("size-3.5", s.spin && "animate-spin")} />
        <span className="text-xs font-medium">{s.label}</span>
      </div>

      {/* Arrow on hover */}
      <ChevronRight className="size-3.5 text-[#92918B] opacity-0 group-hover:opacity-100 -translate-x-1 group-hover:translate-x-0 transition-all shrink-0" />
    </button>
  );
}

function UploadZone() {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => { e.preventDefault(); setIsDragging(false); }}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "group relative flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed cursor-pointer transition-all py-12",
        isDragging
          ? "border-primary bg-primary/5 scale-[1.01]"
          : "border-black/10 bg-[#FAF8F5] hover:border-black/20 hover:bg-[#F5F2ED]"
      )}
    >
      <input ref={inputRef} type="file" className="hidden" accept=".pdf,.md,.txt" multiple />

      <div className={cn(
        "flex size-12 items-center justify-center rounded-2xl transition-colors",
        isDragging ? "bg-primary/10" : "bg-white border border-black/[0.08] group-hover:border-black/12"
      )}>
        <CloudUpload className={cn("size-5 transition-colors", isDragging ? "text-primary" : "text-[#72706B]")} />
      </div>

      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-[13.5px] font-medium text-[#27251E]">
          {isDragging ? "Soltar para subir" : "Arrastrar archivos o hacer clic"}
        </p>
        <p className="text-xs text-[#92918B]">PDF, Markdown o texto plano · Máx. 50 MB</p>
      </div>

      <div className="flex items-center gap-2 mt-1">
        <span className="flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-[#27251E] text-white text-xs font-medium hover:bg-black transition-colors">
          <Upload className="size-3" />
          Subir documento
        </span>
      </div>
    </div>
  );
}

export function HomeView() {
  return (
    <div className="flex flex-col min-h-full bg-white">
      <div className="flex flex-col gap-10 max-w-2xl mx-auto w-full px-8 py-14">

        {/* Welcome heading */}
        <div className="flex flex-col gap-2">
          <h1 className="text-[28px] font-semibold tracking-tight text-[#27251E] text-balance leading-tight">
            Bienvenido a SDA Framework
          </h1>
          <p className="text-[14.5px] text-[#72706B] leading-relaxed max-w-lg">
            Ingesta, indexa y consulta tus documentos con IA. Subí un archivo para empezar o explorá los documentos procesados.
          </p>
        </div>

        {/* Quick action pills */}
        <div className="flex flex-wrap gap-2">
          {quickActions.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className="flex items-center gap-2 px-4 py-2 rounded-full bg-[#FAF8F5] hover:bg-[#F0EDE8] active:bg-[#E8E4DE] border border-black/[0.08] hover:border-black/12 transition-all text-[13px] font-medium text-[#27251E]"
            >
              <Icon className="size-3.5 text-[#72706B]" />
              {label}
            </button>
          ))}
        </div>

        {/* Upload zone */}
        <UploadZone />

        {/* Recent documents */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-[#92918B]">
              Recientes
            </h2>
            <button className="flex items-center gap-1 text-xs text-[#72706B] hover:text-[#27251E] transition-colors font-medium">
              Ver todos
              <ArrowRight className="size-3" />
            </button>
          </div>

          <div className="flex flex-col -mx-4">
            {recentDocuments.map((doc) => (
              <DocRow key={doc.id} doc={doc} />
            ))}
          </div>
        </div>

        {/* Graph CTA */}
        <button className="group flex items-center justify-between rounded-2xl bg-[#FAF8F5] hover:bg-[#F0EDE8] border border-black/[0.06] hover:border-black/10 px-5 py-4 transition-all text-left">
          <div className="flex items-center gap-4">
            <div className="flex size-9 items-center justify-center rounded-xl bg-white border border-black/[0.08]">
              <GitBranch className="size-4 text-[#27251E]" />
            </div>
            <div className="flex flex-col gap-0.5">
              <p className="text-[13.5px] font-medium text-[#27251E]">Grafo de conocimiento</p>
              <p className="text-xs text-[#92918B]">Explorá el árbol de nodos de tus documentos indexados</p>
            </div>
          </div>
          <ChevronRight className="size-4 text-[#92918B] -translate-x-1 group-hover:translate-x-0 transition-transform shrink-0" />
        </button>

      </div>
    </div>
  );
}
