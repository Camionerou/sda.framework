import Link from "next/link";
import { AlertCircle } from "lucide-react";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;

  return (
    <Card className="w-full max-w-sm text-center">
      <CardHeader>
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircle className="size-6 text-destructive" />
        </div>
        <CardTitle className="text-2xl">Error de autenticación</CardTitle>
        <CardDescription>
          El enlace expiró o es inválido. Por favor, vuelve a intentarlo.
        </CardDescription>
        {reason && (
          <p className="mt-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {decodeURIComponent(reason)}
          </p>
        )}
      </CardHeader>
      <CardFooter className="flex justify-center">
        <Link
          href="/auth/login"
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          Volver al inicio de sesión
        </Link>
      </CardFooter>
    </Card>
  );
}
