import type { MetadataRoute } from "next";
import { WEBSITE_DOMAIN } from "@/lib/site";

// Served at /sitemap.xml. Lists only the public, indexable pages.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${WEBSITE_DOMAIN}/`,
      changeFrequency: "monthly",
      priority: 1,
    },
    {
      url: `${WEBSITE_DOMAIN}/privacy-policy`,
      changeFrequency: "yearly",
      priority: 0.5,
    },
    {
      url: `${WEBSITE_DOMAIN}/terms-and-conditions`,
      changeFrequency: "yearly",
      priority: 0.5,
    },
  ];
}
