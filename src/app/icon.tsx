import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Uses the Interscale Marketing logo (same asset as the login page and
// sidebar) as the browser favicon. Next.js renders this at build time
// and auto-injects <link rel="icon"> into <head>.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default async function Icon() {
  const logoData = await readFile(
    join(process.cwd(), "public", "interscale-logo.png"),
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