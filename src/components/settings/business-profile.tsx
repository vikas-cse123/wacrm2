"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Building2,
  Camera,
  CheckCircle2,
  Globe,
  Loader2,
  Mail,
  MapPin,
  Share,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";
import { BUSINESS_VERTICALS, type BusinessProfile } from "@/lib/whatsapp/meta-api";
import {
  buildBusinessProfileUpdate,
  businessProfileToForm,
  validateBusinessProfileForm,
  validateProfilePhoto,
  type BusinessProfileFormValues,
} from "@/lib/whatsapp/business-profile";

interface LoadedState {
  profile: BusinessProfile;
  phone_number: string | null;
  verified_name: string | null;
}

const MANAGER_URL = "https://business.facebook.com/settings/whatsapp-business-accounts";

/**
 * WhatsApp Business Profile editor (Settings → Workspace → Business Profile).
 *
 * Meta is the source of truth: values load from Meta, saves PATCH
 * only changed fields, and the photo goes through Meta's two-step
 * upload without ever touching our database. The right-hand preview
 * renders live from the (possibly unsaved) form state.
 */
export function BusinessProfileSettings() {
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<BusinessProfileFormValues>({
    about: "",
    address: "",
    description: "",
    email: "",
    vertical: "",
    website: "",
    website2: "",
  });
  const [stagedPhoto, setStagedPhoto] = useState<{
    file: File;
    previewUrl: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/whatsapp/business-profile", {
        cache: "no-store",
      });
      const json = (await res.json().catch(() => null)) as Partial<
        LoadedState & { message?: unknown; error?: unknown }
      > | null;
      if (!res.ok) {
        throw new Error(
          typeof json?.error === "string"
            ? json.error
            : (typeof json?.message === "string" ? json.message : null) ??
              "Could not load the WhatsApp profile.",
        );
      }
      if (!json || !("profile" in json) || !json.profile) {
        throw new Error("Could not load the WhatsApp profile.");
      }
      const state: LoadedState = {
        profile: json.profile as BusinessProfile,
        phone_number:
          typeof json.phone_number === "string" ? json.phone_number : null,
        verified_name:
          typeof json.verified_name === "string" ? json.verified_name : null,
      };
      setLoaded(state);
      setForm(businessProfileToForm(state.profile));
      setStagedPhoto(null);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Could not load the WhatsApp profile.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Revoke staged object URLs (no local persistence of images).
  useEffect(() => {
    return () => {
      if (stagedPhoto) URL.revokeObjectURL(stagedPhoto.previewUrl);
    };
  }, [stagedPhoto]);

  const set = (key: keyof BusinessProfileFormValues, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const update = useMemo(
    () =>
      loaded
        ? buildBusinessProfileUpdate(loaded.profile, form)
        : {},
    [loaded, form],
  );
  const dirty = stagedPhoto !== null || Object.keys(update).length > 0;

  const errors = useMemo(() => {
    const found = validateBusinessProfileForm(form);
    // An unknown vertical loaded from Meta is preserved, not an
    // error, unless the user actually changed it.
    if (
      found.vertical &&
      loaded &&
      form.vertical === (loaded.profile.vertical ?? "")
    ) {
      delete found.vertical;
    }
    return found;
  }, [form, loaded]);
  const hasErrors = Object.keys(errors).length > 0;

  function stagePhoto(file: File | undefined) {
    if (!file) return;
    const problem = validateProfilePhoto({
      mimeType: file.type,
      sizeBytes: file.size,
    });
    if (problem) {
      toast.error(problem);
      return;
    }
    if (stagedPhoto) URL.revokeObjectURL(stagedPhoto.previewUrl);
    setStagedPhoto({ file, previewUrl: URL.createObjectURL(file) });
    setSavedAt(null);
  }

  function clearStagedPhoto() {
    if (stagedPhoto) URL.revokeObjectURL(stagedPhoto.previewUrl);
    setStagedPhoto(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleReset() {
    if (!loaded) return;
    setForm(businessProfileToForm(loaded.profile));
    clearStagedPhoto();
    setSaveError(null);
  }

  async function handleSave() {
    if (!loaded || saving || !dirty || hasErrors) return;
    setSaving(true);
    setSaveError(null);
    try {
      let profile = loaded.profile;
      // Photo first (upload + set in one server call), then fields.
      if (stagedPhoto) {
        const photoForm = new FormData();
        photoForm.append("file", stagedPhoto.file);
        const photoRes = await fetch("/api/whatsapp/business-profile/photo", {
          method: "POST",
          body: photoForm,
        });
        const photoJson = (await photoRes.json().catch(() => null)) as {
          profile?: BusinessProfile;
          error?: unknown;
        } | null;
        if (!photoRes.ok || !photoJson?.profile) {
          throw new Error(
            typeof photoJson?.error === "string"
              ? photoJson.error
              : "Couldn't update the profile photo.",
          );
        }
        profile = photoJson.profile;
      }
      const patch = buildBusinessProfileUpdate(profile, form);
      if (Object.keys(patch).length > 0) {
        const patchRes = await fetch("/api/whatsapp/business-profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const patchJson = (await patchRes.json().catch(() => null)) as {
          profile?: BusinessProfile;
          error?: unknown;
        } | null;
        if (!patchRes.ok || !patchJson?.profile) {
          throw new Error(
            typeof patchJson?.error === "string"
              ? patchJson.error
              : "Couldn't update WhatsApp profile.",
          );
        }
        profile = patchJson.profile;
      }
      setLoaded((prev) =>
        prev ? { ...prev, profile } : prev,
      );
      setForm(businessProfileToForm(profile));
      clearStagedPhoto();
      setSavedAt(new Date().toLocaleTimeString());
      toast.success("WhatsApp profile updated");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Couldn't update WhatsApp profile.";
      setSaveError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  const photoSrc =
    stagedPhoto?.previewUrl ?? loaded?.profile.profile_picture_url ?? null;
  const verticalKnown =
    !form.vertical ||
    BUSINESS_VERTICALS.some((v) => v.code === form.vertical);

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Business Profile"
        description="Manage how your business appears on WhatsApp. Changes save directly to Meta — Meta remains the source of truth."
      />

      {loading ? (
        <Card>
          <CardContent className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading WhatsApp profile…
          </CardContent>
        </Card>
      ) : loadError || !loaded ? (
        <Card>
          <CardContent className="space-y-3 py-8">
            <p className="text-sm text-foreground">
              Unable to load WhatsApp profile.
            </p>
            <p className="text-xs text-muted-foreground">
              {loadError ?? "Check the connection, then try again."}
            </p>
            <Button variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          {/* Editor */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                <Building2 className="size-4 text-primary" />
                Profile details
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                Only changed fields are sent to Meta when you save.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Photo */}
              <div className="flex items-center gap-4">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xl font-semibold text-muted-foreground">
                  {photoSrc ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={photoSrc}
                      alt="WhatsApp profile photo preview"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    (loaded.verified_name ?? loaded.phone_number ?? "?")
                      .charAt(0)
                      .toUpperCase()
                  )}
                </div>
                <div className="space-y-1.5">
                  <p className="text-sm font-medium text-foreground">
                    Profile picture
                  </p>
                  <div className="flex gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png"
                      className="hidden"
                      onChange={(e) => {
                        stagePhoto(e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Camera className="size-3.5" />
                      {stagedPhoto || photoSrc ? "Change photo" : "Upload photo"}
                    </Button>
                    {stagedPhoto && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={clearStagedPhoto}
                      >
                        <X className="size-3.5" />
                        Remove
                      </Button>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    JPEG or PNG, up to 5 MB.
                    {stagedPhoto ? " New photo applies on save." : ""}
                  </p>
                </div>
              </div>

              {/* Display name (read-only — Meta review required) */}
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Display name</Label>
                <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground">
                  <span className="flex-1 truncate">
                    {loaded.verified_name ?? "—"}
                  </span>
                  {loaded.verified_name && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <CheckCircle2 className="size-3.5" />
                      Meta
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Display names need Meta review —{" "}
                  <a
                    href={MANAGER_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    change it in WhatsApp Manager
                  </a>
                  .
                </p>
              </div>

              {/* Category */}
              <div className="grid gap-2">
                <Label className="text-muted-foreground" htmlFor="bp-vertical">
                  Category
                </Label>
                <select
                  id="bp-vertical"
                  value={form.vertical}
                  onChange={(e) => set("vertical", e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                >
                  <option value="">Select a category…</option>
                  {!verticalKnown && form.vertical && (
                    <option value={form.vertical}>{form.vertical}</option>
                  )}
                  {BUSINESS_VERTICALS.map((v) => (
                    <option key={v.code} value={v.code}>
                      {v.label}
                    </option>
                  ))}
                </select>
                {errors.vertical && (
                  <p className="text-xs text-destructive">{errors.vertical}</p>
                )}
              </div>

              {/* About */}
              <div className="grid gap-2">
                <Label className="text-muted-foreground" htmlFor="bp-about">
                  About
                </Label>
                <Input
                  id="bp-about"
                  value={form.about}
                  onChange={(e) => set("about", e.target.value)}
                  maxLength={512}
                  placeholder="Short business tagline"
                />
                <p className="text-[11px] text-muted-foreground tabular-nums">
                  {form.about.length}/512
                </p>
                {errors.about && (
                  <p className="text-xs text-destructive">{errors.about}</p>
                )}
              </div>

              {/* Description */}
              <div className="grid gap-2">
                <Label className="text-muted-foreground" htmlFor="bp-description">
                  Description
                </Label>
                <textarea
                  id="bp-description"
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                  maxLength={512}
                  rows={3}
                  placeholder="What your business does…"
                  className="w-full resize-y rounded-lg border border-border bg-muted px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                />
                <p className="text-[11px] text-muted-foreground tabular-nums">
                  {form.description.length}/512
                </p>
                {errors.description && (
                  <p className="text-xs text-destructive">{errors.description}</p>
                )}
              </div>

              {/* Address */}
              <div className="grid gap-2">
                <Label className="text-muted-foreground" htmlFor="bp-address">
                  Address
                </Label>
                <Input
                  id="bp-address"
                  value={form.address}
                  onChange={(e) => set("address", e.target.value)}
                  maxLength={256}
                  placeholder="Enter business address"
                />
                {errors.address && (
                  <p className="text-xs text-destructive">{errors.address}</p>
                )}
              </div>

              {/* Email */}
              <div className="grid gap-2">
                <Label className="text-muted-foreground" htmlFor="bp-email">
                  Email
                </Label>
                <Input
                  id="bp-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => set("email", e.target.value)}
                  placeholder="info@example.com"
                />
                {errors.email && (
                  <p className="text-xs text-destructive">{errors.email}</p>
                )}
              </div>

              {/* Websites */}
              <div className="grid gap-2">
                <Label className="text-muted-foreground" htmlFor="bp-website">
                  Website
                </Label>
                <Input
                  id="bp-website"
                  inputMode="url"
                  value={form.website}
                  onChange={(e) => set("website", e.target.value)}
                  placeholder="https://example.com"
                />
                {errors.website && (
                  <p className="text-xs text-destructive">{errors.website}</p>
                )}
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground" htmlFor="bp-website2">
                  Additional website
                </Label>
                <Input
                  id="bp-website2"
                  inputMode="url"
                  value={form.website2}
                  onChange={(e) => set("website2", e.target.value)}
                  placeholder="https://example.com/shop (optional)"
                />
                {errors.website2 && (
                  <p className="text-xs text-destructive">{errors.website2}</p>
                )}
              </div>

              {saveError && (
                <p className="text-xs text-destructive">{saveError}</p>
              )}
              {savedAt && !saveError && (
                <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <CheckCircle2 className="size-3.5" />
                  Saved at {savedAt}
                </p>
              )}

              <div className="flex gap-2">
                <Button
                  onClick={() => void handleSave()}
                  disabled={saving || !dirty || hasErrors}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  Save changes
                </Button>
                <Button
                  variant="outline"
                  onClick={handleReset}
                  disabled={saving || !dirty}
                >
                  Reset changes
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Live preview */}
          <BusinessProfilePreview
            form={form}
            photoSrc={photoSrc}
            verifiedName={loaded.verified_name}
            phoneNumber={loaded.phone_number}
          />
        </div>
      )}
    </section>
  );
}

function PreviewRow({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 text-[13px] text-foreground">
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}

/**
 * WhatsApp-style profile preview. Renders live from the (possibly
 * unsaved) form state — empty fields are omitted, never placeholders.
 */
export function BusinessProfilePreview({
  form,
  photoSrc,
  verifiedName,
  phoneNumber,
}: {
  form: BusinessProfileFormValues;
  photoSrc: string | null;
  verifiedName: string | null;
  phoneNumber: string | null;
}) {
  const verticalLabel =
    BUSINESS_VERTICALS.find((v) => v.code === form.vertical)?.label ??
    form.vertical;
  const websites = [form.website.trim(), form.website2.trim()].filter(Boolean);

  return (
    <Card className="overflow-hidden lg:sticky lg:top-4">
      <div className="bg-muted/60 px-4 pb-6 pt-3">
        <div className="flex items-center justify-between text-muted-foreground">
          <ArrowLeft className="size-4" />
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        </div>
        <div className="mx-auto mt-2 flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-muted text-2xl font-semibold text-muted-foreground">
          {photoSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photoSrc}
              alt="Profile preview"
              className="h-full w-full object-cover"
            />
          ) : (
            (verifiedName ?? phoneNumber ?? "?").charAt(0).toUpperCase()
          )}
        </div>
        <p className="mt-2 truncate text-center text-[15px] font-semibold text-foreground">
          {verifiedName ?? phoneNumber ?? "WhatsApp Business"}
        </p>
        {phoneNumber && (
          <p className="truncate text-center text-xs text-muted-foreground tabular-nums">
            {phoneNumber}
          </p>
        )}
        <div className="mt-3 flex justify-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-foreground">
            <Share className="size-3" />
            Share
          </span>
        </div>
      </div>
      <CardContent className="space-y-2.5 p-4">
        {verticalLabel && <PreviewRow icon={<Building2 className="size-4" />}>{verticalLabel}</PreviewRow>}
        {form.email.trim() && (
          <PreviewRow icon={<Mail className="size-4" />}>{form.email.trim()}</PreviewRow>
        )}
        {websites.map((w) => (
          <PreviewRow key={w} icon={<Globe className="size-4" />}>
            {w.replace(/^https?:\/\//, "")}
          </PreviewRow>
        ))}
        {form.address.trim() && (
          <PreviewRow icon={<MapPin className="size-4" />}>{form.address.trim()}</PreviewRow>
        )}
        {form.description.trim() ? (
          <p className="whitespace-pre-wrap break-words px-0 pt-1 text-[13px] text-muted-foreground">
            {form.description.trim()}
          </p>
        ) : form.about.trim() ? (
          <p className="whitespace-pre-wrap break-words px-0 pt-1 text-[13px] text-muted-foreground">
            {form.about.trim()}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
