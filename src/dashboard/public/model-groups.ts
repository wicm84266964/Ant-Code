import type { DashboardGatewayProfile } from "./app-core.ts";

export function modelPickerLabel(model: { id: string; label?: string; switchProfileId: string }, models: Array<{ id: string; label?: string; switchProfileId: string }>) {
  const remark = model.label && model.label !== model.id ? model.label : "";
  const label = remark ? `${model.id} (${remark})` : model.id;
  const duplicates = models.filter((other) => other.id === model.id && (other.label || other.id) === (model.label || model.id));
  if (duplicates.length < 2) return label;
  return `${label} (配置 ${duplicates.findIndex((other) => other.switchProfileId === model.switchProfileId) + 1})`;
}

export function providerRouteLabel(profile: DashboardGatewayProfile) {
  const label = String(profile.label ?? "").trim();
  if (label && !/^https?:\/\//i.test(label)) return label;
  const id = String(profile.id ?? "").trim();
  if (id && !/^gw-[a-f0-9]+$/i.test(id)) return id;
  const model = profile.models?.[0];
  return model?.label || model?.id || id || "未命名路线";
}

export function providerRouteGroups(profiles: DashboardGatewayProfile[]) {
  return profiles.map((profile) => ({
    id: profile.id,
    label: providerRouteLabel(profile),
    profiles: [profile]
  }));
}

export function modelConnectionGroups(profiles: DashboardGatewayProfile[]) {
  const groups = new Map<string, { id: string; label: string; profiles: DashboardGatewayProfile[] }>();
  for (const profile of profiles) {
    const id = String(profile.connectionGroupId || profile.id);
    let group = groups.get(id);
    if (!group) {
      group = { id, label: profile.gatewayUrl || profile.label || profile.id, profiles: [] };
      groups.set(id, group);
    }
    group.profiles.push(profile);
  }
  const result = [...groups.values()];
  const counts = new Map<string, number>();
  for (const group of result) counts.set(group.label, (counts.get(group.label) || 0) + 1);
  for (const group of result) {
    if ((counts.get(group.label) || 0) > 1) {
      const profile = group.profiles[0];
      group.label += ` (${profile.gatewayUrl || profile.id}; ${profile.id})`;
    }
  }
  return result;
}
