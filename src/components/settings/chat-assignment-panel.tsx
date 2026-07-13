"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Loader2,
  Plus,
  Trash2,
  RefreshCcw,
  Users,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { canEditSettings } from "@/lib/auth/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { SettingsPanelHead } from "./settings-panel-head";

type AssignmentMode = "round_robin" | "equal_load" | null;

interface AssignmentConfig {
  account_id: string;
  default_mode: AssignmentMode;
  online_only: boolean;
  reassign_offline: boolean;
}

interface AssignmentRule {
  id: string;
  name: string;
  trait_field: string;
  condition: "is" | "contains" | "starts_with";
  trait_values: string[];
  agent_ids: string[];
  is_active: boolean;
}

interface Member {
  user_id: string;
  full_name: string | null;
  account_role: string;
}

const MODE_INFO = {
  round_robin: {
    title: "Round Robin",
    description:
      "Chats are assigned to agents one after another in a fixed order, ensuring an equal distribution.",
  },
  equal_load: {
    title: "Equal Load Balancing",
    description:
      "Chats are assigned to the agent with the fewest currently open conversations.",
  },
} as const;

const CONDITIONS = [
  { value: "is", label: "is" },
  { value: "contains", label: "contains" },
  { value: "starts_with", label: "starts with" },
];

const TRAIT_FIELDS = [
  { value: "name", label: "Name" },
  { value: "phone", label: "Phone" },
  { value: "city", label: "City" },
  { value: "country", label: "Country" },
  { value: "source", label: "Source" },
  { value: "ad_name", label: "Ad Name" },
];

