// Pure Business Profile form helpers — shared by the Settings UI
// and the API route so both sides enforce the same rules. No
// Meta calls here (see meta-api.ts); no DB access.

import {
  BUSINESS_PROFILE_LIMITS,
  BUSINESS_PROFILE_PHOTO_MIMES,
  BUSINESS_VERTICALS,
  type BusinessProfile,
  type BusinessProfileUpdate,
} from "./meta-api";

export interface BusinessProfileFormValues {
  about: string;
  address: string;
  description: string;
  email: string;
  vertical: string;
  website: string;
  website2: string;
}

export function businessProfileToForm(
  profile: BusinessProfile,
): BusinessProfileFormValues {
  return {
    about: profile.about ?? "",
    address: profile.address ?? "",
    description: profile.description ?? "",
    email: profile.email ?? "",
    vertical: profile.vertical ?? "",
    website: profile.websites[0] ?? "",
    website2: profile.websites[1] ?? "",
  };
}

/** Absolute http(s) URL, or empty (means "unset"). */
export function isValidHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type BusinessProfileFieldKey = keyof BusinessProfileFormValues;

/**
 * Validate form values. Returns a map of field → message (empty =
 * valid). Length caps mirror BUSINESS_PROFILE_LIMITS; Meta remains
 * the final validator and its errors surface separately.
 */
export function validateBusinessProfileForm(
  values: BusinessProfileFormValues,
): Partial<Record<BusinessProfileFieldKey, string>> {
  const errors: Partial<Record<BusinessProfileFieldKey, string>> = {};
  const L = BUSINESS_PROFILE_LIMITS;

  if (values.about.length > L.about) {
    errors.about = `About must be ${L.about} characters or fewer.`;
  }
  if (values.description.length > L.description) {
    errors.description = `Description must be ${L.description} characters or fewer.`;
  }
  if (values.address.length > L.address) {
    errors.address = `Address must be ${L.address} characters or fewer.`;
  }
  if (values.email.trim() && !EMAIL_RE.test(values.email.trim())) {
    errors.email = "Enter a valid email address.";
  }
  if (values.vertical && !BUSINESS_VERTICALS.some((v) => v.code === values.vertical)) {
    errors.vertical = "Select a valid category.";
  }
  if (!isValidHttpUrl(values.website)) {
    errors.website = "Enter a valid http(s) URL.";
  }
  if (!isValidHttpUrl(values.website2)) {
    errors.website2 = "Enter a valid http(s) URL.";
  }
  if (
    values.website.trim() &&
    values.website2.trim() &&
    values.website.trim() === values.website2.trim()
  ) {
    errors.website2 = "Websites must be different.";
  }
  return errors;
}

function normWebsites(values: BusinessProfileFormValues): string[] {
  return [values.website.trim(), values.website2.trim()].filter(Boolean);
}

function sameWebsites(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i]);
}

/**
 * Diff form values against the loaded Meta profile. Returns only the
 * changed keys (empty strings become null = clear on Meta's side),
 * so PATCH never rewrites untouched fields.
 */
export function buildBusinessProfileUpdate(
  current: BusinessProfile,
  values: BusinessProfileFormValues,
): BusinessProfileUpdate {
  const update: BusinessProfileUpdate = {};

  const text = (
    key: "about" | "address" | "description" | "email",
  ) => {
    const next = values[key].trim();
    const prev = (current[key] ?? "").trim();
    if (next !== prev) update[key] = next || null;
  };
  text("about");
  text("address");
  text("description");
  text("email");

  const nextVertical = values.vertical || null;
  if (nextVertical !== current.vertical) update.vertical = nextVertical;

  const nextWebsites = normWebsites(values);
  if (!sameWebsites(nextWebsites, current.websites)) {
    update.websites = nextWebsites;
  }

  return update;
}

export interface ProfilePhotoSelection {
  mimeType: string;
  sizeBytes: number;
}

/** Shared client/server gate for staged profile photos. */
export function validateProfilePhoto(
  file: ProfilePhotoSelection,
): string | null {
  if (
    !(BUSINESS_PROFILE_PHOTO_MIMES as readonly string[]).includes(file.mimeType)
  ) {
    return "Photo must be a JPEG or PNG image.";
  }
  if (file.sizeBytes <= 0) {
    return "Photo file is empty.";
  }
  if (file.sizeBytes > BUSINESS_PROFILE_LIMITS.photoMaxBytes) {
    return "Photo must be 5 MB or smaller.";
  }
  return null;
}
