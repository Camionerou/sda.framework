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
  CloudUpload,
  ChevronRight,
  FilePlus2,
  Network,
} from "lucide-react";
import { cn } from "@/lib/utils";

const recentDocuments = [
  {
    id: "1",
    name: "Arquitectura del sistema v2.pdf",
    status: "ready" as const,
    nodes: 87,
    updatedAt: "Hace 2 horas",
  },
  {
    id: "2",
    name: "Manual de usuario — Módulo ingestión.md",
    status: "summarizing" as const,
    nodes: null,
    updatedAt: "Hace 15 min",
  },
  {
    id: "3",
    name: "Especificaciones API REST 2026.pdf",
    status: "pending" as const,
    nodes: null,
    updatedAt: "Hace 1 hora",
  },
  {
    id: "4",
    name: "Roadmap Q2-Q3 2026.md",
    status: "ready" as const,
    nodes: 22,
    updatedAt: "Ayer",
  },
  {
    id: "5",
    name: "Reporte de errores — Sprint 14.pdf",
    status: "failed" as const,
    nodes: null,
    updatedAt: "Hace 3 dias",
  },
];

const statusConfig = {
  ready: { label: "Listo", icon: CheckCircle2, color: "text-emerald-600", dot: "bg-emerald-500", spin: false },
  summarizing: { label: "Procesando", icon: Loader2, color: "text-amber-500", dot: "bg-amber-400", spin: true },
  pending: { label: "En cola", icon: Clock, color: "text-neutral-400", dot: "bg-neutral-300", spin: false },
  failed: { label: "Error", icon: AlertCircle, color: "text-red-500", dot: "bg-red-400", spin: false },
};

const quickActions = [
  { label: "Subir documento", icon: FilePlus2 },
  { label: "Buscar en docs", icon: Search },
  { label: "Ver grafo", icon: Network },
  { label: "Resumir con IA", icon: Sparkles },
];

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
        "group relative w-full flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed cursor-pointer transition-all px-8 py-10",
        isDragging
          ? "border-primary/60 bg-primary/[0.04]"
          : "border-neutral-200 bg-neutral-50 hover:border-neutral-300 hover:bg-white"
      )}
    >
      <input ref={inputRef} type="file" className="hidden" accept=".pdf,.md,.txt" multiple />

      <div className={cn(
        "flex size-11 items-center justify-center rounded-xl border transition-colors",
        isDragging
          ? "bg-primary/10 border-primary/20"
          : "bg-white border-neutral-200 group-hover:border-neutral-300"
      )}>
        <CloudUpload className={cn("size-5 transition-colors", isDragging ? "text-primary" : "text-neutral-400")} />
      </div>

      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-sm font-medium text-neutral-800">
          {isDragging ? "Solta los archivos aca" : "Arrasta archivos o hace clic para subir"}
        </p>
        <p className="text-xs text-neutral-400">PDF, Markdown o texto plano · Max. 50 MB por archivo</p>
      </div>

      <span className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-neutral-900 text-white text-[13px] font-medium hover:bg-black transition-colors">
        <Upload className="size-3.5" />
        Elegir archivos
      </span>
    </div>
  );
}

function DocRow({ doc }: { doc: (typeof recentDocuments)[0] }) {
  const s = statusConfig[doc.status];
  const StatusIcon = s.icon;

  return (
    <button className="group w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-neutral-50 active:bg-neutral-100 transition-colors text-left">
      <div className="relative shrink-0">
        <div className="flex size-8 items-center justify-center rounded-lg bg-neutral-100 group-hover:bg-white border border-neutral-200/50 transition-colors">
          <FileText className="size-4 text-neutral-400" />
        </div>
        <span className={cn("absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-white", s.dot)} />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-[13.5px] font-medium text-neutral-800 truncate leading-snug">{doc.name}</p>
        <div className="flex items-center gap-1.5 mt-0.5">
          {doc.nodes !== null && (
            <span className="flex items-center gap-1 text-[11.5px] text-neutral-400">
              <GitBranch className="size-3" />{doc.nodes} nodos
            </span>
          )}
          {doc.nodes !== null && <span className="text-neutral-300 text-[11px]">·</span>}
          <span className="text-[11.5px] text-neutral-400">{doc.updatedAt}</span>
        </div>
      </div>

      <div className={cn("flex items-center gap-1 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity", s.color)}>
        <StatusIcon className={cn("size-3.5", s.spin && "animate-spin")} />
        <span className="text-[11.5px] font-medium">{s.label}</span>
      </div>

      <ChevronRight className="size-3.5 text-neutral-300 opacity-0 group-hover:opacity-100 transition-all -translate-x-1 group-hover:translate-x-0 shrink-0" />
    </button>
  );
}

export function HomeView() {
  return (
    <div className="flex flex-col flex-1 overflow-y-auto bg-white">
      {/* Centered main content */}
      <div className="flex flex-col items-center justify-center flex-1 px-6 py-16 min-h-[60vh]">
        <div className="w-full max-w-2xl flex flex-col items-center gap-8">

          {/* Greeting */}
          <div className="flex flex-col items-center gap-2 text-center">
            <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
              Que procesamos hoy?
            </h1>
            <p className="text-[14px] text-neutral-400 max-w-sm">
              Subí un documento para indexarlo, o explorá los que ya procesaste.
            </p>
          </div>

          {/* Upload zone */}
          <UploadZone />

          {/* Quick action chips — style Codex/Claude */}
          <div className="flex flex-wrap justify-center gap-2">
            {quickActions.map(({ label, icon: Icon }) => (
              <button
                key={label}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-neutral-100 hover:bg-neutral-200 active:bg-neutral-300 border border-neutral-200 hover:border-neutral-300 transition-all text-[13px] font-medium text-neutral-700"
              >
                <Icon className="size-3.5 text-neutral-500" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Recent docs — below the fold */}
      <div className="border-t border-neutral-100 px-6 py-8">
        <div className="max-w-2xl mx-auto flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[11.5px] font-semibold uppercase tracking-widest text-neutral-400">
              Recientes
            </h2>
            <button className="flex items-center gap-1 text-[12.5px] text-neutral-400 hover:text-neutral-700 font-medium transition-colors">
              Ver todos <ArrowRight className="size-3.5" />
            </button>
          </div>

          <div className="flex flex-col -mx-3">
            {recentDocuments.map((doc) => (
              <DocRow key={doc.id} doc={doc} />
            ))}
          </div>

          {/* Graph CTA */}
          <button className="group flex items-center justify-between mt-2 rounded-xl bg-neutral-50 hover:bg-neutral-100 border border-neutral-200 px-4 py-3.5 transition-all text-left">
            <div className="flex items-center gap-3">
              <div className="flex size-8 items-center justify-center rounded-lg bg-white border border-neutral-200">
                <GitBranch className="size-4 text-neutral-600" />
              </div>
              <div>
                <p className="text-[13px] font-medium text-neutral-800">Grafo de conocimiento</p>
                <p className="text-[11.5px] text-neutral-400">Explora el arbol de nodos de tus documentos</p>
              </div>
            </div>
            <ChevronRight className="size-4 text-neutral-300 -translate-x-1 group-hover:translate-x-0 group-hover:text-neutral-500 transition-all shrink-0" />
          </button>
        </div>
      </div>
    </div>
  );
}
