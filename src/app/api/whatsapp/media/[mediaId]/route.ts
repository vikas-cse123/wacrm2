import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, downloadMediaStream } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // Fetch and decrypt WhatsApp config
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Get the download URL from Meta (short-lived — resolved fresh on
    // every request, never persisted).
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Stream Meta's bytes straight through to the browser — nothing is
    // buffered in Node memory, nothing is stored. The browser's Range
    // header (video/audio seeking, progressive PDFs) is forwarded so
    // Meta's 206 partial response relays back intact.
    const upstream = await downloadMediaStream({
      downloadUrl: mediaInfo.url,
      accessToken,
      range: request.headers.get('range'),
    })

    const headers = new Headers()
    const contentType =
      upstream.headers.get('content-type') ||
      mediaInfo.mimeType ||
      'application/octet-stream'
    headers.set('Content-Type', contentType)
    const contentLength = upstream.headers.get('content-length')
    if (contentLength) headers.set('Content-Length', contentLength)
    const contentRange = upstream.headers.get('content-range')
    if (contentRange) headers.set('Content-Range', contentRange)
    const acceptRanges = upstream.headers.get('accept-ranges')
    headers.set('Accept-Ranges', acceptRanges || 'bytes')
    // Inline rendering by default (image/video/audio/PDF preview);
    // the Inbox Download button passes ?download=1 (or uses the
    // download attribute) to force an attachment instead.
    const asAttachment = new URL(request.url).searchParams.get('download') === '1'
    if (asAttachment) {
      headers.set('Content-Disposition', 'attachment')
    }
    headers.set('Cache-Control', 'public, max-age=86400')

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
