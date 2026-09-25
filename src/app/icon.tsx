import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Uses the WACRM product logo (public/logo.png — the same asset as
// the login page and sidebar) as the browser favicon. Next.js
// renders this at build time and auto-injects <link rel="icon">
// into <head>. The obsolete public/favicon.ico was removed so no
// stale brand icon can shadow it.

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default async function Icon() {
  const logoData = await readFile(
    join(process.cwd(), "public", "logo.png"),
  );
  const logoSrc = `data:image/png;base64,${logoData.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoSrc}
          width={size.width}
          height={size.height}
          style={{ borderRadius: 6, objectFit: "cover" }}
        />
      </div>
    ),
    { ...size },
  );
}