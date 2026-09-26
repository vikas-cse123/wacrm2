import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { ensureWorkspaceDefaultFields } from '@/lib/flows/workspace-defaults'
import {
  parseAssigneeParam,
  serializeAssigneeSelection,
  validateWorkspaceDateRange,
  type WorkspaceAssigneeSelection,
  type WorkspaceDateRange,
} from '@/lib/flows/workspace-filters'
import {
  buildFlowTableColumns,
  toFlowTableRow,
  FLOW_TABLE_PAGE_SIZE,
  type FlowTableRpcRow,
  type FlowTableView,
} from '@/lib/flows/flow-tables'

/**
 * GET /api/flows/[id]/table?view=all|completed|incomplete&search=&page=&pageSize=&dateFrom=&dateTo=&assignee=
 *
 * Workspace foundation read: one row per flow_run (identity =
 * flow_run_id), columns derived from the flow's own nodes,
 * Completed/Incomplete classified by execution reach of the
 * configured completion node (END fallback). Server-side filter +
 * pagination — runs are never fanned out to the browser.
 * RLS scopes every read to the caller's account.
 *
 * Exactly two additive filters (both optional, combinable AND):
 *   dateFrom/dateTo — half-open [from, to) ISO window over
 *     Submission Time (flow_runs.started_at). The client resolves
 *     Today / Yesterday / Last 7 / Last 30 / Custom to concrete
 *     bounds in the viewer's local timezone; the server only
 *     validates ISO shape + from <= to (400 otherwise) and pushes
 *     both into the paginated RPC, so total + page stay correct.
 *   assignee — "all" (default) | "unassigned" | <member user_id>.
 *     Member filtering matches the stable ID server-side; unknown
 *     or foreign IDs match zero rows (account isolation holds
 *     inside the account-scoped RPC).
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

  // Workspace filters — additive query keys; absent = inactive.
  // Date bounds are validated ISO instants (400 on garbage or an
  // inverted range); the assignee keyword/id is parsed leniently
  // (unknown ids match zero rows rather than 400ing the table).
  let dateRange: WorkspaceDateRange | null = null
  const rawFrom = url.searchParams.get('dateFrom')
  const rawTo = url.searchParams.get('dateTo')
  if (rawFrom !== null || rawTo !== null) {
    if (!rawFrom || !rawTo) {
      return NextResponse.json(
        { error: 'dateFrom and dateTo are required together.' },
        { status: 400 },
      )
    }
    try {
      dateRange = validateWorkspaceDateRange({ from: rawFrom, to: rawTo })
    } catch {
      return NextResponse.json(
        { error: 'dateFrom/dateTo must be valid ISO datetimes with from <= to.' },
        { status: 400 },
      )
    }
  }
  let assignee: WorkspaceAssigneeSelection
  try {
    assignee = parseAssigneeParam(url.searchParams.get('assignee'))
  } catch {
    return NextResponse.json(
      { error: 'Invalid assignee filter.' },
      { status: 400 },
    )
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: flow, error: flowErr } = await supabase
    .from('flows')
    .select('id, name, account_id, completion_node_id, entry_node_id')
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
      // Server-side filters (migration 094 — NULL/absent = inactive,
      // so unfiltered reads behave exactly as before). Pagination
      // applies to the FILTERED set, keeping total + row numbering
      // correct with any combination active.
      p_started_from: dateRange?.from ?? null,
      p_started_to: dateRange?.to ?? null,
      p_assignee: serializeAssigneeSelection(assignee),
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
  const rows = rpcRows.map((r) => toFlowTableRow(r, completionNodeId, nameKey, answerKeys));

  // Contact source URLs for this page: one batched contacts lookup
  // (flow_run.contact_id → contacts.source_url), never N+1.
  // RLS scopes the read like every other query on this route.
  // The client uses them read-only for the "Lead Received"
  // auto-detect default (Facebook/Instagram ad platform) — the
  // response shape is unchanged.
  const contactIds = [...new Set(rows.map((r) => r.contactId).filter(Boolean))] as string[];
  const sourceByContact: Record<string, string | null> = {};
  if (contactIds.length > 0) {
    const { data: sourceRows } = await supabase
      .from("contacts")
      .select("id, source_url")
      .in("id", contactIds);
    for (const c of (sourceRows ?? []) as Array<{ id: string; source_url: string | null }>) {
      sourceByContact[c.id] = c.source_url;
    }
  }
  for (const r of rows) {
    r.sourceUrl = r.contactId ? (sourceByContact[r.contactId] ?? null) : null;
  }

  // Workspace custom columns + this page's values (two queries, no
  // N+1). Additive to the response — existing shape untouched.
  // Google Sheets never reads these tables.
  //
  // First-use safety net: flows predating default business columns
  // (or created outside the API) get their missing defaults here,
  // so Completed and Incomplete — views over the SAME flow fields
  // — always share one configuration. Best-effort and
  // role-independent (service-role write scoped to this flow's own
  // account, which the RLS-scoped fetch above already proved the
  // caller may see); a failure never breaks the read.
  try {
    const typed = flow as { id: string; account_id: string }
    await ensureWorkspaceDefaultFields(supabaseAdmin(), typed.account_id, typed.id)
  } catch (err) {
    console.error('workspace defaults provisioning failed', err)
  }
  const { data: customFields } = await supabase
    .from("workspace_fields")
    .select("*")
    .eq("flow_id", id)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  const runIds = rows.map((r) => r.runId);
  const customValues: Record<string, Record<string, string | null>> = {};
  if (runIds.length > 0) {
    const { data: valueRows } = await supabase
      .from("workspace_values")
      .select("flow_run_id, field_id, value_text")
      .in("flow_run_id", runIds);
    for (const v of (valueRows ?? []) as Array<{
      flow_run_id: string;
      field_id: string;
      value_text: string | null;
    }>) {
      (customValues[v.flow_run_id] ??= {})[v.field_id] = v.value_text;
    }
  }
  // Agent overrides for flow-derived cells (one batched read, no
  // N+1). Originals stay in `rows[].answers`; this additive map
  // drives Workspace display + restore UI only — flow_runs.vars,
  // Sheets, and history are untouched. Best-effort: a read failure
  // (e.g. migration not yet applied) degrades to originals.
  const flowOverrides: Record<string, Record<string, string | null>> = {};
  if (runIds.length > 0) {
    try {
      const { data: overrideRows, error: overrideErr } = await supabase
        .from("workspace_flow_overrides")
        .select("flow_run_id, field_key, value_text")
        .eq("account_id", (flow as { account_id: string }).account_id)
        .eq("flow_id", id)
        .in("flow_run_id", runIds);
      if (overrideErr) throw overrideErr;
      for (const v of (overrideRows ?? []) as Array<{
        flow_run_id: string;
        field_key: string;
        value_text: string | null;
      }>) {
        (flowOverrides[v.flow_run_id] ??= {})[v.field_key] = v.value_text;
      }
    } catch (err) {
      console.error("workspace flow overrides read failed", err);
    }
  }
  return NextResponse.json({
    meta: {
      flowId: (flow as { id: string }).id,
      flowName: (flow as { name: string }).name,
      completionNodeId,
      view,
      total,
      page,
      pageSize,
      // Echo of the applied filters (additive — existing shape
      // untouched). Nulls/absent-equivalent mean "inactive".
      filters: {
        dateFrom: dateRange?.from ?? null,
        dateTo: dateRange?.to ?? null,
        assignee: serializeAssigneeSelection(assignee),
      },
    },
    columns,
    rows,
    customFields: (customFields ?? []).map((f) => {
      const row = f as Record<string, unknown>;
      return {
        id: row.id,
        name: row.name,
        field_type: row.field_type,
        position: row.position,
        options: row.options ?? null,
        default_value: row.default_value ?? null,
        currency_code: row.currency_code ?? null,
      };
    }),
    customValues,
    flowOverrides,
  });
}
