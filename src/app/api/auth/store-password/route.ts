import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
// import bcrypt from "bcryptjs";

// Admin client using the service-role key — this bypasses Row Level
// Security, which is exactly why this must only ever run server-side
// (inside an API route / server action), never in browser code.
// NEXT_PUBLIC_SUPABASE_URL is safe to expose (it already is, client-side).
// SUPABASE_SERVICE_ROLE_KEY must NOT have a NEXT_PUBLIC_ prefix, or it
// would get bundled into client JS and leak to anyone viewing the page source.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function POST(request: NextRequest) {
  try {
    const { userId, password } = await request.json();

    if (!userId || !password) {
      return NextResponse.json(
        { error: "userId and password are required" },
        { status: 400 },
      );
    }

    // const passwordHash = await bcrypt.hash(password, 10);

    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ password })
      .eq("user_id", userId);

    if (error) {
    //   console.error("Failed to store password hash:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("store-password route error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}