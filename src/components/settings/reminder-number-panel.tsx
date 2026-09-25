'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  normalizeAgentWhatsappNumber,
} from '@/lib/followups/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { ReminderTemplatePanel } from './reminder-template-panel';

/**
 * Reminder WhatsApp Number — the logged-in user's own WhatsApp
 * number, the delivery target for personal Reminders. Stored on
 * the existing `profiles.whatsapp_number` field (same storage,
 * same strict E.164-with-country-code validation as before —
 * only the location moved, out of Your Profile).
 *
 * Self-service only: the row update is scoped to the caller's own
 * user_id, so teammates cannot edit each other's numbers.
 */
export function ReminderNumberPanel() {
  const { user } = useAuth();
  const supabase = createClient();

  const [number, setNumber] = useState('');
  const [savedNumber, setSavedNumber] = useState('');
  const [supported, setSupported] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load the caller's own number (separate query so older schemas
  // without the column leave the panel hidden instead of breaking).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    supabase
      .from('profiles')
      .select('whatsapp_number')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) return;
        if (!Object.prototype.hasOwnProperty.call(data, 'whatsapp_number')) return;
        setSupported(true);
        const current =
          typeof (data as { whatsapp_number?: unknown }).whatsapp_number === 'string'
            ? ((data as { whatsapp_number: string }).whatsapp_number ?? '')
            : '';
        setNumber(current);
        setSavedNumber(current);
      });
    return () => {
      cancelled = true;
    };
    // Deps mirror profile-form: re-run only when the user identity
    // changes, not on every user object churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function handleSave() {
    if (!user) return;
    const trimmed = number.trim();
    let normalized: string | null = null;
    if (trimmed) {
      // A bare 10-digit Indian number normalizes with the +91
      // default inside normalizeAgentWhatsappNumber — accepted with
      // no warning. Only genuinely malformed input is rejected.
      normalized = normalizeAgentWhatsappNumber(trimmed);
      if (!normalized) {
        toast.error('Enter a valid WhatsApp number, e.g. +919876543210');
        return;
      }
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ whatsapp_number: normalized })
        .eq('user_id', user.id);
      if (error) throw new Error(`Save failed: ${error.message}`);
      setNumber(normalized ?? '');
      setSavedNumber(normalized ?? '');
      toast.success('Reminder number saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the number');
    } finally {
      setSaving(false);
    }
  }

  if (!supported) return null;

  const dirty = number.trim() !== savedNumber.trim();  return (
    <Card className="max-w-md">
      <CardContent className="space-y-4 pt-6">
        <div className="space-y-2">
          <Input
            id="reminder-whatsapp-number"
            type="tel"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="+91XXXXXXXXXX"
            disabled={saving}
            autoComplete="tel"
            aria-label="Reminder WhatsApp Number"
            className="bg-muted border-border text-foreground placeholder:text-muted-foreground w-full max-w-sm"
          />
        </div>
        <div>
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving…
              </>
            ) : (
              'Save number'
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Dedicated Settings section page: heading + the number card +
 * the fallback-template card.
 * Registered as the `reminder-number` section (WORKSPACE group),
 * separate from the WhatsApp Business Connection page.
 */
export function ReminderNumberSettings() {
  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title="Reminder WhatsApp Number"
        description="Reminders created by you will be sent to this WhatsApp number."
      />
      <ReminderNumberPanel />
      <ReminderTemplatePanel />
    </section>
  );
}
