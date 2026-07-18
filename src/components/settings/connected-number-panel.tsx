'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Phone, TriangleAlert } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

interface ConnectedNumberState {
  connected: boolean;
  phone_number?: string;
  verified_name?: string | null;
  message?: string;
}

export function ConnectedNumberPanel() {
  const [state, setState] = useState<ConnectedNumberState | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/whatsapp/connected-number', { cache: 'no-store' })
      .then(async (response) => {
        const payload = (await response.json()) as ConnectedNumberState;
        if (!response.ok) {
          throw new Error(payload.message || 'Could not load connected number.');
        }
        return payload;
      })
      .then((payload) => {
        if (!cancelled) setState(payload);
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            connected: false,
            message:
              error instanceof Error
                ? error.message
                : 'Could not load connected number.',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Connected WhatsApp number"
        description="The business number currently connected to this CRM. Only the account owner can view it."
      />

      <Card>
        <CardContent className="flex min-h-28 items-center gap-4 p-5">
          {!state ? (
            <>
              <Loader2 className="size-5 animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">
                Checking WhatsApp connection…
              </span>
            </>
          ) : state.connected && state.phone_number ? (
            <>
              <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Phone className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="size-4 text-primary" /> Connected
                </div>
                <p className="mt-1 text-xl font-semibold text-foreground">
                  {state.phone_number}
                </p>
                {state.verified_name ? (
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {state.verified_name}
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <TriangleAlert className="size-5 shrink-0 text-amber-500" />
              <span className="text-sm text-muted-foreground">
                {state.message || 'No WhatsApp number is connected.'}
              </span>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
