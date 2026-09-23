import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  buildFlowTableColumns,
  toFlowTableRow,
  FLOW_TABLE_PAGE_SIZE,
  type FlowTableRpcRow,
  type FlowTableView,
} from '@/lib/flows/flow-tables'

/**
 * GET /api/flows/[id]/table?view=all|completed|incomplete&search=&page=&pageSize=
 *
 * Workspace foundation read: one row per flow_run (identity =
 * flow_run_id), columns derived from the flow's own nodes,
 * Completed/Incomplete classified by execution reach of the
 * configured completion node (END fallback). Server-side filter +
 * pagination — runs are never fanned out to the browser.
 * RLS scopes every read to the caller's account.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const url = new URL(request.url)
  const rawView = url.searchParams.get('view') ?? 'all'
  if (rawView !== 'all' && rawView !== 'completed' && rawView !== 'incomplete') {
    return NextResponse.json(
      { error: 'view must be all, completed, or incomplete' },
      { status: 400 },
    )
  }
  const view = rawView as FlowTableView
  const search = url.searchParams.get('search')?.slice(0, 120) ?? ''
  const page = Math.max(Number(url.searchParams.get('page') ?? 0) || 0, 0)
  const pageSize = Math.min(
    Math.max(Number(url.searchParams.get('pageSize') ?? FLOW_TABLE_PAGE_SIZE) || FLOW_TABLE_PAGE_SIZE, 1),
    100,
  )

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: flow, error: flowErr } = await supabase
    .from('flows')
    .select('id, name, completion_node_id, entry_node_id')
    .eq('id', id)
    .maybeSingle()
  if (flowErr) {
    return NextResponse.json({ error: flowErr.message }, { status: 500 })
  }
  if (!flow) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { data: nodes, error: nodesErr } = await supabase
    .from('flow_nodes')
    .select('node_key, node_type, config, created_at')
    .eq('flow_id', id)
    .order('created_at', { ascending: true })
  if (nodesErr) {
    return NextResponse.json({ error: nodesErr.message }, { status: 500 })
  }

  const { data: payload, error: rpcErr } = await supabase.rpc(
    'get_flow_table_rows',
    {
      p_flow_id: id,
      p_view: view,
      p_search: search || null,
      p_page: page,
      p_page_size: pageSize,
    },
  )
  if (rpcErr) {
    return NextResponse.json({ error: rpcErr.message }, { status: 500 })
  }

  const completionNodeId =
    (flow as { completion_node_id?: string | null }).completion_node_id ?? null
  const { columns, nameKey, answerKeys } = buildFlowTableColumns(
    (nodes ?? []).map((n) => ({
      node_key: (n as { node_key: string }).node_key,
      node_type: (n as { node_type: string }).node_type,
      config: ((n as { config?: unknown }).config ?? {}) as Record<string, unknown>,
      created_at: (n as { created_at?: string | null }).created_at ?? null,
    })),
    (flow as { entry_node_id?: string | null }).entry_node_id ?? null,
  )
  const rpcRows = ((payload as { rows?: unknown }).rows ?? []) as FlowTableRpcRow[]
  const total = Number((payload as { total?: unknown }).total ?? 0) || 0
  return NextResponse.json({
    meta: {
      flowId: (flow as { id: string }).id,
      flowName: (flow as { name: string }).name,
      completionNodeId,
      view,
      total,
      page,
      pageSize,
    },
    columns,
    rows: rpcRows.map((r) => toFlowTableRow(r, completionNodeId, nameKey, answerKeys)),
  })
}