export function ChatAssignmentPanel() {
  const { accountRole } = useAuth();
  const isAdmin = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<AssignmentConfig | null>(null);
  const [rules, setRules] = useState<AssignmentRule[]>([]);
  const [members, setMembers] = useState<Member[]>([]);

  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AssignmentRule | null>(null);
  const [ruleForm, setRuleForm] = useState({
    name: "",
    trait_field: "name",
    condition: "is" as "is" | "contains" | "starts_with",
    trait_values: "",
    agent_ids: [] as string[],
  });
  const [ruleSaving, setRuleSaving] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [configRes, rulesRes, membersRes] = await Promise.all([
        fetch("/api/account/assignment"),
        fetch("/api/account/assignment/rules"),
        fetch("/api/account/members"),
      ]);
      const configData = await configRes.json();
      const rulesData = await rulesRes.json();
      const membersData = await membersRes.json();

      setConfig(
        configData.config ?? {
          account_id: "",
          default_mode: null,
          online_only: true,
          reassign_offline: false,
        },
      );
      setRules(rulesData.rules ?? []);
      setMembers(
        (membersData.members ?? []).filter(
          (m: Member) =>
            m.account_role === "owner" ||
            m.account_role === "admin" ||
            m.account_role === "agent",
        ),
      );
    } catch {
      toast.error("Failed to load assignment settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const updateConfig = async (patch: Partial<AssignmentConfig>) => {
    if (!isAdmin) return;
    const next = { ...config, ...patch };
    setConfig(next as AssignmentConfig);
    setSaving(true);
    try {
      const res = await fetch("/api/account/assignment", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error();
      toast.success("Assignment settings saved");
    } catch {
      toast.error("Failed to save settings");
      fetchData();
    } finally {
      setSaving(false);
    }
  };

  const selectMode = (mode: AssignmentMode) => {
    const newMode = config?.default_mode === mode ? null : mode;
    updateConfig({ default_mode: newMode });
  };

  const openNewRule = () => {
    setEditingRule(null);
    setRuleForm({
      name: "",
      trait_field: "name",
      condition: "is",
      trait_values: "",
      agent_ids: [],
    });
    setRuleDialogOpen(true);
  };

  const openEditRule = (rule: AssignmentRule) => {
    setEditingRule(rule);
    setRuleForm({
      name: rule.name,
      trait_field: rule.trait_field,
      condition: rule.condition,
      trait_values: rule.trait_values.join(", "),
      agent_ids: rule.agent_ids,
    });
    setRuleDialogOpen(true);
  };

  const saveRule = async () => {
    if (!ruleForm.name.trim()) {
      toast.error("Rule name is required");
      return;
    }
    setRuleSaving(true);
    try {
      const payload = {
        ...(editingRule ? { id: editingRule.id } : {}),
        name: ruleForm.name.trim(),
        trait_field: ruleForm.trait_field,
        condition: ruleForm.condition,
        trait_values: ruleForm.trait_values
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
        agent_ids: ruleForm.agent_ids,
      };

      const res = await fetch("/api/account/assignment/rules", {
        method: editingRule ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error();

      toast.success(editingRule ? "Rule updated" : "Rule created");
      setRuleDialogOpen(false);
      fetchData();
    } catch {
      toast.error("Failed to save rule");
    } finally {
      setRuleSaving(false);
    }
  };

  const deleteRule = async (ruleId: string) => {
    try {
      const res = await fetch(
        `/api/account/assignment/rules?id=${ruleId}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error();
      toast.success("Rule deleted");
      setRules((prev) => prev.filter((r) => r.id !== ruleId));
    } catch {
      toast.error("Failed to delete rule");
    }
  };

  const toggleRule = async (rule: AssignmentRule) => {
    try {
      const res = await fetch("/api/account/assignment/rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rule.id, is_active: !rule.is_active }),
      });
      if (!res.ok) throw new Error();
      setRules((prev) =>
        prev.map((r) =>
          r.id === rule.id ? { ...r, is_active: !r.is_active } : r,
        ),
      );
    } catch {
      toast.error("Failed to update rule");
    }
  };

  const toggleAgent = (agentId: string) => {
    setRuleForm((prev) => ({
      ...prev,
      agent_ids: prev.agent_ids.includes(agentId)
        ? prev.agent_ids.filter((id) => id !== agentId)
        : [...prev.agent_ids, agentId],
    }));
  };

  if (loading) {
    return (
      <section className="flex max-w-3xl items-center justify-center py-16">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </section>
    );
  }

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Chat Assignment"
        description="Configure how incoming chats are automatically assigned to team members."
      />

      {/* Default Assignment Mode */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground">
          Default Assignment Rule
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {(Object.keys(MODE_INFO) as Array<keyof typeof MODE_INFO>).map(
            (mode) => {
              const active = config?.default_mode === mode;
              return (
                <Card
                  key={mode}
                  className={`cursor-pointer transition-colors ${
                    active
                      ? "border-primary bg-primary/5"
                      : "hover:border-muted-foreground/30"
                  } ${!isAdmin ? "pointer-events-none opacity-60" : ""}`}
                  onClick={() => selectMode(mode)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div
                        className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 ${
                          active
                            ? "border-primary bg-primary"
                            : "border-muted-foreground/40"
                        }`}
                      >
                        {active && (
                          <div className="size-2 rounded-full bg-white" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">
                          {MODE_INFO[mode].title}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {MODE_INFO[mode].description}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            },
          )}
        </div>
      </div>

      {/* Toggles */}
      <div className="mt-6 space-y-4">
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <Users className="mt-0.5 size-5 text-muted-foreground" />
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Assign only to online agents
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  When enabled, chats will only be assigned to agents who are
                  currently online.
                </p>
              </div>
            </div>
            <Switch
              checked={config?.online_only ?? true}
              onCheckedChange={(v) => updateConfig({ online_only: v })}
              disabled={!isAdmin || saving}
            />
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <RefreshCcw className="mt-0.5 size-5 text-muted-foreground" />
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Reassign when agent goes offline
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Automatically reassign open chats to another available agent
                  when the assigned agent goes offline.
                </p>
              </div>
            </div>
            <Switch
              checked={config?.reassign_offline ?? false}
              onCheckedChange={(v) => updateConfig({ reassign_offline: v })}
              disabled={!isAdmin || saving}
            />
          </div>
        </div>
      </div>

      {/* Custom Rules */}
      <div className="mt-8">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Custom Assignment Rules
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Route conversations to specific agents based on contact traits.
              Rules are evaluated in order before the default mode.
            </p>
          </div>
          {isAdmin && (
            <Button size="sm" onClick={openNewRule}>
              <Plus className="mr-1.5 size-4" />
              New Rule
            </Button>
          )}
        </div>

        {rules.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No custom rules yet. Create one to route chats based on contact
            traits.
          </div>
        ) : (
          <div className="space-y-2">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
              >
                <Switch
                  checked={rule.is_active}
                  onCheckedChange={() => toggleRule(rule)}
                  disabled={!isAdmin}
                  aria-label={`Toggle rule ${rule.name}`}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => isAdmin && openEditRule(rule)}
                  disabled={!isAdmin}
                >
                  <p className="truncate text-sm font-medium text-foreground">
                    {rule.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {TRAIT_FIELDS.find((f) => f.value === rule.trait_field)
                      ?.label ?? rule.trait_field}{" "}
                    {rule.condition.replace("_", " ")}{" "}
                    {rule.trait_values.join(", ")} →{" "}
                    {rule.agent_ids.length} agent
                    {rule.agent_ids.length !== 1 ? "s" : ""}
                  </p>
                </button>
                {isAdmin && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => deleteRule(rule.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Rule Dialog */}
      <Dialog open={ruleDialogOpen} onOpenChange={setRuleDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingRule ? "Edit Rule" : "New Assignment Rule"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div>
              <Label htmlFor="rule-name">Rule Name</Label>
              <Input
                id="rule-name"
                placeholder="e.g. Delhi leads to Rahul"
                value={ruleForm.name}
                onChange={(e) =>
                  setRuleForm((p) => ({ ...p, name: e.target.value }))
                }
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Contact Trait</Label>
                <Select
                  value={ruleForm.trait_field}
                  onValueChange={(v) => {
                    if (v) setRuleForm((p) => ({ ...p, trait_field: v }));
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRAIT_FIELDS.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Condition</Label>
                <Select
                  value={ruleForm.condition}
                  onValueChange={(v) => {
                    if (v) setRuleForm((p) => ({
                      ...p,
                      condition: v as "is" | "contains" | "starts_with",
                    }));
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONDITIONS.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label htmlFor="trait-values">
                Values{" "}
                <span className="font-normal text-muted-foreground">
                  (comma-separated)
                </span>
              </Label>
              <Input
                id="trait-values"
                placeholder="e.g. Delhi, Mumbai"
                value={ruleForm.trait_values}
                onChange={(e) =>
                  setRuleForm((p) => ({ ...p, trait_values: e.target.value }))
                }
              />
            </div>

            <div>
              <Label>Assign to agents</Label>
              <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                {members.length === 0 ? (
                  <p className="py-2 text-center text-xs text-muted-foreground">
                    No agents found
                  </p>
                ) : (
                  members.map((m) => {
                    const selected = ruleForm.agent_ids.includes(m.user_id);
                    return (
                      <button
                        key={m.user_id}
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                          selected
                            ? "bg-primary/10 text-foreground"
                            : "text-muted-foreground hover:bg-muted"
                        }`}
                        onClick={() => toggleAgent(m.user_id)}
                      >
                        <div
                          className={`flex size-4 items-center justify-center rounded border ${
                            selected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-muted-foreground/40"
                          }`}
                        >
                          {selected && (
                            <svg
                              className="size-3"
                              viewBox="0 0 12 12"
                              fill="none"
                            >
                              <path
                                d="M2.5 6L5 8.5L9.5 3.5"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </div>
                        <span className="truncate">
                          {m.full_name || "Unnamed"}
                        </span>
                        <Badge variant="secondary" className="ml-auto text-[10px]">
                          {m.account_role}
                        </Badge>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRuleDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={saveRule} disabled={ruleSaving}>
              {ruleSaving && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              {editingRule ? "Update" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
