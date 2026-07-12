import type { MetadataRoute } from 'next';

/**
 * Web app manifest — makes the CRM installable ("Add to Home Screen").
 * Served at /manifest.webmanifest and linked automatically by Next from
 * the presence of this file.
 *
 * `display: standalone` opens the installed shortcut chrome-less like a
 * native app; `start_url` lands the user straight in the inbox.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Interscale Marketing',
    short_name: 'Interscale',
    description: 'Interscale Marketing WhatsApp CRM',
    start_url: '/inbox',
    scope: '/',
    display: 'standalone',
    background_color: '#020617',
    theme_color: '#020617',
    icons: [
      {
        src: '/interscale-logo.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/interscale-logo.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/interscale-logo.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
