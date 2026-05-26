import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  console.log("[v0] callback origin:", origin);
  console.log("[v0] callback code present:", !!code);

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    console.log("[v0] exchangeCodeForSession error:", error);

    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }

    console.log("[v0] redirecting to error page, error:", error.message);
    return NextResponse.redirect(`${origin}/auth/error?reason=${encodeURIComponent(error.message)}`);
  }

  console.log("[v0] no code in callback, redirecting to error");
  return NextResponse.redirect(`${origin}/auth/error`);
}
