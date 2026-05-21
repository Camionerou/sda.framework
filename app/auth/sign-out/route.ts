import { NextResponse, type NextRequest } from "next/server";

import { requireSameOrigin } from "@/lib/auth/csrf";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const csrf = requireSameOrigin(request);

  if (!csrf.ok) {
    return NextResponse.json({ error: csrf.error }, { status: csrf.status });
  }

  const supabase = await createClient();
  await supabase.auth.signOut();

  return NextResponse.redirect(new URL("/login", request.url), 303);
}
