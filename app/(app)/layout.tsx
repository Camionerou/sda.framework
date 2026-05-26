import type { Metadata } from "next";
import { AppSidebar } from "@/components/app/sidebar";
import { AppTopbar } from "@/components/app/topbar";

export const metadata: Metadata = {
  title: "SDA Framework",
  description: "Plataforma de ingestión e indexación de documentos",
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <AppSidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <AppTopbar />
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
